import { MS_PER_HOUR } from '../db/prices.js';
import type { HttpTransport } from '../ingest/transport/http.js';
import { toFiniteNumber } from '../ingest/units.js';
import { OrionError } from '../types.js';
import { methodSource, type PriceEntry, type PriceMethod } from './config.js';
import { EVM_METHOD_KINDS, priceHourEvm, withCheck, type MethodRead } from './evmMethods.js';
import type { HourPrice, PriceDeps, SolanaPriceTransport, SolanaTokenBalance, SolanaTransaction } from './types.js';

/**
 * The off-chain price methods of prices.yaml (Phase 3 R2 Task 4): the first-party venues (Hyperliquid's info API for
 * HYPE, Lighter's API for LIT) and Solana (PumpSwap's vaults for PUMP, Meteora DLMM as its check), each in USDC and
 * multiplied by the Ethereum USDC/USD feed of the same hour, which the writer reads on chain 1 and hands on (Ruling R5).
 *
 * Hour semantics (plan P2): the row with ts = H prices [H, H+1h). A venue's hourly candle of H gives its close; Solana
 * gives the pool reserves after the last successful swap before H+1h, found from the block at H+1h backwards through
 * the vault's signatures (measured method, hype-lit-pump.md §3 (a)), refused when that swap is older than 6 h.
 * PUMP is read only through our own Solana RPC, never a pump.fun host (Ruling R8, M8).
 */

const H = MS_PER_HOUR;
/** The start of the hour `deps.now` is in: every hour before it is closed (its candle final, its block produced). */
const openHourMs = (deps: PriceDeps): number => Math.floor(deps.now.getTime() / H) * H;
const isClosed = (deps: PriceDeps, hourMs: number): boolean => hourMs + H <= openHourMs(deps);
export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
/** Lighter's public API. Candles come from /candles (500 a call); the old /candlesticks answers 403 (measured). */
export const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
/** candleSnapshot serves only the newest 5,000 candles of a coin: one request covers them all. */
const HYPERLIQUID_MAX_CANDLES = 5000;
const LIGHTER_MAX_CANDLES = 500;
/** A swap older than this before H+1h prices nothing (the pool is not trading; its reserves are not a price). */
export const MAX_SWAP_AGE_S = 6 * 3600;
/** Signatures per getSignaturesForAddress page, and pages read back before giving up (~86% are failed bot txs). */
const SIGNATURE_PAGE = 100;
const MAX_SIGNATURE_PAGES = 10;
/** Successful transactions fetched before giving up: the primary's vault, the check's pair (scoping: none in 6). */
const MAX_PRIMARY_TX = 8;
const MAX_CHECK_TX = 6;
/**
 * Ruling R37: the Meteora DLMM history check uses only swaps whose USDC leg is at least this many USDC. A smaller (dust)
 * swap's execution price is noise (the Task 10 proof: 0.000002-0.000012 USDC swaps gave gaps up to 284,448%), so it is
 * skipped and the check takes the newest qualifying swap within MAX_CHECK_TX reads, else has no reading. The PumpSwap
 * primary needs no floor: it reads the vaults' reserves after the swap, which are the pool's price at any swap size.
 */
export const MIN_CHECK_SWAP_USDC = 10;

// ---- shared ----------------------------------------------------------------------------------------------------------

const lc = (s: string) => s.toLowerCase();
const usdFeedOf = (m: object): string | undefined => (m as { usd_feed?: string }).usd_feed;
const methodOf = (check: PriceEntry['check']): PriceMethod => {
  const { tolerancePct: _t, consecutive: _c, label: _l, ...m } = check;
  return m as PriceMethod;
};

/** The USDC/USD value for a method's feed: one number for every feed, or the writer's per-feed map (lowercased keys). */
export type UsdcUsd = number | null | ReadonlyMap<string, number>;
function usdcFor(usdc: UsdcUsd, m: object): number | null {
  if (usdc === null || typeof usdc === 'number') return usdc;
  const f = usdFeedOf(m);
  return f === undefined ? null : (usdc.get(lc(f)) ?? null);
}

/** An HttpTransport that counts its requests, for `calls`. */
function counting(http: HttpTransport): { http: HttpTransport; count: () => number } {
  let n = 0;
  return {
    http: {
      getJson: async (url, headers) => (n++, await http.getJson(url, headers)),
      postJson: async (url, body, headers) => (n++, await http.postJson(url, body, headers)),
    },
    count: () => n,
  };
}

