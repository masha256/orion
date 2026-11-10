import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { listCheckResults } from '../db/checkResults.js';
import { listActiveObservations, listActiveProvenance } from '../db/observations.js';
import { listFlowUsd, type PriceBasis } from '../db/prices.js';
import { provenanceLabel } from '../provenance/locator.js';
import { latestLevel } from '../observations/select.js';
import { addDays, utcDay } from '../ingest/time.js';
import { MS_PER_DAY, STD_METRICS } from '../types.js';
import { reportHeader, type DayProvenance, type ReportInput, type ReportLevels } from './holderYield.js';
import { incomeStatementV2, type IsV2 } from './incomeStatement.js';
import { legacyView, type HolderYieldReport } from './legacy.js';

/**
 * Every flow metric the report reads: income_statement's revenue, uses, paid_metric, below-line flows, apportion by and
 * total, sum check totals, volume and burned_tokens (Task 11: the only block since holder_flows and reporting retired).
 */
export function reportFlowMetrics(asset: AssetConfig): string[] {
  const is = asset.income_statement;
  if (!is) return [];
  const uses = [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])];
  return [...new Set([
    ...is.revenue.flatMap((l) => [l.metric, l.derived?.from, l.cross_check]),
    ...uses.flatMap((l) => [l.metric, 'paid_metric' in l ? l.paid_metric : undefined, l.apportion?.by, l.apportion?.total]),
    ...(is.below_line ?? []).flatMap((b) => [b.metric, b.apportion?.by, b.apportion?.total]),
    // Only a sum check's totals: the other check types read their own series, which must never move the report day.
    ...(is.checks ?? []).flatMap((c) => (c.type === 'sum' ? c.total : [])),
    ...(is.volume ?? []),
    ...(is.burned_tokens ?? []),
  ].filter((m): m is string => m !== undefined))];
}

