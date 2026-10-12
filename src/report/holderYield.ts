import type { AssetConfig, FlowKind, RecipientBase } from '../config/schema.js';
import { addDays } from '../ingest/time.js';
import { DAYS_PER_YEAR } from '../types.js';

/**
 * Report-only holder yield and growth (no driver, no grade, no signal). Everything here is computed from stored daily
 * flow totals and the level metrics in force, so any past day can be recomputed and nothing new is stored.
 *
 * Buckets (Mike's like-kind classes): a holder flow's `kind` decides its bucket, so reporting and valuation never
 * disagree. burn -> burn (no haircut), buy_and_hold -> hold (an overhang haircut), fee_share -> cash (a slippage
 * haircut per payout token, sized from pool depth). `extra_cash` adds a cash line the valuation keeps elsewhere
 * (CRV's vote incentives).
 */

export type Bucket = 'burn' | 'hold' | 'cash';
export const BUCKET_OF: Record<FlowKind, Bucket> = { burn: 'burn', buy_and_hold: 'hold', fee_share: 'cash' };
const BUCKETS: Bucket[] = ['burn', 'hold', 'cash'];

export interface ReportLevels {
  price: number | null;
  /** total_supply: on-chain supply less what CoinGecko also excludes (burn addresses; HYPE's Assistance Fund). FDV basis. */
  totalSupply: number | null;
  /** circulating_supply (CoinGecko's, or the on-chain total for the wrappers CoinGecko has none for): market cap basis. */
  circulatingSupply?: number | null;
  stakedSupply: number | null;
  lockedSupply: number | null;
  emissionRateAnnual: number | null;
  /** Annual run rates of the `extra_cash` level metrics, by metric key. */
  extra: Record<string, number | null>;
  /** `reporting.dilution` lines: the rate (tokens a year) and the cap (tokens), by line id; null when unread. */
  dilution?: Record<string, { rate: number | null; cap: number | null }>;
  /** Disclosed revenue levels (oldest first), for `revenue_disclosed`. */
  disclosed: { observedAt: string; value: number }[];
}

export interface ReportInput {
  asset: AssetConfig;
  /** The last complete UTC day the report covers (YYYY-MM-DD). */
  day: string;
  /** Daily flow totals per flow metric: UTC day -> value (USD). */
  daily: Map<string, Map<string, number>>;
  levels: ReportLevels;
}

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

export interface FlowLine {
  id: string;
  metric: string;
  bucket: Bucket;
  recipientBase: RecipientBase;
  haircut: number;
  /** Annualized over the window, USD. */
  gross: number | null;
  net: number | null;
  /** Net per recipient token / price. */
  yield: number | null;
  growth: Growth;
}

export interface BucketLine {
  gross: number | null;
  net: number | null;
  yield: number | null;
  growth: Growth;
}

export interface HolderYieldReport {
  asset: string;
  day: string;
  windowDays: number;
  price: number | null;
  /** price x circulating_supply; null when the asset records no circulating supply. */
  marketCap: number | null;
  /** price x total_supply. The yields, the multiple and the supply line are on this basis. */
  fdv: number | null;
  flows: FlowLine[];
  buckets: Record<Bucket, BucketLine | null>;
  yields: {
    /** Cash payouts, net of slippage, on price. */
    cash: number | null;
    /** Burns plus holds net of the overhang haircut, on price. */
    buyback: number | null;
    /** cash + buyback. */
    shareholder: number | null;
    /** Annual supply growth from emissions. */
    dilution: number | null;
    /** reporting.dilution lines (tokens a year, after the cap, and as a share of total supply); absent without the block. */
    dilutionLines?: { id: string; tokensPerYear: number | null; yield: number | null }[];
    /** shareholder - dilution. */
    netShareholder: number | null;
    /** 1 / shareholder: price over net holder cash per token. */
    multiple: number | null;
    /** multiple / (holder-flow growth in percent). Null when growth <= 0. */
    pegTrailing: number | null;
  };
  holderFlowGrowth: Growth;
  /**
   * Supply in tokens a year over the window (reporting.burned_tokens): removed by the holder flows, added by emissions and
   * releases; net = added - removed, and as a share of total supply (negative: supply shrinks). Null without the block.
   */
  supply: { burnedPerYear: number | null; addedPerYear: number | null; netPerYear: number | null; netPct: number | null } | null;
  income: IncomeStatement | null;
  volume: { annualized: number | null; growth: Growth; metrics: string[] } | null;
  revenueDisclosed: { latest: number | null; latestAt: string | null; previous: number | null; previousAt: string | null; annualizedGrowth: number | null } | null;
  notes: string[];
}

