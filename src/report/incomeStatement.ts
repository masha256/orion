import { resolveUse, type IsBucket, type IsHolderLine, type IsRevenueLine, type IsBelowLine, type IsCostLine, type IsUseLine, type CostTo, type IsCategory } from '../config/incomeStatement.js';
import type { AssetConfig, IncomeStatementDef, MetricDef, RecipientBase } from '../config/schema.js';
import { addDays } from '../ingest/time.js';
import { DAYS_PER_YEAR, STD_METRICS } from '../types.js';
import { growthOf, NEW_STREAM_DAYS, recipients, windowSum, type Bucket, type Growth, type HolderYieldReport, type ReportInput } from './holderYield.js';
import { LISTING_RUNGS, sourceLabelOf, sourceTypeOf, type SourceType } from './sourceTypes.js';

/**
 * Income statement v2 (spec 2026-10-28 §6-7, plan corrections 6, 7, 13, 14): a pure function of the same report input as
 * v1, beside it for one release. Annualizing, window sums and growth reuse `windowSum`/`growthOf` and v1's term
 * arithmetic (Σ window sum × weight, then × 365 / window), summed in YAML line order, so every figure the two statements
 * share is equal by construction (the parity map, PARITY below). `yields`, `dilution` and the supply line are copied
 * from the v1 report (spec §7 "as today").
 *
 *   revenue        = Σ revenue lines
 *   gross profit   = revenue − Σ cost_of_revenue          (null if any cost line is not_measured)
 *   gross profit   = holders + protocol + operating_costs + unreconciled
 *   payout ratio   = holders / gross profit; holders / revenue (payoutRatioBasis 'revenue') when gross profit is n/m
 *   holder flow    = holders (at the recipients, net of haircuts) + below_line to holders (flagged fromBelowLine)
 */

export type IsMethod = 'measured' | 'derived' | 'disclosed' | 'not_measured';

const BUCKETS: Bucket[] = ['burn', 'hold', 'cash'];

/** One series in a figure: Σ windowSum(metric) × w, annualized. `gw` is its growth weight (w without a young stream's run-rate weight, as v1). */
interface Term {
  metric: string;
  w: number;
  gw: number;
}

/** What a line reads: daily series (terms), a level in USD a year (a disclosure, a run rate), or nothing (not_measured). */
type Value = { kind: 'terms'; terms: Term[] } | { kind: 'level'; value: number | null; note: string } | { kind: 'nm'; reason: string };

export interface IsRevenueLineOut {
  id: string;
  label: string | null;
  method: IsMethod;
  sourceTypes: SourceType[];
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
  growth: Growth;
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
  annualized: number | null;
  growth: Growth;
  note?: string;
  notMeasured?: string;
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
  annualized: number | null;
  growth: Growth;
  bucket: Bucket | null;
  haircut: number | null;
  recipientBase: RecipientBase | null;
  captureRule: IsBelowLine['capture_rule'] | null;
  note?: string;
  notMeasured?: string;
}

export interface UseSectionOut<L> {
  annualized: number | null;
  growth: Growth;
  /** True when the section is the declared remainder (revenue less the rest): one derived line. */
  remainder: boolean;
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
    gross: number | null;
    net: number | null;
    /** Growth of every line with a daily series, each net of its haircut (v1 holderFlowGrowth). */
    growth: Growth;
    byBucket: Record<Bucket, BucketFlow | null>;
    fromRevenue: number | null;
    fromBelowLine: number | null;
    notMeasured: string[];
    lines: HolderFlowLineOut[];
  };
  dilution: {
    /** Annual supply growth from emissions and releases (v1 yields.dilution). */
    pct: number | null;
    emissionsPerYear: number | null;
    releases: { id: string; tokensPerYear: number | null; yield: number | null }[];
    supply: HolderYieldReport['supply'];
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
  yields: HolderYieldReport['yields'];
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
    /** How the flows are priced: each day's USD at that day's price, as stored. */
    flows: string;
  };
  /** Checks run in Task 5; empty here. */
  checks: [];
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