/** Requests a Solana transport made: its own count when it keeps one (a slot search is several), else one per call. */
function countingSolana(sol: SolanaPriceTransport): { sol: SolanaPriceTransport; count: () => number } {
  const before = sol.stats?.requests ?? 0;
  let n = 0;
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => (n++, await f(...a));
  return {
    sol: {
      getMultipleAccounts: wrap((k: string[]) => sol.getMultipleAccounts(k)),
      slotAt: wrap((t: number) => sol.slotAt(t)),
      blockSignature: wrap((s: number) => sol.blockSignature(s)),
      signaturesBefore: wrap((a: string, b: string | null, l: number) => sol.signaturesBefore(a, b, l)),
      getTransaction: wrap((s: string) => sol.getTransaction(s)),
    },
    count: () => (sol.stats ? sol.stats.requests - before : n),
  };
}

// ---- candles (Hyperliquid, Lighter) ----------------------------------------------------------------------------------

/** One coin's hourly closes by candle start (ms): the number, and the value as the venue wrote it. */
type Closes = Map<number, { close: number; raw: string | number }>;

/** Hyperliquid candleSnapshot of `coin`, hourly, for the candles starting in [fromMs, toMs): one request per 5,000 hours. */
async function hyperliquidCloses(http: HttpTransport, coin: string, fromMs: number, toMs: number): Promise<Closes> {
  const out: Closes = new Map();
  for (let start = fromMs; start < toMs; start += HYPERLIQUID_MAX_CANDLES * H) {
    const end = Math.min(toMs, start + HYPERLIQUID_MAX_CANDLES * H);
    const reply = await http.postJson(HYPERLIQUID_INFO_URL, { type: 'candleSnapshot', req: { coin, interval: '1h', startTime: start, endTime: end - 1 } });
    if (!Array.isArray(reply)) throw new Error(`hyperliquid candleSnapshot ${coin}: the reply is not a candle list`);
    for (const row of reply as Record<string, unknown>[]) {
      const t = toFiniteNumber(row.t);
      const close = toFiniteNumber(row.c);
      if (t === null || close === null || !(close > 0) || t % H !== 0 || t < start || t >= end) continue;
      out.set(t, { close, raw: typeof row.c === 'string' || typeof row.c === 'number' ? row.c : close });
    }
  }
  return out;
}

/**
 * Lighter /api/v1/candles of `market`, hourly, for the candles starting in [fromMs, toMs): one call per 500 hours. Rows
 * are read as `c[]` of {t, c} (the endpoint's compact shape) or `candlesticks[]` of {timestamp, close}; a timestamp
 * in seconds is taken as seconds.
 */
async function lighterCloses(http: HttpTransport, market: number, fromMs: number, toMs: number): Promise<Closes> {
  const out: Closes = new Map();
  for (let start = fromMs; start < toMs; start += LIGHTER_MAX_CANDLES * H) {
    const end = Math.min(toMs, start + LIGHTER_MAX_CANDLES * H);
    const url = `${LIGHTER_API}/candles?market_id=${market}&resolution=1h&start_timestamp=${start}&end_timestamp=${end}&count_back=${(end - start) / H}`;
    const reply = (await http.getJson(url)) as { c?: unknown; candlesticks?: unknown } | null;
    const rows = Array.isArray(reply?.c) ? reply.c : Array.isArray(reply?.candlesticks) ? reply.candlesticks : null;
    if (!rows) throw new Error(`lighter candles ${market}: the reply has no candle list`);
    for (const row of rows as Record<string, unknown>[]) {
      let t = toFiniteNumber(row.t ?? row.timestamp);
      const rawClose = row.c ?? row.close;
      const close = toFiniteNumber(rawClose);
      if (t === null || close === null || !(close > 0)) continue;
      if (t < 1e12) t *= 1000;
      if (t % H !== 0 || t < start || t >= end) continue;
      out.set(t, { close, raw: typeof rawClose === 'string' || typeof rawClose === 'number' ? rawClose : close });
    }
  }
  return out;
}

type CandleMethod = Extract<PriceMethod, { kind: 'hyperliquid_candle' | 'lighter_candle' }>;
const isCandle = (m: PriceMethod): m is CandleMethod => m.kind === 'hyperliquid_candle' || m.kind === 'lighter_candle';
const candleKey = (m: CandleMethod) => (m.kind === 'hyperliquid_candle' ? `hyperliquid:${m.coin}` : `lighter:${m.market_id}`);
const candleMax = (m: CandleMethod) => (m.kind === 'hyperliquid_candle' ? HYPERLIQUID_MAX_CANDLES : LIGHTER_MAX_CANDLES);
const fetchCloses = (http: HttpTransport, m: CandleMethod, fromMs: number, toMs: number): Promise<Closes> =>
  m.kind === 'hyperliquid_candle' ? hyperliquidCloses(http, m.coin, fromMs, toMs) : lighterCloses(http, m.market_id, fromMs, toMs);