/** The metrics of periodic revenue streams: paid weeks after the days they cover, so they never hold back the report day. */
function periodicMetrics(asset: AssetConfig): Set<string> {
  return new Set((asset.income_statement?.revenue ?? []).filter((l) => l.settlement === 'periodic').map((l) => (l.metric ?? l.derived?.from)!));
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

/** The day rows `dailyOf` reads: confirmed, active, one day each, keyed by the UTC day each covers (the newest wins). */
async function dayRows(db: Db, assetId: string, metricKey: string): Promise<Map<string, { id: number; value: number }>> {
  const days = new Map<string, { id: number; value: number }>();
  for (const o of await listActiveObservations(db, assetId, metricKey)) {
    if (o.status !== 'confirmed' || o.periodDays !== 1) continue;
    days.set(utcDay(new Date(o.observedAt).getTime() - MS_PER_DAY), { id: o.id, value: o.value });
  }
  return days;
}

/** A flow metric's stored daily rows (confirmed, active), keyed by the UTC day each covers: the stored `value`. */
async function dailyOf(db: Db, assetId: string, metricKey: string): Promise<Map<string, number>> {
  return new Map([...(await dayRows(db, assetId, metricKey))].map(([d, r]) => [d, r.value]));
}

/**
 * Task 8 (after G2): income statement v2's daily series. The rows `dailyOf` reads (`rowsOf`: the same days), each valued from
 * flow_usd_v: tokens x hourly prices where every hour with an amount is priced and the row's stored USD was itself
 * hourly-priced at ingest (`pricedHourlyAtIngest`: the G2-signed days), a first-party API's dollars where the row is
 * usd-native, else the stored `value`; `basis` says which per day. A metric that is not a USD flow (tokens, a
 * level) is not in the view: its days keep `value` and get no basis. Periodic streams are left to `periodicDaily`
 * (stored value, basis legacy).
 */
async function statementSeries(
  db: Db, assetId: string, metrics: string[], periodic: Set<string>, legacyDaily: Map<string, Map<string, number>>,
  rowsOf: Map<string, Map<string, { id: number; value: number }>>,
): Promise<{ daily: Map<string, Map<string, number>>; basis: Map<string, Map<string, PriceBasis>> }> {
  const flowUsd = await listFlowUsd(db, assetId);
  const daily = new Map<string, Map<string, number>>();
  const basis = new Map<string, Map<string, PriceBasis>>();
  for (const m of metrics) {
    if (!m.startsWith('flow_usd.')) {
      daily.set(m, legacyDaily.get(m) ?? new Map());
      continue;
    }
    const b = new Map<string, PriceBasis>();
    basis.set(m, b);
    if (periodic.has(m)) {
      const days = legacyDaily.get(m) ?? new Map<string, number>();
      for (const d of days.keys()) b.set(d, 'legacy');
      daily.set(m, days);
      continue;
    }
    const days = new Map<string, number>();
    for (const [d, r] of rowsOf.get(m) ?? new Map<string, { id: number; value: number }>()) {
      const v = flowUsd.get(r.id);
      days.set(d, v?.usd ?? r.value);
      b.set(d, v?.basis ?? 'legacy');
    }
    daily.set(m, days);
  }
  return { daily, basis };
}

/**
 * The flows that set the default report day: every flow the report reads (Task 11, ruling R11.1). For 12 assets this is
 * the v1 set exactly; yCRV's differs (the v1-only st-yCRV fee leaves it, the two by-sender flows of yearn_gross's own
 * scan join it), pinned in tests/report/load.test.ts.
 */
export function defaultDayFlowMetrics(asset: AssetConfig): string[] {
  return reportFlowMetrics(asset);
}

/**
 * The newest day that every flow `defaultDayFlowMetrics` names has: the default day a report covers. A series that runs
 * a day ahead of another (HYPE's buybacks vs its revenue proxy) must not leave the slower one blank in the report.
 */
export async function lastCompleteReportDay(db: Db, asset: AssetConfig): Promise<string | null> {
  let last: string | null = null;
  // Periodic streams are paid weeks after the days they cover: they never hold back the day.
  const periodic = periodicMetrics(asset);
  for (const metric of defaultDayFlowMetrics(asset)) {
    if (periodic.has(metric)) continue;
    const days = [...(await dailyOf(db, asset.id, metric)).keys()].sort();
    const d = days.at(-1);
    if (d === undefined) return null;
    if (last === null || d < last) last = d;
  }
  return last;
}

/**
 * `report yield --json` (D9): the income statement v2 with the figures it shares with the header. Absent for an asset
 * with no `income_statement` block (it has no report). Task 11a: the v1 keys behind `--legacy` are rebuilt from the
 * statement (src/report/legacy.ts) until Task 11b removes them.
 */
export interface YieldReport {
  asset: string;
  day: string;
  windowDays: number;
  price: number | null;
  marketCap: number | null;
  fdv: number | null;
  /** Null when computing it threw (`incomeStatementError` says why). */
  incomeStatement: IsV2 | null;
  incomeStatementError?: string;
  notes: string[];
}

export interface ReportOptions {
  /** The v1-shaped keys (src/report/legacy.ts) in v1 key order, `incomeStatement` appended last. */
  legacy?: boolean;
}

/**
 * Ruling C4: an exception inside the statement never fails the report, the tick or the snapshot: the report carries
 * `incomeStatement: null` and the error's message (`incomeStatementError`), the tick `holder_yield.statement_error`,
 * and the nightly block an ALERT line, so a broken statement is never silent. Task 8: on its own daily series when the
 * loader gives them (`statementDaily`).
 */
function statementOf(input: ReportInput): { incomeStatement: IsV2 } | { incomeStatement: null; incomeStatementError: string } {
  try {
    return { incomeStatement: incomeStatementV2(input.statementDaily === undefined ? input : { ...input, daily: input.statementDaily }) };
  } catch (err) {
    return { incomeStatement: null, incomeStatementError: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

/** The report object for one input (pure). */
export function yieldReport(input: ReportInput, opts: { legacy: true }): HolderYieldReport;
export function yieldReport(input: ReportInput, opts?: ReportOptions): YieldReport | HolderYieldReport;
export function yieldReport(input: ReportInput, opts: ReportOptions = {}): YieldReport | HolderYieldReport {
  return assembleReport(input, opts);
}

/**
 * `yieldReport`, or with `v2ReadError` (a statement-only DB read threw, M3): the statement is not computed and carries
 * that error.
 */
function assembleReport(input: ReportInput, opts: ReportOptions, v2ReadError?: string): YieldReport | HolderYieldReport {
  // The header's figures and notes, on the series the statement reads (Task 8: the same basis as its yields).
  const head = reportHeader(input.statementDaily === undefined ? input : { ...input, daily: input.statementDaily });
  const withIs = v2ReadError !== undefined ? { incomeStatement: null, incomeStatementError: v2ReadError.slice(0, 300) } : statementOf(input);
  const base = { asset: input.asset.id, day: input.day, windowDays: head.windowDays, price: head.price, marketCap: head.marketCap, fdv: head.fdv };
  if (opts.legacy) return { ...legacyView({ ...base, notes: head.notes }, withIs.incomeStatement), ...withIs };
  return { ...base, ...withIs, notes: head.notes };
}

/**
 * The asset's report for `day` (default: its last complete report day): the D9 shape; with `legacy`, the v1-shaped keys
 * plus `incomeStatement` (Task 11a: the tick's summary and the snapshot body still read them). Throws for an asset with
 * no income_statement block.
 */
export async function loadHolderYieldReport(db: Db, asset: AssetConfig, day: string | undefined, opts: { legacy: true }): Promise<HolderYieldReport>;
export async function loadHolderYieldReport(db: Db, asset: AssetConfig, day?: string, opts?: ReportOptions): Promise<YieldReport | HolderYieldReport>;
export async function loadHolderYieldReport(db: Db, asset: AssetConfig, day?: string, opts: ReportOptions = {}): Promise<YieldReport | HolderYieldReport> {
  const is = asset.income_statement;
  if (!is) throw new Error(`assets/${asset.id}.yaml has no income_statement block`);
  const target = day ?? (await lastCompleteReportDay(db, asset));
  if (target === null) throw new Error(`${asset.id}: no stored day for every report flow yet`);
  const asOf = new Date(Date.parse(`${addDays(target, 1)}T00:00:00.000Z`) + MS_PER_DAY - 1).toISOString(); // to the end of the next day: the levels read with that day's run
  const level = async (key: string): Promise<number | null> => {
    const rows = (await listActiveObservations(db, asset.id, key)).filter((o) => o.status === 'confirmed');
    return latestLevel(rows, asOf)?.value ?? null;
  };
  // The run-rate lines below the line (CRV's vote incentives).
  const extra: Record<string, number | null> = {};
  for (const b of is.below_line ?? []) if (b.run_rate !== undefined && !(b.run_rate in extra)) extra[b.run_rate] = await level(b.run_rate);
  // The disclosed revenue line reads the metric its `disclosed` key names (VVV's run rate).
  const disclosedMetric = is.revenue.find((l) => l.disclosed !== undefined)?.disclosed;
  const disclosed = disclosedMetric === undefined
    ? []
    : (await listActiveObservations(db, asset.id, disclosedMetric))
        .filter((o) => o.status === 'confirmed' && o.observedAt <= asOf)
        .sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1))
        .map((o) => ({ observedAt: o.observedAt, value: o.value }));
  let dilution: ReportLevels['dilution'];
  if (is.dilution) {
    dilution = {};
    for (const d of is.dilution) dilution[d.id] = { rate: await level(d.metric), cap: d.cap_metric ? await level(d.cap_metric) : null };
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
    asOf,
  };
  const periodic = periodicMetrics(asset);
  const provisional = new Map<string, Set<string>>();
  const daily = new Map<string, Map<string, number>>();
  const rowsOf = new Map<string, Map<string, { id: number; value: number }>>();
  for (const m of reportFlowMetrics(asset)) {
    if (!periodic.has(m)) {
      const rows = await dayRows(db, asset.id, m);
      rowsOf.set(m, rows);
      daily.set(m, new Map([...rows].map(([d, r]) => [d, r.value])));
      continue;
    }
    const p = await periodicDaily(db, asset.id, m, target);
    provisional.set(m, p.provisional);
    daily.set(m, p.days);
  }
  // The statement-only reads, inside C4's isolation (M3): a throw here gives `incomeStatement: null` and its message,
  // and never fails the report's header, the tick's holder_yield or the snapshot.
  let checks: Awaited<ReturnType<typeof listCheckResults>> = [];
  let provenance: Map<string, Map<string, DayProvenance>> | undefined;
  let statement: Awaited<ReturnType<typeof statementSeries>> | undefined;
  let v2ReadError: string | undefined;
  try {
    // The checks the tick stored for this day.
    checks = await listCheckResults(db, asset.id, target);
    // The provenance of every day the daily series hold, for the statement's provenance from observations.
    provenance = await provenanceByDay(db, asset.id, [...daily.keys()], periodic);
    // Task 8 (after G2): the statement's series on the tokens x prices basis where hourly coverage is full.
    statement = await statementSeries(db, asset.id, [...daily.keys()], periodic, daily, rowsOf);
  } catch (err) {
    v2ReadError = `income statement inputs unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
  return assembleReport(
    {
      asset, day: target, daily, provisional, levels, ...(checks.length > 0 ? { checks } : {}), ...(provenance ? { provenance } : {}),
      ...(statement ? { statementDaily: statement.daily, priceBasis: statement.basis } : {}),
    },
    opts, v2ReadError,
  );
}

/**
 * Per flow metric, the provenance of the row each day's value came from: the rows `dailyOf` reads (confirmed, one day)
 * or, for a periodic stream, `periodicDaily` (confirmed, spread over the days a payment covers), so every day those
 * series hold has an entry here.
 */
async function provenanceByDay(db: Db, assetId: string, metrics: string[], periodic: Set<string>): Promise<Map<string, Map<string, DayProvenance>>> {
  const out = new Map<string, Map<string, DayProvenance>>(metrics.map((m) => [m, new Map()]));
  for (const r of await listActiveProvenance(db, assetId, metrics)) {
    if (r.status !== 'confirmed') continue;
    const n = r.periodDays ?? 1;
    if (periodic.has(r.metricKey) ? n < 1 : n !== 1) continue;
    const end = utcDay(new Date(r.observedAt).getTime() - MS_PER_DAY);
    const p: DayProvenance = { method: r.method, label: provenanceLabel(r.sourceType, r.chain, r.locator) };
    for (let i = 0; i < n; i++) out.get(r.metricKey)!.set(addDays(end, -i), p);
  }
  return out;
}
