import { createHash } from 'node:crypto';
import { DEFAULT_API_FLOW_BACKFILL_DAYS } from '../apiFlow.js';
import { ScanConfigSchema, chainLiveOn, driftDedupeKey, type ChainDayScan, type ChainScan, type Drift, type ScanConfig } from '../poolscan/types.js';
import { rpcChainReader, type ChainReader } from '../poolscan/reader.js';
import { checkRootChains, scanChainDay } from '../poolscan/scan.js';
import { priceDay, valueScan, type PriceBook, type ScanValue } from '../poolscan/pricing.js';
import { discoverVrms, programs, streamedDay, type IncentiveClass, type Program, type StreamedDay } from '../poolscan/incentives.js';
import { CHAIN_RPC_ENV } from '../transport/chainRpcEnv.js';
import { addDays, utcDay } from '../time.js';
import type { AdapterWarning, DailyPoint, SourceContext, SourceValue } from '../types.js';
import type { Json } from '../../provenance/types.js';
import { MS_PER_DAY } from '../../types.js';
import type { AdapterDef } from './registry.js';
import { intIn, isoDate } from './dates.js';

/**
 * The pool scan's adapters (Phase 3 R4, spec §4.2, §5 checks, §7 errors): `pool.tape_fees_daily` (gross, allocator or
 * LP pool fees) and `pool.vrm_incentives_daily` (VRM incentive streams by creator class), USD per completed UTC day
 * summed over the configured chains, priced on chain (no token: the report's `onchain_usd` basis).
 *
 * Days per run: the revision days (yesterday, −1, −2) and every day of [today − window, yesterday] the metric's own
 * series lacks (`ctx.storedFlowDays`), never before `since`; the oldest `max_scan_days` of them (default 7, at most 14),
 * so a backfill runs in resumable chunks. window = the run's `--backfill-days`, else the asset's `ingest.backfill_days`
 * capped at the series writer's routine gap window (DEFAULT_API_FLOW_BACKFILL_DAYS): a day the writer would not write
 * is never scanned. The detail records `remaining_missing`.
 *
 * Memo: one per SourceContext (one run), so the five metrics of a run share every chain-day's scan + price book, each
 * chain's VRMs and programs (read once, at the latest scanned day's e−1) and each chain-day's streams; keyed by a hash of
 * `scan` (field/class/max_scan_days/since do not change a chain-day) with the chain and day.
 *
 * Chains with their own `since` (Elysium: its contracts arrived 2026-11-07): a chain-day before it is not scanned at all
 * (no read, so no failed read either), adds 0 and its slice is `{ live: false }`; the per-chain gates and warnings skip
 * it, and the root Voter's `chains()` is compared with the chains live that day.
 *
 * Failures (the run throws, so the reading is `ok: false` and nothing is written): any failed read (the engine throws),
 * a chain-day priced below 95%, a chain-day with fees and nothing priced, allocator above gross by more than 0.5% and
 * $1, any `negative_gross` / `negative_allocator` drift. Warnings (advisory anomalies, deduped per key): engine drift,
 * root-Voter chain drift, 95-99% coverage, dropped anchors and spot-fallback prices are emitted only by
 * `pool.tape_fees_daily` with `field: gross`, incentive `ambiguous` points only by `class: vote_incentives` (run.ts
 * dedupes warnings per request, so each is posted once per run). `pool_scan:incentives_unpriced:<chain>` (incentive
 * tokens the chain-day's price book does not price: skipped, never imputed) comes from `class: vote_incentives` only.
 */

export const MAX_SCAN_DAYS = 14;
export const DEFAULT_MAX_SCAN_DAYS = 7;
/** A chain-day priced below this fails; below WARN_PCT it warns. */
export const FAIL_PCT = 95;
export const WARN_PCT = 99;
/** Allocator may exceed gross on a chain-day by at most this share OR this many dollars (fails past both). */
export const BOUND_SHARE = 0.005;
export const BOUND_USD = 1;

