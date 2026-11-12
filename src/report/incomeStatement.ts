import { resolveUse, type IsApportion, type IsBucket, type IsHolderLine, type IsRevenueLine, type IsBelowLine, type IsCostLine, type IsUseLine, type CostTo, type IsCategory } from '../config/incomeStatement.js';
import type { AssetConfig, IncomeStatementDef, MetricDef, RecipientBase } from '../config/schema.js';
import type { PriceBasis } from '../db/prices.js';
import { addDays } from '../ingest/time.js';
import { chainOfSource, locatorOfSource, provenanceLabel, scrubLocator } from '../provenance/locator.js';
import { DAYS_PER_YEAR, STD_METRICS } from '../types.js';
import { disclosedGrowthOf, growthOf, NEW_STREAM_DAYS, recipients, windowSum, type Bucket, type DisclosedGrowth, type Growth, type ReportInput, type SupplyFlow, type Yields } from './holderYield.js';
import { crossCheckTypesOf, LISTING_RUNGS, sourceLabelOf, sourceTypeOf, type SourceType } from './sourceTypes.js';

/**
 * Income statement v2 (spec 2026-10-28 §6-7, plan corrections 6, 7, 13, 14): a pure function of the report input, the
 * only report since Task 11 (G4) retired v1 and its config keys. Annualizing, window sums and growth use
 * `windowSum`/`growthOf` (Σ window sum × weight, then × 365 / window), summed in YAML line order. The yields, the
 * dilution and the supply line keep v1's arithmetic (spec §7 "as today"), now over the statement's holder-flow lines:
 * the same series, in the same order, as the retired holder_flows, revenue streams and extra_cash, so every figure is
 * unchanged to the bit (tests/report/v2Golden.test.ts).
 * Task 8 (after G2): the loader gives the statement its own daily series (`ReportInput.statementDaily`: tokens x hourly
 * prices where a row's hourly coverage is full and its stored USD was hourly-priced at ingest, else the stored USD).
 * Each line's `priceBasis` labels the days it reads (the window and growth's prior window).
 *
 *   revenue        = Σ revenue lines
 *   gross profit   = revenue − Σ cost_of_revenue          (null if any cost line is not_measured)
 *   gross profit   = holders + protocol + operating_costs + unreconciled
 *   payout ratio   = holders / gross profit; holders / revenue (payoutRatioBasis 'revenue') when gross profit is n/m
 *   holder flow    = holders (at the recipients) + below_line to holders (flagged fromBelowLine):
 *                      gross            what reaches holders, USD a year
 *                      net              gross after each line's haircut (slippage, overhang): spec §7, v1's yield basis
 *                      netOfDilution    net less dilution (emissions + releases, valued at price): spec §6 "net holder flow"
 *
 * Not measured is never zero-filled: a not_measured line makes its section's total null (and every figure built on it:
 * gross profit, the remainder, unreconciled, the payout ratio), and is listed in that section's `notMeasured`. Below the
 * line and in holder flow, a not_measured below-line line is listed and left out of the measured sum, which is null when
 * no line to that side is measured.
 */

export type IsMethod = 'measured' | 'derived' | 'disclosed' | 'not_measured';

/**
 * Task 8: what a line's USD days are priced on, over every day its figures read: the window and growth's prior window
 * (a line's growth reads the same series as its annualized figure, over both windows). One label when every such day of
 * every USD series the line reads has it (`hourly`: tokens x hourly prices; `usd_native`: a first-party API's dollars;
 * `legacy`: the stored USD), `mixed` otherwise, null when the line reads no daily USD series (a level, a line not
 * measured).
 */
export type LinePriceBasis = PriceBasis | 'mixed' | null;

/** The formula an apportioned line's figure comes from (Task 7b, ruling R14): its flow x the window's mix. */
export const APPORTION_FORMULA = 'apportion_by_mix@1';

/**
 * An apportioned line's split (Task 7b): the line carries its flow x `mix`, where mix = `bySum` / `totalSum`, the window
 * sums of the two series. Null mix (the total's window sum is 0, or a day of either is missing) leaves the line null and
 * flagged; it is never divided by zero.
 */
export interface ApportionOut {
  by: string;
  total: string;
  mix: number | null;
  bySum: number | null;
  totalSum: number | null;
  formula: typeof APPORTION_FORMULA;
}

const BUCKETS: Bucket[] = ['burn', 'hold', 'cash'];

/** One series in a figure: Σ windowSum(metric) × w, annualized. `gw` is its growth weight (w without a young stream's run-rate weight, as v1). */
interface Term {
  metric: string;
  w: number;
  gw: number;
}

/**
 * What a line reads: daily series (terms), a level in USD a year (a disclosure, a run rate; `growth` when the level has
 * one, as a disclosure does between its two latest values), or nothing (not_measured).
 */
type Value = { kind: 'terms'; terms: Term[] } | { kind: 'level'; value: number | null; note: string; growth?: Growth } | { kind: 'nm'; reason: string };

export interface IsRevenueLineOut {
  id: string;
  label: string | null;
  method: IsMethod;
  sourceTypes: SourceType[];
  priceBasis: LinePriceBasis;
  /** USD a year (a young stream at its run rate over its own days). Null when not measured or a day is missing. */
  annualized: number | null;
  /** The window's sum (USD; with a share or ratio applied, before the run-rate weight); null for a level. */
  windowSum: number | null;
  settlement: 'daily' | 'periodic' | null;
  started: string | null;
  /** Days of the window the line existed (null: older than the window, or a level). */
  daysMeasured: number | null;
  provisionalDays: number;
  /** Pool coverage (pool_scan lines, Phase 3): null today. */
  coverage: null;
  isNew: boolean;
  /** A disclosed line: growth between the two latest disclosures (v1's disclosed growth, the same computation). */
  growth: Growth;
  /** A disclosed line only: the gap between the two latest disclosures, the latest's age and their flags (v1's). */
  disclosedGrowth?: DisclosedGrowth;
  /** A disclosed line's cross-check series, annualized over the window, and its rung (VVV: DefiLlama, third_party). */
  crossCheck?: { metric: string; annualized: number | null; sourceType: SourceType | null };
  notMeasured?: string;
}

export interface IsUseLineOut {
  id: string;
  label: string | null;
  /** The revenue line this one passes on (`of`), else null. */
  of: string | null;
  share: number;
  method: IsMethod;
  sourceTypes: SourceType[];
  priceBasis: LinePriceBasis;
  annualized: number | null;
  growth: Growth;
  note?: string;
  notMeasured?: string;
  /** Present only on an apportioned line. */
  apportion?: ApportionOut;
}

export interface IsCostLineOut extends IsUseLineOut {
  to: CostTo;
}

/** A line of holder flow: what reaches holders, measured at the recipients (`paid_metric` when set). */
export interface HolderFlowLineOut {
  id: string;
  section: 'holders' | 'below_line';
  fromBelowLine: boolean;
  /** Null only for a below-line line not measured, which names no bucket (AERO's bribes). */
  bucket: Bucket | null;
  method: IsMethod;
  /** The rungs of the series the line reads (paid_metric included). */
  sourceTypes: SourceType[];
  /** The basis of the series holder flow reads (paid_metric when set). */
  priceBasis: LinePriceBasis;
  /** The series holder flow reads (null for a run-rate level or a line not measured). */
  metric: string | null;
  haircut: number;
  recipientBase: RecipientBase;
  gross: number | null;
  net: number | null;
  /** Net per recipient token / price, as v1. */
  yield: number | null;
  growth: Growth;
  notMeasured?: string;
}

export interface IsHolderLineOut extends IsUseLineOut {
  bucket: Bucket;
  haircut: number;
  recipientBase: RecipientBase;
  valuedPer: 'supply' | 'recipients' | null;
  captureRule: IsHolderLine['capture_rule'];
  paidMetric: string | null;
  gross: number | null;
  net: number | null;
  yield: number | null;
}