export interface PerToken {
  revenue: number | null;
  grossProfit: number | null;
  holderFlow: { total: number | null; byBucket: Record<Bucket, number | null> };
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

export function incomeStatementV2(input: ReportInput, legacy: HolderYieldReport): IsV2 {
  const { asset, day, levels: lv } = input;
  const is = asset.income_statement;
  if (!is) throw new Error(`assets/${asset.id}.yaml has no income_statement block`);
  const W = is.window_days;
  const metricDef = (m: string): MetricDef | undefined => asset.metrics[m];
  const typesOf = (metrics: (string | undefined)[]): SourceType[] =>
    uniq(metrics.filter((m): m is string => m !== undefined).map((m) => (metricDef(m) ? sourceTypeOf(metricDef(m)!) : null)).filter((t): t is SourceType => t !== null));

  // A line is zero before it began: days before `started` are filled with 0 (as v1 does for reporting.revenue streams).
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
    else if (r.disclosed !== undefined) v = { kind: 'level', value: lv.disclosed.at(-1)?.value ?? null, note: 'a disclosed level: no daily series' };
    else {
      const base = is.revenue.find((x) => x.id === r.estimate!.of)!;
      v = ratioOf(revenueValue(base), r.estimate!.ratio);
    }
    revValue.set(r.id, v);
    return v;
  };
  const ratioOf = (v: Value, k: number): Value => (v.kind === 'terms' ? { kind: 'terms', terms: scale(v.terms, k) } : v.kind === 'level' ? { kind: 'level', value: finite(v.value) ? v.value * k : null, note: v.note } : v);
  const revenueById = new Map(is.revenue.map((r) => [r.id, r] as const));
  const revenueTypes = (r: IsRevenueLine): SourceType[] =>
    r.estimate !== undefined ? revenueTypes(revenueById.get(r.estimate.of)!) : typesOf([r.metric, r.derived?.from, r.derived?.share_metric, r.disclosed]);
  const revenueMethod = (r: IsRevenueLine): IsMethod =>
    r.not_measured !== undefined ? 'not_measured' : r.disclosed !== undefined ? 'disclosed' : r.metric !== undefined ? 'measured' : 'derived';

