import type { Db } from '../db/connection.js';
import { dbHourBlocks, type HourBlockCache } from '../db/hourBlocks.js';
import { MS_PER_HOUR, upsertPrices, upsertToken, type PriceRow } from '../db/prices.js';
import { CHAINS } from '../ingest/transport/chains.js';
import type { HttpTransport } from '../ingest/transport/http.js';
import { firstBlockAtOrAfter, type BlockRef, type RpcFactory, type RpcTransport } from '../ingest/transport/rpc.js';
import { OrionError } from '../types.js';
import { methodSource, quoteRefOf, type PriceEntry } from './config.js';
import { checkLabel, EVM_METHOD_KINDS, priceHourEvm, type BlockReadCache, type HourBlocks, type MethodRead } from './evmMethods.js';
import type { HourPrice, PriceDeps, SolanaPriceTransport, WriteResult } from './types.js';

/**
 * The resumable chain price writer (Phase 3 R2 Task 3, plans P2/P5/P6): every later job (levels, the prices backfill)
 * calls writeChainPrices. It walks UTC days newest first and, per day, each chain of the run (eip155:1 first, Ruling R5;
 * then the other EVM chains; then the off-chain venues) over that day's hours newest first, and commits one chain-day per
 * transaction, so an interrupted run keeps every committed chain-day and a re-run resumes from `prices` itself: an hour
 * already stored for a ref under its primary's source is skipped without a read.
 *
 * A row with ts = H prices the bucket [H, H+1h) at B(H+1h), the first block at or after H+1h (an hour whose B(H+1h)
 * does not exist yet gets no row: `no_block_yet`); a cumulative TWAP reads from B(H). One BlockReadCache per chain is
 * carried from hour to hour (B(H+1h) of hour h is B(H) of the hour after it), so a TWAP chain costs one multicall per hour.
 */

const H = MS_PER_HOUR;
const DAY_MS = 24 * H;
/** An hour block is cached (hour_blocks) only this far below the head: a younger block could still be reorged away. */
export const HOUR_BLOCK_MIN_AGE_SEC = 3600;
/** How far around the written hours the breach rule reads stored gaps (a skipped hour neither breaches nor resets). */
const BREACH_WINDOW_HOURS = 48;

// ---- the per-chain registry (Ruling R4) ------------------------------------------------------------------------------

/** The hour a chain method prices: the bucket [hourMs, hourMs + 1h), and on an EVM chain its blocks B(H), B(H+1h). */
export interface ChainHour {
  hourMs: number;
  blocks: HourBlocks | null;
}

export interface ChainHourCtx {
  /** Chain 1's Chainlink answers this hour, keyed by the lowercased feed address (Ruling R5); null on chain 1 itself. */
  feedUsd: ReadonlyMap<string, number> | null;
  /** The EVM check reads of off-chain entries this hour (LIT's v4 pool), by ref; empty on an EVM chain. */
  checks: ReadonlyMap<string, MethodRead>;
  /** More feeds this chain-hour reads: on chain 1, every off-chain entry's usd_feed. */
  feeds: string[];
  /** This chain's block reads, carried across the hours of the run and pruned to the last hour's B(H). */
  cache: BlockReadCache;
}

export interface ChainHourResult {
  prices: Map<string, HourPrice>;
  missing: { ref: string; reason: string; detail?: Record<string, unknown> }[];
  /** An EVM chain's feed answers this hour (chain 1's go to the off-chain methods). */
  feedUsd?: Map<string, number>;
  /** EVM check reads of entries whose primary is off-chain. */
  checks?: Map<string, MethodRead>;
  /** Requests an off-chain method made (an EVM chain's are counted by the writer). */
  calls?: number;
}

/** Prices `entries` (the chain's refs needed this hour, their quote refs, and any off-chain entry checked here). */
export type PriceChainMethod = (deps: PriceDeps, entries: PriceEntry[], hour: ChainHour, ctx: ChainHourCtx) => Promise<ChainHourResult>;

function evmChain(chain: string): PriceChainMethod {
  return async (deps, entries, hour, ctx) => {
    if (!hour.blocks) throw new OrionError('invalid_price_config', `${chain}: an EVM chain-hour needs its blocks`);
    return await priceHourEvm(deps.rpcFor(chain), entries, hour.blocks, { cache: ctx.cache, feeds: ctx.feeds });
  };
}