/** Which candle was read, and its close as the venue wrote it (none: no candle that hour). */
const candleDetail = (m: CandleMethod, raw?: string | number): Record<string, unknown> => ({
  ...(m.kind === 'hyperliquid_candle' ? { coin: m.coin } : { market_id: m.market_id }),
  ...(raw === undefined ? {} : { close: raw }),
});

/**
 * Closes fetched in one set of deps (the writer makes one per run), so the writer, which asks hour by hour, fetches each
 * coin's range once: an hour not yet covered fetches back from it as far as one request reaches (5,000 hours on
 * Hyperliquid, 500 on Lighter), never before the ref's valid_from.
 */
const CLOSE_CACHE = new WeakMap<object, Map<string, { covered: Set<number>; closes: Closes }>>();
async function closeAt(deps: PriceDeps, http: HttpTransport, m: CandleMethod, hourMs: number, validFromMs: number): Promise<{ close: number; raw: string | number } | null> {
  // The candle of an hour that has not ended is still moving: never fetched, never cached, never priced.
  if (!isClosed(deps, hourMs)) return null;
  let perDeps = CLOSE_CACHE.get(deps);
  if (!perDeps) CLOSE_CACHE.set(deps, (perDeps = new Map()));
  const key = candleKey(m);
  let series = perDeps.get(key);
  if (!series) perDeps.set(key, (series = { covered: new Set(), closes: new Map() }));
  if (!series.covered.has(hourMs)) {
    const from = Math.min(hourMs, Math.max(validFromMs, hourMs - (candleMax(m) - 1) * H));
    const got = await fetchCloses(http, m, from, hourMs + H);
    for (let t = from; t <= hourMs; t += H) series.covered.add(t);
    for (const [t, c] of got) series.closes.set(t, c);
  }
  return series.closes.get(hourMs) ?? null;
}

// ---- Solana (PumpSwap, Meteora DLMM) ---------------------------------------------------------------------------------

/** Every account key of a transaction in accountIndex order: the static keys, then the lookup tables' writable, readonly. */
function accountKeys(tx: SolanaTransaction): string[] {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const loaded = tx.meta?.loadedAddresses;
  return loaded ? [...keys, ...loaded.writable, ...loaded.readonly] : keys;
}
const rawOf = (b: SolanaTokenBalance | undefined): bigint | null => (b && /^\d+$/.test(b.uiTokenAmount.amount) ? BigInt(b.uiTokenAmount.amount) : null);
/** raw / 10^decimals as a float, exact in its integer part. */
const ui = (raw: bigint, decimals: number): number => {
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
};

/** The PumpSwap vaults' balances after a transaction (its postTokenBalances): quote per base, or null if it did not hold both. */
function vaultReserves(tx: SolanaTransaction, m: Extract<PriceMethod, { kind: 'solana_vaults' }>, baseMint: string) {
  const keys = accountKeys(tx);
  const post = tx.meta?.postTokenBalances ?? [];
  const find = (vault: string) => post.find((b) => keys[b.accountIndex] === vault);
  const base = find(m.base_vault);
  const quote = find(m.quote_vault);
  const baseRaw = rawOf(base);
  const quoteRaw = rawOf(quote);
  if (!base || !quote || baseRaw === null || quoteRaw === null || !(baseRaw > 0n && quoteRaw > 0n)) return null;
  if (base.mint !== baseMint || quote.mint !== USDC_MINT) throw new Error(`PumpSwap vaults ${m.base_vault}/${m.quote_vault} hold ${base.mint}/${quote.mint}, not ${baseMint}/USDC`);
  const inUsdc = ui(quoteRaw, quote.uiTokenAmount.decimals) / ui(baseRaw, base.uiTokenAmount.decimals);
  return { inUsdc, detail: { base_raw: baseRaw.toString(), quote_raw: quoteRaw.toString(), base_decimals: base.uiTokenAmount.decimals, quote_decimals: quote.uiTokenAmount.decimals } };
}

/** A Meteora DLMM pair's two reserve token accounts, by mint: the LbPair's own reserve_x / reserve_y fields. */
interface DlmmReserves { token: string; usdc: string }

/**
 * Decodes the LbPair account: token_x_mint @88, token_y_mint @120, reserve_x @152, reserve_y @184 (measured). The pair
 * also owns other token accounts (airdrop spam, a second USDC account among them), so only these two are its reserves.
 */