/** One line of the income statement, annualized over the window. */
export interface IncomeLine {
  id: string;
  to: 'holders' | 'protocol' | 'cost';
  annualized: number | null;
  /** 'measured' (a daily flow), 'estimate' (a contractual ratio of another flow), 'remainder' (total less the rest). */
  basis: 'measured' | 'estimate' | 'remainder';
  note?: string;
}

/**
 * Revenue = everything the protocol takes in from the market; paid to holders + protocol income + costs = revenue.
 * Ratios are of revenue. A reserve payout (outside revenue) is listed apart, never in the payout ratio.
 */
export interface IncomeStatement {
  revenue: { annualized: number | null; growth: Growth };
  holders: { annualized: number | null; growth: Growth };
  protocol: { annualized: number | null; growth: Growth };
  costs: { annualized: number | null };
  payoutRatio: number | null;
  protocolMargin: number | null;
  lines: IncomeLine[];
  checks: { total: string[]; parts: string[]; measured: number | null; sumOfParts: number | null; gapPct: number | null }[];
  outsideRevenue: { id: string; annualized: number | null; note?: string }[];
}

const finite = (x: number | null): x is number => x !== null && Number.isFinite(x);

/** Sum of `metrics` per day over [end - days + 1, end]; null when any metric misses any day. */
function windowSum(daily: Map<string, Map<string, number>>, metrics: string[], end: string, days: number): number | null {
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

function recipients(base: RecipientBase, lv: ReportLevels): number | null {
  if (base === 'all') return lv.totalSupply;
  if (base === 'locked') return lv.lockedSupply ?? lv.stakedSupply;
  return lv.stakedSupply;
}

export function holderYieldReport(input: ReportInput): HolderYieldReport {
  const { asset, day, daily, levels: lv } = input;
  const r = asset.reporting;
  if (!r) throw new Error(`assets/${asset.id}.yaml has no reporting block`);
  const W = r.window_days;
  const annualize = (sum: number | null) => (sum === null ? null : (sum * DAYS_PER_YEAR) / W);
  const notes: string[] = [];
  const price = lv.price;
  const yieldOf = (net: number | null, base: RecipientBase): number | null => {
    const n = recipients(base, lv);
    if (!finite(net) || !finite(price) || !finite(n) || !(n > 0) || !(price > 0)) return null;
    return net / (n * price);
  };

  const flows: FlowLine[] = asset.holder_flows.map((f) => {
    const haircut = r.haircuts[f.id] ?? 0;
    const gross = annualize(windowSum(daily, [f.metric], day, W));
    const net = gross === null ? null : gross * (1 - haircut);
    return {
      id: f.id, metric: f.metric, bucket: BUCKET_OF[f.kind], recipientBase: f.recipient_base, haircut, gross, net,
      yield: yieldOf(net, f.recipient_base), growth: growthOf(daily, [f.metric], day, W),
    };
  });
  for (const x of r.extra_cash ?? []) {
    const gross = lv.extra[x.metric] ?? null;
    const net = gross === null ? null : gross * (1 - x.haircut);
    flows.push({
      id: x.id, metric: x.metric, bucket: 'cash', recipientBase: x.recipient_base, haircut: x.haircut, gross, net,
      yield: yieldOf(net, x.recipient_base), growth: { current: null, prior: null, change: null, annualized: null, note: 'a run-rate level: no daily series' },
    });
  }

  const sumOrNull = (xs: (number | null)[]): number | null => (xs.length === 0 || xs.some((x) => x === null) ? null : xs.reduce<number>((s, x) => s + x!, 0));
  const buckets = Object.fromEntries(
    BUCKETS.map((b) => {
      const lines = flows.filter((f) => f.bucket === b);
      if (lines.length === 0) return [b, null];
      const daySeries = lines.filter((l) => daily.has(l.metric));
      return [
        b,
        {
          gross: sumOrNull(lines.map((l) => l.gross)),
          net: sumOrNull(lines.map((l) => l.net)),
          yield: sumOrNull(lines.map((l) => l.yield)),
          growth: daySeries.length === 0 ? { current: null, prior: null, change: null, annualized: null, note: 'no daily series' } : growthOf(daily, daySeries.map((l) => l.metric), day, W, daySeries.map((l) => 1 - l.haircut)),
        },
      ];
    }),
  ) as Record<Bucket, BucketLine | null>;

  const cash = buckets.cash ? buckets.cash.yield : 0;
  const bb = [buckets.burn, buckets.hold].filter((x): x is BucketLine => x !== null);
  const buyback = bb.length === 0 ? 0 : sumOrNull(bb.map((x) => x.yield));
  const shareholder = cash === null || buyback === null ? null : cash + buyback;
  const eff = lv.totalSupply;
  const circ = lv.circulatingSupply ?? null;
  // Emissions plus any release outside the schedule (reporting.dilution), each capped by what is approved.
  const releases = (r.dilution ?? []).map((d) => {
    const x = lv.dilution?.[d.id];
    if (!x || !finite(x.rate)) return null;
    return d.cap_metric === undefined ? x.rate : finite(x.cap) ? Math.min(x.rate, x.cap) : null;
  });
  const released = sumOrNull(releases);
  const dilution =
    finite(lv.emissionRateAnnual) && finite(eff) && eff > 0 && (r.dilution === undefined || released !== null)
      ? (lv.emissionRateAnnual + (released ?? 0)) / eff
      : null;
  const dilutionLines = (r.dilution ?? []).map((d, i) => ({ id: d.id, tokensPerYear: releases[i], yield: finite(releases[i]) && finite(eff) && eff > 0 ? releases[i]! / eff : null }));
  const netShareholder = shareholder === null || dilution === null ? null : shareholder - dilution;

  // Growth of all holder cash with a daily series, each flow net of its haircut.
  const series = flows.filter((l) => daily.has(l.metric));
  const holderFlowGrowth = growthOf(daily, series.map((l) => l.metric), day, W, series.map((l) => 1 - l.haircut));
  const multiple = shareholder !== null && shareholder > 0 ? 1 / shareholder : null;
  const g = holderFlowGrowth.annualized;
  const pegTrailing = multiple !== null && g !== null && g > 0 ? multiple / (g * 100) : null;
  if (r.extra_cash?.length) notes.push(`holder-flow growth excludes ${r.extra_cash.map((x) => x.id).join(', ')} (a run rate with no daily series)`);
  if (asset.holder_flows.some((f) => f.recipient_base !== 'all')) {
    notes.push('yields are per token of each flow\'s recipients (staked or locked supply), i.e. to a holder in every flow\'s base');
  }

  const income = r.income ? incomeStatement(r.income, daily, day, W) : null;

  let supply: HolderYieldReport['supply'] = null;
  if (r.burned_tokens) {
    const burnedPerYear = annualize(windowSum(daily, r.burned_tokens, day, W));
    const addedPerYear = finite(lv.emissionRateAnnual) && (r.dilution === undefined || released !== null) ? lv.emissionRateAnnual + (released ?? 0) : null;
    const netPerYear = finite(burnedPerYear) && finite(addedPerYear) ? addedPerYear - burnedPerYear : null;
    supply = { burnedPerYear, addedPerYear, netPerYear, netPct: finite(netPerYear) && finite(eff) && eff > 0 ? netPerYear / eff : null };
  }

  const series2 = (metrics: string[] | undefined) =>
    metrics === undefined ? null : { metrics, annualized: annualize(windowSum(daily, metrics, day, W)), growth: growthOf(daily, metrics, day, W) };

  let revenueDisclosed: HolderYieldReport['revenueDisclosed'] = null;
  if (r.revenue_disclosed !== undefined) {
    const d = lv.disclosed;
    const latest = d.at(-1) ?? null;
    const prev = d.length > 1 ? d[d.length - 2] : null;
    let annualizedGrowth: number | null = null;
    if (latest && prev && prev.value > 0 && latest.value > 0) {
      const gapDays = (Date.parse(latest.observedAt) - Date.parse(prev.observedAt)) / 86_400_000;
      if (gapDays >= 7) annualizedGrowth = (latest.value / prev.value) ** (DAYS_PER_YEAR / gapDays) - 1;
    }
    revenueDisclosed = { latest: latest?.value ?? null, latestAt: latest?.observedAt ?? null, previous: prev?.value ?? null, previousAt: prev?.observedAt ?? null, annualizedGrowth };
    if (!prev) notes.push('disclosed revenue: one disclosure so far; growth starts at the next one');
  }

  return {
    asset: asset.id, day, windowDays: W, price,
    marketCap: finite(price) && finite(circ) ? price * circ : null,
    fdv: finite(price) && finite(eff) ? price * eff : null,
    flows, buckets,
    yields: { cash, buyback, shareholder, dilution, netShareholder, multiple, pegTrailing, ...(r.dilution ? { dilutionLines } : {}) },
    holderFlowGrowth,
    supply,
    income, volume: series2(r.volume), revenueDisclosed, notes,
  };
}

type IncomeConfig = NonNullable<NonNullable<AssetConfig['reporting']>['income']>;

/** A weighted sum of flow metrics, for one income figure: [metric, weight] terms. */
type Terms = [string, number][];

function incomeStatement(inc: IncomeConfig, daily: Map<string, Map<string, number>>, day: string, W: number): IncomeStatement {
  const annual = (terms: Terms): number | null => {
    let s = 0;
    for (const [m, w] of terms) {
      const x = windowSum(daily, [m], day, W);
      if (x === null) return null;
      s += x * w;
    }
    return (s * DAYS_PER_YEAR) / W;
  };
  const grow = (terms: Terms): Growth => (terms.length === 0 ? { current: 0, prior: 0, change: null, annualized: null, note: 'no lines' } : growthOf(daily, terms.map((t) => t[0]), day, W, terms.map((t) => t[1])));
  const termsOf = (l: IncomeConfig['lines'][number]): Terms => (l.metric ? [[l.metric, 1]] : [[l.estimate!.of, l.estimate!.ratio]]);
  const of = (to: IncomeLine['to']): Terms => inc.lines.filter((l) => l.to === to).flatMap(termsOf);

  const holdersT = of('holders');
  const costT = of('cost');
  const totalT: Terms = inc.remainder_of ? inc.remainder_of.map((m) => [m, 1]) : inc.lines.flatMap(termsOf);
  const protocolT: Terms = inc.remainder_of ? [...totalT, ...holdersT.map(([m, w]) => [m, -w] as [string, number]), ...costT.map(([m, w]) => [m, -w] as [string, number])] : of('protocol');

  const lines: IncomeLine[] = inc.lines.map((l) => ({ id: l.id, to: l.to, annualized: annual(termsOf(l)), basis: l.metric ? 'measured' : 'estimate', ...(l.note ? { note: l.note } : {}) }));
  if (inc.remainder_of) lines.push({ id: 'protocol_income', to: 'protocol', annualized: annual(protocolT), basis: 'remainder', note: 'revenue less holders and costs' });

  const revenue = annual(totalT);
  const holders = annual(holdersT);
  const protocol = annual(protocolT);
  const ratio = (x: number | null) => (finite(x) && finite(revenue) && revenue > 0 ? x / revenue : null);
  const byId = new Map(inc.lines.map((l) => [l.id, l]));
  const checks = (inc.checks ?? []).map((c) => {
    const measured = annual(c.total.map((m) => [m, 1]));
    const sumOfParts = annual(c.parts.flatMap((p) => termsOf(byId.get(p)!)));
    const gapPct = finite(measured) && finite(sumOfParts) && measured > 0 ? (sumOfParts / measured - 1) * 100 : null;
    return { total: c.total, parts: c.parts, measured, sumOfParts, gapPct };
  });
  return {
    revenue: { annualized: revenue, growth: grow(totalT) },
    holders: { annualized: holders, growth: grow(holdersT) },
    protocol: { annualized: protocol, growth: grow(protocolT) },
    costs: { annualized: annual(costT) },
    payoutRatio: ratio(holders),
    protocolMargin: ratio(protocol),
    lines,
    checks,
    outsideRevenue: (inc.outside_revenue ?? []).map((o) => ({ id: o.id, annualized: annual([[o.metric, 1]]), ...(o.note ? { note: o.note } : {}) })),
  };
}