  /** A use line's value: its own metric, `of` a revenue line (times share), an estimate of one, or not measured. */
  const useValue = (l: IsUseLine | IsHolderLine | IsCostLine): Value => {
    const u = resolveUse(is, l);
    if (l.not_measured !== undefined) return { kind: 'nm', reason: l.not_measured };
    if (l.of !== undefined) return ratioOf(revenueValue(u.revenue!), u.share);
    if (l.metric !== undefined) return { kind: 'terms', terms: [{ metric: l.metric, w: 1, gw: 1 }] };
    return ratioOf(revenueValue(revenueById.get(l.estimate!.of)!), l.estimate!.ratio);
  };
  const useTypes = (l: IsUseLine | IsHolderLine | IsCostLine): SourceType[] =>
    l.of !== undefined ? revenueTypes(revenueById.get(l.of)!) : l.estimate !== undefined ? revenueTypes(revenueById.get(l.estimate.of)!) : typesOf([l.metric]);
  const useMethod = (l: IsUseLine | IsHolderLine | IsCostLine): IsMethod => {
    if (l.not_measured !== undefined) return 'not_measured';
    if (l.of !== undefined) {
      const m = revenueMethod(revenueById.get(l.of)!);
      return m === 'measured' && (l.share ?? 1) !== 1 ? 'derived' : m;
    }
    return l.metric !== undefined ? 'measured' : 'derived';
  };
  const valueAnnual = (v: Value): number | null => (v.kind === 'terms' ? annual(v.terms) : v.kind === 'level' ? v.value : null);
  const valueGrowth = (v: Value): Growth => (v.kind === 'terms' ? grow(v.terms) : v.kind === 'level' ? noSeries(v.note) : noSeries('not measured'));

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
      id: r.id, label: r.label ?? null, method: revenueMethod(r), sourceTypes: revenueTypes(r),
      annualized: valueAnnual(v), windowSum: ws, settlement: v.kind === 'terms' ? (r.settlement ?? 'daily') : null, started: r.started ?? null,
      daysMeasured: v.kind === 'terms' ? daysIn(r.started) : null, provisionalDays: pending(metric), coverage: null,
      isNew: age !== null && age < NEW_STREAM_DAYS, growth: valueGrowth(v),
      ...(r.not_measured !== undefined ? { notMeasured: r.not_measured } : {}),
    };
  });
  const revenueGrowth = revAgg.nm.length > 0 ? noSeries('a revenue line is not measured') : aggGrowth(revAgg, 'a disclosed level: no daily series');
  const newIds = revLines.filter((l) => l.isNew).map((l) => l.id);
  const oldAgg = agg(revItems.filter((x) => !newIds.includes(x.id)));
  const growthExNew = newIds.length === 0 || revAgg.levels.length > 0 ? null : oldAgg.terms.length === 0 ? noSeries('every line is new') : grow(oldAgg.terms);

  // Cost of revenue and gross profit.
  const costItems = (is.cost_of_revenue ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const costAgg = agg(costItems);
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
      id: l.id, label: l.label ?? null, of: l.of ?? null, share: l.share ?? 1, method: useMethod(l), sourceTypes: useTypes(l),
      annualized: valueAnnual(v), growth: valueGrowth(v), ...(l.note ? { note: l.note } : {}), ...(l.not_measured !== undefined ? { notMeasured: l.not_measured } : {}),
    };
  };
  const holderItems = (is.holders ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const protocolItems = (is.protocol ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const opexItems = (is.operating_costs ?? []).map((l) => ({ id: l.id, v: useValue(l) }));
  const holdersAgg = agg(holderItems);
  const holdersAnnual = aggAnnual(holdersAgg);

  // The remainder: revenue less the measured rest, in v1's term order (revenue, -holders, -costs, -the other use).
  const anyLevel = hasLevel || [holdersAgg, agg(protocolItems), agg(opexItems)].some((a) => a.levels.length > 0);
  const remainderOf = (other: Agg): { annualized: number | null; growth: Growth } => {
    if (anyLevel) {
      const o = aggAnnual(other);
      return { annualized: finite(base) && finite(holdersAnnual) && finite(o) ? base - holdersAnnual - o : null, growth: noSeries('a disclosed level less daily flows') };
    }
    const terms = [...revAgg.terms, ...neg(holdersAgg.terms), ...neg(costAgg.terms), ...neg(other.terms)];
    return { annualized: revenueAnnual === null ? null : annual(terms), growth: grow(terms) };
  };
  const section = (items: { id: string; v: Value }[], lines: IsUseLineOut[], isRemainder: boolean, other: Agg): UseSectionOut<IsUseLineOut> => {
    if (!isRemainder) {
      const a = agg(items);
      return { annualized: aggAnnual(a), growth: aggGrowth(a, 'a disclosed level: no daily series'), remainder: false, lines };
    }
    const r = remainderOf(other);
    const note = costAgg.nm.length > 0 ? 'revenue less holders and the other uses, before the costs not measured' : 'revenue less the rest';
    return {
      annualized: r.annualized, growth: r.growth, remainder: true,
      lines: [{ id: 'remainder', label: null, of: null, share: 1, method: 'derived', sourceTypes: [], annualized: r.annualized, growth: r.growth, note }],
    };
  };
  const protocol = section(protocolItems, (is.protocol ?? []).map(useLine), is.remainder === 'protocol', agg(opexItems));
  const operatingCosts = section(opexItems, (is.operating_costs ?? []).map(useLine), is.remainder === 'operating_costs', agg(protocolItems));
  const unreconciledAnnual =
    is.remainder !== undefined
      ? finite(protocol.annualized) && finite(operatingCosts.annualized) && finite(base)
        ? 0
        : null
      : finite(base) && finite(holdersAnnual) && finite(protocol.annualized) && finite(operatingCosts.annualized)
        ? base - holdersAnnual - protocol.annualized - operatingCosts.annualized
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
  const flowLine = (id: string, sectionName: 'holders' | 'below_line', v: Value, bucket: Bucket | null, haircut: number, b: RecipientBase): HolderFlowLineOut & { terms: Term[] } => {
    const gross = flowGross(v);
    const net = gross === null ? null : gross * (1 - haircut);
    const terms = v.kind === 'terms' ? v.terms : [];
    return {
      id, section: sectionName, fromBelowLine: sectionName === 'below_line', bucket, metric: terms.length === 1 ? terms[0].metric : null, haircut, recipientBase: b,
      gross, net, yield: yieldOf(net, b),
      growth: v.kind === 'terms' ? growthOf(daily, terms.map((t) => t.metric), day, W, terms.map((t) => t.gw)) : v.kind === 'level' ? noSeries('a run-rate level: no daily series') : noSeries('not measured'),
      ...(v.kind === 'nm' ? { notMeasured: v.reason } : {}),
      terms,
    };
  };
  const holderFlowLines: (HolderFlowLineOut & { terms: Term[] })[] = [];
  const holderLines: IsHolderLineOut[] = (is.holders ?? []).map((l) => {
    const v = l.paid_metric !== undefined ? ({ kind: 'terms', terms: [{ metric: l.paid_metric, w: 1, gw: 1 }] } as Value) : useValue(l);
    const f = flowLine(l.id, 'holders', v, l.bucket, l.haircut, l.recipient_base);
    holderFlowLines.push(f);
    return {
      ...useLine(l), sourceTypes: uniq([...useTypes(l), ...typesOf([l.paid_metric])]),
      bucket: l.bucket, haircut: l.haircut, recipientBase: l.recipient_base, valuedPer: l.valued_per ?? null, captureRule: l.capture_rule,
      paidMetric: l.paid_metric ?? null, gross: f.gross, net: f.net, yield: f.yield,
    };
  });
  const belowValue = (b: IsBelowLine): Value =>
    b.not_measured !== undefined ? { kind: 'nm', reason: b.not_measured } : b.metric !== undefined ? { kind: 'terms', terms: [{ metric: b.metric, w: 1, gw: 1 }] } : { kind: 'level', value: lv.extra[b.run_rate!] ?? null, note: 'a run-rate level: no daily series' };
  const belowLines: IsBelowLineOut[] = (is.below_line ?? []).map((b) => {
    const v = belowValue(b);
    if (b.to === 'holders') holderFlowLines.push(flowLine(b.id, 'below_line', v, b.bucket ?? null, b.haircut ?? 0, b.recipient_base ?? 'all'));
    return {
      id: b.id, label: b.label ?? null, to: b.to, method: b.not_measured !== undefined ? 'not_measured' : 'measured', sourceTypes: typesOf([b.metric, b.run_rate]),
      annualized: valueAnnual(v), growth: valueGrowth(v), bucket: b.bucket ?? null, haircut: b.haircut ?? null, recipientBase: b.recipient_base ?? null,
      captureRule: b.capture_rule ?? null, ...(b.note ? { note: b.note } : {}), ...(b.not_measured !== undefined ? { notMeasured: b.not_measured } : {}),
    };
  });
  const measuredBelow = (to: 'holders' | 'protocol') => sumOrNull(belowLines.filter((b) => b.to === to && b.method !== 'not_measured').map((b) => b.annualized));
  const belowNm = belowLines.filter((b) => b.method === 'not_measured').map((b) => b.id);

  const counted = holderFlowLines.filter((f) => f.notMeasured === undefined);
  const hfNm = holderFlowLines.filter((f) => f.notMeasured !== undefined).map((f) => f.id);
  const byBucket = Object.fromEntries(
    BUCKETS.map((bk) => {
      const ls = counted.filter((f) => f.bucket === bk);
      if (ls.length === 0) return [bk, null];
      return [bk, {
        gross: sumOrNull(ls.map((f) => f.gross)), net: sumOrNull(ls.map((f) => f.net)), yield: sumOrNull(ls.map((f) => f.yield)),
        fromRevenue: sumOrNull(ls.filter((f) => !f.fromBelowLine).map((f) => f.gross)), fromBelowLine: sumOrNull(ls.filter((f) => f.fromBelowLine).map((f) => f.gross)),
      }];
    }),
  ) as Record<Bucket, BucketFlow | null>;
  const series = counted.filter((f) => f.terms.length > 0 && f.terms.every((t) => daily.has(t.metric)));
  const holderFlowGrowth = growthOf(daily, series.flatMap((f) => f.terms.map((t) => t.metric)), day, W, series.flatMap((f) => f.terms.map((t) => (1 - f.haircut) * t.gw)));
  const holderFlow: IsV2['holderFlow'] = {
    gross: sumOrNull(counted.map((f) => f.gross)),
    net: sumOrNull(counted.map((f) => f.net)),
    growth: holderFlowGrowth,
    byBucket,
    fromRevenue: sumOrNull(counted.filter((f) => !f.fromBelowLine).map((f) => f.gross)),
    fromBelowLine: sumOrNull(counted.filter((f) => f.fromBelowLine).map((f) => f.gross)),
    notMeasured: hfNm,
    lines: holderFlowLines.map(({ terms: _terms, ...f }) => f),
  };

  const holdersByBucket = Object.fromEntries(
    BUCKETS.map((bk) => {
      const items = (is.holders ?? []).filter((l) => l.bucket === bk).map((l) => ({ id: l.id, v: useValue(l) }));
      return [bk, items.length === 0 ? null : { annualized: aggAnnual(agg(items)) }];
    }),
  ) as Record<IsBucket, { annualized: number | null } | null>;

  // Ratios (D8, correction 14).
  const gpMeasured = grossProfit !== null;
  const payoutRatio = gpMeasured ? div(holdersAnnual, grossProfit) : div(holdersAnnual, revenueAnnual);

  const mcap = legacy.marketCap;
  const bucketNet = (bk: Bucket) => byBucket[bk]?.net ?? null;
  const multiples: IsV2['multiples'] = {
    mcapToRevenue: div(mcap, revenueAnnual),
    mcapToGrossProfit: div(mcap, grossProfit),
    mcapToHolderFlow: { burn: div(mcap, bucketNet('burn')), hold: div(mcap, bucketNet('hold')), cash: div(mcap, bucketNet('cash')), total: div(mcap, holderFlow.net) },
  };

  const circ = lv.circulatingSupply ?? null;
  const total = lv.totalSupply;
  const dilutionUsd = finite(legacy.yields.dilution) && finite(legacy.fdv) ? legacy.yields.dilution * legacy.fdv : null;
  const per = (n: number | null): PerToken => ({
    revenue: div(revenueAnnual, n),
    grossProfit: div(grossProfit, n),
    holderFlow: { total: div(holderFlow.net, n), byBucket: { burn: div(bucketNet('burn'), n), hold: div(bucketNet('hold'), n), cash: div(bucketNet('cash'), n) } },
    dilution: div(dilutionUsd, n),
  });

  const priceDef = metricDef(STD_METRICS.price);

  // Provenance: the share of revenue by method, and every line on a third-party source.
  const methodShare = (m: IsMethod): number | null => {
    if (!finite(revenueAnnual) || !(revenueAnnual > 0)) return null;
    const ls = revLines.filter((l) => l.method === m);
    if (ls.length === 0) return 0;
    const s = sumOrNull(ls.map((l) => l.annualized));
    return s === null ? null : s / revenueAnnual;
  };
  const thirdParty: string[] = [];
  const tp = (name: string, types: SourceType[]) => {
    if (types.includes('third_party')) thirdParty.push(name);
  };
  for (const r of is.revenue) {
    tp(`revenue.${r.id}`, revenueTypes(r));
    if (r.cross_check !== undefined) tp(`revenue.${r.id}.cross_check`, typesOf([r.cross_check]));
  }
  for (const [name, lines] of [['cost_of_revenue', is.cost_of_revenue], ['holders', is.holders], ['protocol', is.protocol], ['operating_costs', is.operating_costs]] as const) {
    for (const l of (lines ?? []) as (IsUseLine | IsHolderLine)[]) tp(`${name}.${l.id}`, uniq([...useTypes(l), ...typesOf([(l as IsHolderLine).paid_metric])]));
  }
  for (const b of is.below_line ?? []) tp(`below_line.${b.id}`, typesOf([b.metric, b.run_rate]));
  const statementMetrics = uniq([
    ...is.revenue.flatMap((r) => [r.metric, r.derived?.from, r.derived?.share_metric, r.disclosed, r.cross_check]),
    ...[...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])].flatMap((l) => [l.metric, l.share_metric, (l as IsHolderLine).paid_metric]),
    ...(is.below_line ?? []).flatMap((b) => [b.metric, b.run_rate]),
  ].filter((m): m is string => m !== undefined));
  const sources = uniq(statementMetrics.map((m) => (metricDef(m) ? sourceLabelOf(metricDef(m)!) : null)).filter((s): s is string => s !== null)).sort();

  const flags: string[] = [];
  if (costAgg.nm.length > 0) flags.push(`cost of revenue not measured: ${costAgg.nm.join(', ')}`);
  if (revAgg.nm.length > 0) flags.push(`revenue not measured: ${revAgg.nm.join(', ')}`);
  const useNm = [...holderItems, ...protocolItems, ...opexItems].filter((x) => x.v.kind === 'nm').map((x) => x.id);
  if (useNm.length > 0) flags.push(`not measured: ${useNm.join(', ')}`);
  if (belowNm.length > 0) flags.push(`below the line not measured: ${belowNm.join(', ')}`);
  if (!gpMeasured) flags.push('payout ratio on revenue: cost of revenue not measured');
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
    holders: { annualized: holdersAnnual, growth: aggGrowth(holdersAgg, 'a disclosed level: no daily series'), remainder: false, lines: holderLines, byBucket: holdersByBucket },
    protocol,
    operatingCosts,
    unreconciled: { annualized: unreconciledAnnual, pct: div(unreconciledAnnual, base), basis: gpMeasured ? 'grossProfit' : 'revenue' },
    belowLine: { toHolders: measuredBelow('holders'), toProtocol: measuredBelow('protocol'), notMeasured: belowNm, lines: belowLines },
    holderFlow,
    dilution: { pct: legacy.yields.dilution, emissionsPerYear: lv.emissionRateAnnual, releases: legacy.yields.dilutionLines ?? [], supply: legacy.supply },
    ratios: { takeRate: div(grossProfit, revenueAnnual), payoutRatio, payoutRatioBasis: gpMeasured ? 'grossProfit' : 'revenue' },
    multiples,
    yields: legacy.yields,
    perToken: { ...per(circ), circulatingSupply: circ, totalSupply: total, supplyAsOf: lv.asOf ?? null, perTokenFdv: per(total) },
    priceBasis: {
      price, metric: STD_METRICS.price, sourceType: priceDef ? sourceTypeOf(priceDef) : null, source: priceDef ? sourceLabelOf(priceDef) : null,
      day, asOf: lv.asOf ?? null, flows: "each flow day's USD at that day's price (the stored value)",
    },
    checks: [],
    provenance: { methods: { measured: methodShare('measured'), derived: methodShare('derived'), disclosed: methodShare('disclosed') }, thirdParty, sources, basis: 'config' },
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
      const t = def ? sourceTypeOf(def) : null;
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
      const own = h.not_measured !== undefined ? [] : h.of !== undefined ? revMetrics(byId.get(h.of)!) : h.estimate !== undefined ? revMetrics(byId.get(h.estimate.of)!) : [h.metric];
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