/** The price method per chain: the EVM chains here; Task 4 registers hyperliquid, lighter and solana. */
export const PRICE_CHAIN_METHODS: Record<string, PriceChainMethod> = {
  'eip155:1': evmChain('eip155:1'),
  'eip155:56': evmChain('eip155:56'),
  'eip155:8453': evmChain('eip155:8453'),
};

// ---- hour blocks -----------------------------------------------------------------------------------------------------

/**
 * The first block at or after `targetTs` (unix seconds), searched from a known nearby block (the previous hour's) at
 * `rate` seconds per block (the rate the two previous hours' blocks show). It probes the estimate and the block before
 * it; a miss re-estimates once from the block probed, on that block's own spacing (or, where blocks share a second, on
 * the spacing back to the anchor), which finds the hour on either side of a block-time change (Base's 2 s -> 0.2 s) in
 * 2-4 getBlock calls; otherwise it hands the bracket to firstBlockAtOrAfter (chain halts). `upper` is a known block at
 * or after the target (the next hour's block, else the head).
 */
export async function findHourBlock(rpc: RpcTransport, targetTs: number, anchor: BlockRef, rate: number, upper: BlockRef): Promise<BlockRef> {
  if (upper.timestamp < targetTs) throw new Error(`no block at or after ${new Date(targetTs * 1000).toISOString()} yet`);
  const clamp = (n: bigint): bigint => (n < 1n ? 1n : n > upper.number ? upper.number : n);
  const perBlock = rate > 0 ? rate : (rpc.blockTimeSec ?? 2);
  let guess = clamp(anchor.number + BigInt(Math.round((targetTs - anchor.timestamp) / perBlock)));
  let last: BlockRef = anchor;
  for (let attempt = 0; attempt < 2; attempt++) {
    const b = await rpc.getBlock(guess);
    const prev = await rpc.getBlock(guess - 1n);
    if (prev.timestamp < targetTs && b.timestamp >= targetTs) return b;
    // Spacing at the probe: one block's step when it spans 2 s or more; below that, blocks share integer seconds and
    // the step says nothing, so the spacing back to the anchor (or the last probe) is used.
    let spacing = b.timestamp - prev.timestamp;
    if (spacing < 2) {
      const ref = b.timestamp !== last.timestamp && b.number !== last.number ? last : anchor;
      const dn = Math.abs(Number(b.number - ref.number));
      spacing = dn > 0 ? Math.abs(b.timestamp - ref.timestamp) / dn : 0;
      if (!(spacing > 0)) spacing = perBlock;
    }
    last = b;
    guess = b.timestamp < targetTs
      ? clamp(b.number + BigInt(Math.ceil((targetTs - b.timestamp) / spacing)))
      : clamp(prev.number - BigInt(Math.floor((prev.timestamp - targetTs) / spacing)));
  }
  return await firstBlockAtOrAfter(rpc, targetTs, last.number <= upper.number ? last : anchor, upper, perBlock);
}

/** One chain's hour blocks for a run: hour_blocks first, then a search from the neighbouring hour's block. */
class ChainBlocks {
  private readonly known = new Map<number, BlockRef | null>();
  private head: BlockRef | null = null;
  private readonly fresh = new Map<number, BlockRef>();

  constructor(
    private readonly rpc: RpcTransport,
    private readonly store: HourBlockCache,
  ) {}

  private async lookup(hourMs: number): Promise<BlockRef | null> {
    if (!this.known.has(hourMs)) this.known.set(hourMs, await this.store.get(hourMs));
    return this.known.get(hourMs) ?? null;
  }

  /** The blocks found in this run old enough to cache; taken once (they are written with the chain-day). */
  takeFresh(): [number, BlockRef][] {
    const out = [...this.fresh.entries()];
    this.fresh.clear();
    return out;
  }

  /** B(hourMs), or null when the chain has no block at or after it yet. */
  async at(hourMs: number): Promise<BlockRef | null> {
    const hit = await this.lookup(hourMs);
    if (hit) return hit;
    this.head ??= await this.rpc.latestBlock();
    const head = this.head;
    const t = hourMs / 1000;
    if (head.timestamp < t) return null;
    const rateOf = (a: BlockRef, b: BlockRef | null): number | null =>
      b && a.number !== b.number ? Math.abs(a.timestamp - b.timestamp) / Math.abs(Number(a.number - b.number)) : null;
    const newer = await this.lookup(hourMs + H);
    const older = newer ? null : await this.lookup(hourMs - H);
    const rate = newer ? rateOf(newer, await this.lookup(hourMs + 2 * H)) : older ? rateOf(older, await this.lookup(hourMs - 2 * H)) : null;
    const found = await findHourBlock(this.rpc, t, newer ?? older ?? head, rate ?? this.rpc.blockTimeSec ?? 2, newer ?? head);
    this.known.set(hourMs, found);
    if (head.timestamp - found.timestamp >= HOUR_BLOCK_MIN_AGE_SEC) this.fresh.set(hourMs, found);
    return found;
  }
}

