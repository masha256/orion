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
/** The token a vault share is valued in when the config names only its CoinGecko id (shares x pricePerShare x price). */
export const coingeckoTokenRef = (id: string): string => `coingecko:${id}`;

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
}

/**
 * Upserts hourly prices of one token from one source, in one statement: a point already stored at the same (token, hour,
 * source) is replaced by the newer fetch, so a re-fetch adds no row. Returns how many rows the statement touched.
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
  const result = await db.run(
    `INSERT INTO prices (token_ref, ts, price_usd, source, fetched_at)
     SELECT $1, t.ts, t.p, $2, $3 FROM unnest($4::timestamptz[], $5::float8[]) AS t(ts, p)
     ON CONFLICT (token_ref, ts, source) DO UPDATE SET price_usd = EXCLUDED.price_usd, fetched_at = EXCLUDED.fetched_at`,
    [tokenRef, source, fetchedAtIso, rows.map((r) => r.ts), rows.map((r) => r.priceUsd)],
  );
  return result.rowCount;
}

/**
 * The hours (ms) in [fromMs, toMs) that already have a `source` price under EVERY one of `tokenRefs`: hours a fetch
 * need not ask for again.
 */
export async function storedPriceHours(db: Db, tokenRefs: string[], source: string, fromMs: number, toMs: number): Promise<Set<number>> {
  if (tokenRefs.length === 0) return new Set();
  const rows = await db.all<{ ts: string }>(
    `SELECT ts FROM prices WHERE token_ref = ANY($1::text[]) AND source = $2 AND ts >= $3 AND ts < $4
     GROUP BY ts HAVING count(DISTINCT token_ref)::float8 = $5`,
    [tokenRefs, source, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), new Set(tokenRefs).size],
  );
  return new Set(rows.map((r) => new Date(r.ts).getTime()));
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

/** One group of compared days: legacy `value` vs the USD re-priced from the hourly buckets (or the dollar amount). */
export interface GapStats {
  days: number;
  sumLegacy: number;
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
  /** Days within the hourly series (spec §4): their legacy USD was priced per transfer at hourly points. */
  hourlyCovered: number;
  /** Of those, days whose amount is already dollars (token 'usd'). */
  usdNative: number;
  /** Days whose legacy USD was priced at DAILY points (written more than 90 days after the day, plan correction 13), re-priced hourly now. */
  beyondHourly: number;
  beyond: GapStats;
  /** Days with tokens but an hour with an amount and no price (beyond the hourly price history): they keep `value`. */
  unpriced: number;
  /** Days with no token columns (not backfilled, or a DefiLlama series): they keep `value`. */
  noTokens: number;
  /** Days with tokens but no hourly buckets (Solana's supply drop): they keep `value`. */
  noHourly: number;
}

/** CoinGecko answers `days=90` with hourly points (src/ingest/flow.ts loadPrices): older transfers were priced daily. */
export const HOURLY_SERIES_DAYS = 90;

/**
 * Whether a daily row's stored USD (`value`) was priced from CoinGecko's hourly series at ingest: its day (observed_at
 * less 24 h) starts no more than HOURLY_SERIES_DAYS before its fetched_at. Older rows (a backfill reaching past the
 * hourly series) were priced from daily points (plan correction 13). The one rule for compareUsd's within/beyond split
 * and for the report's basis.
 */
export function pricedHourlyAtIngest(observedAt: string, fetchedAt: string): boolean {
  return Date.parse(observedAt) - 86_400_000 >= Date.parse(fetchedAt) - HOURLY_SERIES_DAYS * 86_400_000;
}

/**
 * The basis a report figure is priced on (Task 8, after G2): `hourly` (flow_usd_v's tokens x hourly prices, every hour
 * with an amount priced, on a row whose stored USD was itself hourly-priced at ingest), `usd_native` (a first-party API's
 * dollars), else `legacy` (the stored USD: some hour unpriced, no hourly buckets, no tokens, e.g. DefiLlama and derived
 * rows, or a row backfilled with daily prices, which G2 did not sign off at hourly prices).
 */