/** One step of a parity path, as tools/phase2-proof/compare.py reads it: `key` or `key[field=value]`. */
const SELECT = /^([^[\]]+)\[([A-Za-z_][A-Za-z0-9_]*)=([^[\]]+)\]$/;

/** The value at a dotted path (compare.py's get_path); undefined when a step is absent or a selector is not unique. */
export function getPath(obj: unknown, dotted: string): unknown {
  let node: unknown = obj;
  for (const step of dotted.split('.')) {
    const m = SELECT.exec(step);
    const key = m ? m[1] : step;
    if (node === null || typeof node !== 'object' || Array.isArray(node) || !(key in (node as object))) return undefined;
    node = (node as Record<string, unknown>)[key];
    if (m) {
      if (!Array.isArray(node)) return undefined;
      const found = node.filter((x) => x !== null && typeof x === 'object' && (x as Record<string, unknown>)[m[2]] === m[3]);
      if (found.length !== 1) return undefined;
      node = found[0];
    }
  }
  return node;
}

type PathPair = [label: string, v2: string, v1: string];

const IS = 'incomeStatement';
const YIELD_KEYS = ['cash', 'buyback', 'shareholder', 'dilution', 'netShareholder', 'multiple', 'pegTrailing'] as const;

/** The pairs every unchanged asset shares: totals, ratios, yields, dilution, and its one holder-flow bucket. */
function commonPairs(bucket: Bucket): PathPair[] {
  return [
    ['revenue', `${IS}.revenue.annualized`, 'income.revenue.annualized'],
    ['revenue growth', `${IS}.revenue.growth.annualized`, 'income.revenue.growth.annualized'],
    ['holders', `${IS}.holders.annualized`, 'income.holders.annualized'],
    ['holders growth', `${IS}.holders.growth.annualized`, 'income.holders.growth.annualized'],
    ['protocol', `${IS}.protocol.annualized`, 'income.protocol.annualized'],
    ['operating costs = v1 costs', `${IS}.operatingCosts.annualized`, 'income.costs.annualized'],
    ['payout ratio', `${IS}.ratios.payoutRatio`, 'income.payoutRatio'],
    ['holder flow total', `${IS}.holderFlow.gross`, `buckets.${bucket}.gross`],
    ['holder flow total net', `${IS}.holderFlow.net`, `buckets.${bucket}.net`],
    [`holder flow ${bucket}`, `${IS}.holderFlow.byBucket.${bucket}.gross`, `buckets.${bucket}.gross`],
    [`holder flow ${bucket} net`, `${IS}.holderFlow.byBucket.${bucket}.net`, `buckets.${bucket}.net`],
    [`holder flow ${bucket} yield`, `${IS}.holderFlow.byBucket.${bucket}.yield`, `buckets.${bucket}.yield`],
    ['holder flow growth', `${IS}.holderFlow.growth.annualized`, 'holderFlowGrowth.annualized'],
    ...YIELD_KEYS.map((k): PathPair => [`yield ${k}`, `${IS}.yields.${k}`, `yields.${k}`]),
    ['dilution pct', `${IS}.dilution.pct`, 'yields.dilution'],
  ];
}