function dlmmReservesOf(a: unknown, pair: string, mint: string): DlmmReserves {
  const data = (a as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || typeof data[0] !== 'string' || data[1] !== 'base64') throw new Error(`solana account ${pair}: no base64 data`);
  const buf = Buffer.from(data[0], 'base64');
  if (buf.length < 216) throw new Error(`solana account ${pair}: ${buf.length} bytes is too short for an lb_pair`);
  const x = base58Encode(buf.subarray(88, 120));
  const y = base58Encode(buf.subarray(120, 152));
  const rx = base58Encode(buf.subarray(152, 184));
  const ry = base58Encode(buf.subarray(184, 216));
  if (x === mint && y === USDC_MINT) return { token: rx, usdc: ry };
  if (x === USDC_MINT && y === mint) return { token: ry, usdc: rx };
  throw new Error(`Meteora pair ${pair} is ${x}/${y}, not ${mint}/USDC`);
}

/** LbPair reserves read in one set of deps (the writer makes one per run): one getMultipleAccounts per pair per run. */
const DLMM_RESERVES = new WeakMap<object, Map<string, DlmmReserves>>();
async function dlmmReserves(deps: PriceDeps, sol: SolanaPriceTransport, pair: string, mint: string): Promise<DlmmReserves> {
  let perDeps = DLMM_RESERVES.get(deps);
  if (!perDeps) DLMM_RESERVES.set(deps, (perDeps = new Map()));
  const hit = perDeps.get(`${pair}|${mint}`);
  if (hit) return hit;
  const [account] = await sol.getMultipleAccounts([pair]);
  const r = dlmmReservesOf(account, pair, mint);
  perDeps.set(`${pair}|${mint}`, r);
  return r;
}

/**
 * A Meteora DLMM swap's execution price from the deltas of the pair's two reserve accounts (matched by account key,
 * as the PumpSwap vaults are): USDC per token, fee included. Null for a transaction that is not a swap of the two (a
 * liquidity change moves both one way).
 */
function dlmmExecution(tx: SolanaTransaction, reserves: DlmmReserves, mint: string) {
  const keys = accountKeys(tx);
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const side = (account: string, want: string) => {
    const after = post.find((b) => keys[b.accountIndex] === account);
    if (!after) return null;
    if (after.mint !== want) throw new Error(`Meteora reserve ${account} holds ${after.mint}, not ${want}`);
    const before = pre.find((b) => b.accountIndex === after.accountIndex);
    const a = rawOf(after);
    const b = before ? rawOf(before) : 0n;
    return a === null || b === null ? null : { delta: a - b, decimals: after.uiTokenAmount.decimals };
  };
  const x = side(reserves.token, mint);
  const y = side(reserves.usdc, USDC_MINT);
  if (!x || !y || x.delta === 0n || y.delta === 0n || x.delta > 0n === y.delta > 0n) return null;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const usdcLeg = ui(abs(y.delta), y.decimals);
  if (usdcLeg < MIN_CHECK_SWAP_USDC) return { dust: true as const };
  const inUsdc = usdcLeg / ui(abs(x.delta), x.decimals);
  return { inUsdc, detail: { reserve_x: reserves.token, reserve_y: reserves.usdc, d_token_raw: x.delta.toString(), d_usdc_raw: y.delta.toString() } };
}

type Found<T> = { ok: true; value: T; signature: string; blockTime: number; ageS: number } | { ok: false; reason: string; detail: Record<string, unknown> };

/**
 * The newest successful transaction of `address` before the seek signature (the first of the block at H+1h) that
 * `extract` accepts, paging back with `before`; refused (`stale_swap`) once the signatures reach 6 h before H+1h, and
 * `no_swap` when the history ends first, `read_budget_spent` when the read budget (pages, transactions) does. Failed signatures are skipped unread.
 */
async function lastTx<T>(sol: SolanaPriceTransport, address: string, seek: string, endTs: number, maxTx: number, extract: (tx: SolanaTransaction) => T | null): Promise<Found<T>> {
  let before = seek;
  let reads = 0;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const sigs = await sol.signaturesBefore(address, before, SIGNATURE_PAGE);
    for (const s of sigs) {
      const age = s.blockTime === null ? null : endTs - s.blockTime;
      if (age !== null && age > MAX_SWAP_AGE_S) {
        return { ok: false, reason: 'stale_swap', detail: s.err === null ? { signature: s.signature, last_swap_age_s: age } : { scanned_back_s: age } };
      }
      if (s.err !== null) continue;
      if (reads >= maxTx) return { ok: false, reason: 'read_budget_spent', detail: { transactions_read: reads } };
      reads += 1;
      const tx = await sol.getTransaction(s.signature);
      if (!tx || (tx.meta?.err ?? null) !== null) continue;
      const v = extract(tx);
      if (v === null) continue;
      const blockTime = tx.blockTime ?? s.blockTime;
      if (blockTime === null) throw new Error(`solana transaction ${s.signature} has no block time`);
      if (endTs - blockTime > MAX_SWAP_AGE_S) return { ok: false, reason: 'stale_swap', detail: { signature: s.signature, last_swap_age_s: endTs - blockTime } };
      return { ok: true, value: v, signature: s.signature, blockTime, ageS: endTs - blockTime };
    }
    if (sigs.length < SIGNATURE_PAGE) return { ok: false, reason: 'no_swap', detail: { transactions_read: reads } };
    before = sigs[sigs.length - 1]!.signature;
  }
  return { ok: false, reason: 'read_budget_spent', detail: { transactions_read: reads, signature_pages: MAX_SIGNATURE_PAGES } };
}

