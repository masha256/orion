import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { listCheckResults } from '../db/checkResults.js';
import { listActiveObservations, listActiveProvenance } from '../db/observations.js';
import { provenanceLabel } from '../provenance/locator.js';
import { latestLevel } from '../observations/select.js';
import { addDays, utcDay } from '../ingest/time.js';
import { MS_PER_DAY, STD_METRICS } from '../types.js';
import { holderYieldReport, type DayProvenance, type HolderYieldReport, type ReportInput, type ReportLevels } from './holderYield.js';
import { incomeStatementV2, type IsV2 } from './incomeStatement.js';

/**
 * Every flow metric the report reads: the holder flows, plus revenue and volume, then the income statement v2's (which
 * reads the same series for all 13 assets today, so the default report day does not move).
 */
export function reportFlowMetrics(asset: AssetConfig): string[] {
  const r = asset.reporting;
  const inc = r?.income;
  const income = inc
    ? [
        ...inc.lines.map((l) => l.metric ?? l.estimate!.of),
        ...(inc.remainder_of ?? []),
        ...(inc.checks ?? []).flatMap((c) => c.total),
        ...(inc.outside_revenue ?? []).map((o) => o.metric),
      ]
    : [];
  const streams = (r?.revenue ?? []).flatMap((s) => [s.metric, s.cross_check].filter((m): m is string => m !== undefined));
  return [...new Set([...asset.holder_flows.map((f) => f.metric), ...income, ...streams, ...(r?.volume ?? []), ...(r?.burned_tokens ?? []), ...statementFlowMetrics(asset)])];
}

/** The flow metrics `income_statement` reads (revenue, uses, paid_metric, below-line flows, check totals, volume, burned_tokens). */
function statementFlowMetrics(asset: AssetConfig): string[] {
  const is = asset.income_statement;
  if (!is) return [];
  const uses = [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])];
  return [
    ...is.revenue.flatMap((l) => [l.metric, l.derived?.from, l.cross_check]),
    ...uses.flatMap((l) => [l.metric, 'paid_metric' in l ? l.paid_metric : undefined]),
    ...(is.below_line ?? []).map((b) => b.metric),
    // Only a sum check's totals: the other check types read their own series, which must never move the report day.
    ...(is.checks ?? []).flatMap((c) => (c.type === 'sum' ? c.total : [])),
    ...(is.volume ?? []),
    ...(is.burned_tokens ?? []),
  ].filter((m): m is string => m !== undefined);
}

/** The metrics of periodic revenue streams: paid weeks after the days they cover, so they never hold back the report day. */
function periodicMetrics(asset: AssetConfig): Set<string> {
  return new Set([
    ...(asset.reporting?.revenue ?? []).filter((s) => s.settlement === 'periodic').map((s) => s.metric!),
    ...(asset.income_statement?.revenue ?? []).filter((l) => l.settlement === 'periodic').map((l) => (l.metric ?? l.derived?.from)!),
  ]);
}

/**
 * A periodic stream's payments spread evenly over the days each covers, then the unpaid days after the last covered one,
 * through `through`, at the last period's daily rate: provisional, and replaced when the payment lands (the payment row
 * is the only thing stored). Before the first payment there is no rate, so the unpaid days stay missing.
 */
export async function periodicDaily(db: Db, assetId: string, metricKey: string, through: string): Promise<{ days: Map<string, number>; provisional: Set<string> }> {
  const days = new Map<string, number>();
  const provisional = new Set<string>();
  const rows = (await listActiveObservations(db, assetId, metricKey))
    .filter((o) => o.status === 'confirmed' && (o.periodDays ?? 1) >= 1)
    .sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1));
  let last: { end: string; rate: number } | null = null;
  for (const o of rows) {
    const n = o.periodDays ?? 1;
    const end = utcDay(new Date(o.observedAt).getTime() - MS_PER_DAY);
    for (let i = 0; i < n; i++) days.set(addDays(end, -i), o.value / n);
    if (last === null || end > last.end) last = { end, rate: o.value / n };
  }
  if (last) {
    for (let d = addDays(last.end, 1); d <= through; d = addDays(d, 1)) {
      days.set(d, last.rate);
      provisional.add(d);
    }
  }
  return { days, provisional };
}

/** A flow metric's stored daily rows (confirmed, active), keyed by the UTC day each covers. */
async function dailyOf(db: Db, assetId: string, metricKey: string): Promise<Map<string, number>> {
  const days = new Map<string, number>();
  for (const o of await listActiveObservations(db, assetId, metricKey)) {
    if (o.status !== 'confirmed' || o.periodDays !== 1) continue;
    days.set(utcDay(new Date(o.observedAt).getTime() - MS_PER_DAY), o.value);
  }
  return days;
}

