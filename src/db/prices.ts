import { OrionError } from '../types.js';
import type { Db } from './connection.js';

/**
 * Tokens and prices stored apart from the flows (spec §4, migration 0005). A flow row carries its amount in token units
 * (`observations.amount`, `hourly_amounts`, `token_ref`); `prices` holds the hourly price points, so a price source can be
 * swapped (or deleted if a licence lapses) without touching the amounts.
 */

export const USD_TOKEN_REF = 'usd';

export interface TokenInfo {
  tokenRef: string;
  symbol: string;
  decimals: number | null;
  peg?: 'usd' | null;
  coingeckoId: string | null;
}

/** A row's token amounts: the day's total and, for a transfer scan, the 24 UTC-hour sub-totals (null otherwise). */
export interface ObservationTokens {
  tokenRef: string;
  amount: number;
  hourlyAmounts: number[] | null;
}

/** Dollars as a first-party API reports them (Lighter fees, Hyperliquid USDC fills and payments): no price needed. */
export const USD_TOKEN: TokenInfo = { tokenRef: USD_TOKEN_REF, symbol: 'USD', decimals: null, peg: 'usd', coingeckoId: null };

export const HOURS_PER_DAY = 24;
export const MS_PER_HOUR = 3_600_000;

/** The token ref of an EVM token: CAIP-2 chain, then the address lowercased. */
export const evmTokenRef = (chainId: number, address: string): string => `eip155:${chainId}/${address.toLowerCase()}`;
/** The token ref of a Solana mint. */
export const solanaTokenRef = (mint: string): string => `solana:mainnet/${mint}`;

/** Refuses token amounts the columns must not hold: a non-finite amount, or hourly buckets that are not 24 finite numbers. */
export function checkedTokens(t: ObservationTokens): ObservationTokens {
  if (!t.tokenRef) throw new OrionError('invalid_tokens', 'token amounts need a token ref');
  if (!Number.isFinite(t.amount)) throw new OrionError('invalid_tokens', `token amount must be a finite number, got ${t.amount}`);
  if (t.hourlyAmounts !== null) {
    if (t.hourlyAmounts.length !== HOURS_PER_DAY || !t.hourlyAmounts.every(Number.isFinite)) {
      throw new OrionError('invalid_tokens', `hourly amounts must be ${HOURS_PER_DAY} finite numbers`);
    }
  }
  return t;
}

/**
 * Records the token (inserted once; a later write fills a coingecko id or decimals the first one lacked, never replaces
 * one). The 'usd' row is seeded by 0005.
 */
export async function upsertToken(db: Db, t: TokenInfo): Promise<void> {
  await db.run(
    `INSERT INTO tokens (token_ref, symbol, decimals, peg, coingecko_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token_ref) DO UPDATE SET
       decimals = COALESCE(tokens.decimals, EXCLUDED.decimals),
       coingecko_id = COALESCE(tokens.coingecko_id, EXCLUDED.coingecko_id)`,
    [t.tokenRef, t.symbol, t.decimals, t.peg ?? null, t.coingeckoId],
  );
}

export interface PriceRow {
  /** ISO, the top of a UTC hour. */
  ts: string;
  priceUsd: number;
  /** A chain/first-party row's check outcome (0008, plan P5): absent (null) on a CoinGecko row. */
  checkGapPct?: number | null;
  check?: string | null;
  detail?: Record<string, unknown> | null;
}

/**
 * Upserts hourly prices of one token from one source, in one statement: a point already stored at the same (token, hour,
 * source) is replaced by the newer fetch, so a re-fetch adds no row. Returns how many rows the statement touched. A
 * chain/first-party row also stores its check's gap, label and the read's detail (0008); a row without them stores null.
 */