/**
 * The anchor feeds a scan config may name, by their on-chain `description()`: crypto and stablecoin USD feeds only.
 * Tokenized-stock feeds are never anchors (spec §4.3); a new crypto anchor needs a reviewed line here.
 */
export const ANCHOR_DESCRIPTIONS: readonly string[] = ['ETH / USD', 'BTC / USD', 'WBTC / USD', 'CBBTC / USD', 'USDC / USD', 'USDT / USD', 'DAI / USD', 'USDS / USD', 'USDG / USD', 'EURC / USD', 'HYPE / USD'];

const BASE = 8453;
const TAPE_FIELDS = ['gross', 'allocator', 'lp'] as const;
type TapeField = (typeof TAPE_FIELDS)[number];
const CLASSES: readonly IncentiveClass[] = ['vote_incentives', 'protocol_subsidy'];
const TAPE_KEYS = ['scan', 'field', 'max_scan_days', 'since'];
const VRM_KEYS = ['scan', 'class', 'max_scan_days', 'since'];

// ---- params ------------------------------------------------------------------------------------------------------------

/** Problems with a scan block: the zod shape, then chains, factories, anchors and root_voter. */
export function validateScan(raw: unknown): string[] {
  const parsed = ScanConfigSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `scan${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`);
  const scan = parsed.data;
  const out: string[] = [];
  const ids = scan.chains.map((c) => c.chain_id);
  scan.chains.forEach((c, i) => {
    const at = `scan.chains[${i}]`;
    if (CHAIN_RPC_ENV[c.chain_id] === undefined) out.push(`${at}.chain_id: chain ${c.chain_id} is not a known chain (${Object.keys(CHAIN_RPC_ENV).join(', ')})`);
    if (ids.indexOf(c.chain_id) !== i) out.push(`${at}: chain ${c.chain_id} is listed twice`);
    const factories = c.factories.map((f) => f.address.toLowerCase());
    for (const [k, f] of factories.entries()) if (factories.indexOf(f) !== k) out.push(`${at}: factory ${f} is listed twice`);
    const tokens = c.anchors.map((a) => a.token.toLowerCase());
    c.anchors.forEach((a, k) => {
      if (tokens.indexOf(a.token.toLowerCase()) !== k) out.push(`${at}: token ${a.token.toLowerCase()} has two anchors`);
      if (!ANCHOR_DESCRIPTIONS.includes(a.description)) out.push(`${at}.anchors[${k}].description ${JSON.stringify(a.description)} is not an allowed anchor feed (${ANCHOR_DESCRIPTIONS.join(', ')})`);
      if (a.feed_chain_id !== undefined && !ids.includes(a.feed_chain_id)) out.push(`${at}.anchors[${k}].feed_chain_id: chain ${a.feed_chain_id} is not in scan.chains (its reader is the run's)`);
    });
  });
  if (scan.root_voter && !ids.includes(BASE)) out.push(`scan.root_voter: the root Voter is read on Base (${BASE}), which scan.chains does not list`);
  return out;
}

function validateCommon(p: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const k of Object.keys(p)) if (!keys.includes(k)) out.push(`unknown key "${k}" (${keys.join(', ')})`);
  out.push(...validateScan(p.scan));
  if (p.max_scan_days !== undefined && !intIn(p.max_scan_days, 1, MAX_SCAN_DAYS)) out.push(`max_scan_days: an integer 1..${MAX_SCAN_DAYS}, not ${JSON.stringify(p.max_scan_days)}`);
  if (p.since !== undefined && isoDate(p.since) === null) out.push('since: a YYYY-MM-DD day');
  const chains = (p.scan as { chains?: unknown } | undefined)?.chains;
  if (typeof p.since === 'string' && isoDate(p.since) !== null && Array.isArray(chains)) {
    chains.forEach((c: { since?: unknown }, i) => {
      if (typeof c?.since === 'string' && c.since < (p.since as string)) out.push(`scan.chains[${i}].since: ${c.since} is before the params since ${p.since}`);
    });
  }
  return out;
}

export function validateTapeParams(p: Record<string, unknown>): string[] {
  const out = validateCommon(p, TAPE_KEYS);
  if (!TAPE_FIELDS.includes(p.field as TapeField)) out.push('field: gross, allocator or lp');
  return out;
}