export interface IsBelowLineOut {
  id: string;
  label: string | null;
  to: 'holders' | 'protocol';
  method: IsMethod;
  sourceTypes: SourceType[];
  priceBasis: LinePriceBasis;
  annualized: number | null;
  growth: Growth;
  bucket: Bucket | null;
  haircut: number | null;
  recipientBase: RecipientBase | null;
  captureRule: IsBelowLine['capture_rule'] | null;
  note?: string;
  notMeasured?: string;
  /** Present only on an apportioned line. */
  apportion?: ApportionOut;
}

export interface UseSectionOut<L> {
  /** Null when any line of the section is not measured (never zero-filled). */
  annualized: number | null;
  growth: Growth;
  /** True when the section is the declared remainder (revenue less the rest): one derived line. */
  remainder: boolean;
  /** The section's not_measured lines (a remainder: those of the sections it is computed from). */
  notMeasured: string[];
  lines: L[];
}

export interface BucketFlow {
  gross: number | null;
  net: number | null;
  yield: number | null;
  fromRevenue: number | null;
  fromBelowLine: number | null;
}

export interface IsV2 {
  schema: 2;
  day: string;
  windowDays: number;
  category: IsCategory;
  scope: IncomeStatementDef['scope'];
  revenue: {
    annualized: number | null;
    growth: Growth;
    /** Growth leaving out lines younger than NEW_STREAM_DAYS; null when none is that young. */
    growthExNew: Growth | null;
    excludedFromExNew: string[];
    provisional: boolean;
    notMeasured: string[];
    lines: IsRevenueLineOut[];
  };
  costOfRevenue: {
    /** Null when any cost line is not measured (never zero-filled); 0 with no cost line. */
    annualized: number | null;
    /** The measured cost lines' sum (0 when none is measured). */
    measuredAnnualized: number | null;
    notMeasured: string[];
    lines: IsCostLineOut[];
  };
  grossProfit: { annualized: number | null; growth: Growth };
  holders: UseSectionOut<IsHolderLineOut> & { byBucket: Record<Bucket, { annualized: number | null } | null> };
  protocol: UseSectionOut<IsUseLineOut>;
  operatingCosts: UseSectionOut<IsUseLineOut>;
  /**
   * Gross profit less holders, protocol and operating costs: shown, never booked; exactly 0 with a remainder. Basis
   * 'revenue' when gross profit is n/m: revenue less the measured cost lines.
   */
  unreconciled: { annualized: number | null; pct: number | null; basis: 'grossProfit' | 'revenue' };
  belowLine: { toHolders: number | null; toProtocol: number | null; notMeasured: string[]; lines: IsBelowLineOut[] };
  holderFlow: {
    /** USD a year reaching holders; null when a holders line is not measured. */
    gross: number | null;
    /** Gross after the haircuts (spec §7). */
    net: number | null;
    /** Net less dilution (emissions + releases at price, USD a year): spec §6 "net holder flow". */
    netOfDilution: number | null;
    /** Growth of every line with a daily series, each net of its haircut (v1 holderFlowGrowth). */
    growth: Growth;
    byBucket: Record<Bucket, BucketFlow | null>;
    fromRevenue: number | null;
    fromBelowLine: number | null;
    notMeasured: string[];
    lines: HolderFlowLineOut[];
  };
  /**
   * The statement's `volume` series (v1's volume figure): null without a volume block. For `volume: { not_measured }`
   * no metrics, no figure (never 0) and `notMeasured` = the reason; the list form has no `notMeasured` key.
   */
  volume: { metrics: string[]; annualized: number | null; growth: Growth; notMeasured?: string } | null;
  dilution: {
    /** Annual supply growth from emissions and releases (v1 yields.dilution). */
    pct: number | null;
    /** Tokens a year added: emissions plus releases (null when either is unread). */
    tokensPerYear: number | null;
    emissionsPerYear: number | null;
    releases: { id: string; tokensPerYear: number | null; yield: number | null }[];
    supply: SupplyFlow;
  };
  ratios: {
    takeRate: number | null;
    payoutRatio: number | null;
    payoutRatioBasis: 'grossProfit' | 'revenue';
  };
  /** At Orion's day-end price: market cap over revenue, gross profit and net holder flow. */
  multiples: {
    mcapToRevenue: number | null;
    mcapToGrossProfit: number | null;
    mcapToHolderFlow: Record<Bucket | 'total', number | null>;
  };
  yields: Yields;
  /** USD a year per token (circulating supply), for the site's live-price layer (spec §7 amendment 2026-10-28). */
  perToken: PerToken & {
    circulatingSupply: number | null;
    totalSupply: number | null;
    supplyAsOf: string | null;
    /** The same figures per token of total supply. */
    perTokenFdv: PerToken;
  };
  priceBasis: {
    /** The price the yields and multiples use: the latest price level at the report's as-of. */
    price: number | null;
    metric: string;
    sourceType: SourceType | null;
    source: string | null;
    day: string;
    asOf: string | null;
    /** How the flows are priced (each line's `priceBasis` says which basis its days are on). */
    flows: string;
  };
  /**
   * The reconciliation checks (spec §5) as the tick stored them for this day, by check id: none when the day was never
   * evaluated. `gapPct` is |lhs - rhs| / max(|lhs|, |rhs|) x 100; lhs/rhs/gapPct are null when a side had no row.
   */
  checks: IsCheckOut[];
  provenance: {
    /** Share of revenue by method (null without a positive revenue). */
    methods: { measured: number | null; derived: number | null; disclosed: number | null };
    /** Every line (section.id) whose series still sits on a third-party source. */
    thirdParty: string[];
    sources: string[];
    basis: 'config' | 'observations';
  };
  /** Display flags: not-measured lines, third-party lines, the payout ratio basis. */
  flags: string[];
}

export interface IsCheckOut {
  id: string;
  type: string;
  status: 'ok' | 'breach' | 'incomplete';
  lhs: number | null;
  rhs: number | null;
  gapPct: number | null;
  tolerancePct: number | null;
  evaluatedAt: string;
}

export interface PerToken {
  revenue: number | null;
  grossProfit: number | null;
  /** Net holder flow (after haircuts) per token, in total and by bucket, and net of dilution. */
  holderFlow: { total: number | null; netOfDilution: number | null; byBucket: Record<Bucket, number | null> };
  /** Dilution in USD a year (supply growth × FDV) per token. */
  dilution: number | null;
}

