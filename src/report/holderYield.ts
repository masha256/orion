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
  /** Daily flow totals per flow metric: UTC day -> value (USD). A periodic stream's payments arrive spread over their days. */
  daily: Map<string, Map<string, number>>;
  /** Days of a periodic stream's metric not yet paid for: filled at the last period's daily rate, provisional. */
  provisional?: Map<string, Set<string>>;
  levels: ReportLevels;
}

/** Streams younger than this are left out of the second revenue growth figure (a new stream inflates 90d/90d). */
export const NEW_STREAM_DAYS = 180;

export interface RevenueStreamLine {
  id: string;
  label: string | null;
  basis: 'daily' | 'periodic' | 'disclosed';
  metric: string;
  /**
   * USD a year. A daily or periodic stream: its window sum scaled to a year, over its own days when it is younger than the
   * window (a run rate, not diluted by the days before it began). A disclosed stream: the latest disclosed run rate.
   */
  annualized: number | null;
  /** Days of the window this stream existed (null: older than the window, or a disclosure). */
  daysInWindow: number | null;
  /** Days at the end of the window not yet paid for (periodic): filled at the last period's daily rate. */
  provisionalDays: number;
  started: string | null;
  /** True when younger than NEW_STREAM_DAYS on the report day. */
  isNew: boolean;
  growth: Growth;
  holderFlow: Bucket | null;
  /** The fraction of the gross series the protocol keeps (reporting.revenue[].share): present only when set. */
  share?: number;
  /** USD a year before the share (annualized is after it): present only with a share. */
  grossAnnualized?: number | null;
}