// ---- the writer ------------------------------------------------------------------------------------------------------

export interface WriteOptions {
  signal?: AbortSignal;
  /** Stop after the first chain-day that ends past this many ms of work (the chain-day is committed first). */
  budgetMs?: number;
  /** Milliseconds now, for the budget (default Date.now). */
  clock?: () => number;
}

const isEvm = (chain: string): boolean => chain.startsWith('eip155:');
const chainRank = (chain: string): number => (chain === 'eip155:1' ? 0 : isEvm(chain) ? 1 : 2);
const usdFeedOf = (m: object): string | undefined => {
  const f = (m as { usd_feed?: string }).usd_feed;
  return f === undefined ? undefined : f.toLowerCase();
};
/** The EVM chain an off-chain entry's check is read on (LIT's v4 pool on its Ethereum ref), or null. */
function checkChainOf(e: PriceEntry): string | null {
  if (isEvm(e.chain) || !EVM_METHOD_KINDS.has(e.check.kind) || e.check.kind === 'bound') return null;
  const m = /^eip155:(\d+)\//.exec(e.ref);
  return m ? `eip155:${m[1]}` : null;
}
const dayStartOf = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const isHour = (ms: number): boolean => Number.isInteger(ms) && ms % H === 0;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Writes the chain/first-party price of every ref in `refs` for every hour in [fromHourMs, toHourMs) not stored yet
 * under the ref's primary source (methodSource), from the ref's `valid_from` on. Quote refs are read with the ref but
 * written only when asked for. Each row stores the check's gap, label and the read's detail; a breach is |gap| over the
 * check's tolerance (a `bound`: any gap but 0) for `consecutive` stored hours in a row, reported once per run of
 * breaching hours at the hour that completes it. A transport failure on a chain stops that chain for the run (`errors`).
 */
