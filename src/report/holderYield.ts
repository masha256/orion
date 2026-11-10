import type { AssetConfig, RecipientBase } from '../config/schema.js';
import type { CheckResult } from '../db/checkResults.js';
import type { PriceBasis } from '../db/prices.js';
import { addDays } from '../ingest/time.js';
import { DAYS_PER_YEAR } from '../types.js';

/**
 * The report's shared pieces (no driver, no grade, no signal): its input, window sums and growth, the disclosed-revenue
 * growth, and the header (price, market cap, FDV, notes). Everything is computed from stored daily flow totals and the
 * level metrics in force, so any past day can be recomputed and nothing new is stored. The figures themselves are the
 * income statement v2's (src/report/incomeStatement.ts): since Task 11 (G4) it is the only report, read from the
 * `income_statement` block alone (`holder_flows` and `reporting` are retired).
 */

export type Bucket = 'burn' | 'hold' | 'cash';

export interface ReportLevels {
  price: number | null;
  /** total_supply: on-chain supply less what CoinGecko also excludes (burn addresses; HYPE's Assistance Fund). FDV basis. */
  totalSupply: number | null;
  /** circulating_supply (CoinGecko's, or the on-chain total for the wrappers CoinGecko has none for): market cap basis. */
  circulatingSupply?: number | null;
  stakedSupply: number | null;
  lockedSupply: number | null;
  emissionRateAnnual: number | null;
  /** Annual run rates of the below_line `run_rate` level metrics (CRV's vote incentives), by metric key. */
  extra: Record<string, number | null>;
  /** `income_statement.dilution` lines: the rate (tokens a year) and the cap (tokens), by line id; null when unread. */
  dilution?: Record<string, { rate: number | null; cap: number | null }>;
  /** The disclosed revenue line's levels (oldest first), read from the metric its `disclosed` key names. */
  disclosed: { observedAt: string; value: number }[];
  /** The as-of the levels were read at (the statement's priceBasis and supplyAsOf); absent in fixtures. */
  asOf?: string;
}

export interface ReportInput {
  asset: AssetConfig;
  /** The last complete UTC day the report covers (YYYY-MM-DD). */
  day: string;
  /** Daily flow totals per flow metric: UTC day -> value (USD). A periodic stream's payments arrive spread over their days. */
  daily: Map<string, Map<string, number>>;
  /** Days of a periodic stream's metric not yet paid for: filled at the last period's daily rate, provisional. */
  provisional?: Map<string, Set<string>>;
  levels: ReportLevels;
  /** The stored reconciliation check results for `day`. */
  checks?: CheckResult[];
  /**
   * Per flow metric and UTC day, the provenance of the stored row behind `daily`'s value. The loader always passes it;
   * absent (a pure input), the statement's provenance is the config's (`basis: 'config'`).
   */
  provenance?: Map<string, Map<string, DayProvenance>>;
  /**
   * Task 8 (after G2): the statement's daily series, priced from the stored tokens x hourly prices where a row's hourly
   * coverage is full (flow_usd_v) and its stored USD was hourly-priced at ingest, else the stored USD. Absent: the
   * statement reads `daily`. The header's figures (yields, dilution, supply) are on the same series as the statement.
   */
  statementDaily?: Map<string, Map<string, number>>;
  /** Per USD flow metric and UTC day, the basis of `statementDaily`'s value. Absent: every day is `legacy`. */
  priceBasis?: Map<string, Map<string, PriceBasis>>;
}

/** The method and `<rung>:<what>` label of the row a day's value came from (both NOT NULL since 0006). */
export interface DayProvenance {
  method: 'measured' | 'derived' | 'disclosed';
  label: string;
}

/** Streams younger than this are left out of the second revenue growth figure (a new stream inflates 90d/90d). */
export const NEW_STREAM_DAYS = 180;

export interface Growth {
  /** Sum over the latest window, and over the window before it. Null when either has a missing day. */
  current: number | null;
  prior: number | null;
  /** current / prior - 1. */
  change: number | null;
  /** (current / prior) ^ (365 / window) - 1. Null (not meaningful) when either side is <= 0 or incomplete. */
  annualized: number | null;
  note?: string;
}