const solanaMint = (e: PriceEntry): string => {
  const m = /^solana:mainnet\/(.+)$/.exec(e.ref);
  if (!m) throw new OrionError('invalid_price_config', `${e.ref}: a Solana price method needs a solana:mainnet token ref`);
  return m[1]!;
};

type HourOutcome = { price: HourPrice } | { reason: string; detail?: Record<string, unknown> };

async function solanaHour(deps: PriceDeps, sol: SolanaPriceTransport, e: PriceEntry, hourMs: number, usdc: number, checkUsdc: number | null): Promise<HourOutcome> {
  const m = e.primary;
  if (m.kind !== 'solana_vaults') throw new OrionError('invalid_price_config', `${e.ref}: ${m.kind} is not a Solana primary`);
  const mint = solanaMint(e);
  const endTs = hourMs / 1000 + 3600;
  const slot = await sol.slotAt(endTs);
  if (slot === null) return { reason: 'no_block_yet' };
  const seek = await sol.blockSignature(slot);
  if (seek === null) throw new Error(`solana block ${slot} has no transaction to seek from`);
  // Every swap of the pool writes its quote vault, so the vault's signatures are the pool's swaps (and its failures).
  const found = await lastTx(sol, m.quote_vault, seek, endTs, MAX_PRIMARY_TX, (tx) => vaultReserves(tx, m, mint));
  if (!found.ok) return { reason: found.reason, detail: { slot, seek_signature: seek, ...found.detail } };
  const primary = {
    usd: found.value.inUsdc * usdc,
    source: methodSource(m),
    detail: { slot, seek_signature: seek, signature: found.signature, block_time: found.blockTime, last_swap_age_s: found.ageS, ...found.value.detail, in_usdc: found.value.inUsdc, usdc_usd: usdc },
  };
  const check = methodOf(e.check);
  let read: MethodRead | null = null;
  if (check.kind === 'meteora_dlmm') {
    if (checkUsdc === null) read = { usd: null, reason: 'quote_missing', detail: { method: check.kind } };
    else {
      // A check that cannot be read (an RPC error, an LbPair that is not PUMP/USDC) leaves the check unread: the primary
      // still prices and the chain goes on (a check is never the reason an hour has no price).
      try {
        const reserves = await dlmmReserves(deps, sol, check.pair, mint);
        // R37: a dust swap is skipped (counted, never used); none at or above the floor in reach is no reading.
        let dust = 0;
        const c = await lastTx(sol, check.pair, seek, endTs, MAX_CHECK_TX, (tx) => {
          const e = dlmmExecution(tx, reserves, mint);
          if (e !== null && 'dust' in e) {
            dust += 1;
            return null;
          }
          return e;
        });
        const dustNote = dust > 0 ? { dust_swaps_skipped: dust, min_swap_usdc: MIN_CHECK_SWAP_USDC } : {};
        read = c.ok
          ? { usd: c.value.inUsdc * checkUsdc, detail: { method: check.kind, signature: c.signature, block_time: c.blockTime, last_swap_age_s: c.ageS, ...c.value.detail, in_usdc: c.value.inUsdc, usdc_usd: checkUsdc, ...dustNote } }
          : dust > 0
            ? { usd: null, reason: 'no_qualifying_swap', detail: { method: check.kind, scan_end: c.reason, ...c.detail, ...dustNote } }
            : { usd: null, reason: c.reason, detail: { method: check.kind, ...c.detail } };
      } catch (err) {
        if (err instanceof OrionError) throw err;
        read = { usd: null, reason: 'check_error', detail: { method: check.kind, error: err instanceof Error ? err.message : String(err) } };
      }
    }
  }
  return { price: withCheck(e, primary, read) };
}

// ---- one hour, a range, the live level -------------------------------------------------------------------------------

export interface OffchainHourResult {
  prices: Map<string, HourPrice>;
  missing: { ref: string; reason: string; detail?: Record<string, unknown> }[];
  /** Requests made (HTTP, and Solana JSON-RPC). */
  calls: number;
}