/** A v2 revenue line against a v1 income line (assets whose v1 revenue is the income statement's total). */
const revIncome = (v2: string, v1: string): PathPair => [`revenue line ${v2}`, `${IS}.revenue.lines[id=${v2}].annualized`, `income.lines[id=${v1}].annualized`];
/** A v2 revenue line against a v1 revenue stream. */
const revStream = (id: string): PathPair => [`revenue line ${id}`, `${IS}.revenue.lines[id=${id}].annualized`, `revenue.streams[id=${id}].annualized`];
/** A v2 holders line (statement) against a v1 income line. */
const holderIncome = (v2: string, v1: string): PathPair => [`holders line ${v2}`, `${IS}.holders.lines[id=${v2}].annualized`, `income.lines[id=${v1}].annualized`];
/** A v2 holder-flow line against a v1 flow. */
const flowPair = (v2: string, v1: string): PathPair => [`holder flow line ${v2}`, `${IS}.holderFlow.lines[id=${v2}].gross`, `flows[id=${v1}].gross`];
const protocolIncome = (v2: string, v1: string): PathPair => [`protocol line ${v2}`, `${IS}.protocol.lines[id=${v2}].annualized`, `income.lines[id=${v1}].annualized`];

/**
 * The parity map (ruling R7): for each of the 10 assets whose figures v2 leaves unchanged, [label, v2 path in the report
 * JSON, v1 path in today's report JSON]. Every path names one stored number. tools/phase2-proof/parity.json is this
 * object as JSON (tools/phase2-proof/write-parity.ts writes it; tests/report/parity.test.ts asserts they agree).
 */