const finite = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
const noSeries = (note: string): Growth => ({ current: null, prior: null, change: null, annualized: null, note });
const sumOrNull = (xs: (number | null)[]): number | null => (xs.some((x) => !finite(x)) ? null : xs.reduce<number>((s, x) => s + x!, 0));
const div = (a: number | null, b: number | null): number | null => (finite(a) && finite(b) && b > 0 ? a / b : null);
const neg = (t: Term[]): Term[] => t.map((x) => ({ metric: x.metric, w: -x.w, gw: -x.gw }));
const scale = (t: Term[], k: number): Term[] => t.map((x) => ({ metric: x.metric, w: x.w * k, gw: x.gw * k }));
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export function incomeStatementV2(input: ReportInput): IsV2 {
  const { asset, day, levels: lv } = input;
  const is = asset.income_statement;
  if (!is) throw new Error(`assets/${asset.id}.yaml has no income_statement block`);
  const W = is.window_days;
  const metricDef = (m: string): MetricDef | undefined => asset.metrics[m];
  const typesOf = (metrics: (string | undefined)[]): SourceType[] =>
    uniq(metrics.filter((m): m is string => m !== undefined).map((m) => (metricDef(m) ? sourceTypeOf(metricDef(m)!, asset.metrics) : null)).filter((t): t is SourceType => t !== null));
  /** The rungs of the cross_checks on the metrics a line reads. */
  const crossTypesOf = (metrics: (string | undefined)[]): SourceType[] =>
    uniq(metrics.filter((m): m is string => m !== undefined).flatMap((m) => (metricDef(m) ? crossCheckTypesOf(metricDef(m)!, asset.metrics) : [])));
  // The disclosed line's levels (the loader reads the metric its `disclosed` key names).
  const disclosedSeries = lv.disclosed;

  // A line is zero before it began: days before `started` are filled with 0 (as v1 did for its revenue streams).
  const daily = new Map(input.daily);
  for (const r of is.revenue) {
    const m = r.metric ?? r.derived?.from;
    if (m === undefined || r.started === undefined) continue;
    const filled = new Map(daily.get(m) ?? new Map<string, number>());
    for (let i = 0; i < 2 * W; i++) {
      const d = addDays(day, -i);
      if (d < r.started && !filled.has(d)) filled.set(d, 0);
    }
    daily.set(m, filled);
  }
  const daysIn = (started: string | undefined): number | null => {
    if (started === undefined) return null;
    const n = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${started}T00:00:00Z`)) / 86_400_000) + 1;
    return n >= W ? null : Math.max(n, 0);
  };
  /** A line younger than the window is annualized over its own days (its run rate). */
  const youngWeight = (started: string | undefined): number => {
    const n = daysIn(started);
    return n === null || n === 0 ? 1 : W / n;
  };

  const annual = (terms: Term[]): number | null => {
    let s = 0;
    for (const t of terms) {
      const x = windowSum(daily, [t.metric], day, W);
      if (x === null) return null;
      s += x * t.w;
    }
    return (s * DAYS_PER_YEAR) / W;
  };
  const grow = (terms: Term[]): Growth =>
    terms.length === 0 ? { current: 0, prior: 0, change: null, annualized: null, note: 'no lines' } : growthOf(daily, terms.map((t) => t.metric), day, W, terms.map((t) => t.gw));

  // Revenue lines: their value sources, in YAML order.
  const revValue = new Map<string, Value>();
  const revenueValue = (r: IsRevenueLine): Value => {
    const known = revValue.get(r.id);
    if (known) return known;
    let v: Value;
    if (r.not_measured !== undefined) v = { kind: 'nm', reason: r.not_measured };
    else if (r.metric !== undefined) v = { kind: 'terms', terms: [{ metric: r.metric, w: youngWeight(r.started), gw: 1 }] };
    else if (r.derived !== undefined) v = { kind: 'terms', terms: [{ metric: r.derived.from, w: youngWeight(r.started) / r.derived.share, gw: 1 / r.derived.share }] };
    else if (r.disclosed !== undefined) {
      const g = disclosedGrowthOf(disclosedSeries, day);
      v = { kind: 'level', value: g.latest?.value ?? null, note: 'a disclosed level: no daily series', growth: g.growth };
    }
    else {
      const base = is.revenue.find((x) => x.id === r.estimate!.of)!;
      v = ratioOf(revenueValue(base), r.estimate!.ratio);
    }
    revValue.set(r.id, v);
    return v;
  };
  const ratioOf = (v: Value, k: number): Value => (v.kind === 'terms' ? { kind: 'terms', terms: scale(v.terms, k) } : v.kind === 'level' ? { kind: 'level', value: finite(v.value) ? v.value * k : null, note: v.note } : v);
  const revenueById = new Map(is.revenue.map((r) => [r.id, r] as const));
  /** The metrics a revenue line reads (an estimate: those of the line it is a ratio of). */
  const revenueMetrics = (r: IsRevenueLine): (string | undefined)[] =>
    r.estimate !== undefined ? revenueMetrics(revenueById.get(r.estimate.of)!) : [r.metric, r.derived?.from, r.derived?.share_metric, r.disclosed];
  const revenueTypes = (r: IsRevenueLine): SourceType[] => typesOf(revenueMetrics(r));
  const revenueMethod = (r: IsRevenueLine): IsMethod =>
    r.not_measured !== undefined ? 'not_measured' : r.disclosed !== undefined ? 'disclosed' : r.metric !== undefined ? 'measured' : 'derived';

  /** An apportioned line's split over the window (Task 7b): window sum of `by` / window sum of `total`, never over 0. */
  const mixOf = (a: IsApportion): ApportionOut => {
    const bySum = windowSum(daily, [a.by], day, W);
    const totalSum = windowSum(daily, [a.total], day, W);
    const mix = finite(bySum) && finite(totalSum) && totalSum !== 0 ? bySum / totalSum : null;
    return { by: a.by, total: a.total, mix, bySum, totalSum, formula: APPORTION_FORMULA };
  };
  /** Why an apportioned line has no mix (null when it has one). */
  const noMixReason = (x: ApportionOut): string | null =>
    x.mix !== null ? null : x.bySum === null || x.totalSum === null ? `a day of ${x.by} or ${x.total} is missing` : `the window sum of ${x.total} is 0`;
  /**
   * The flow x the mix: one term weighted by the mix (its growth too: the window's mix applied to both windows). With no
   * mix, a null level: the line, and every total built on it, is null (never zero-filled, never divided by zero).
   */
  const apportionValue = (metric: string, a: IsApportion): Value => {
    const x = mixOf(a);
    return x.mix === null ? { kind: 'level', value: null, note: `apportion mix n/a: ${noMixReason(x)}` } : { kind: 'terms', terms: [{ metric, w: x.mix, gw: x.mix }] };
  };
  const apportionMetrics = (a: IsApportion | undefined): string[] => (a === undefined ? [] : [a.by, a.total]);
  /** A use line's value: its own metric (apportioned or whole), `of` a revenue line (times share), an estimate of one, or not measured. */
  const useValue = (l: IsUseLine | IsHolderLine | IsCostLine): Value => {
    const u = resolveUse(is, l);
    if (l.not_measured !== undefined) return { kind: 'nm', reason: l.not_measured };
    if (l.of !== undefined) return ratioOf(revenueValue(u.revenue!), u.share);
    if (l.metric !== undefined && l.apportion !== undefined) return apportionValue(l.metric, l.apportion);
    if (l.metric !== undefined) return { kind: 'terms', terms: [{ metric: l.metric, w: 1, gw: 1 }] };
    return ratioOf(revenueValue(revenueById.get(l.estimate!.of)!), l.estimate!.ratio);
  };
  /** The metrics a use line reads: its own, or those of the revenue line it passes on or estimates from. */
  const useMetrics = (l: IsUseLine | IsHolderLine | IsCostLine): (string | undefined)[] =>
    l.of !== undefined ? revenueMetrics(revenueById.get(l.of)!) : l.estimate !== undefined ? revenueMetrics(revenueById.get(l.estimate.of)!) : [l.metric, ...apportionMetrics(l.apportion)];
  const useTypes = (l: IsUseLine | IsHolderLine | IsCostLine): SourceType[] => typesOf(useMetrics(l));
  const useMethod = (l: IsUseLine | IsHolderLine | IsCostLine): IsMethod => {
    if (l.not_measured !== undefined) return 'not_measured';
    if (l.apportion !== undefined) return 'derived';
    if (l.of !== undefined) {
      const m = revenueMethod(revenueById.get(l.of)!);
      return m === 'measured' && (l.share ?? 1) !== 1 ? 'derived' : m;
    }
    return l.metric !== undefined ? 'measured' : 'derived';
  };
  const valueAnnual = (v: Value): number | null => (v.kind === 'terms' ? annual(v.terms) : v.kind === 'level' ? v.value : null);
  const valueGrowth = (v: Value): Growth => (v.kind === 'terms' ? grow(v.terms) : v.kind === 'level' ? (v.growth ?? noSeries(v.note)) : noSeries('not measured'));

  /** A section's figure over its measured lines: one pass over the terms, plus any levels. */
  interface Agg {
    terms: Term[];
    levels: (number | null)[];
    nm: string[];
  }
  const agg = (items: { id: string; v: Value }[]): Agg => ({
    terms: items.flatMap((x) => (x.v.kind === 'terms' ? x.v.terms : [])),
    levels: items.flatMap((x) => (x.v.kind === 'level' ? [x.v.value] : [])),
    nm: items.filter((x) => x.v.kind === 'nm').map((x) => x.id),
  });
  const aggAnnual = (a: Agg): number | null => {
    const t = annual(a.terms);
    if (a.levels.length === 0) return t;
    return sumOrNull([t, ...a.levels]);
  };
  const aggGrowth = (a: Agg, levelNote: string): Growth => (a.levels.length > 0 ? noSeries(levelNote) : grow(a.terms));

  // Revenue.
  const revItems = is.revenue.map((r) => ({ id: r.id, v: revenueValue(r) }));
  const revAgg = agg(revItems);
  const revenueAnnual = revAgg.nm.length > 0 ? null : aggAnnual(revAgg);
  const pending = (m: string | undefined): number => {
    const p = m === undefined ? undefined : input.provisional?.get(m);
    let n = 0;
    if (p) for (let i = 0; i < W; i++) if (p.has(addDays(day, -i))) n++;
    return n;
  };
  /** A disclosed line's cross-check series over the window (v1's `revenue.crossCheck` arithmetic), with its rung. */
  const crossCheckOf = (m: string): NonNullable<IsRevenueLineOut['crossCheck']> => {
    const sum = windowSum(daily, [m], day, W);
    return { metric: m, annualized: sum === null ? null : (sum * DAYS_PER_YEAR) / W, sourceType: metricDef(m) ? sourceTypeOf(metricDef(m)!, asset.metrics) : null };
  };
  // Provenance from the stored rows (spec §3, Task 6). Basis `observations` whenever the loader passed the rows'
  // provenance (since 0006 every stored row has a method, so there is no unbackfilled window to fall back from); `config`
  // only for a pure input without it (the config's labels).
  const rowProv = input.provenance;
  const windowDaysList = Array.from({ length: W }, (_, i) => addDays(day, -i));
  const termMetrics = (v: Value): string[] => (v.kind === 'terms' ? uniq(v.terms.map((t) => t.metric)) : []);
  const basisObservations = rowProv !== undefined;
  /** Days of the window on which every series the line reads comes from a measured row (basis observations only). */
  const measuredDays = (v: Value): number | null => {
    const ms = termMetrics(v);
    if (ms.length === 0) return null;
    return windowDaysList.filter((d) => ms.every((m) => rowProv!.get(m)?.get(d)?.method === 'measured')).length;
  };
  // Task 8: the basis of every USD day a line's figures read (the loader's `priceBasis`; absent, every day is the stored
  // USD): the window and growth's prior window, since a line's growth reads the same series over both (fix round 1, M-1).
  const dayBasis = input.priceBasis;
  const basisDaysList = Array.from({ length: 2 * W }, (_, i) => addDays(day, -i));
  const basisOf = (...vs: Value[]): LinePriceBasis => {
    const seen = new Set<PriceBasis>();
    for (const m of uniq(vs.flatMap(termMetrics)).filter((x) => x.startsWith('flow_usd.'))) {
      for (const d of basisDaysList) if (input.daily.get(m)?.has(d) === true) seen.add(dayBasis?.get(m)?.get(d) ?? 'legacy');
    }
    return seen.size === 0 ? null : seen.size === 1 ? [...seen][0]! : 'mixed';
  };
  const revLines: IsRevenueLineOut[] = is.revenue.map((r) => {
    const v = revenueValue(r);
    const metric = r.metric ?? r.derived?.from;
    const age = r.started === undefined ? null : Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${r.started}T00:00:00Z`)) / 86_400_000) + 1;
    let ws: number | null = null;
    if (v.kind === 'terms') {
      let s = 0;
      for (const t of v.terms) {
        const x = windowSum(daily, [t.metric], day, W);
        if (x === null) {
          s = NaN;
          break;
        }
        s += x * t.gw;
      }
      ws = Number.isNaN(s) ? null : s;
    }
    return {
      id: r.id, label: r.label ?? null, method: revenueMethod(r), sourceTypes: revenueTypes(r), priceBasis: basisOf(v),
      annualized: valueAnnual(v), windowSum: ws, settlement: v.kind === 'terms' ? (r.settlement ?? 'daily') : null, started: r.started ?? null,
      daysMeasured: v.kind !== 'terms' ? null : basisObservations ? measuredDays(v) : daysIn(r.started), provisionalDays: pending(metric), coverage: null,
      isNew: age !== null && age < NEW_STREAM_DAYS, growth: valueGrowth(v),
      ...(r.disclosed !== undefined ? { disclosedGrowth: disclosedGrowthOf(disclosedSeries, day).disclosedGrowth } : {}),
      ...(r.cross_check !== undefined ? { crossCheck: crossCheckOf(r.cross_check) } : {}),
      ...(r.not_measured !== undefined ? { notMeasured: r.not_measured } : {}),
    };
  });
  // A disclosed line is the whole revenue (schema): revenue growth is its disclosure-to-disclosure growth, as v1's.
  const disclosedLine = is.revenue.find((r) => r.disclosed !== undefined);
  const revenueGrowth =
    revAgg.nm.length > 0 ? noSeries('a revenue line is not measured') : disclosedLine ? valueGrowth(revenueValue(disclosedLine)) : aggGrowth(revAgg, 'a disclosed level: no daily series');
  const newIds = revLines.filter((l) => l.isNew).map((l) => l.id);
  const oldAgg = agg(revItems.filter((x) => !newIds.includes(x.id)));
  const growthExNew = newIds.length === 0 || revAgg.levels.length > 0 ? null : oldAgg.terms.length === 0 ? noSeries('every line is new') : grow(oldAgg.terms);

  // Cost of revenue and gross profit.
  const costItems = (is.cost_of_revenue ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const costAgg = agg(costItems);
  /** Cost lines read as a level (a run rate, an apportioned line with no mix) that have no value. */
  const costNoReading = costItems.filter((x) => x.v.kind === 'level' && !finite(x.v.value)).map((x) => x.id);
  const costMeasured = aggAnnual(costAgg);
  const costAnnual = costAgg.nm.length > 0 ? null : costMeasured;
  const hasLevel = revAgg.levels.length > 0 || costAgg.levels.length > 0;
  const grossProfit =
    costAgg.nm.length > 0 || revenueAnnual === null ? null : hasLevel ? (finite(costMeasured) ? revenueAnnual - costMeasured : null) : annual([...revAgg.terms, ...neg(costAgg.terms)]);
  const grossProfitGrowth = costAgg.nm.length > 0 ? noSeries('cost of revenue not measured') : hasLevel ? noSeries('a disclosed level: no daily series') : grow([...revAgg.terms, ...neg(costAgg.terms)]);
  /** Revenue less the measured costs: gross profit when every cost is measured. */
  const base = grossProfit ?? (finite(revenueAnnual) && finite(costMeasured) ? revenueAnnual - costMeasured : null);

  // Uses.
  const useLine = (l: IsUseLine | IsHolderLine | IsCostLine): IsUseLineOut => {
    const v = useValue(l);
    return {
      id: l.id, label: l.label ?? null, of: l.of ?? null, share: l.share ?? 1, method: useMethod(l), sourceTypes: useTypes(l), priceBasis: basisOf(v),
      annualized: valueAnnual(v), growth: valueGrowth(v), ...(l.note ? { note: l.note } : {}), ...(l.not_measured !== undefined ? { notMeasured: l.not_measured } : {}),
      ...(l.apportion !== undefined ? { apportion: mixOf(l.apportion) } : {}),
    };
  };
  const holderItems = (is.holders ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const protocolItems = (is.protocol ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const opexItems = (is.operating_costs ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const holdersAgg = agg(holderItems);
  const protocolAgg = agg(protocolItems);
  const opexAgg = agg(opexItems);
  // A not_measured line makes its section's total null, as a not_measured cost does to gross profit (never zero-filled).
  const sectionAnnual = (a: Agg): number | null => (a.nm.length > 0 ? null : aggAnnual(a));
  const sectionGrowth = (a: Agg, levelNote: string): Growth => (a.nm.length > 0 ? noSeries(`not measured: ${a.nm.join(', ')}`) : aggGrowth(a, levelNote));
  const holdersAnnual = sectionAnnual(holdersAgg);

  // The remainder: revenue less the measured rest, in v1's term order (revenue, -holders, -costs, -the other use). Null
  // when holders or the other use has a line not measured: the rest is then unknown.
  const anyLevel = hasLevel || [holdersAgg, protocolAgg, opexAgg].some((a) => a.levels.length > 0);
  const remainderOf = (other: Agg): { annualized: number | null; growth: Growth } => {
    const nm = [...holdersAgg.nm, ...other.nm];
    if (nm.length > 0) return { annualized: null, growth: noSeries(`not measured: ${nm.join(', ')}`) };
    if (anyLevel) {
      const o = aggAnnual(other);
      return { annualized: finite(base) && finite(holdersAnnual) && finite(o) ? base - holdersAnnual - o : null, growth: noSeries('a disclosed level less daily flows') };
    }
    const terms = [...revAgg.terms, ...neg(holdersAgg.terms), ...neg(costAgg.terms), ...neg(other.terms)];
    return { annualized: revenueAnnual === null ? null : annual(terms), growth: grow(terms) };
  };
  const section = (a: Agg, lines: IsUseLineOut[], isRemainder: boolean, other: Agg): UseSectionOut<IsUseLineOut> => {
    if (!isRemainder) return { annualized: sectionAnnual(a), growth: sectionGrowth(a, 'a disclosed level: no daily series'), remainder: false, notMeasured: a.nm, lines };
    const r = remainderOf(other);
    const priceBasis = basisOf({ kind: 'terms', terms: [...revAgg.terms, ...costAgg.terms, ...holdersAgg.terms, ...other.terms] });
    const note = costAgg.nm.length > 0 ? 'revenue less holders and the other uses, before the costs not measured' : 'revenue less the rest';
    return {
      annualized: r.annualized, growth: r.growth, remainder: true, notMeasured: [...holdersAgg.nm, ...other.nm],
      lines: [{ id: 'remainder', label: null, of: null, share: 1, method: 'derived', sourceTypes: [], priceBasis, annualized: r.annualized, growth: r.growth, note }],
    };
  };
  const protocol = section(protocolAgg, (is.protocol ?? []).map(useLine), is.remainder === 'protocol', opexAgg);
  const operatingCosts = section(opexAgg, (is.operating_costs ?? []).map(useLine), is.remainder === 'operating_costs', protocolAgg);
  // Unreconciled = gross profit (or revenue less the measured costs) less holders, protocol and operating costs: exactly 0
  // with a declared remainder, and exactly 0 when every series cancels (each use passes on a revenue line whole, the CRV
  // and liquid-locker shape), so no float residue is shown. Otherwise it is computed from the totals (a level in play, or
  // a real gap such as yCRV's), in expected.py's order.
  const reconciles = (): boolean => {
    if (anyLevel) return false;
    const pos = [...revAgg.terms];
    for (const t of [...costAgg.terms, ...holdersAgg.terms, ...protocolAgg.terms, ...opexAgg.terms]) {
      const i = pos.findIndex((p) => p.metric === t.metric && p.w === t.w);
      if (i < 0) return false;
      pos.splice(i, 1);
    }
    return pos.length === 0;
  };
  const unreconciledAnnual =
    is.remainder !== undefined
      ? finite(protocol.annualized) && finite(operatingCosts.annualized) && finite(base)
        ? 0
        : null
      : finite(base) && finite(holdersAnnual) && finite(protocol.annualized) && finite(operatingCosts.annualized)
        ? reconciles()
          ? 0
          : base - holdersAnnual - protocol.annualized - operatingCosts.annualized
        : null;

  // Holder flow: holders lines at their recipients (paid_metric when set), then below-line lines to holders.
  const price = lv.price;
  const yieldOf = (net: number | null, b: RecipientBase): number | null => {
    const n = recipients(b, lv);
    if (!finite(net) || !finite(price) || !finite(n) || !(n > 0) || !(price > 0)) return null;
    return net / (n * price);
  };
  const flowGross = (v: Value): number | null => {
    if (v.kind === 'level') return v.value;
    if (v.kind === 'nm') return null;
    // One series: v1's FlowLine arithmetic (window sum scaled to a year, then the run-rate weight).
    if (v.terms.length === 1) {
      const s = windowSum(daily, [v.terms[0].metric], day, W);
      return s === null ? null : ((s * DAYS_PER_YEAR) / W) * v.terms[0].w;
    }
    return annual(v.terms);
  };
  interface FlowSpec {
    id: string;
    section: 'holders' | 'below_line';
    v: Value;
    bucket: Bucket | null;
    haircut: number;
    base: RecipientBase;
    method: IsMethod;
    sourceTypes: SourceType[];
    /** An apportioned line's set: the flow it splits and the total it is apportioned over. */
    set?: { metric: string; total: string };
  }
  type FlowLine = HolderFlowLineOut & { terms: Term[]; set?: FlowSpec['set'] };
  const flowLine = (s: FlowSpec): FlowLine => {
    const { v } = s;
    const gross = flowGross(v);
    const net = gross === null ? null : gross * (1 - s.haircut);
    const terms = v.kind === 'terms' ? v.terms : [];
    return {
      id: s.id, section: s.section, fromBelowLine: s.section === 'below_line', bucket: s.bucket, method: s.method, sourceTypes: s.sourceTypes, priceBasis: basisOf(v),
      metric: terms.length === 1 ? terms[0].metric : null, haircut: s.haircut, recipientBase: s.base,
      gross, net, yield: yieldOf(net, s.base),
      growth: v.kind === 'terms' ? growthOf(daily, terms.map((t) => t.metric), day, W, terms.map((t) => t.gw)) : v.kind === 'level' ? noSeries('a run-rate level: no daily series') : noSeries('not measured'),
      ...(v.kind === 'nm' ? { notMeasured: v.reason } : {}),
      terms,
      ...(s.set ? { set: s.set } : {}),
    };
  };
  const setOf = (metric: string | undefined, a: IsApportion | undefined): FlowSpec['set'] => (metric !== undefined && a !== undefined ? { metric, total: a.total } : undefined);
  const holderFlowLines: FlowLine[] = [];
  const holderLines: IsHolderLineOut[] = (is.holders ?? []).map((l) => {
    const v = l.paid_metric !== undefined ? ({ kind: 'terms', terms: [{ metric: l.paid_metric, w: 1, gw: 1 }] } as Value) : useValue(l);
    const sourceTypes = uniq([...useTypes(l), ...typesOf([l.paid_metric])]);
    const f = flowLine({ id: l.id, section: 'holders', v, bucket: l.bucket, haircut: l.haircut, base: l.recipient_base, method: useMethod(l), sourceTypes, set: setOf(l.metric, l.apportion) });
    holderFlowLines.push(f);
    return {
      ...useLine(l), sourceTypes, priceBasis: basisOf(useValue(l), v),
      bucket: l.bucket, haircut: l.haircut, recipientBase: l.recipient_base, valuedPer: l.valued_per ?? null, captureRule: l.capture_rule,
      paidMetric: l.paid_metric ?? null, gross: f.gross, net: f.net, yield: f.yield,
    };
  });
  const belowValue = (b: IsBelowLine): Value =>
    b.not_measured !== undefined
      ? { kind: 'nm', reason: b.not_measured }
      : b.metric !== undefined
        ? b.apportion !== undefined
          ? apportionValue(b.metric, b.apportion)
          : { kind: 'terms', terms: [{ metric: b.metric, w: 1, gw: 1 }] }
        : { kind: 'level', value: lv.extra[b.run_rate!] ?? null, note: 'a run-rate level: no daily series' };
  const belowLines: IsBelowLineOut[] = (is.below_line ?? []).map((b) => {
    const v = belowValue(b);
    const method: IsMethod = b.not_measured !== undefined ? 'not_measured' : b.apportion !== undefined ? 'derived' : 'measured';
    const sourceTypes = typesOf([b.metric, b.run_rate, ...apportionMetrics(b.apportion)]);
    if (b.to === 'holders') {
      holderFlowLines.push(flowLine({ id: b.id, section: 'below_line', v, bucket: b.bucket ?? null, haircut: b.haircut ?? 0, base: b.recipient_base ?? 'all', method, sourceTypes, set: setOf(b.metric, b.apportion) }));
    }
    return {
      id: b.id, label: b.label ?? null, to: b.to, method, sourceTypes, priceBasis: basisOf(v),
      annualized: valueAnnual(v), growth: valueGrowth(v), bucket: b.bucket ?? null, haircut: b.haircut ?? null, recipientBase: b.recipient_base ?? null,
      captureRule: b.capture_rule ?? null, ...(b.note ? { note: b.note } : {}), ...(b.not_measured !== undefined ? { notMeasured: b.not_measured } : {}),
      ...(b.apportion !== undefined ? { apportion: mixOf(b.apportion) } : {}),
    };
  });
  /**
   * The measured sum of `lines`, with the not-measured ones listed elsewhere: 0 with no line, and null when there are
   * lines but none is measured (a not-measured figure is never published as 0).
   */
  const measuredSum = <T>(lines: T[], measured: (x: T) => boolean, value: (x: T) => number | null): number | null => {
    const m = lines.filter(measured);
    return lines.length > 0 && m.length === 0 ? null : sumOrNull(m.map(value));
  };
  const measuredBelow = (to: 'holders' | 'protocol') => measuredSum(belowLines.filter((b) => b.to === to), (b) => b.method !== 'not_measured', (b) => b.annualized);
  const belowNm = belowLines.filter((b) => b.method === 'not_measured').map((b) => b.id);

  // A not_measured holders line leaves holder flow unknown (its totals and its bucket null); a not_measured below-line
  // line is listed and kept out of the measured sums (v1 has no such line, so AERO's totals stay v1's).
  const counted = holderFlowLines.filter((f) => f.notMeasured === undefined);
  // What holder flow sums (Task 7b): each line, except that an apportion set whose lines all reach holders alike (one
  // bucket, haircut and recipient base) counts as its whole flow, once: the set's lines split the flow between from
  // revenue and below the line, and holder flow, its net, buckets, yields and growth stay those of the flow (v1's, to
  // the bit). Set members are every apportioned line, in any section, reading the same flow over the same total.
  const setKey = (x: { metric: string; total: string }) => `${x.metric}|${x.total}`;
  const setSize = new Map<string, number>();
  for (const l of [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? []), ...(is.below_line ?? [])]) {
    const k = setOf(l.metric, l.apportion);
    if (k) setSize.set(setKey(k), (setSize.get(setKey(k)) ?? 0) + 1);
  }
  const units: FlowLine[] = [];
  const collapsed = new Set<string>();
  for (const f of counted) {
    if (f.set === undefined) {
      units.push(f);
      continue;
    }
    const k = setKey(f.set);
    if (collapsed.has(k)) continue;
    const members = counted.filter((x) => x.set !== undefined && setKey(x.set) === k);
    const alike = members.length === setSize.get(k) && members.every((x) => x.bucket === f.bucket && x.haircut === f.haircut && x.recipientBase === f.recipientBase);
    if (!alike) {
      units.push(f);
      continue;
    }
    collapsed.add(k);
    units.push(flowLine({ id: k, section: f.section, v: { kind: 'terms', terms: [{ metric: f.set.metric, w: 1, gw: 1 }] }, bucket: f.bucket, haircut: f.haircut, base: f.recipientBase, method: f.method, sourceTypes: f.sourceTypes }));
  }
  const hfNm = holderFlowLines.filter((f) => f.notMeasured !== undefined).map((f) => f.id);
  const holdersNm = holderFlowLines.filter((f) => f.section === 'holders' && f.notMeasured !== undefined);
  const fromRevenueOf = (ls: typeof holderFlowLines): number | null => sumOrNull(ls.filter((f) => !f.fromBelowLine).map((f) => f.gross));
  const fromBelowOf = (ls: typeof holderFlowLines): number | null =>
    measuredSum(ls.filter((f) => f.fromBelowLine), (f) => f.notMeasured === undefined, (f) => f.gross);
  const byBucket = Object.fromEntries(
    BUCKETS.map((bk) => {
      const ls = counted.filter((f) => f.bucket === bk);
      const us = units.filter((f) => f.bucket === bk);
      const nmHere = holdersNm.filter((f) => f.bucket === bk);
      if (ls.length === 0 && nmHere.length === 0) return [bk, null];
      const unknown = nmHere.length > 0;
      // A below-line line not measured names no bucket (AERO's bribes): it may land in any bucket.
      const below = holderFlowLines.filter((f) => f.fromBelowLine && (f.bucket === bk || (f.bucket === null && f.notMeasured !== undefined)));
      return [bk, {
        gross: unknown ? null : sumOrNull(us.map((f) => f.gross)), net: unknown ? null : sumOrNull(us.map((f) => f.net)), yield: unknown ? null : sumOrNull(us.map((f) => f.yield)),
        fromRevenue: unknown ? null : fromRevenueOf(ls), fromBelowLine: fromBelowOf(below),
      }];
    }),
  ) as Record<Bucket, BucketFlow | null>;
  const series = units.filter((f) => f.terms.length > 0 && f.terms.every((t) => daily.has(t.metric)));
  const holderFlowGrowth =
    holdersNm.length > 0
      ? noSeries(`not measured: ${holdersNm.map((f) => f.id).join(', ')}`)
      : growthOf(daily, series.flatMap((f) => f.terms.map((t) => t.metric)), day, W, series.flatMap((f) => f.terms.map((t) => (1 - f.haircut) * t.gw)));
  const hfNet = holdersNm.length > 0 ? null : sumOrNull(units.map((f) => f.net));

  // Yields, dilution and the supply line (spec §7 "as today"): v1's arithmetic, term for term, on the units above (each
  // the series a retired holder flow, revenue stream or extra_cash line read, in that order), so the figures are v1's
  // to the bit. A bucket with no line is 0 in the yields; a missing value anywhere makes the sum null.
  const eff = lv.totalSupply;
  const fdv = finite(price) && finite(eff) ? price * eff : null;
  const strictSum = (xs: (number | null)[]): number | null => (xs.length === 0 || xs.some((x) => x === null) ? null : xs.reduce<number>((s, x) => s + x!, 0));
  const cashYield = byBucket.cash ? byBucket.cash.yield : 0;
  const bb = [byBucket.burn, byBucket.hold].filter((x): x is BucketFlow => x !== null);
  const buybackYield = bb.length === 0 ? 0 : strictSum(bb.map((x) => x.yield));
  const shareholder = cashYield === null || buybackYield === null ? null : cashYield + buybackYield;
  // Emissions plus any release outside the schedule (income_statement.dilution), each capped by what is approved.
  const releaseRates = (is.dilution ?? []).map((d) => {
    const x = lv.dilution?.[d.id];
    if (!x || !finite(x.rate)) return null;
    return d.cap_metric === undefined ? x.rate : finite(x.cap) ? Math.min(x.rate, x.cap) : null;
  });
  const released = strictSum(releaseRates);
  const dilutionPct =
    finite(lv.emissionRateAnnual) && finite(eff) && eff > 0 && (is.dilution === undefined || released !== null) ? (lv.emissionRateAnnual + (released ?? 0)) / eff : null;
  const releases = (is.dilution ?? []).map((d, i) => ({ id: d.id, tokensPerYear: releaseRates[i]!, yield: finite(releaseRates[i]!) && finite(eff) && eff > 0 ? releaseRates[i]! / eff : null }));
  const netShareholder = shareholder === null || dilutionPct === null ? null : shareholder - dilutionPct;
  const multiple = shareholder !== null && shareholder > 0 ? 1 / shareholder : null;
  const hfg = holderFlowGrowth.annualized;
  const yields: Yields = {
    cash: cashYield, buyback: buybackYield, shareholder, dilution: dilutionPct, netShareholder, multiple,
    pegTrailing: multiple !== null && hfg !== null && hfg > 0 ? multiple / (hfg * 100) : null, ...(is.dilution ? { dilutionLines: releases } : {}),
  };
  let supply: SupplyFlow = null;
  if (is.burned_tokens) {
    const b = windowSum(daily, is.burned_tokens, day, W);
    const burnedPerYear = b === null ? null : (b * DAYS_PER_YEAR) / W;
    const addedPerYear = finite(lv.emissionRateAnnual) && (is.dilution === undefined || released !== null) ? lv.emissionRateAnnual + (released ?? 0) : null;
    const netPerYear = finite(burnedPerYear) && finite(addedPerYear) ? addedPerYear - burnedPerYear : null;
    supply = { burnedPerYear, addedPerYear, netPerYear, netPct: finite(netPerYear) && finite(eff) && eff > 0 ? netPerYear / eff : null };
  }
  // Dilution in USD a year: annual supply growth x FDV = (emissions + releases) x price.
  const dilutionUsd = finite(dilutionPct) && finite(fdv) ? dilutionPct * fdv : null;
  const holderFlow: IsV2['holderFlow'] = {
    gross: holdersNm.length > 0 ? null : sumOrNull(units.map((f) => f.gross)),
    net: hfNet,
    netOfDilution: finite(hfNet) && finite(dilutionUsd) ? hfNet - dilutionUsd : null,
    growth: holderFlowGrowth,
    byBucket,
    fromRevenue: holdersNm.length > 0 ? null : fromRevenueOf(counted),
    fromBelowLine: fromBelowOf(holderFlowLines),
    notMeasured: hfNm,
    lines: holderFlowLines.map(({ terms: _terms, set: _set, ...f }) => f),
  };

  const holdersByBucket = Object.fromEntries(
    BUCKETS.map((bk) => {
      const items = (is.holders ?? []).filter((l) => l.bucket === bk).map((l) => ({ id: l.id, v: useValue(l) }));
      return [bk, items.length === 0 ? null : { annualized: sectionAnnual(agg(items)) }];
    }),
  ) as Record<IsBucket, { annualized: number | null } | null>;

  // Ratios (D8, correction 14).
  const gpMeasured = grossProfit !== null;
  const payoutRatio = gpMeasured ? div(holdersAnnual, grossProfit) : div(holdersAnnual, revenueAnnual);

  const mcap = finite(price) && finite(lv.circulatingSupply) ? price * lv.circulatingSupply : null;
  const bucketNet = (bk: Bucket) => byBucket[bk]?.net ?? null;
  const multiples: IsV2['multiples'] = {
    mcapToRevenue: div(mcap, revenueAnnual),
    mcapToGrossProfit: div(mcap, grossProfit),
    mcapToHolderFlow: { burn: div(mcap, bucketNet('burn')), hold: div(mcap, bucketNet('hold')), cash: div(mcap, bucketNet('cash')), total: div(mcap, holderFlow.net) },
  };

  const circ = lv.circulatingSupply ?? null;
  const total = lv.totalSupply;
  // Per token: a positive supply only; netOfDilution may be negative, so it is divided directly.
  const perOf = (x: number | null, n: number | null): number | null => (finite(x) && finite(n) && n > 0 ? x / n : null);
  const per = (n: number | null): PerToken => ({
    revenue: div(revenueAnnual, n),
    grossProfit: div(grossProfit, n),
    holderFlow: {
      total: div(holderFlow.net, n), netOfDilution: perOf(holderFlow.netOfDilution, n),
      byBucket: { burn: div(bucketNet('burn'), n), hold: div(bucketNet('hold'), n), cash: div(bucketNet('cash'), n) },
    },
    dilution: div(dilutionUsd, n),
  });

  // Volume (v1's figure over the same series): the window's sum across the listed series, annualized, and its growth.
  const vol = is.volume;
  const volume: IsV2['volume'] = vol === undefined
    ? null
    : !Array.isArray(vol)
      ? { metrics: [], annualized: null, growth: noSeries('not measured'), notMeasured: vol.not_measured }
      : (() => {
          const s = windowSum(daily, vol, day, W);
          return { metrics: vol, annualized: s === null ? null : (s * DAYS_PER_YEAR) / W, growth: growthOf(daily, vol, day, W) };
        })();

  // Tokens a year added (v1's dilution numerator): emissions plus the income_statement.dilution releases (null when one
  // is unread).
  const tokensPerYear =
    dilutionPct === null || !finite(lv.emissionRateAnnual) || releases.some((r) => !finite(r.tokensPerYear))
      ? null
      : releases.reduce((s, r) => s + r.tokensPerYear!, lv.emissionRateAnnual);

  const priceDef = metricDef(STD_METRICS.price);

  // Provenance: the share of revenue by method, and every line on a third-party source. On basis `observations` a
  // metric line's annualized amount is split by the method of the row behind each day's value (a manual day is
  // disclosed); a provisional day and a derived or estimated line are derived; a level line keeps its line's method.
  const lineMethodSplit = (l: IsRevenueLineOut, v: Value): Partial<Record<IsMethod, number>> => {
    if (l.annualized === null) return {};
    if (!basisObservations || v.kind !== 'terms' || l.method !== 'measured') return { [l.method]: l.annualized };
    const by: Partial<Record<IsMethod, number>> = {};
    let total = 0;
    for (const t of v.terms) {
      for (const d of windowDaysList) {
        const x = input.daily.get(t.metric)?.get(d);
        if (x === undefined) continue;
        const m: IsMethod = input.provisional?.get(t.metric)?.has(d) ? 'derived' : (rowProv!.get(t.metric)?.get(d)?.method ?? l.method);
        by[m] = (by[m] ?? 0) + x * t.gw;
        total += x * t.gw;
      }
    }
    if (!(total > 0)) return { [l.method]: l.annualized };
    return Object.fromEntries(Object.entries(by).map(([m, x]) => [m, (l.annualized! * x) / total])) as Partial<Record<IsMethod, number>>;
  };
  const splits = revLines.map((l, i) => lineMethodSplit(l, revItems[i]!.v));
  const methodShare = (m: IsMethod): number | null => {
    if (!finite(revenueAnnual) || !(revenueAnnual > 0)) return null;
    if (basisObservations) {
      if (revLines.some((l) => l.annualized === null && l.method !== 'not_measured')) return null;
      return splits.reduce((s, x) => s + (x[m] ?? 0), 0) / revenueAnnual;
    }
    const ls = revLines.filter((l) => l.method === m);
    if (ls.length === 0) return 0;
    const s = sumOrNull(ls.map((l) => l.annualized));
    return s === null ? null : s / revenueAnnual;
  };
  // A line is listed as `<section>.<id>` when a series it reads is on a third-party source, `<section>.<id>.cross_check`
  // for a disclosed line's cross-check series, and `<section>.<id>.cross_checks` when a series it reads is cross-checked
  // against a third-party source (a metric-level `cross_checks` entry, e.g. DefiLlama holders revenue).
  const thirdParty: string[] = [];
  const tp = (name: string, types: SourceType[]) => {
    if (types.includes('third_party')) thirdParty.push(name);
  };
  for (const r of is.revenue) {
    tp(`revenue.${r.id}`, revenueTypes(r));
    if (r.cross_check !== undefined) tp(`revenue.${r.id}.cross_check`, typesOf([r.cross_check]));
    tp(`revenue.${r.id}.cross_checks`, crossTypesOf([...revenueMetrics(r), r.cross_check]));
  }
  for (const [name, lines] of [['cost_of_revenue', is.cost_of_revenue], ['holders', is.holders], ['protocol', is.protocol], ['operating_costs', is.operating_costs]] as const) {
    for (const l of (lines ?? []) as (IsUseLine | IsHolderLine)[]) {
      const own = [...useMetrics(l), l.share_metric, (l as IsHolderLine).paid_metric];
      tp(`${name}.${l.id}`, uniq([...useTypes(l), ...typesOf([(l as IsHolderLine).paid_metric])]));
      tp(`${name}.${l.id}.cross_checks`, crossTypesOf(own));
    }
  }
  for (const b of is.below_line ?? []) {
    tp(`below_line.${b.id}`, typesOf([b.metric, b.run_rate, ...apportionMetrics(b.apportion)]));
    tp(`below_line.${b.id}.cross_checks`, crossTypesOf([b.metric, b.run_rate, ...apportionMetrics(b.apportion)]));
  }
  const statementMetrics = uniq([
    ...is.revenue.flatMap((r) => [r.metric, r.derived?.from, r.derived?.share_metric, r.disclosed, r.cross_check]),
    ...[...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])].flatMap((l) => [l.metric, l.share_metric, (l as IsHolderLine).paid_metric, ...apportionMetrics(l.apportion)]),
    ...(is.below_line ?? []).flatMap((b) => [b.metric, b.run_rate, ...apportionMetrics(b.apportion)]),
  ].filter((m): m is string => m !== undefined));
  /** A metric's label from its config, in the rows' `<rung>:<what>` form (a level has no daily rows to read it from). */
  const configLabel = (m: string): string | null => {
    const def = metricDef(m);
    if (def?.source === undefined) return def ? sourceLabelOf(def) : null;
    const t = sourceTypeOf(def, asset.metrics);
    return t === null ? null : provenanceLabel(t, chainOfSource(asset, def.source), scrubLocator(locatorOfSource(asset, m, def.source)));
  };
  const sources = basisObservations
    ? uniq(
        statementMetrics.flatMap((m) => {
          const days = rowProv!.get(m);
          const inWindow = windowDaysList.flatMap((d) => (days?.get(d)?.label ? [days.get(d)!.label] : []));
          const own = inWindow.length > 0 ? inWindow : [configLabel(m)];
          return own.filter((s): s is string => s !== null);
        }),
      ).sort()
    : uniq(statementMetrics.map((m) => (metricDef(m) ? sourceLabelOf(metricDef(m)!) : null)).filter((s): s is string => s !== null)).sort();

  const flags: string[] = [];
  if (costAgg.nm.length > 0) flags.push(`cost of revenue not measured: ${costAgg.nm.join(', ')}`);
  if (revAgg.nm.length > 0) flags.push(`revenue not measured: ${revAgg.nm.join(', ')}`);
  const useNm = [...holderItems, ...protocolItems, ...opexItems].filter((x) => x.v.kind === 'nm').map((x) => x.id);
  if (useNm.length > 0) flags.push(`not measured: ${useNm.join(', ')}`);
  if (belowNm.length > 0) flags.push(`below the line not measured: ${belowNm.join(', ')}`);
  // An apportioned line with no mix (Task 7b), by reason: its figure is null, never a division by zero.
  const noMix = new Map<string, string[]>();
  for (const l of [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? []), ...(is.below_line ?? [])]) {
    if (l.apportion === undefined || l.metric === undefined) continue;
    const why = noMixReason(mixOf(l.apportion));
    if (why !== null) noMix.set(why, [...(noMix.get(why) ?? []), l.id]);
  }
  for (const [why, ids] of noMix) flags.push(`apportion mix n/a: ${ids.join(', ')} (${why})`);
  if (holdersAgg.nm.length > 0) flags.push(`payout ratio n/a: holders not measured: ${holdersAgg.nm.join(', ')}`);
  else if (!gpMeasured && costAgg.nm.length > 0) flags.push('payout ratio on revenue: cost of revenue not measured');
  // A cost level with no reading (T3/4 M-d, Task 11b) is neither a line nobody measures nor a missing day: say which.
  else if (!gpMeasured && revenueAnnual !== null && costNoReading.length > 0) flags.push(`payout ratio on revenue: cost of revenue has no reading: ${costNoReading.join(', ')}`);
  // A data gap (a measured line missing a day) is not a line nobody measures: say which.
  else if (!gpMeasured && revenueAnnual !== null) flags.push('payout ratio on revenue: cost of revenue has a missing day');
  for (const r of revLines) for (const f of r.disclosedGrowth?.flags ?? []) flags.push(`disclosed revenue: ${f}`);
  if (thirdParty.length > 0) flags.push(`third_party: ${thirdParty.join(', ')}`);

  return {
    schema: 2, day, windowDays: W, category: is.category, scope: is.scope,
    revenue: {
      annualized: revenueAnnual, growth: revenueGrowth, growthExNew, excludedFromExNew: newIds,
      provisional: revLines.some((l) => l.provisionalDays > 0), notMeasured: revAgg.nm, lines: revLines,
    },
    costOfRevenue: {
      annualized: costAnnual, measuredAnnualized: costMeasured, notMeasured: costAgg.nm,
      lines: (is.cost_of_revenue ?? []).map((l) => ({ ...useLine(l), to: l.to })),
    },
    grossProfit: { annualized: grossProfit, growth: grossProfitGrowth },
    holders: {
      annualized: holdersAnnual, growth: sectionGrowth(holdersAgg, 'a disclosed level: no daily series'), remainder: false, notMeasured: holdersAgg.nm, lines: holderLines,
      byBucket: holdersByBucket,
    },
    protocol,
    operatingCosts,
    unreconciled: { annualized: unreconciledAnnual, pct: div(unreconciledAnnual, base), basis: gpMeasured ? 'grossProfit' : 'revenue' },
    belowLine: { toHolders: measuredBelow('holders'), toProtocol: measuredBelow('protocol'), notMeasured: belowNm, lines: belowLines },
    holderFlow,
    volume,
    dilution: { pct: dilutionPct, tokensPerYear, emissionsPerYear: lv.emissionRateAnnual, releases, supply },
    ratios: { takeRate: div(grossProfit, revenueAnnual), payoutRatio, payoutRatioBasis: gpMeasured ? 'grossProfit' : 'revenue' },
    multiples,
    yields,
    perToken: { ...per(circ), circulatingSupply: circ, totalSupply: total, supplyAsOf: lv.asOf ?? null, perTokenFdv: per(total) },
    priceBasis: {
      price, metric: STD_METRICS.price, sourceType: priceDef ? sourceTypeOf(priceDef, asset.metrics) : null, source: priceDef ? sourceLabelOf(priceDef) : null,
      day, asOf: lv.asOf ?? null, flows: dayBasis === undefined
        ? "each flow day's USD at that day's price (the stored value)"
        : "each flow day's USD from its tokens x hourly prices where every hour is priced and the stored value was itself hourly-priced at ingest (the G2-signed days), else the stored value (per line: priceBasis)",
    },
    checks: (input.checks ?? []).map((c) => ({
      id: c.checkId, type: c.type, status: c.status, lhs: c.lhs, rhs: c.rhs, gapPct: c.gapPct,
      tolerancePct: typeof c.detail.tolerance_pct === 'number' ? c.detail.tolerance_pct : null, evaluatedAt: c.evaluatedAt,
    })),
    provenance: { methods: { measured: methodShare('measured'), derived: methodShare('derived'), disclosed: methodShare('disclosed') }, thirdParty, sources, basis: basisObservations ? 'observations' : 'config' },
    flags,
  };
}