/**
 * The newest day that every flow the report reads has (holder flows, income lines, volume): the default day a report
 * covers. A series that runs a day ahead of another (HYPE's buybacks vs its revenue proxy) must not leave the slower one
 * blank in the report.
 */
export async function lastCompleteReportDay(db: Db, asset: AssetConfig): Promise<string | null> {
  let last: string | null = null;
  const periodic = periodicMetrics(asset);
  for (const metric of reportFlowMetrics(asset)) {
    if (periodic.has(metric)) continue;
    const days = [...(await dailyOf(db, asset.id, metric)).keys()].sort();
    const d = days.at(-1);
    if (d === undefined) return null;
    if (last === null || d < last) last = d;
  }
  return last;
}

/**
 * `report yield --json` (D9): the income statement v2 with the figures it shares with the header. The v1 keys (`flows`,
 * `buckets`, `yields`, `holderFlowGrowth`, `supply`, `income`, `revenue`, `volume`, `revenueDisclosed`) stay one release
 * behind `--legacy`. `incomeStatement` is absent for an asset with no `income_statement` block.
 */
export interface YieldReport {
  asset: string;
  day: string;
  windowDays: number;
  price: number | null;
  marketCap: number | null;
  fdv: number | null;
  /** Null when computing it threw (`incomeStatementError` says why); absent without an income_statement block. */
  incomeStatement?: IsV2 | null;
  incomeStatementError?: string;
  notes: string[];
}

export interface ReportOptions {
  /** The v1 object in v1 key order, `incomeStatement` appended last (deleting it gives v1 byte for byte). */
  legacy?: boolean;
}

/**
 * Ruling C4: income statement v2 is new code beside the legacy report for one release, so an exception inside it never
 * fails the legacy report, the tick or the snapshot: the report carries `incomeStatement: null` and the error's message
 * (`incomeStatementError`), the tick `holder_yield.statement_error`, and the nightly block an ALERT line, so a broken
 * statement is never silent.
 */