export async function writeChainPrices(
  db: Db,
  deps: PriceDeps,
  refs: string[],
  fromHourMs: number,
  toHourMs: number,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  if (!isHour(fromHourMs) || !isHour(toHourMs) || fromHourMs > toHourMs) {
    throw new OrionError('invalid_price_range', `the price hours must be whole UTC hours with from <= to, got ${fromHourMs} -> ${toHourMs}`);
  }
  const entryOf = (ref: string): PriceEntry => {
    const e = deps.prices.get(ref);
    if (!e) throw new OrionError('unknown_price_ref', `${ref} is not in prices.yaml`);
    return e;
  };
  const wanted = [...new Set(refs)].map(entryOf);
  const offchain = wanted.filter((e) => !isEvm(e.chain));
  const chainSet = new Set(wanted.map((e) => e.chain as string));
  if (offchain.length > 0) chainSet.add('eip155:1');
  for (const e of offchain) {
    const c = checkChainOf(e);
    if (c) chainSet.add(c);
  }
  const chains = [...chainSet].sort((a, b) => chainRank(a) - chainRank(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const c of chains) {
    if (!PRICE_CHAIN_METHODS[c]) throw new OrionError('no_price_method', `no price method is registered for chain ${c}`);
  }
  // Ruling R5: chain 1 also reads every off-chain entry's USD feed, and hands its answers on.
  const extraFeeds = [...new Set(offchain.flatMap((e) => [usdFeedOf(e.primary), usdFeedOf(e.check)]).filter((f): f is string => f !== undefined))].sort();

  const result: WriteResult = {
    written: Object.fromEntries(wanted.map((e) => [e.ref, 0])),
    skippedExisting: 0,
    missing: [],
    breaches: [],
    calls: Object.fromEntries(chains.filter(isEvm).map((c) => [c, 0])),
    reachedMs: null,
    stoppedByBudget: false,
    errors: [],
  };
  if (fromHourMs === toHourMs) return result;

  // Every EVM request is counted per chain, the methods' as well as the block searches'.
  const rpcs = new Map<string, RpcTransport>();
  const rpcOf = (chain: string): RpcTransport => {
    let rpc = rpcs.get(chain);
    if (!rpc) {
      const inner = deps.rpcFor(chain);
      const bump = () => {
        result.calls[chain] = (result.calls[chain] ?? 0) + 1;
      };
      rpc = {
        ...inner,
        latestBlock: async () => (bump(), await inner.latestBlock()),
        getBlock: async (n) => (bump(), await inner.getBlock(n)),
        multicall: async (calls, block) => (bump(), await inner.multicall(calls, block)),
      };
      rpcs.set(chain, rpc);
    }
    return rpc;
  };
  const methodDeps: PriceDeps = { ...deps, rpcFor: rpcOf };
  const state = new Map<string, { cache: BlockReadCache; blocks: ChainBlocks | null; failed: boolean }>();
  const stateOf = (chain: string) => {
    let s = state.get(chain);
    if (!s) {
      s = { cache: new Map(), blocks: isEvm(chain) ? new ChainBlocks(rpcOf(chain), dbHourBlocks(db, Number(chain.slice(7)))) : null, failed: false };
      state.set(chain, s);
    }
    return s;
  };
  const closureOn = (entries: PriceEntry[]): PriceEntry[] => {
    const out = new Map<string, PriceEntry>();
    const visit = (e: PriceEntry) => {
      if (out.has(e.ref)) return;
      out.set(e.ref, e);
      for (const q of [quoteRefOf(e.primary), quoteRefOf(e.check)]) if (q !== undefined) visit(entryOf(q));
    };
    entries.forEach(visit);
    return [...out.values()];
  };
  const validFromMs = new Map(wanted.map((e) => [e.ref, Date.parse(`${e.validFrom}T00:00:00Z`)]));
  const fetchedAt = deps.now.toISOString();
  const clock = opts.clock ?? Date.now;
  const started = clock();

  const firstDay = dayStartOf(toHourMs - H);
  const lastDay = dayStartOf(fromHourMs);
  days: for (let day = firstDay; day >= lastDay; day -= DAY_MS) {
    const hours: number[] = [];
    for (let h = Math.min(day + DAY_MS, toHourMs) - H; h >= Math.max(day, fromHourMs); h -= H) hours.push(h);
    const oldest = hours[hours.length - 1]!;
    const stored = await storedHours(db, wanted, oldest, hours[0]! + H);
    const wantedAt = new Map<number, PriceEntry[]>();
    for (const h of hours) {
      const inScope = wanted.filter((e) => h >= validFromMs.get(e.ref)!);
      const todo = inScope.filter((e) => !stored.has(`${e.ref}|${h}`));
      result.skippedExisting += inScope.length - todo.length;
      wantedAt.set(h, todo);
    }
    const feedsAt = new Map<number, Map<string, number> | null>();
    const checksAt = new Map<number, Map<string, MethodRead>>();
    let complete = true;

    for (let ci = 0; ci < chains.length; ci++) {
      const chain = chains[ci]!;
      if (opts.signal?.aborted) break days;
      const st = stateOf(chain);
      if (st.failed) {
        complete = false;
        continue;
      }
      const method = PRICE_CHAIN_METHODS[chain]!;
      const rows = new Map<string, PriceRow[]>();
      let worked = false;
      const collect = (todo: PriceEntry[], h: number, r: ChainHourResult) => {
        for (const e of todo) {
          const p = r.prices.get(e.ref);
          if (p) {
            if (!rows.has(e.ref)) rows.set(e.ref, []);
            rows.get(e.ref)!.push({ ts: new Date(h).toISOString(), priceUsd: p.usd, checkGapPct: p.checkGapPct, check: p.check, detail: p.detail });
          } else {
            result.missing.push({ ref: e.ref, hourMs: h, reason: r.missing.find((m) => m.ref === e.ref)?.reason ?? 'not_priced' });
          }
        }
      };
      const fail = (h: number, err: unknown, todo: PriceEntry[]) => {
        result.errors.push({ chain, hourMs: h, error: message(err) });
        st.failed = true;
        complete = false;
        for (const e of todo) result.missing.push({ ref: e.ref, hourMs: h, reason: 'read_failed' });
      };

      for (const h of hours) {
        const all = wantedAt.get(h)!;
        const todo = all.filter((e) => e.chain === chain);
        const offTodo = all.filter((e) => !isEvm(e.chain));
        const checkOnly = offTodo.filter((e) => checkChainOf(e) === chain);
        const serves = chain === 'eip155:1' && offTodo.length > 0;
        if (todo.length === 0 && checkOnly.length === 0 && !serves) continue;
        worked = true;

        if (isEvm(chain)) {
          let r: ChainHourResult;
          try {
            const end = await st.blocks!.at(h + H);
            if (!end) {
              for (const e of todo) result.missing.push({ ref: e.ref, hourMs: h, reason: 'no_block_yet' });
              if (chain === 'eip155:1') feedsAt.set(h, null);
              continue;
            }
            const start = (await st.blocks!.at(h))!;
            const ctx: ChainHourCtx = { feedUsd: chain === 'eip155:1' ? null : (feedsAt.get(h) ?? null), checks: new Map(), feeds: chain === 'eip155:1' ? extraFeeds : [], cache: st.cache };
            r = await method(methodDeps, [...closureOn(todo), ...checkOnly], { hourMs: h, blocks: { start, end } }, ctx);
            // The next (older) hour reads its end at this hour's B(H): keep that block's reads, drop the rest.
            for (const b of [...st.cache.keys()]) if (b !== start.number) st.cache.delete(b);
          } catch (err) {
            if (err instanceof OrionError) throw err;
            if (chain === 'eip155:1') feedsAt.set(h, null);
            fail(h, err, todo);
            break;
          }
          if (chain === 'eip155:1') feedsAt.set(h, r.feedUsd ?? new Map());
          for (const [ref, read] of r.checks ?? []) {
            if (!checksAt.has(h)) checksAt.set(h, new Map());
            checksAt.get(h)!.set(ref, read);
          }
          collect(todo, h, r);
          continue;
        }

        // An off-chain venue: its hour must be closed, and chain 1 must have read the hour's USD feed (Ruling R5).
        if (h + H > deps.now.getTime()) {
          for (const e of todo) result.missing.push({ ref: e.ref, hourMs: h, reason: 'no_block_yet' });
          continue;
        }
        const feeds = feedsAt.get(h) ?? null;
        const ready = todo.filter((e) => {
          const f = usdFeedOf(e.primary);
          const ok = feeds !== null && (f === undefined || feeds.has(f));
          if (!ok) result.missing.push({ ref: e.ref, hourMs: h, reason: 'quote_missing' });
          return ok;
        });
        if (ready.length === 0 || feeds === null) continue;
        let r: ChainHourResult;
        try {
          r = await method(methodDeps, ready, { hourMs: h, blocks: null }, { feedUsd: feeds, checks: checksAt.get(h) ?? new Map(), feeds: [], cache: st.cache });
        } catch (err) {
          if (err instanceof OrionError) throw err;
          fail(h, err, ready);
          break;
        }
        result.calls[chain] = (result.calls[chain] ?? 0) + (r.calls ?? 0);
        collect(ready, h, r);
      }

      // Commit the chain-day: its rows and the hour blocks it found, in one transaction.
      const fresh = st.blocks?.takeFresh() ?? [];
      if (rows.size > 0 || fresh.length > 0) {
        await db.tx(async (t) => {
          for (const [ref, list] of rows) {
            const e = entryOf(ref);
            await upsertToken(t, { tokenRef: ref, symbol: e.symbol, decimals: e.decimals, coingeckoId: null });
            await upsertPrices(t, ref, methodSource(e.primary), list, fetchedAt);
          }
          if (fresh.length > 0) {
            const cache = dbHourBlocks(t, Number(chain.slice(7)));
            for (const [hourMs, b] of fresh) await cache.put(hourMs, b);
          }
        });
      }
      for (const [ref, list] of rows) {
        result.written[ref] = (result.written[ref] ?? 0) + list.length;
        result.breaches.push(...(await breachesOf(db, entryOf(ref), list.map((x) => Date.parse(x.ts)))));
      }
      const more = ci < chains.length - 1 || day - DAY_MS >= lastDay;
      if (worked && opts.budgetMs !== undefined && clock() - started >= opts.budgetMs && more) {
        if (ci === chains.length - 1 && complete) result.reachedMs = oldest;
        result.stoppedByBudget = true;
        break days;
      }
    }
    if (complete && !opts.signal?.aborted) result.reachedMs = oldest;
  }
  result.breaches.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.hourMs - b.hourMs));
  return result;
}