export async function upsertPrices(db: Db, tokenRef: string, source: string, rows: PriceRow[], fetchedAtIso: string): Promise<number> {
  if (rows.length === 0) return 0;
  const hours = new Set<string>();
  for (const r of rows) {
    if (Date.parse(r.ts) % MS_PER_HOUR !== 0) throw new OrionError('invalid_price', `price time ${r.ts} is not the top of an hour`);
    if (!(r.priceUsd > 0) || !Number.isFinite(r.priceUsd)) throw new OrionError('invalid_price', `price ${r.priceUsd} at ${r.ts} is not a positive number`);
    if (hours.has(r.ts)) throw new OrionError('invalid_price', `two prices for ${tokenRef} at ${r.ts}`);
    hours.add(r.ts);
  }
  for (const r of rows) {
    if (r.checkGapPct !== undefined && r.checkGapPct !== null && !Number.isFinite(r.checkGapPct)) {
      throw new OrionError('invalid_price', `check gap ${r.checkGapPct} at ${r.ts} is not a finite number`);
    }
  }
  // One jsonb array of rows: a float8 travels as its shortest round-trip decimal, so it is stored exactly.
  const payload = rows.map((r) => ({ ts: r.ts, p: r.priceUsd, gap: r.checkGapPct ?? null, chk: r.check ?? null, detail: r.detail ?? null }));
  const result = await db.run(
    `INSERT INTO prices (token_ref, ts, price_usd, source, fetched_at, check_gap_pct, "check", detail)
     SELECT $1, t.ts, t.p, $2, $3, t.gap, t.chk, t.detail
     FROM jsonb_to_recordset($4::jsonb) AS t(ts timestamptz, p float8, gap float8, chk text, detail jsonb)
     ON CONFLICT (token_ref, ts, source) DO UPDATE SET price_usd = EXCLUDED.price_usd, fetched_at = EXCLUDED.fetched_at,
       check_gap_pct = EXCLUDED.check_gap_pct, "check" = EXCLUDED."check", detail = EXCLUDED.detail`,
    [tokenRef, source, fetchedAtIso, JSON.stringify(payload)],
  );
  return result.rowCount;
}

export interface StoredPrice {
  tokenRef: string;
  ts: string;
  priceUsd: number;
  source: string;
  fetchedAt: string;
}

/** A token's stored prices, oldest first. */
export async function listPrices(db: Db, tokenRef: string): Promise<StoredPrice[]> {
  const rows = await db.all<{ token_ref: string; ts: string; price_usd: number; source: string; fetched_at: string }>(
    'SELECT token_ref, ts, price_usd, source, fetched_at FROM prices WHERE token_ref = $1 ORDER BY ts, source',
    [tokenRef],
  );
  return rows.map((r) => ({ tokenRef: r.token_ref, ts: new Date(r.ts).toISOString(), priceUsd: r.price_usd, source: r.source, fetchedAt: new Date(r.fetched_at).toISOString() }));
}

/** How old a chain row may be and still price an hour (flow_usd_chain_v, plan P3): older is a gap, never a price. */
export const CHAIN_PRICE_MAX_AGE_HOURS = 6;

/** A chain/first-party price row as the readers below rank it; `ts` and `fetchedAt` ISO. */
export interface ChainPriceCandidate {
  ts: string;
  priceUsd: number;
  source: string;
  fetchedAt: string;
}

const isChainSource = (source: string): boolean => source.startsWith('chain:') || source.startsWith('first_party:');

/**
 * The chain/first-party price of `tokenRef` at each stored hour in [fromMs, toMs), one per hour: of two rows at one ts the
 * newest write (fetched_at) wins, then the source by name (Ruling R6, flow_usd_chain_v's order). A CoinGecko row is never
 * read. `extra` (a dry run's in-memory rows, Ruling R19) ranks with the stored rows. Keyed by the hour in ms.
 */