export type PriceBasis = 'hourly' | 'usd_native' | 'legacy';

/** flow_usd_v's `usd_basis` and the row's ingest pricing (pricedHourlyAtIngest) folded to the report's three labels. */
export function priceBasisOf(usdBasis: string, hourlyAtIngest: boolean): PriceBasis {
  if (usdBasis === 'usd_native') return 'usd_native';
  return usdBasis === 'hourly' && hourlyAtIngest ? 'hourly' : 'legacy';
}

/**
 * Per active USD flow row of the asset (flow_usd_v), the USD the report's income statement reads and its basis: the
 * view's `usd` where the basis is hourly or usd_native, else the stored `value` (`legacy_usd`). Keyed by observation id,
 * so the caller selects the rows exactly as it selects `value` rows. Read-only.
 */
export async function listFlowUsd(db: Db, assetId: string): Promise<Map<number, { usd: number; basis: PriceBasis }>> {
  const rows = await db.all<{ id: number; observed_at: string; fetched_at: string; usd: number; legacy_usd: number; usd_basis: string }>(
    `SELECT v.id, v.observed_at, o.fetched_at, v.usd, v.legacy_usd, v.usd_basis
     FROM flow_usd_v v JOIN observations o ON o.id = v.id WHERE v.asset_id = $1`, [assetId],
  );
  const out = new Map<number, { usd: number; basis: PriceBasis }>();
  for (const r of rows) {
    const basis = priceBasisOf(r.usd_basis, pricedHourlyAtIngest(r.observed_at, r.fetched_at));
    out.set(Number(r.id), { usd: basis === 'legacy' ? r.legacy_usd : r.usd, basis });
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
 * against the view's re-priced USD (flow_usd_v), with days inside the hourly series and days beyond it (correction 13)
 * reported apart. Read-only; for gate G2, nothing else reads the view.
 */
export async function compareUsd(
  db: Db, asset: { id: string; metrics: Record<string, { type: string; unit: string }> }, days: number, opts: { now?: Date } = {},
): Promise<UsdComparison[]> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const metrics = Object.entries(asset.metrics).filter(([, d]) => d.type === 'flow' && d.unit === 'usd').map(([k]) => k).sort();
  if (metrics.length === 0) return [];
  const rows = await db.all<{ metric_key: string; observed_at: string; fetched_at: string; legacy_usd: number; usd: number; usd_basis: string }>(
    `SELECT v.metric_key, v.observed_at, o.fetched_at, v.legacy_usd, v.usd, v.usd_basis
     FROM flow_usd_v v JOIN observations o ON o.id = v.id
     WHERE v.asset_id = $1 AND v.metric_key = ANY($2::text[]) AND v.period_days = 1 AND v.observed_at > $3 AND v.observed_at <= $4
     ORDER BY v.metric_key, v.observed_at`,
    [asset.id, metrics, from, now.toISOString()],
  );
  return metrics.map((metric) => {
    const mine = rows.filter((r) => r.metric_key === metric);
    const within: { legacy: number; hourly: number }[] = [];
    const beyond: { legacy: number; hourly: number }[] = [];
    let usdNative = 0;
    let unpriced = 0;
    let noTokens = 0;
    let noHourly = 0;
    for (const r of mine) {
      if (r.usd_basis === 'legacy_unpriced') unpriced++;
      else if (r.usd_basis === 'legacy_no_tokens') noTokens++;
      else if (r.usd_basis === 'legacy_no_hourly') noHourly++;
      else {
        const pricedDaily = r.usd_basis === 'hourly' && !pricedHourlyAtIngest(r.observed_at, r.fetched_at);
        (pricedDaily ? beyond : within).push({ legacy: r.legacy_usd, hourly: r.usd });
        if (r.usd_basis === 'usd_native') usdNative++;
      }
    }
    return {
      metric, ...gapStats(within), days: mine.length, hourlyCovered: within.length, usdNative, beyondHourly: beyond.length, beyond: gapStats(beyond),
      unpriced, noTokens, noHourly,
    };
  });
}