/**
 * The listing bar (spec §2 deferral, D6): a protocol is listed only when its revenue and holder lines and its supply sit
 * on an allowed rung. Cost lines may be not_measured. It gates new listings; AERO, HYPE and PUMP fail today and are
 * reported, not blocked. `line` is `<section>.<id>` (supply: the metric key).
 */
export function listingBar(asset: AssetConfig): { ok: boolean; failing: { line: string; sourceType: SourceType | null }[] } {
  const is = asset.income_statement;
  const failing: { line: string; sourceType: SourceType | null }[] = [];
  const check = (line: string, metrics: (string | undefined)[]) => {
    const ms = metrics.filter((m): m is string => m !== undefined);
    if (ms.length === 0) {
      failing.push({ line, sourceType: null });
      return;
    }
    for (const m of ms) {
      const def = asset.metrics[m];
      const t = def ? sourceTypeOf(def, asset.metrics) : null;
      if (t === null || !LISTING_RUNGS.has(t)) {
        failing.push({ line, sourceType: t });
        return;
      }
    }
  };
  if (is) {
    const byId = new Map(is.revenue.map((r) => [r.id, r] as const));
    const revMetrics = (r: IsRevenueLine): (string | undefined)[] => (r.estimate !== undefined ? revMetrics(byId.get(r.estimate.of)!) : [r.metric, r.derived?.from, r.disclosed]);
    for (const r of is.revenue) check(`revenue.${r.id}`, r.not_measured !== undefined ? [] : revMetrics(r));
    for (const h of is.holders ?? []) {
      const own =
        h.not_measured !== undefined ? [] : h.of !== undefined ? revMetrics(byId.get(h.of)!) : h.estimate !== undefined ? revMetrics(byId.get(h.estimate.of)!) : [h.metric, ...(h.apportion ? [h.apportion.by, h.apportion.total] : [])];
      check(`holders.${h.id}`, own.length === 0 ? [] : [...own, h.paid_metric]);
    }
  } else {
    failing.push({ line: 'income_statement', sourceType: null });
  }
  for (const m of [STD_METRICS.totalSupply, STD_METRICS.circulatingSupply]) {
    if (asset.metrics[m]) check(`supply.${m}`, [m]);
  }
  return { ok: failing.length === 0, failing };
}