export function validateVrmParams(p: Record<string, unknown>): string[] {
  const out = validateCommon(p, VRM_KEYS);
  if (!CLASSES.includes(p.class as IncentiveClass)) out.push('class: vote_incentives or protocol_subsidy');
  return out;
}

const COMMON_DOC =
  '`scan`: the pool-scan block (chains: [{ chain_id, since?, factories: [{ address, kind: v2_stable|v2_volatile|cl, tape, hook? }], factory_registry, leaf_voter, anchors: [{ token, feed, description, feed_chain_id? }], log_range? }], subsidy_creators: [address], root_voter?: { chain_id: 8453, address }); ' +
  'anchor descriptions must be one of ' + ANCHOR_DESCRIPTIONS.join(', ') + '. ' +
  '`max_scan_days` (1..14, default 7): days scanned per run, oldest missing first, plus the 3 revision days. `since` (YYYY-MM-DD): no day before it is scanned (the contracts\' first day); a chain\'s own `since` (not before it) starts that chain later: its earlier days add 0, sliced `{ live: false }`.';

// ---- run memo ----------------------------------------------------------------------------------------------------------

interface ChainDayFees {
  scan: ChainDayScan;
  book: PriceBook;
  value: ScanValue;
  /** Why the chain-day fails, if it does (coverage, bound, negative drift). */
  failures: string[];
}

interface RunMemo {
  readers: Map<number, ChainReader>;
  fees: Map<string, Promise<ChainDayFees>>;
  roots: Map<string, Promise<Drift[]>>;
  programs: Map<string, { day: string; list: Promise<Program[]> }>;
  streams: Map<string, Promise<StreamedDay>>;
}

const MEMOS = new WeakMap<SourceContext, RunMemo>();

function memoOf(ctx: SourceContext): RunMemo {
  let m = MEMOS.get(ctx);
  if (!m) {
    m = { readers: new Map(), fees: new Map(), roots: new Map(), programs: new Map(), streams: new Map() };
    MEMOS.set(ctx, m);
  }
  return m;
}

/** A memoized promise that never raises an unhandled rejection when a sibling metric stops awaiting it. */
function remember<T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = map.get(key);
  if (!p) {
    p = make();
    p.catch(() => undefined);
    map.set(key, p);
  }
  return p;
}

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const scanHash = (scan: ScanConfig): string => createHash('sha256').update(canonical(scan)).digest('hex').slice(0, 16);

function readerFor(ctx: SourceContext, memo: RunMemo, chainId: number): ChainReader {
  let r = memo.readers.get(chainId);
  if (!r) {
    if (!ctx.rpcFor) throw new Error('the pool scan reads every configured chain through ctx.rpcFor, which this run has not set');
    r = rpcChainReader(ctx.rpcFor(chainId), chainId);
    memo.readers.set(chainId, r);
  }
  return r;
}