/** `${ref}|${hourMs}` of every wanted ref's hour in [fromMs, toMs) stored under its primary's source. */
async function storedHours(db: Db, entries: PriceEntry[], fromMs: number, toMs: number): Promise<Set<string>> {
  const sourceOf = new Map(entries.map((e) => [e.ref, methodSource(e.primary)]));
  const rows = await db.all<{ token_ref: string; ts: string; source: string }>(
    'SELECT token_ref, ts, source FROM prices WHERE token_ref = ANY($1::text[]) AND ts >= $2 AND ts < $3',
    [[...sourceOf.keys()], new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  return new Set(rows.filter((r) => sourceOf.get(r.token_ref) === r.source).map((r) => `${r.token_ref}|${new Date(r.ts).getTime()}`));
}

/**
 * The breaches the rows just written for `entry` complete: over the stored gaps around them (null gaps skipped), a run of
 * `consecutive` breaching hours in a row (|gap| > tolerance; a `bound` check: gap != 0) that includes a new row, reported
 * at the hour that completes it, once per run.
 */
async function breachesOf(db: Db, entry: PriceEntry, writtenMs: number[]): Promise<WriteResult['breaches']> {
  if (writtenMs.length === 0) return [];
  const span = (BREACH_WINDOW_HOURS + entry.check.consecutive) * H;
  const rows = await db.all<{ ts: string; gap: number; check: string | null }>(
    `SELECT ts, check_gap_pct AS gap, "check" FROM prices
     WHERE token_ref = $1 AND source = $2 AND ts >= $3 AND ts <= $4 AND check_gap_pct IS NOT NULL ORDER BY ts`,
    [entry.ref, methodSource(entry.primary), new Date(Math.min(...writtenMs) - span).toISOString(), new Date(Math.max(...writtenMs) + span).toISOString()],
  );
  const fresh = new Set(writtenMs);
  const breaching = (gap: number) => (entry.check.kind === 'bound' ? gap !== 0 : Math.abs(gap) > entry.check.tolerancePct);
  const out: WriteResult['breaches'] = [];
  let run: number[] = [];
  for (const r of rows) {
    const ts = new Date(r.ts).getTime();
    if (!breaching(r.gap)) {
      run = [];
      continue;
    }
    run.push(ts);
    if (run.length === entry.check.consecutive && run.some((x) => fresh.has(x))) {
      out.push({ ref: entry.ref, hourMs: ts, gapPct: r.gap, check: r.check ?? checkLabel(entry.check) });
    }
  }
  return out;
}

// ---- dependencies from the environment -------------------------------------------------------------------------------

/** The env var naming each EVM price chain's RPC URL (Base falls back to its keyless public endpoint). */
export const PRICE_RPC_ENV: Readonly<Record<number, string>> = { 1: 'ORION_ETH_RPC_URL', 56: 'ORION_BNB_RPC_URL', 8453: 'ORION_BASE_RPC_URL' };

export interface PriceFactories {
  rpcFactory: RpcFactory;
  prices: ReadonlyMap<string, PriceEntry>;
  /** Task 4's Solana reads; absent: any use refuses with no_price_transport. */
  solana?: SolanaPriceTransport;
  /** The first-party venues' HTTP; absent: any use refuses with no_price_transport. */
  http?: HttpTransport;
  now?: Date;
}

/** PriceDeps from the environment's RPC URLs (one transport per chain, made on first use) and the given slots. */
export function makePriceDeps(env: Record<string, string | undefined>, f: PriceFactories): PriceDeps {
  const rpcs = new Map<string, RpcTransport>();
  const unwired = (what: string) => async (): Promise<never> => {
    throw new OrionError('no_price_transport', `no ${what} transport is wired into these price deps`);
  };
  return {
    rpcFor(chain) {
      const hit = rpcs.get(chain);
      if (hit) return hit;
      const id = /^eip155:(\d+)$/.exec(chain) ? Number(chain.slice(7)) : NaN;
      const name = PRICE_RPC_ENV[id];
      if (name === undefined) throw new OrionError('no_rpc_url', `price chain ${chain} has no RPC (only ${Object.keys(PRICE_RPC_ENV).map((c) => `eip155:${c}`).join(', ')})`);
      const url = env[name]?.trim() || CHAINS[id]?.defaultRpcUrl;
      if (!url) throw new OrionError('no_rpc_url', `${name} is not set (environment or <ORION_HOME>/.env): ${chain} has no keyless default`);
      const rpc = f.rpcFactory(url, id);
      rpcs.set(chain, rpc);
      return rpc;
    },
    solana: f.solana ?? { getMultipleAccounts: unwired('Solana'), slotAt: unwired('Solana'), signaturesBefore: unwired('Solana'), getTransaction: unwired('Solana') },
    http: f.http ?? { getJson: unwired('HTTP'), postJson: unwired('HTTP') },
    now: f.now ?? new Date(),
    prices: f.prices,
  };
}