function statementOf(input: ReportInput, v1: HolderYieldReport): { incomeStatement: IsV2 } | { incomeStatement: null; incomeStatementError: string } {
  try {
    return { incomeStatement: incomeStatementV2(input, v1) };
  } catch (err) {
    return { incomeStatement: null, incomeStatementError: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

/** The report object for one input: v1 then v2, from the same input (pure). */
export function yieldReport(input: ReportInput, opts: { legacy: true }): HolderYieldReport;
export function yieldReport(input: ReportInput, opts?: ReportOptions): YieldReport | HolderYieldReport;
export function yieldReport(input: ReportInput, opts: ReportOptions = {}): YieldReport | HolderYieldReport {
  const v1 = holderYieldReport(input);
  const withIs = input.asset.income_statement ? statementOf(input, v1) : {};
  if (opts.legacy) return { ...v1, ...withIs };
  return { asset: v1.asset, day: v1.day, windowDays: v1.windowDays, price: v1.price, marketCap: v1.marketCap, fdv: v1.fdv, ...withIs, notes: v1.notes };
}

/**
 * The asset's report for `day` (default: its last complete report day). Without `legacy`, the D9 shape; with it, the v1
 * object plus `incomeStatement` (the tick's summary and the snapshot body read the v1 keys).
 */
export async function loadHolderYieldReport(db: Db, asset: AssetConfig, day: string | undefined, opts: { legacy: true }): Promise<HolderYieldReport>;
export async function loadHolderYieldReport(db: Db, asset: AssetConfig, day?: string, opts?: ReportOptions): Promise<YieldReport | HolderYieldReport>;
export async function loadHolderYieldReport(db: Db, asset: AssetConfig, day?: string, opts: ReportOptions = {}): Promise<YieldReport | HolderYieldReport> {
  const r = asset.reporting;
  if (!r) throw new Error(`assets/${asset.id}.yaml has no reporting block`);
  const target = day ?? (await lastCompleteReportDay(db, asset));
  if (target === null) throw new Error(`${asset.id}: no stored day for every report flow yet`);
  const asOf = new Date(Date.parse(`${addDays(target, 1)}T00:00:00.000Z`) + MS_PER_DAY - 1).toISOString(); // to the end of the next day: the levels read with that day's run
  const level = async (key: string): Promise<number | null> => {
    const rows = (await listActiveObservations(db, asset.id, key)).filter((o) => o.status === 'confirmed');
    return latestLevel(rows, asOf)?.value ?? null;
  };
  const extra: Record<string, number | null> = {};
  for (const x of r.extra_cash ?? []) extra[x.metric] = await level(x.metric);
  // Income statement v2's run-rate lines (CRV's vote incentives: the same level extra_cash reads).
  for (const b of asset.income_statement?.below_line ?? []) if (b.run_rate !== undefined && !(b.run_rate in extra)) extra[b.run_rate] = await level(b.run_rate);
  const disclosuresOf = async (metric: string) =>
    (await listActiveObservations(db, asset.id, metric))
      .filter((o) => o.status === 'confirmed' && o.observedAt <= asOf)
      .sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1))
      .map((o) => ({ observedAt: o.observedAt, value: o.value }));
  // v1 reads `revenue_disclosed` (output unchanged). The v2 disclosed line reads the metric its own `disclosed` key names:
  // the same rows when the two keys agree (VVV), its own rows when they differ, so a mismatch can never borrow v1's.
  const v1Discloses = r.revenue_disclosed !== undefined || (r.revenue ?? []).some((s) => s.disclosed !== undefined);
  const v1Metric = v1Discloses ? r.revenue_disclosed : undefined;
  const disclosed = v1Metric ? await disclosuresOf(v1Metric) : [];
  const statementMetric = asset.income_statement?.revenue.find((l) => l.disclosed !== undefined)?.disclosed;
  const statementDisclosed = statementMetric === undefined ? undefined : statementMetric === v1Metric ? disclosed : await disclosuresOf(statementMetric);
  let dilution: ReportLevels['dilution'];
  if (r.dilution) {
    dilution = {};
    for (const d of r.dilution) dilution[d.id] = { rate: await level(d.metric), cap: d.cap_metric ? await level(d.cap_metric) : null };
  }
  const levels: ReportLevels = {
    price: await level(STD_METRICS.price),
    totalSupply: await level(STD_METRICS.totalSupply),
    circulatingSupply: asset.metrics[STD_METRICS.circulatingSupply] ? await level(STD_METRICS.circulatingSupply) : null,
    stakedSupply: await level(STD_METRICS.stakedSupply),
    lockedSupply: asset.metrics[STD_METRICS.lockedSupply] ? await level(STD_METRICS.lockedSupply) : null,
    emissionRateAnnual: await level(STD_METRICS.emissionRate),
    extra,
    ...(dilution ? { dilution } : {}),
    disclosed,
    ...(statementDisclosed ? { statementDisclosed } : {}),
    asOf,
  };
  const periodic = periodicMetrics(asset);
  const provisional = new Map<string, Set<string>>();
  const daily = new Map<string, Map<string, number>>();
  for (const m of reportFlowMetrics(asset)) {
    if (!periodic.has(m)) {
      daily.set(m, await dailyOf(db, asset.id, m));
      continue;
    }
    const p = await periodicDaily(db, asset.id, m, target);
    provisional.set(m, p.provisional);
    daily.set(m, p.days);
  }
  // The checks the tick stored for this day (v2 only: the legacy object never carries them).
  const checks = asset.income_statement ? await listCheckResults(db, asset.id, target) : [];
  // The provenance of every day the daily series hold (v2 only), for the statement's provenance from observations.
  const provenance = asset.income_statement ? await provenanceByDay(db, asset.id, [...daily.keys()], periodic) : undefined;
  return yieldReport({ asset, day: target, daily, provisional, levels, ...(checks.length > 0 ? { checks } : {}), ...(provenance ? { provenance } : {}) }, opts);
}

/**
 * Per flow metric, the provenance of the row each day's value came from: the rows `dailyOf` reads (confirmed, one day)
 * or, for a periodic stream, `periodicDaily` (confirmed, spread over the days a payment covers). A row written before
 * 0004 and not yet backfilled has a null method.
 */
async function provenanceByDay(db: Db, assetId: string, metrics: string[], periodic: Set<string>): Promise<Map<string, Map<string, DayProvenance>>> {
  const out = new Map<string, Map<string, DayProvenance>>(metrics.map((m) => [m, new Map()]));
  for (const r of await listActiveProvenance(db, assetId, metrics)) {
    if (r.status !== 'confirmed') continue;
    const n = r.periodDays ?? 1;
    if (periodic.has(r.metricKey) ? n < 1 : n !== 1) continue;
    const end = utcDay(new Date(r.observedAt).getTime() - MS_PER_DAY);
    const p: DayProvenance = { method: r.method, label: r.sourceType === null ? null : provenanceLabel(r.sourceType, r.chain, r.locator) };
    for (let i = 0; i < n; i++) out.get(r.metricKey)!.set(addDays(end, -i), p);
  }
  return out;
}
