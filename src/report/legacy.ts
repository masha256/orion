import type { RecipientBase } from '../config/schema.js';
import type { Bucket, Growth, SupplyFlow, Yields } from './holderYield.js';
import type { IsV2 } from './incomeStatement.js';

/**
 * Task 11a (one commit only): the v1 report's keys (`report yield --legacy`, the tick's holder-yield block, the
 * snapshot body) rebuilt from the income statement, because the config they were computed from (`holder_flows`,
 * `reporting`) is retired. Task 11b removes `--legacy`, these keys and this file. Holder flow, buckets, yields, supply
 * and volume are the statement's own figures; v1's own income statement and revenue streams are gone with their config,
 * so `income` and `revenue` carry the statement's totals and no lines, and `revenueDisclosed` is null.
 */

export interface FlowLine {
  id: string;
  metric: string;
  bucket: Bucket;
  recipientBase: RecipientBase;
  haircut: number;
  gross: number | null;
  net: number | null;
  yield: number | null;
  growth: Growth;
}

export interface BucketLine {
  gross: number | null;
  net: number | null;
  yield: number | null;
  growth: Growth;
}

export interface RevenueStreamLine {
  id: string;
  label: string | null;
  basis: 'daily' | 'periodic' | 'disclosed';
  metric: string;
  annualized: number | null;
  daysInWindow: number | null;
  provisionalDays: number;
  started: string | null;
  isNew: boolean;
  growth: Growth;
  holderFlow: Bucket | null;
  share?: number;
  grossAnnualized?: number | null;
}

export interface RevenueReport {
  basis: 'streams' | 'income' | 'disclosed';
  streams: RevenueStreamLine[];
  annualized: number | null;
  growth: Growth;
  growthExNew: Growth | null;
  excludedFromExNew: string[];
  disclosedGrowth?: { annualized: number | null; gapDays: number | null; latestAgeDays: number | null; flags: string[] };
  crossCheck?: { metric: string; annualized: number | null };
  provisional: boolean;
}

export interface IncomeLine {
  id: string;
  to: 'holders' | 'protocol' | 'cost';
  annualized: number | null;
  basis: 'measured' | 'estimate' | 'remainder';
  note?: string;
}

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

export interface HolderYieldReport {
  asset: string;
  day: string;
  windowDays: number;
  price: number | null;
  marketCap: number | null;
  fdv: number | null;
  flows: FlowLine[];
  buckets: Record<Bucket, BucketLine | null>;
  yields: Yields;
  holderFlowGrowth: Growth;
  supply: SupplyFlow;
  income: IncomeStatement | null;
  revenue: RevenueReport | null;
  volume: { annualized: number | null; growth: Growth; metrics: string[] } | null;
  revenueDisclosed: { latest: number | null; latestAt: string | null; previous: number | null; previousAt: string | null; annualizedGrowth: number | null } | null;
  notes: string[];
  incomeStatement?: IsV2 | null;
  incomeStatementError?: string;
}

const noSeries = (note: string): Growth => ({ current: null, prior: null, change: null, annualized: null, note });
const NULL_YIELDS: Yields = { cash: null, buyback: null, shareholder: null, dilution: null, netShareholder: null, multiple: null, pegTrailing: null };

/** The v1-shaped object (v1 key order, `incomeStatement` last) from the header and the statement (null: it threw). */
export function legacyView(
  head: { asset: string; day: string; windowDays: number; price: number | null; marketCap: number | null; fdv: number | null; notes: string[] },
  is: IsV2 | null,
): Omit<HolderYieldReport, 'incomeStatement' | 'incomeStatementError'> {
  const base = { asset: head.asset, day: head.day, windowDays: head.windowDays, price: head.price, marketCap: head.marketCap, fdv: head.fdv };
  if (is === null) {
    return {
      ...base, flows: [], buckets: { burn: null, hold: null, cash: null }, yields: NULL_YIELDS, holderFlowGrowth: noSeries('income statement unavailable'),
      supply: null, income: null, revenue: null, volume: null, revenueDisclosed: null, notes: head.notes,
    };
  }
  const flows: FlowLine[] = is.holderFlow.lines
    .filter((l) => l.notMeasured === undefined && l.bucket !== null)
    .map((l) => ({ id: l.id, metric: l.metric ?? l.id, bucket: l.bucket!, recipientBase: l.recipientBase, haircut: l.haircut, gross: l.gross, net: l.net, yield: l.yield, growth: l.growth }));
  const bucket = (b: Bucket): BucketLine | null => {
    const x = is.holderFlow.byBucket[b];
    return x === null ? null : { gross: x.gross, net: x.net, yield: x.yield, growth: noSeries('see incomeStatement.holderFlow') };
  };
  const rev = is.revenue;
  const ratio = (x: number | null) => (x !== null && rev.annualized !== null && rev.annualized > 0 ? x / rev.annualized : null);
  return {
    ...base,
    flows,
    buckets: { burn: bucket('burn'), hold: bucket('hold'), cash: bucket('cash') },
    yields: is.yields,
    holderFlowGrowth: is.holderFlow.growth,
    supply: is.dilution.supply,
    income: {
      revenue: { annualized: rev.annualized, growth: rev.growth }, holders: { annualized: is.holders.annualized, growth: is.holders.growth },
      protocol: { annualized: is.protocol.annualized, growth: is.protocol.growth }, costs: { annualized: is.costOfRevenue.annualized },
      payoutRatio: is.ratios.payoutRatio, protocolMargin: ratio(is.protocol.annualized), lines: [], checks: [], outsideRevenue: [],
    },
    revenue: {
      basis: rev.lines.some((l) => l.method === 'disclosed') ? 'disclosed' : 'income', streams: [], annualized: rev.annualized, growth: rev.growth,
      growthExNew: rev.growthExNew, excludedFromExNew: rev.excludedFromExNew, provisional: rev.provisional,
    },
    volume: is.volume === null ? null : { annualized: is.volume.annualized, growth: is.volume.growth, metrics: is.volume.metrics },
    revenueDisclosed: null,
    notes: head.notes,
  };
}