export const PARITY_PATHS: Record<string, PathPair[]> = {
  aero: [...commonPairs('cash'), revIncome('fees', 'voter_fees'), holderIncome('voter_fees', 'voter_fees'), flowPair('voter_fees', 'fees')],
  cake: [
    ...commonPairs('burn'), revIncome('burn_rev', 'burn'), revIncome('treasury_rev', 'treasury'), holderIncome('burn', 'burn'), protocolIncome('treasury', 'treasury'),
    flowPair('burn', 'burn'),
  ],
  crv: [
    ...commonPairs('cash'), revIncome('fees', 'vecrv_fees'), revIncome('treasury_rev', 'treasury'), holderIncome('vecrv_fees', 'vecrv_fees'), protocolIncome('treasury', 'treasury'),
    flowPair('vecrv_fees', 'fees'), flowPair('vote_incentives', 'vote_incentives'),
    ['below line to holders = v1 vote incentives', `${IS}.belowLine.toHolders`, 'flows[id=vote_incentives].gross'],
  ],
  cvxcrv: [
    ...commonPairs('cash'), revIncome('vecrv_fees_rev', 'vecrv_fees'), revIncome('platform_cvxcrv', 'crv_lock_incentive'), revIncome('platform_cvx', 'cvx_stakers'),
    revIncome('platform_treasury', 'treasury'), revIncome('callers_fee', 'callers'),
    holderIncome('vecrv_fees', 'vecrv_fees'), holderIncome('crv', 'crv_lock_incentive'), protocolIncome('cvx_stakers', 'cvx_stakers'), protocolIncome('treasury', 'treasury'),
    ['operating cost line callers', `${IS}.operatingCosts.lines[id=callers].annualized`, 'income.lines[id=callers].annualized'],
    flowPair('vecrv_fees', 'fees'), flowPair('crv', 'crv'), flowPair('cvx_rewards', 'cvx'),
    ['below line to holders = v1 outside revenue', `${IS}.belowLine.toHolders`, 'income.outsideRevenue[id=cvx_rewards].annualized'],
  ],
  hype: [
    ...commonPairs('burn'), revStream('trading'), revStream('reserve_yield'), holderIncome('af_buyback', 'af_buyback'), holderIncome('reserve_yield_paid', 'reserve_yield'),
    flowPair('af_buyback', 'af_buyback'), flowPair('reserve_yield_paid', 'reserve_yield'),
  ],
  link: [...commonPairs('hold'), revStream('onchain_fees'), holderIncome('reserve', 'reserve'), flowPair('reserve', 'reserve')],
  pump: [...commonPairs('burn'), revStream('protocol'), holderIncome('buyback', 'buyback'), flowPair('buyback', 'buyback')],
  // SKY's v1 protocol income is a remainder of the very series its holders lines read (revenue streams less the same
  // streams), so it is 0 only up to rounding (-1e-10 on synthetic data); v2 lists no protocol section and reports an
  // exact 0. A relative tolerance cannot compare a rounding residue with 0, so that one pair is left out.
  sky: [
    ...commonPairs('cash').filter(([label]) => label !== 'protocol'), revStream('surplus_usds'), revStream('surplus_buyback'), holderIncome('stakers', 'stakers'), holderIncome('buyback', 'buyback'),
    flowPair('stakers', 'stakers'), flowPair('buyback', 'buyback'),
  ],
  uni: [...commonPairs('burn'), revStream('protocol_fees'), holderIncome('burn', 'burn'), flowPair('burn', 'burn')],
  vvv: [...commonPairs('burn'), revStream('business'), holderIncome('burn', 'burn'), flowPair('burn', 'burn')],
};

/** PARITY[a](v2, v1): each pair's two values, read from the same paths compare.py reads in the report JSON. */
export const PARITY: Record<string, (v2: IsV2, v1: HolderYieldReport) => [label: string, a: number | null, b: number | null][]> = Object.fromEntries(
  Object.entries(PARITY_PATHS).map(([a, pairs]) => [
    a,
    (v2: IsV2, v1: HolderYieldReport) => {
      const newSide = { [IS]: v2 };
      const num = (x: unknown, where: string): number | null => {
        if (x === null) return null;
        if (typeof x !== 'number') throw new Error(`parity ${a}: ${where} is ${x === undefined ? 'missing' : JSON.stringify(x)}`);
        return x;
      };
      return pairs.map(([label, p2, p1]) => [label, num(getPath(newSide, p2), p2), num(getPath(v1, p1), p1)] as [string, number | null, number | null]);
    },
  ]),
);