/** Every configured chain's reader: pricing reads cross-chain feeds (Elysium's on Base) through this map. */
function readersOf(ctx: SourceContext, memo: RunMemo, scan: ScanConfig): Map<number, ChainReader> {
  return new Map(scan.chains.map((c) => [c.chain_id, readerFor(ctx, memo, c.chain_id)]));
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function chainDayFees(ctx: SourceContext, memo: RunMemo, hash: string, scan: ScanConfig, cfg: ChainScan, day: string): Promise<ChainDayFees> {
  return remember(memo.fees, `${hash}|${cfg.chain_id}|${day}`, async () => {
    const readers = readersOf(ctx, memo, scan);
    const s = await scanChainDay(readers.get(cfg.chain_id)!, cfg, day);
    const book = await priceDay(readers, cfg, s);
    const value = valueScan(s, book);
    const where = `chain ${cfg.chain_id} ${day}`;
    const failures: string[] = [];
    for (const d of s.drift) if (d.kind === 'negative_gross' || d.kind === 'negative_allocator') failures.push(`${where}: ${d.kind} on ${d.id} (${JSON.stringify(d.detail)}): an accumulator fell, so logs or reads are missing`);
    if (value.grossUsd === 0 && value.unpriced.length > 0) failures.push(`${where}: no fee priced (${value.unpriced.length} fees unpriced; anchors dropped: ${book.anchorsDropped.length})`);
    else if (value.pricedPct < FAIL_PCT) failures.push(`${where}: priced ${value.pricedPct}% of gross (below ${FAIL_PCT}%; ${usd(value.coverageEstimateUsd)} unpriced)`);
    const excess = value.allocatorUsd - value.grossUsd;
    if (excess > BOUND_SHARE * value.grossUsd && excess > BOUND_USD) failures.push(`${where}: allocator ${usd(value.allocatorUsd)} exceeds gross ${usd(value.grossUsd)} by more than ${BOUND_SHARE * 100}% and ${usd(BOUND_USD)}`);
    return { scan: s, book, value, failures };
  });
}

/** The run's VRM programs of one chain, read at `latestDay`'s e−1 (re-read only for a later day than the memo's). */
function chainPrograms(ctx: SourceContext, memo: RunMemo, hash: string, cfg: ChainScan, latestDay: string, latest: ChainDayFees): Promise<Program[]> {
  const key = `${hash}|${cfg.chain_id}`;
  const hit = memo.programs.get(key);
  if (hit && hit.day >= latestDay) return hit.list;
  const reader = readerFor(ctx, memo, cfg.chain_id);
  const at = latest.scan.blocks.e - 1n;
  const list = (async () => programs(reader, await discoverVrms(reader, cfg, at), at))();
  list.catch(() => undefined);
  memo.programs.set(key, { day: latestDay, list });
  return list;
}

// ---- days --------------------------------------------------------------------------------------------------------------

/** The metric whose source carries these params (identity first, then equal content). */
function metricOf(ctx: SourceContext, name: string, params: Record<string, unknown>): string {
  const metrics = Object.entries(ctx.asset.metrics) as [string, { source?: { type: string; name?: string; params?: unknown } }][];
  const same = metrics.filter(([, d]) => d.source?.type === 'adapter' && d.source.name === name && d.source.params === params);
  if (same.length === 1) return same[0][0];
  const want = canonical(params);
  const equal = metrics.filter(([, d]) => d.source?.type === 'adapter' && d.source.name === name && canonical(d.source.params) === want);
  if (equal.length === 1) return equal[0][0];
  throw new Error(`no single metric of ${ctx.asset.id} reads ${name} with these params (${equal.length} do)`);
}

interface DayPlan {
  days: string[];
  remainingMissing: number;
}

async function planDays(ctx: SourceContext, name: string, params: Record<string, unknown>): Promise<DayPlan> {
  const today = utcDay(Date.parse(ctx.nowIso));
  const yesterday = addDays(today, -1);
  const since = typeof params.since === 'string' ? params.since : null;
  const window = ctx.backfillDays ?? Math.min(ctx.asset.ingest?.backfill_days ?? DEFAULT_API_FLOW_BACKFILL_DAYS, DEFAULT_API_FLOW_BACKFILL_DAYS);
  const from = utcDay(Date.parse(ctx.nowIso) - window * MS_PER_DAY);
  const stored = ctx.storedFlowDays ? await ctx.storedFlowDays(metricOf(ctx, name, params)) : new Set<string>();
  const ok = (d: string) => since === null || d >= since;
  const missing: string[] = [];
  for (let d = from; d <= yesterday; d = addDays(d, 1)) if (ok(d) && !stored.has(d)) missing.push(d);
  const revision = [-2, -1, 0].map((k) => addDays(yesterday, k)).filter(ok);
  const all = [...new Set([...missing, ...revision])].sort();
  if (all.length === 0) throw new Error(`no completed day to scan: since ${since} is after yesterday (${yesterday})`);
  const cap = (params.max_scan_days as number | undefined) ?? DEFAULT_MAX_SCAN_DAYS;
  const days = all.slice(0, cap);
  const chosen = new Set(days);
  return { days, remainingMissing: missing.filter((d) => !chosen.has(d)).length };
}

// ---- warnings ----------------------------------------------------------------------------------------------------------

/**
 * Warnings by key: the first sighting's detail plus `days`, every day it was seen (or that day's figures, when given):
 * run.ts keeps one warning per key per request, so a run's days fold into it.
 */
class Warnings {
  private byKey = new Map<string, { detail: Record<string, unknown>; seen: Set<string>; days: unknown[] }>();
  add(key: string, day: string, detail: Record<string, unknown>, perDay?: Record<string, unknown>): void {
    let w = this.byKey.get(key);
    if (!w) {
      w = { detail, seen: new Set(), days: [] };
      this.byKey.set(key, w);
    }
    if (w.seen.has(day)) return;
    w.seen.add(day);
    w.days.push(perDay ? { day, ...perDay } : day);
  }
  list(): AdapterWarning[] {
    return [...this.byKey].map(([dedupeKey, w]) => ({ dedupeKey, detail: { ...w.detail, days: w.days } }));
  }
}

function driftWarning(w: Warnings, d: Drift, day: string): void {
  w.add(driftDedupeKey(d), day, { kind: d.kind, chain: d.chainId, id: d.id, ...d.detail });
}

function feeWarnings(w: Warnings, cfg: ChainScan, day: string, f: ChainDayFees): void {
  for (const d of f.scan.drift) driftWarning(w, d, day);
  const chain = cfg.chain_id;
  if (f.value.pricedPct < WARN_PCT) {
    w.add(`pool_scan:coverage:${chain}`, day, { chain, warn_below_pct: WARN_PCT, fail_below_pct: FAIL_PCT }, { pricedPct: f.value.pricedPct, unpricedUsd: f.value.coverageEstimateUsd });
  }
  for (const token of f.book.anchorsDropped) {
    const a = cfg.anchors.find((x) => x.token.toLowerCase() === token);
    w.add(`pool_scan:anchor_dropped:${chain}:${token}`, day, { chain, token, feed: a?.feed.toLowerCase() ?? null, description: a?.description ?? null, ...(a?.feed_chain_id !== undefined ? { feed_chain_id: a.feed_chain_id } : {}), max_age_h: 26 });
  }
  // Spot-fallback prices that valued a fee of the day.
  const feeTokens = new Set<string>();
  for (const p of f.scan.pools) {
    if (p.fee0 > 0n) feeTokens.add(p.token0.toLowerCase());
    if (p.fee1 > 0n) feeTokens.add(p.token1.toLowerCase());
  }
  for (const amounts of f.scan.allocatorByPool.values()) for (const [t, v] of amounts) if (v > 0n) feeTokens.add(t.toLowerCase());
  for (const t of feeTokens) {
    if (f.book.how.get(t) !== 'graph_spot_fallback') continue;
    const src = f.book.sources.get(t);
    w.add(`pool_scan:spot_fallback:${chain}:${t}`, day, { chain, token: t, pool: src?.pool ?? null, hop: src?.hop ?? null });
  }
}

// ---- the adapters ------------------------------------------------------------------------------------------------------

interface Prepared {
  scan: ScanConfig;
  hash: string;
  memo: RunMemo;
  plan: DayPlan;
}

async function prepare(ctx: SourceContext, name: string, params: Record<string, unknown>, issues: string[]): Promise<Prepared> {
  if (issues.length > 0) throw new Error(`params: ${issues.join('; ')}`);
  const scan = ScanConfigSchema.parse(params.scan);
  if (!ctx.rpcFor) throw new Error('the pool scan reads every configured chain through ctx.rpcFor, which this run has not set');
  return { scan, hash: scanHash(scan), memo: memoOf(ctx), plan: await planDays(ctx, name, params) };
}

/**
 * Every chain's fees for each day, oldest day first; null for a chain not live that day (before its `since`: never
 * scanned). Throws on the first failing day (all its live chains' reasons).
 */
async function feesByDay(ctx: SourceContext, p: Prepared): Promise<Map<string, Map<number, ChainDayFees | null>>> {
  const out = new Map<string, Map<number, ChainDayFees | null>>();
  for (const day of p.plan.days) {
    const list = await Promise.all(p.scan.chains.map((c) => (chainLiveOn(c, day) ? chainDayFees(ctx, p.memo, p.hash, p.scan, c, day) : Promise.resolve(null))));
    const failures = list.flatMap((f) => f?.failures ?? []);
    if (failures.length > 0) throw new Error(failures.join('; '));
    out.set(day, new Map(p.scan.chains.map((c, i) => [c.chain_id, list[i]])));
  }
  return out;
}

/** The slice of a chain-day that was not scanned (before the chain's `since`). */
const NOT_LIVE: Json = { live: false };

const blocksOf = (s: ChainDayScan) => ({ s: s.blocks.s.toString(), e: s.blocks.e.toString() });
const span = (days: string[]) => (days.length === 1 ? days[0] : `${days[0]}..${days[days.length - 1]}`);

async function tapeFeesDaily(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const p = await prepare(ctx, 'pool.tape_fees_daily', params, validateTapeParams(params));
  const field = params.field as TapeField;
  const fees = await feesByDay(ctx, p);
  const warnings = new Warnings();
  const points: DailyPoint[] = [];
  for (const day of p.plan.days) {
    const byChain = fees.get(day)!;
    let value = 0;
    const chains: Record<string, Json> = {};
    for (const c of p.scan.chains) {
      const f = byChain.get(c.chain_id);
      if (!f) {
        chains[String(c.chain_id)] = NOT_LIVE;
        continue;
      }
      const v = f.value;
      // LP is what the allocator did not take; inside the bound allocator may top gross by cents, never below 0.
      value += field === 'gross' ? v.grossUsd : field === 'allocator' ? v.allocatorUsd : Math.max(0, v.grossUsd - v.allocatorUsd);
      chains[String(c.chain_id)] = {
        ...blocksOf(f.scan), grossUsd: v.grossUsd, allocatorUsd: v.allocatorUsd, unregisteredAllocatorUsd: v.unregisteredAllocatorUsd, pricedPct: v.pricedPct, unpricedUsd: v.coverageEstimateUsd,
      };
      if (field === 'gross') feeWarnings(warnings, c, day, f);
    }
    const base = byChain.get(BASE);
    if (field === 'gross' && p.scan.root_voter && base) {
      // Compared with the chains live that day: a chain before its `since` is not expected in the root Voter yet.
      const live = p.scan.chains.filter((c) => byChain.get(c.chain_id)).map((c) => c.chain_id);
      const drift = await remember(p.memo.roots, `${p.hash}|${day}`, () => checkRootChains(readerFor(ctx, p.memo, BASE), p.scan.root_voter!.address, live, base.scan.blocks.e - 1n));
      for (const d of drift) driftWarning(warnings, d, day);
    }
    points.push({ day, value, slice: { chains } });
  }
  const ws = warnings.list();
  const detail = `pool scan ${field} fees USD (on-chain prices), chains ${p.scan.chains.map((c) => c.chain_id).join('+')}, days ${span(p.plan.days)} (${p.plan.days.length}); remaining_missing: ${p.plan.remainingMissing}`;
  return { kind: 'daily_series', points, detail, ...(ws.length > 0 ? { warnings: ws } : {}) };
}

async function vrmIncentivesDaily(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const p = await prepare(ctx, 'pool.vrm_incentives_daily', params, validateVrmParams(params));
  const cls = params.class as IncentiveClass;
  const fees = await feesByDay(ctx, p);
  const latestDay = p.plan.days[p.plan.days.length - 1];
  const progs = new Map<number, Program[]>();
  for (const c of p.scan.chains) {
    // A chain not live on the latest day is live on none of the run's days: its programs are never read.
    const latest = fees.get(latestDay)!.get(c.chain_id);
    if (latest) progs.set(c.chain_id, await chainPrograms(ctx, p.memo, p.hash, c, latestDay, latest));
  }
  const warnings = new Warnings();
  const points: DailyPoint[] = [];
  for (const day of p.plan.days) {
    let value = 0;
    const chains: Record<string, Json> = {};
    const streams = await Promise.all(
      p.scan.chains.map((c) => {
        const f = fees.get(day)!.get(c.chain_id);
        if (!f) return Promise.resolve(null);
        return remember(p.memo.streams, `${p.hash}|${c.chain_id}|${day}`, () => streamedDay(readerFor(ctx, p.memo, c.chain_id), progs.get(c.chain_id)!, day, f.scan.blocks, p.scan.subsidy_creators));
      }),
    );
    p.scan.chains.forEach((c, i) => {
      const f = fees.get(day)!.get(c.chain_id);
      const st = streams[i];
      if (!f || !st) {
        chains[String(c.chain_id)] = NOT_LIVE;
        return;
      }
      const byClass: Record<string, number> = {};
      let unpricedTokens = 0;
      const unpriced: { token: string; class: IncentiveClass; amount: string }[] = [];
      for (const k of CLASSES) {
        let total = 0;
        for (const [token, amount] of st.byClass[k]) {
          const px = f.book.usd.get(token.toLowerCase());
          const dec = f.book.decimals.get(token.toLowerCase());
          if (px === undefined || dec === undefined) {
            unpricedTokens++;
            unpriced.push({ token: token.toLowerCase(), class: k, amount: amount.toString() });
            continue;
          }
          total += (Number(amount) / 10 ** dec) * px;
        }
        byClass[k] = total;
      }
      value += byClass[cls];
      chains[String(c.chain_id)] = { ...blocksOf(f.scan), vote_incentives: byClass.vote_incentives, protocol_subsidy: byClass.protocol_subsidy, programsActive: st.programsActive, unpricedTokens };
      if (cls === 'vote_incentives') {
        for (const a of st.ambiguous) warnings.add(`pool_scan:incentive_ambiguous:${c.chain_id}:${a.vrm}`, day, { chain: c.chain_id, vrm: a.vrm, t: a.t });
        // Skipped, never imputed (spec §7): the held-to-holders line may read low, so say which tokens and how much (raw).
        if (unpriced.length > 0) warnings.add(`pool_scan:incentives_unpriced:${c.chain_id}`, day, { chain: c.chain_id }, { tokens: unpriced });
      }
    });
    points.push({ day, value, slice: { chains } });
  }
  const ws = warnings.list();
  const detail = `pool scan ${cls} USD (VRM streams, on-chain prices), chains ${p.scan.chains.map((c) => c.chain_id).join('+')}, days ${span(p.plan.days)} (${p.plan.days.length}); remaining_missing: ${p.plan.remainingMissing}`;
  return { kind: 'daily_series', points, detail, ...(ws.length > 0 ? { warnings: ws } : {}) };
}

/**
 * `needsRpc: false`: needsRpc means the asset's own chain read at the run's block (ctx.rpc; tests/provenance/locator.test
 * pins it to the contract-state rung). The pool scan reads every chain at its own day blocks through ctx.rpcFor, so a
 * failure of the asset's chain transport does not block it and its rows carry no run block.
 */
export const poolAdapters: AdapterDef[] = [
  {
    name: 'pool.tape_fees_daily',
    needsRpc: false,
    paramsDoc: `Pool fees per completed UTC day in USD, summed over the scan's chains (pool tapes, gauges, FeesCollected; priced on chain). \`field\`: gross (every fee users paid), allocator (gauged pools' fees, owed to the voters who allocate to them), or lp (gross − allocator). ${COMMON_DOC}`,
    validateParams: validateTapeParams,
    run: tapeFeesDaily,
  },
  {
    name: 'pool.vrm_incentives_daily',
    needsRpc: false,
    paramsDoc: `VRM incentive streams per completed UTC day in USD (allocator-earned seconds only), summed over the scan's chains. \`class\`: vote_incentives (third-party programs) or protocol_subsidy (programs whose creator is in scan.subsidy_creators). ${COMMON_DOC}`,
    validateParams: validateVrmParams,
    run: vrmIncentivesDaily,
  },
];