export async function chainHourPrices(db: Db, tokenRef: string, fromMs: number, toMs: number, extra: ChainPriceCandidate[] = []): Promise<Map<number, number>> {
  const stored = await db.all<{ ts: string; price_usd: number; source: string; fetched_at: string }>(
    `SELECT ts, price_usd, source, fetched_at FROM prices
     WHERE token_ref = $1 AND ts >= $2 AND ts < $3 AND (starts_with(source, 'chain:') OR starts_with(source, 'first_party:'))`,
    [tokenRef, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  const all: { ms: number; price: number; source: string; fetchedMs: number }[] = [
    ...stored.map((r) => ({ ms: new Date(r.ts).getTime(), price: r.price_usd, source: r.source, fetchedMs: new Date(r.fetched_at).getTime() })),
    ...extra
      .filter((r) => isChainSource(r.source))
      .map((r) => ({ ms: Date.parse(r.ts), price: r.priceUsd, source: r.source, fetchedMs: Date.parse(r.fetchedAt) }))
      .filter((r) => r.ms >= fromMs && r.ms < toMs),
  ];
  all.sort((a, b) => a.ms - b.ms || b.fetchedMs - a.fetchedMs || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const out = new Map<number, number>();
  for (const r of all) if (!out.has(r.ms)) out.set(r.ms, r.price);
  return out;
}

/**
 * The price of each hour bucket [H, H+1h) for H in [fromMs, toMs) (whole hours), as flow_usd_chain_v prices it: the newest
 * chain row at or before H, no more than CHAIN_PRICE_MAX_AGE_HOURS old. An hour with none is absent (a gap).
 */
export async function chainPricesAt(db: Db, tokenRef: string, fromMs: number, toMs: number, extra: ChainPriceCandidate[] = []): Promise<Map<number, number>> {
  const lookback = CHAIN_PRICE_MAX_AGE_HOURS * MS_PER_HOUR;
  const byHour = await chainHourPrices(db, tokenRef, fromMs - lookback, toMs, extra);
  const out = new Map<number, number>();
  for (let h = fromMs; h < toMs; h += MS_PER_HOUR) {
    for (let t = h; t >= h - lookback; t -= MS_PER_HOUR) {
      const p = byHour.get(t);
      if (p !== undefined) {
        out.set(h, p);
        break;
      }
    }
  }
  return out;
}

/** One group of compared days: legacy `value` vs the chain view's USD (hourly buckets, the daily mean, or the dollar amount). */
export interface GapStats {
  days: number;
  sumLegacy: number;
  /** The chain view's USD of the same days (named for the hourly buckets most days are priced from). */
  sumHourly: number;
  /** (sumHourly / sumLegacy - 1) x 100; null when sumLegacy is 0. */
  gapPct: number | null;
  /**
   * Per-day |hourly - legacy| / |legacy| x 100, nearest-rank percentiles over every day; null with no day. A day whose
   * legacy USD is 0 counts 0 when hourly is 0 too, else 100 (the whole hourly amount is the gap): such a day is the
   * discrepancy a gate must see, so it is never left out.
   */
  p50DayGapPct: number | null;
  p90DayGapPct: number | null;
  /** Days whose legacy USD is 0 but whose hourly USD is not (each counted at 100 in the percentiles). */
  legacyZeroDays: number;
}

export interface UsdComparison extends GapStats {
  metric: string;
  /** Days the chain view prices (flow_usd_chain_v basis hourly, daily_mean or usd_native): the days in the sums. */
  hourlyCovered: number;
  /** Of those, days priced as the day's amount x the mean of its 24 chain hours (no hourly buckets: Solana's supply drop). */
  dailyMean: number;
  /** Of those, days whose amount is already dollars (token 'usd'). */
  usdNative: number;
  /** Days with tokens but an hour with an amount and no chain price: they keep `value`. */
  unpriced: number;
  /** Days with no token columns (not backfilled, or a DefiLlama series): they keep `value`. */
  noTokens: number;
  /** Days with tokens but no hourly buckets and not all 24 chain hours priced: they keep `value`. */
  noHourly: number;
}

/**
 * The basis a report figure is priced on (Phase 3 R2, plan P3), from flow_usd_chain_v: `hourly` (tokens x the chain
 * writer's hourly prices, every hour with an amount priced), `daily_mean` (a day's amount without hourly buckets x the
 * mean of its 24 chain hours), `usd_native` (a first-party API's dollars), `onchain_usd` (Phase 3 R4: a `pool_scan` row
 * with no token columns, whose USD the adapter computed from on-chain prices inside its scan: one row sums hundreds of
 * pool tokens, so no token_ref can be stored), else `legacy` (the stored USD: some hour unpriced, no hourly buckets and
 * not 24 chain hours, no tokens, e.g. DefiLlama and derived rows). There is no ingest gate: a row's basis depends on the
 * prices stored now, not on how its `value` was priced when it was written.
 */
export type PriceBasis = 'hourly' | 'daily_mean' | 'usd_native' | 'onchain_usd' | 'legacy';

/** flow_usd_chain_v's `usd_basis` folded to the report's four labels. */
export function priceBasisOf(usdBasis: string): PriceBasis {
  if (usdBasis === 'usd_native' || usdBasis === 'hourly' || usdBasis === 'daily_mean') return usdBasis;
  return 'legacy';
}

/**
 * Per active USD flow row of the asset (flow_usd_chain_v), the USD the report's income statement reads and its basis:
 * the view's `usd` where the basis is hourly, daily_mean or usd_native, else the stored `value` (`legacy_usd`), labelled
 * `onchain_usd` when the row is a `pool_scan` row without token columns (the view's `legacy_no_tokens`; the label is
 * TypeScript only, no migration). Keyed by observation id, so the caller selects the rows exactly as it selects `value`
 * rows. Read-only.
 */
export async function listFlowUsd(db: Db, assetId: string): Promise<Map<number, { usd: number; basis: PriceBasis }>> {
  const rows = await db.all<{ id: number; usd: number; legacy_usd: number; usd_basis: string; source_type: string }>(
    'SELECT v.id, v.usd, v.legacy_usd, v.usd_basis, o.source_type FROM flow_usd_chain_v v JOIN observations o ON o.id = v.id WHERE v.asset_id = $1', [assetId],
  );
  const out = new Map<number, { usd: number; basis: PriceBasis }>();
  for (const r of rows) {
    const basis = r.usd_basis === 'legacy_no_tokens' && r.source_type === 'pool_scan' ? 'onchain_usd' : priceBasisOf(r.usd_basis);
    out.set(Number(r.id), { usd: basis === 'legacy' || basis === 'onchain_usd' ? r.legacy_usd : r.usd, basis });
  }
  return out;
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function gapStats(rows: { legacy: number; hourly: number }[]): GapStats {
  const sumLegacy = rows.reduce((s, r) => s + r.legacy, 0);
  const sumHourly = rows.reduce((s, r) => s + r.hourly, 0);
  const dayGaps = rows
    .map((r) => (r.legacy === 0 ? (r.hourly === 0 ? 0 : 100) : (Math.abs(r.hourly - r.legacy) / Math.abs(r.legacy)) * 100))
    .sort((a, b) => a - b);
  return {
    days: rows.length, sumLegacy, sumHourly, gapPct: sumLegacy === 0 ? null : (sumHourly / sumLegacy - 1) * 100,
    p50DayGapPct: percentile(dayGaps, 0.5), p90DayGapPct: percentile(dayGaps, 0.9),
    legacyZeroDays: rows.filter((r) => r.legacy === 0 && r.hourly !== 0).length,
  };
}

/**
 * Per USD flow metric of the asset, over the active daily rows observed in (now - days, now]: the legacy USD (`value`)
 * against the chain view's USD (flow_usd_chain_v), every priced day in one group. Read-only.
 */
export async function compareUsd(
  db: Db, asset: { id: string; metrics: Record<string, { type: string; unit: string }> }, days: number, opts: { now?: Date } = {},
): Promise<UsdComparison[]> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const metrics = Object.entries(asset.metrics).filter(([, d]) => d.type === 'flow' && d.unit === 'usd').map(([k]) => k).sort();
  if (metrics.length === 0) return [];
  const rows = await db.all<{ metric_key: string; legacy_usd: number; usd: number; usd_basis: string }>(
    `SELECT metric_key, legacy_usd, usd, usd_basis FROM flow_usd_chain_v
     WHERE asset_id = $1 AND metric_key = ANY($2::text[]) AND period_days = 1 AND observed_at > $3 AND observed_at <= $4
     ORDER BY metric_key, observed_at`,
    [asset.id, metrics, from, now.toISOString()],
  );
  return metrics.map((metric) => {
    const mine = rows.filter((r) => r.metric_key === metric);
    const priced: { legacy: number; hourly: number }[] = [];
    let dailyMean = 0;
    let usdNative = 0;
    let unpriced = 0;
    let noTokens = 0;
    let noHourly = 0;
    for (const r of mine) {
      if (r.usd_basis === 'legacy_unpriced') unpriced++;
      else if (r.usd_basis === 'legacy_no_tokens') noTokens++;
      else if (r.usd_basis === 'legacy_no_hourly') noHourly++;
      else {
        priced.push({ legacy: r.legacy_usd, hourly: r.usd });
        if (r.usd_basis === 'usd_native') usdNative++;
        if (r.usd_basis === 'daily_mean') dailyMean++;
      }
    }
    return { metric, ...gapStats(priced), days: mine.length, hourlyCovered: priced.length, dailyMean, usdNative, unpriced, noTokens, noHourly };
  });
}