/** The statement's yields on price (spec §7 "as today": the v1 report's arithmetic, now on the statement's lines). */
export interface Yields {
  /** Cash payouts, net of slippage, on price. */
  cash: number | null;
  /** Burns plus holds net of the overhang haircut, on price. */
  buyback: number | null;
  /** cash + buyback. */
  shareholder: number | null;
  /** Annual supply growth from emissions and releases. */
  dilution: number | null;
  /** shareholder - dilution. */
  netShareholder: number | null;
  /** 1 / shareholder: price over net holder cash per token. */
  multiple: number | null;
  /** multiple / (holder-flow growth in percent). Null when growth <= 0. */
  pegTrailing: number | null;
  /**
   * income_statement.dilution lines (tokens a year, after the cap, and as a share of total supply); absent without the
   * block.
   */
  dilutionLines?: { id: string; tokensPerYear: number | null; yield: number | null }[];
}

/**
 * Supply in tokens a year over the window (income_statement.burned_tokens): removed by the holder flows, added by
 * emissions and releases; net = added - removed, and as a share of total supply (negative: supply shrinks). Null
 * without the block.
 */
export type SupplyFlow = { burnedPerYear: number | null; addedPerYear: number | null; netPerYear: number | null; netPct: number | null } | null;

/** A disclosed level's growth between its two latest disclosures, with its flags. */
export interface DisclosedGrowth {
  annualized: number | null;
  gapDays: number | null;
  latestAgeDays: number | null;
  flags: string[];
}

const finite = (x: number | null): x is number => x !== null && Number.isFinite(x);

/** Sum of `metrics` per day over [end - days + 1, end]; null when any metric misses any day. */
export function windowSum(daily: Map<string, Map<string, number>>, metrics: string[], end: string, days: number): number | null {
  let sum = 0;
  for (const m of metrics) {
    const series = daily.get(m);
    if (!series) return null;
    for (let i = 0; i < days; i++) {
      const v = series.get(addDays(end, -i));
      if (v === undefined) return null;
      sum += v;
    }
  }
  return sum;
}

export function growthOf(daily: Map<string, Map<string, number>>, metrics: string[], end: string, days: number, weights?: number[]): Growth {
  const weighted = (e: string): number | null => {
    if (!weights) return windowSum(daily, metrics, e, days);
    let s = 0;
    for (let i = 0; i < metrics.length; i++) {
      const w = windowSum(daily, [metrics[i]], e, days);
      if (w === null) return null;
      s += w * weights[i];
    }
    return s;
  };
  const current = weighted(end);
  const prior = weighted(addDays(end, -days));
  if (current === null || prior === null) {
    return { current, prior, change: null, annualized: null, note: `needs ${2 * days} complete days of every flow` };
  }
  if (!(prior > 0) || current < 0) return { current, prior, change: prior > 0 ? current / prior - 1 : null, annualized: null, note: 'not meaningful: a window is zero or negative' };
  const ratio = current / prior;
  return { current, prior, change: ratio - 1, annualized: ratio ** (DAYS_PER_YEAR / days) - 1 };
}

export function recipients(base: RecipientBase, lv: ReportLevels): number | null {
  if (base === 'all') return lv.totalSupply;
  if (base === 'locked') return lv.lockedSupply ?? lv.stakedSupply;
  return lv.stakedSupply;
}

/** Days from a to b (ISO times or days), rounded. */
const daysFrom = (a: string, b: string) => Math.round((Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b) - Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a)) / 86_400_000);

/** Two disclosures closer than this give a noisy growth rate; a latest disclosure older than it is stale. */
export const DISCLOSURE_GAP_DAYS = 90;

/**
 * A disclosed revenue level's growth between the two latest disclosures (oldest first in `d`), and its flags: under
 * DISCLOSURE_GAP_DAYS apart, or the latest older than that on the report day.
 */