/**
 * Prices the off-chain `entries` for the hour bucket [hourMs, hourMs + 1h). `usdcUsd` is the Ethereum USDC/USD answer of
 * the hour (the writer's chain-1 feed map, Ruling R5); a method whose feed has no value gives `quote_missing` and reads
 * nothing. `checks` are the EVM check reads the writer made on chain 1 for these refs (LIT's v4 pool).
 */
export async function priceHourOffchain(
  deps: PriceDeps,
  entries: PriceEntry[],
  hourMs: number,
  usdcUsd: UsdcUsd,
  checks: ReadonlyMap<string, MethodRead> = new Map(),
): Promise<OffchainHourResult> {
  const { http, count: httpCount } = counting(deps.http);
  let solana: ReturnType<typeof countingSolana> | null = null;
  const out: OffchainHourResult = { prices: new Map(), missing: [], calls: 0 };
  for (const e of entries) {
    const usdc = usdcFor(usdcUsd, e.primary);
    if (usdc === null) {
      out.missing.push({ ref: e.ref, reason: 'quote_missing' });
      continue;
    }
    const check = methodOf(e.check);
    const checkUsdc = usdcFor(usdcUsd, check);
    let outcome: HourOutcome;
    if (isCandle(e.primary) && !isClosed(deps, hourMs)) {
      outcome = { reason: 'no_block_yet' };
    } else if (isCandle(e.primary)) {
      const validFromMs = Date.parse(`${e.validFrom}T00:00:00Z`);
      const c = await closeAt(deps, http, e.primary, hourMs, validFromMs);
      if (!c) outcome = { reason: 'no_candle', detail: candleDetail(e.primary) };
      else {
        const primary = { usd: c.close * usdc, source: methodSource(e.primary), detail: { ...candleDetail(e.primary, c.raw), usdc_usd: usdc } };
        let read: MethodRead | null;
        if (isCandle(check)) {
          const cc = checkUsdc === null ? null : await closeAt(deps, http, check, hourMs, validFromMs);
          read = checkUsdc === null
            ? { usd: null, reason: 'quote_missing', detail: { method: check.kind } }
            : cc
              ? { usd: cc.close * checkUsdc, detail: { ...candleDetail(check, cc.raw), usdc_usd: checkUsdc } }
              : { usd: null, reason: 'no_candle', detail: candleDetail(check) };
        } else {
          read = EVM_METHOD_KINDS.has(check.kind) ? (checks.get(e.ref) ?? null) : null;
        }
        outcome = { price: withCheck(e, primary, read) };
      }
    } else if (e.primary.kind === 'solana_vaults') {
      solana ??= countingSolana(deps.solana);
      outcome = await solanaHour(deps, solana.sol, e, hourMs, usdc, checkUsdc);
    } else {
      throw new OrionError('invalid_price_config', `${e.ref}: ${e.primary.kind} is not an off-chain price method`);
    }
    if ('price' in outcome) out.prices.set(e.ref, outcome.price);
    else out.missing.push({ ref: e.ref, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  }
  out.calls = httpCount() + (solana?.count() ?? 0);
  return out;
}

export interface OffchainRangeResult {
  prices: Map<number, HourPrice>;
  missing: { hourMs: number; reason: string }[];
  calls: number;
}

/**
 * A candle venue's whole range [fromHourMs, toHourMs) in a few requests: Hyperliquid one candleSnapshot per coin per
 * 5,000 hours (spot, and the perp check), Lighter one /candles call per 500 hours (183 days: 9). `usdAt(feed, hourMs)`
 * gives each hour's USDC/USD; `checkAt(hourMs)` the hour's EVM check read (LIT's v4 pool), if any.
 */
export async function priceRangeOffchain(
  deps: PriceDeps,
  entry: PriceEntry,
  fromHourMs: number,
  toHourMs: number,
  usdAt: (feed: string, hourMs: number) => number | null,
  checkAt?: (hourMs: number) => MethodRead | null,
): Promise<OffchainRangeResult> {
  const m = entry.primary;
  if (!isCandle(m)) throw new OrionError('invalid_price_config', `${entry.ref}: ${m.kind} has no range read (only the candle venues do)`);
  if (fromHourMs % H !== 0 || toHourMs % H !== 0 || fromHourMs > toHourMs) {
    throw new OrionError('invalid_price_range', `the price hours must be whole UTC hours with from <= to, got ${fromHourMs} -> ${toHourMs}`);
  }
  const { http, count } = counting(deps.http);
  const check = methodOf(entry.check);
  const out: OffchainRangeResult = { prices: new Map(), missing: [], calls: 0 };
  // Only closed candles: the hours from the one deps.now is in onwards are not read (their close still moves).
  const closedTo = Math.max(fromHourMs, Math.min(toHourMs, openHourMs(deps)));
  const closes = closedTo > fromHourMs ? await fetchCloses(http, m, fromHourMs, closedTo) : new Map() as Closes;
  const checkCloses = !isCandle(check) ? null : closedTo > fromHourMs ? await fetchCloses(http, check, fromHourMs, closedTo) : (new Map() as Closes);
  for (let h = fromHourMs; h < toHourMs; h += H) {
    if (h >= closedTo) {
      out.missing.push({ hourMs: h, reason: 'no_block_yet' });
      continue;
    }
    const usdc = usdAt(lc(m.usd_feed), h);
    if (usdc === null) {
      out.missing.push({ hourMs: h, reason: 'quote_missing' });
      continue;
    }
    const c = closes.get(h);
    if (!c) {
      out.missing.push({ hourMs: h, reason: 'no_candle' });
      continue;
    }
    let read: MethodRead | null = null;
    if (checkCloses && isCandle(check)) {
      const cu = usdAt(lc(check.usd_feed), h);
      const cc = checkCloses.get(h);
      read = cu === null ? { usd: null, reason: 'quote_missing', detail: { method: check.kind } } : cc ? { usd: cc.close * cu, detail: { ...candleDetail(check, cc.raw), usdc_usd: cu } } : { usd: null, reason: 'no_candle', detail: candleDetail(check) };
    } else if (checkAt) {
      read = checkAt(h);
    }
    out.prices.set(h, withCheck(entry, { usd: c.close * usdc, source: methodSource(m), detail: { ...candleDetail(m, c.raw), usdc_usd: usdc } }, read));
  }
  out.calls = count();
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 of raw bytes (a Solana public key). */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = `1${s}`;
  return s;
}

function tokenAccountAmount(a: unknown, key: string, mint: string): { raw: bigint; decimals: number } {
  const info = (a as { data?: { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } } } } | null)?.data?.parsed?.info;
  const amount = info?.tokenAmount?.amount;
  const decimals = info?.tokenAmount?.decimals;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount) || typeof decimals !== 'number') throw new Error(`solana account ${key}: not a parsed token account`);
  if (info?.mint !== mint) throw new Error(`solana account ${key} holds ${String(info?.mint)}, not ${mint}`);
  return { raw: BigInt(amount), decimals };
}