export interface RevenueReport {
  /** 'streams': reporting.revenue; 'income': no streams listed, so the income statement's total (one daily series); 'disclosed': the company's figure. */
  basis: 'streams' | 'income' | 'disclosed';
  streams: RevenueStreamLine[];
  annualized: number | null;
  /** 90d/90d of the sum of the streams with a daily series, as is. */
  growth: Growth;
  /** The same, leaving out streams younger than NEW_STREAM_DAYS; null when no stream is that young. */
  growthExNew: Growth | null;
  excludedFromExNew: string[];
  /** A disclosed stream's growth between the two latest disclosures, with its flags. */
  disclosedGrowth?: { annualized: number | null; gapDays: number | null; latestAgeDays: number | null; flags: string[] };
  /** A disclosed stream's cross-check: the third-party daily series, annualized over the window. */
  crossCheck?: { metric: string; annualized: number | null };
  provisional: boolean;
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
  /** Revenue = the sum of reporting.revenue's streams; without the list, the income statement's total. */
  revenue: RevenueReport | null;
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
  const { asset, day, levels: lv } = input;
  const r = asset.reporting;
  if (!r) throw new Error(`assets/${asset.id}.yaml has no reporting block`);
  const W = r.window_days;
  // A stream is zero before it began: days before `started` are filled with 0, so a window that reaches back past the
  // start is complete (the stream's growth then counts it as new money, which growthExNew leaves out).
  const daily = new Map(input.daily);
  for (const s of r.revenue ?? []) {
    if (s.metric === undefined || s.started === undefined) continue;
    const src = daily.get(s.metric) ?? new Map<string, number>();
    const filled = new Map(src);
    for (let i = 0; i < 2 * W; i++) {
      const d = addDays(day, -i);
      if (d < s.started && !filled.has(d)) filled.set(d, 0);
    }
    daily.set(s.metric, filled);
  }
  // A stream younger than the window is annualized over its own days (a run rate), not diluted by the days before it.
  const daysIn = (started: string | undefined): number | null => {
    if (started === undefined) return null;
    const n = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${started}T00:00:00Z`)) / 86_400_000) + 1;
    return n >= W ? null : Math.max(n, 0);
  };
  const weightOf = (metric: string): number => {
    const s = (r.revenue ?? []).find((x) => x.metric === metric);
    const n = daysIn(s?.started);
    return n === null || n === 0 ? 1 : W / n;
  };
  // The fraction of a stream's gross series the protocol keeps (1 without a share).
  const shareOf = (metric: string): number => (r.revenue ?? []).find((x) => x.metric === metric)?.share ?? 1;
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
  // A revenue stream that also reaches holders (HYPE's reserve yield funds the Assistance Fund's buybacks): report only.
  for (const s of r.revenue ?? []) {
    if (s.holder_flow === undefined || s.metric === undefined) continue;
    const haircut = r.haircuts[s.id] ?? 0;
    const sum = windowSum(daily, [s.metric], day, W);
    const gross = sum === null ? null : ((sum * DAYS_PER_YEAR) / W) * weightOf(s.metric);
    const net = gross === null ? null : gross * (1 - haircut);
    flows.push({
      id: s.id, metric: s.metric, bucket: s.holder_flow, recipientBase: 'all', haircut, gross, net,
      yield: yieldOf(net, 'all'), growth: growthOf(daily, [s.metric], day, W),
    });
  }
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

  const revenue = revenueReport(asset, daily, input.provisional, day, W, lv, daysIn, weightOf);
  const income = r.income ? incomeStatement(r.income, daily, day, W, r.revenue ? { revenue, weightOf, shareOf, holderStreams: (r.revenue ?? []).filter((s) => s.holder_flow !== undefined && s.metric !== undefined).map((s) => s.metric!) } : undefined) : null;
  const revenueOut: RevenueReport | null =
    revenue ?? (income ? { basis: 'income', streams: [], annualized: income.revenue.annualized, growth: income.revenue.growth, growthExNew: null, excludedFromExNew: [], provisional: false } : null);
  if (revenue?.provisional) notes.push(`revenue: ${revenue.streams.filter((s) => s.provisionalDays > 0).map((s) => `${s.id} has ${s.provisionalDays} unpaid day(s) at the last period's daily rate (provisional)`).join('; ')}`);

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
    income, revenue: revenueOut, volume: series2(r.volume), revenueDisclosed, notes,
  };
}

type IncomeConfig = NonNullable<NonNullable<AssetConfig['reporting']>['income']>;

/** A weighted sum of flow metrics, for one income figure: [metric, weight] terms. */
type Terms = [string, number][];

interface StreamTotal {
  revenue: RevenueReport | null;
  weightOf: (metric: string) => number;
  /** A stream's share of its gross series: the statement counts the kept part, as the revenue report does. */
  shareOf: (metric: string) => number;
  /** Stream metrics that also reach holders: holders lines of the statement. */
  holderStreams: string[];
}

function incomeStatement(inc: IncomeConfig, daily: Map<string, Map<string, number>>, day: string, W: number, streams?: StreamTotal): IncomeStatement {
  const annual = (terms: Terms): number | null => {
    let s = 0;
    for (const [m, w] of terms) {
      const x = windowSum(daily, [m], day, W);
      if (x === null) return null;
      s += x * w;
    }
    return (s * DAYS_PER_YEAR) / W;
  };
  // A young stream's run-rate weight annualizes it; growth compares raw window sums (weight 1), as the revenue report does.
  // A stream with a share counts its kept part in both.
  const streamMetrics = new Set((streams?.revenue?.streams ?? []).filter((s) => s.basis !== 'disclosed').map((s) => s.metric));
  const grow = (terms: Terms): Growth =>
    terms.length === 0
      ? { current: 0, prior: 0, change: null, annualized: null, note: 'no lines' }
      : growthOf(daily, terms.map((t) => t[0]), day, W, terms.map(([m, w]) => (streamMetrics.has(m) ? Math.sign(w) * streams!.shareOf(m) : w)));
  const termsOf = (l: IncomeConfig['lines'][number]): Terms => (l.metric ? [[l.metric, 1]] : [[l.estimate!.of, l.estimate!.ratio]]);
  const of = (to: IncomeLine['to']): Terms => inc.lines.filter((l) => l.to === to).flatMap(termsOf);

  const neg = (t: Terms): Terms => t.map(([m, w]) => [m, -w] as [string, number]);
  // With revenue streams: revenue is their sum (a young stream at its run rate), the streams that reach holders are holders
  // lines, and protocol income is the remainder. A disclosed stream is a level: the statement's revenue is that figure.
  const streamHolders: Terms = (streams?.holderStreams ?? []).map((m) => [m, streams!.weightOf(m) * streams!.shareOf(m)]);
  const holdersT = [...of('holders'), ...streamHolders];
  const costT = of('cost');
  const streamT: Terms | null = streams?.revenue
    ? streams.revenue.streams.filter((s) => s.basis !== 'disclosed').map((s) => [s.metric, streams.weightOf(s.metric) * streams.shareOf(s.metric)] as [string, number])
    : null;
  const disclosedTotal = streams?.revenue?.basis === 'disclosed' ? streams.revenue.annualized : undefined;
  const remainder = inc.remainder_of !== undefined || streams !== undefined;
  const totalT: Terms = streamT ?? (inc.remainder_of ? inc.remainder_of.map((m) => [m, 1]) : inc.lines.flatMap(termsOf));
  const protocolT: Terms = remainder ? [...totalT, ...neg(holdersT), ...neg(costT)] : of('protocol');

  const lines: IncomeLine[] = inc.lines.map((l) => ({ id: l.id, to: l.to, annualized: annual(termsOf(l)), basis: l.metric ? 'measured' : 'estimate', ...(l.note ? { note: l.note } : {}) }));
  for (const s of streams?.revenue?.streams.filter((x) => x.holderFlow !== null) ?? []) {
    lines.push({ id: s.id, to: 'holders', annualized: s.annualized, basis: 'measured', note: `${s.label ?? s.id}: a revenue stream paid to holders` });
  }
  const annualTotal = (): number | null => (disclosedTotal !== undefined ? disclosedTotal : annual(totalT));
  const protocolAnnual = (): number | null => {
    if (disclosedTotal === undefined) return annual(protocolT);
    const h = annual(holdersT);
    const c = annual(costT);
    return finite(disclosedTotal) && finite(h) && finite(c) ? disclosedTotal - h - c : null;
  };
  if (remainder) lines.push({ id: 'protocol_income', to: 'protocol', annualized: protocolAnnual(), basis: 'remainder', note: 'revenue less holders and costs' });

  const revenue = annualTotal();
  const holders = annual(holdersT);
  const protocol = protocolAnnual();
  const ratio = (x: number | null) => (finite(x) && finite(revenue) && revenue > 0 ? x / revenue : null);
  const byId = new Map(inc.lines.map((l) => [l.id, l]));
  const checks = (inc.checks ?? []).map((c) => {
    const measured = annual(c.total.map((m) => [m, 1]));
    const sumOfParts = annual(c.parts.flatMap((p) => termsOf(byId.get(p)!)));
    const gapPct = finite(measured) && finite(sumOfParts) && measured > 0 ? (sumOfParts / measured - 1) * 100 : null;
    return { total: c.total, parts: c.parts, measured, sumOfParts, gapPct };
  });
  return {
    revenue: { annualized: revenue, growth: disclosedTotal !== undefined ? noSeries('a disclosed level: see revenue') : grow(totalT) },
    holders: { annualized: holders, growth: grow(holdersT) },
    protocol: { annualized: protocol, growth: disclosedTotal !== undefined ? noSeries('a disclosed level less daily flows') : grow(protocolT) },
    costs: { annualized: annual(costT) },
    payoutRatio: ratio(holders),
    protocolMargin: ratio(protocol),
    lines,
    checks,
    outsideRevenue: (inc.outside_revenue ?? []).map((o) => ({ id: o.id, annualized: annual([[o.metric, 1]]), ...(o.note ? { note: o.note } : {}) })),
  };
}

/** One series' window sum scaled to a year, times a young stream's run-rate weight. */
function runRate(daily: Map<string, Map<string, number>>, key: string, day: string, W: number, weight: number): number | null {
  const sum = windowSum(daily, [key], day, W);
  return sum === null ? null : ((sum * DAYS_PER_YEAR) / W) * weight;
}

const noSeries = (note: string): Growth => ({ current: null, prior: null, change: null, annualized: null, note });

/** Days from a to b (ISO times or days), rounded. */
const daysFrom = (a: string, b: string) => Math.round((Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b) - Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a)) / 86_400_000);

/** Two disclosures closer than this give a noisy growth rate; a latest disclosure older than it is stale. */
export const DISCLOSURE_GAP_DAYS = 90;

/**
 * Revenue (Mike, 2026-10-12): the sum of reporting.revenue's streams. Without the list, the income statement's total, as
 * before. A disclosed stream (the company's own figure) is the whole revenue; its growth is between the two latest
 * disclosures, flagged when they are under 90 days apart or the latest is over 90 days old.
 */
function revenueReport(
  asset: AssetConfig,
  daily: Map<string, Map<string, number>>,
  provisional: Map<string, Set<string>> | undefined,
  day: string,
  W: number,
  lv: ReportLevels,
  daysIn: (started: string | undefined) => number | null,
  weightOf: (metric: string) => number,
): RevenueReport | null {
  const r = asset.reporting!;
  if (!r.revenue) return null;
  const endIso = `${addDays(day, 1)}T00:00:00.000Z`;
  const streams: RevenueStreamLine[] = [];
  // A stream with a share reads a scaled copy of its series, keyed by stream id: the shared daily map stays gross for
  // every other reader of the metric (income lines, holder flows, volume).
  const kept = new Map<string, Map<string, number>>();
  for (const s of r.revenue) {
    const src = s.metric === undefined ? undefined : daily.get(s.metric);
    if (!src) continue;
    kept.set(s.id, s.share === undefined ? src : new Map([...src].map(([d, v]) => [d, v * s.share!] as const)));
  }
  let disclosedGrowth: RevenueReport['disclosedGrowth'];
  let crossCheck: RevenueReport['crossCheck'];
  for (const s of r.revenue) {
    if (s.disclosed !== undefined) {
      const d = lv.disclosed;
      const latest = d.at(-1) ?? null;
      const prev = d.length > 1 ? d[d.length - 2] : null;
      const gapDays = latest && prev ? daysFrom(prev.observedAt, latest.observedAt) : null;
      const latestAgeDays = latest ? daysFrom(latest.observedAt, endIso) : null;
      const annualized = latest && prev && prev.value > 0 && latest.value > 0 && gapDays! > 0 ? (latest.value / prev.value) ** (DAYS_PER_YEAR / gapDays!) - 1 : null;
      const flags: string[] = [];
      if (!prev) flags.push('one disclosure so far: no growth');
      if (gapDays !== null && gapDays < DISCLOSURE_GAP_DAYS) flags.push(`the two latest disclosures are ${gapDays} days apart (< ${DISCLOSURE_GAP_DAYS}): a noisy rate`);
      if (latestAgeDays !== null && latestAgeDays > DISCLOSURE_GAP_DAYS) flags.push(`the latest disclosure is ${latestAgeDays} days old (> ${DISCLOSURE_GAP_DAYS})`);
      disclosedGrowth = { annualized, gapDays, latestAgeDays, flags };
      if (s.cross_check !== undefined) {
        const sum = windowSum(daily, [s.cross_check], day, W);
        crossCheck = { metric: s.cross_check, annualized: sum === null ? null : (sum * DAYS_PER_YEAR) / W };
      }
      streams.push({
        id: s.id, label: s.label ?? null, basis: 'disclosed', metric: s.disclosed, annualized: latest?.value ?? null, daysInWindow: null, provisionalDays: 0,
        started: s.started ?? null, isNew: false, growth: { current: latest?.value ?? null, prior: prev?.value ?? null, change: latest && prev && prev.value > 0 ? latest.value / prev.value - 1 : null, annualized, note: 'between the two latest disclosures' },
        holderFlow: null,
      });
      continue;
    }
    const metric = s.metric!;
    const n = daysIn(s.started);
    const pending = provisional?.get(metric);
    let provisionalDays = 0;
    if (pending) for (let i = 0; i < W; i++) if (pending.has(addDays(day, -i))) provisionalDays++;
    const age = s.started === undefined ? null : daysFrom(s.started, day) + 1;
    streams.push({
      id: s.id, label: s.label ?? null, basis: s.settlement ?? 'daily', metric,
      annualized: runRate(kept, s.id, day, W, weightOf(metric)),
      daysInWindow: n, provisionalDays, started: s.started ?? null, isNew: age !== null && age < NEW_STREAM_DAYS,
      growth: growthOf(kept, [s.id], day, W), holderFlow: s.holder_flow ?? null,
      ...(s.share !== undefined ? { share: s.share, grossAnnualized: runRate(daily, metric, day, W, weightOf(metric)) } : {}),
    });
  }
  const finiteAll = (xs: (number | null)[]) => (xs.some((x) => x === null || !Number.isFinite(x)) ? null : xs.reduce<number>((a, x) => a + x!, 0));
  const series = streams.filter((s) => s.basis !== 'disclosed');
  const isDisclosed = streams.some((s) => s.basis === 'disclosed');
  const growth = isDisclosed
    ? streams[0].growth
    : series.length === 0
      ? noSeries('no daily stream')
      : growthOf(kept, series.map((s) => s.id), day, W);
  const old = series.filter((s) => !s.isNew);
  const excluded = series.filter((s) => s.isNew).map((s) => s.id);
  const growthExNew = isDisclosed || excluded.length === 0 ? null : old.length === 0 ? noSeries('every stream is new') : growthOf(kept, old.map((s) => s.id), day, W);
  return {
    basis: isDisclosed ? 'disclosed' : 'streams',
    streams,
    annualized: finiteAll(streams.map((s) => s.annualized)),
    growth,
    growthExNew,
    excludedFromExNew: excluded,
    ...(disclosedGrowth ? { disclosedGrowth } : {}),
    ...(crossCheck ? { crossCheck } : {}),
    provisional: streams.some((s) => s.provisionalDays > 0),
  };
}