export function disclosedGrowthOf(
  d: { observedAt: string; value: number }[],
  day: string,
): { latest: { observedAt: string; value: number } | null; growth: Growth; disclosedGrowth: DisclosedGrowth } {
  const endIso = `${addDays(day, 1)}T00:00:00.000Z`;
  const latest = d.at(-1) ?? null;
  const prev = d.length > 1 ? d[d.length - 2] : null;
  const gapDays = latest && prev ? daysFrom(prev.observedAt, latest.observedAt) : null;
  const latestAgeDays = latest ? daysFrom(latest.observedAt, endIso) : null;
  const annualized = latest && prev && prev.value > 0 && latest.value > 0 && gapDays! > 0 ? (latest.value / prev.value) ** (DAYS_PER_YEAR / gapDays!) - 1 : null;
  const flags: string[] = [];
  if (!prev) flags.push('one disclosure so far: no growth');
  if (gapDays !== null && gapDays < DISCLOSURE_GAP_DAYS) flags.push(`the two latest disclosures are ${gapDays} days apart (< ${DISCLOSURE_GAP_DAYS}): a noisy rate`);
  if (latestAgeDays !== null && latestAgeDays > DISCLOSURE_GAP_DAYS) flags.push(`the latest disclosure is ${latestAgeDays} days old (> ${DISCLOSURE_GAP_DAYS})`);
  return {
    latest,
    growth: { current: latest?.value ?? null, prior: prev?.value ?? null, change: latest && prev && prev.value > 0 ? latest.value / prev.value - 1 : null, annualized, note: 'between the two latest disclosures' },
    disclosedGrowth: { annualized, gapDays, latestAgeDays, flags },
  };
}

/** The report's header: the window, the price, market cap and FDV at the report's as-of, and its notes. */
export interface ReportHeader {
  windowDays: number;
  price: number | null;
  /** price x circulating_supply; null when the asset records no circulating supply. */
  marketCap: number | null;
  /** price x total_supply. The yields, the multiple and the supply line are on this basis. */
  fdv: number | null;
  notes: string[];
}

/**
 * The header of `report yield` (outside the statement, so a statement that throws still has one, ruling C4). The notes
 * are those v1 printed, now read from income_statement: a run-rate holder-flow line has no daily series, yields per
 * token of each line's recipients, a periodic line's unpaid days, and a single disclosure. Throws without the block.
 */
export function reportHeader(input: ReportInput): ReportHeader {
  const { asset, day, levels: lv } = input;
  const is = asset.income_statement;
  if (!is) throw new Error(`assets/${asset.id}.yaml has no income_statement block`);
  const W = is.window_days;
  const price = lv.price;
  const circ = lv.circulatingSupply ?? null;
  const eff = lv.totalSupply;
  const notes: string[] = [];
  const toHolders = (is.below_line ?? []).filter((b) => b.to === 'holders');
  const runRates = toHolders.filter((b) => b.run_rate !== undefined).map((b) => b.id);
  if (runRates.length > 0) notes.push(`holder-flow growth excludes ${runRates.join(', ')} (a run rate with no daily series)`);
  const bases = [...(is.holders ?? []).map((h) => h.recipient_base), ...toHolders.flatMap((b) => (b.recipient_base === undefined ? [] : [b.recipient_base]))];
  if (bases.some((b) => b !== 'all')) notes.push('yields are per token of each flow\'s recipients (staked or locked supply), i.e. to a holder in every flow\'s base');
  const unpaid = is.revenue.flatMap((r) => {
    const m = r.metric ?? r.derived?.from;
    const pending = m === undefined ? undefined : input.provisional?.get(m);
    let n = 0;
    if (pending) for (let i = 0; i < W; i++) if (pending.has(addDays(day, -i))) n++;
    return n > 0 ? [`${r.id} has ${n} unpaid day(s) at the last period's daily rate (provisional)`] : [];
  });
  if (unpaid.length > 0) notes.push(`revenue: ${unpaid.join('; ')}`);
  if (is.revenue.some((r) => r.disclosed !== undefined) && lv.disclosed.length < 2) notes.push('disclosed revenue: one disclosure so far; growth starts at the next one');
  return { windowDays: W, price, marketCap: finite(price) && finite(circ) ? price * circ : null, fdv: finite(price) && finite(eff) ? price * eff : null, notes };
}