/**
 * The Meteora DLMM lb_pair's active-bin price, (1 + bin_step / 1e4) ^ active_id in raw units of token Y per token X
 * (active_id i32 at byte 76, bin_step u16 at 80, token_x_mint at 88, token_y_mint at 120), in USDC per `mint`.
 */
function dlmmActiveBin(a: unknown, pair: string, mint: string, decimals: number): { inUsdc: number; detail: Record<string, unknown> } {
  const data = (a as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || typeof data[0] !== 'string' || data[1] !== 'base64') throw new Error(`solana account ${pair}: no base64 data`);
  const buf = Buffer.from(data[0], 'base64');
  if (buf.length < 152) throw new Error(`solana account ${pair}: ${buf.length} bytes is too short for an lb_pair`);
  const activeId = buf.readInt32LE(76);
  const binStep = buf.readUInt16LE(80);
  const x = base58Encode(buf.subarray(88, 120));
  const y = base58Encode(buf.subarray(120, 152));
  const yPerX = (1 + binStep / 1e4) ** activeId;
  let inUsdc: number;
  if (x === mint && y === USDC_MINT) inUsdc = yPerX * 10 ** (decimals - USDC_DECIMALS);
  else if (x === USDC_MINT && y === mint) inUsdc = 1 / (yPerX * 10 ** (USDC_DECIMALS - decimals));
  else throw new Error(`Meteora pair ${pair} is ${x}/${y}, not ${mint}/USDC`);
  return { inUsdc, detail: { method: 'meteora_dlmm', active_id: activeId, bin_step: binStep, in_usdc: inUsdc } };
}

/**
 * The live level of an off-chain ref now (Task 6's levels): Hyperliquid `allMids[coin]` (check: the perp's mid), the
 * Lighter order-book mid (check: the v4 pool at the Ethereum head), or the PumpSwap vault reserves (check: the Meteora
 * active bin), each x the Ethereum USDC/USD feed read at the head (one multicall with LIT's v4 check).
 */
export async function livePriceOffchain(deps: PriceDeps, entry: PriceEntry): Promise<HourPrice> {
  const m = entry.primary;
  const check = methodOf(entry.check);
  const rpc = deps.rpcFor('eip155:1');
  const head = await rpc.latestBlock();
  const evmCheck = EVM_METHOD_KINDS.has(check.kind) && check.kind !== 'bound';
  const feeds = [usdFeedOf(m), usdFeedOf(check)].filter((f): f is string => f !== undefined);
  const evm = await priceHourEvm(rpc, evmCheck ? [entry] : [], { start: head, end: head }, { feeds });
  const usdc = usdcFor(evm.feedUsd, m);
  if (usdc === null) throw new Error(`${entry.ref}: the USDC/USD feed ${usdFeedOf(m) ?? '?'} has no answer at Ethereum block ${head.number}`);
  const checkUsdc = usdcFor(evm.feedUsd, check);
  const at = { block: String(head.number), block_ts: head.timestamp };
  let primary: { usd: number; source: string; detail: Record<string, unknown> };
  let read: MethodRead | null = evmCheck ? (evm.checks.get(entry.ref) ?? null) : null;

  if (m.kind === 'hyperliquid_candle') {
    const mids = (await deps.http.postJson(HYPERLIQUID_INFO_URL, { type: 'allMids' })) as Record<string, unknown> | null;
    const mid = toFiniteNumber(mids?.[m.coin]);
    if (mid === null || !(mid > 0)) throw new Error(`hyperliquid allMids has no mid for ${m.coin}`);
    primary = { usd: mid * usdc, source: methodSource(m), detail: { level: 'allMids', coin: m.coin, mid: String(mids![m.coin]), usdc_usd: usdc, ...at } };
    if (check.kind === 'hyperliquid_candle') {
      const cm = toFiniteNumber(mids?.[check.coin]);
      read = cm === null || checkUsdc === null ? { usd: null, reason: cm === null ? 'no_mid' : 'quote_missing', detail: { coin: check.coin } } : { usd: cm * checkUsdc, detail: { coin: check.coin, mid: String(mids![check.coin]), usdc_usd: checkUsdc } };
    }
  } else if (m.kind === 'lighter_candle') {
    const book = (await deps.http.getJson(`${LIGHTER_API}/orderBookOrders?market_id=${m.market_id}&limit=1`)) as { bids?: { price?: unknown }[]; asks?: { price?: unknown }[] } | null;
    const bidRaw = book?.bids?.[0]?.price;
    const askRaw = book?.asks?.[0]?.price;
    const bid = toFiniteNumber(bidRaw);
    const ask = toFiniteNumber(askRaw);
    if (bid === null || ask === null || !(bid > 0 && ask >= bid)) throw new Error(`lighter orderBookOrders ${m.market_id}: no best bid and ask`);
    const mid = (bid + ask) / 2;
    primary = { usd: mid * usdc, source: methodSource(m), detail: { level: 'order_book_mid', market_id: m.market_id, bid: String(bidRaw), ask: String(askRaw), mid, usdc_usd: usdc, ...at } };
  } else if (m.kind === 'solana_vaults') {
    const mint = solanaMint(entry);
    const keys = [m.base_vault, m.quote_vault, ...(check.kind === 'meteora_dlmm' ? [check.pair] : [])];
    const accounts = await deps.solana.getMultipleAccounts(keys);
    const base = tokenAccountAmount(accounts[0], m.base_vault, mint);
    const quote = tokenAccountAmount(accounts[1], m.quote_vault, USDC_MINT);
    if (!(base.raw > 0n && quote.raw > 0n)) throw new Error(`PumpSwap vaults ${m.base_vault}/${m.quote_vault}: a reserve is zero`);
    const inUsdc = ui(quote.raw, quote.decimals) / ui(base.raw, base.decimals);
    primary = { usd: inUsdc * usdc, source: methodSource(m), detail: { level: 'vault_reserves', base_raw: base.raw.toString(), quote_raw: quote.raw.toString(), in_usdc: inUsdc, usdc_usd: usdc, ...at } };
    if (check.kind === 'meteora_dlmm') {
      let bin: ReturnType<typeof dlmmActiveBin> | null = null;
      try {
        bin = dlmmActiveBin(accounts[2], check.pair, mint, entry.decimals);
      } catch (err) {
        read = { usd: null, reason: 'check_error', detail: { method: check.kind, error: err instanceof Error ? err.message : String(err) } };
      }
      if (bin) read = checkUsdc === null ? { usd: null, reason: 'quote_missing', detail: bin.detail } : { usd: bin.inUsdc * checkUsdc, detail: { ...bin.detail, usdc_usd: checkUsdc } };
    }
  } else {
    throw new OrionError('invalid_price_config', `${entry.ref}: ${m.kind} is not an off-chain price method`);
  }
  return withCheck(entry, primary, read);
}
