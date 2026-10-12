import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { listActiveObservations } from '../db/observations.js';
import { latestLevel } from '../drivers/select.js';
import { addDays, utcDay } from '../ingest/time.js';
import { MS_PER_DAY, STD_METRICS } from '../types.js';
import { holderYieldReport, type HolderYieldReport, type ReportLevels } from './holderYield.js';

/** Every flow metric the report reads: the holder flows, plus revenue and volume. */
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
  return [...new Set([...asset.holder_flows.map((f) => f.metric), ...income, ...streams, ...(r?.volume ?? []), ...(r?.burned_tokens ?? [])])];
}

/** The metrics of periodic revenue streams: paid weeks after the days they cover, so they never hold back the report day. */
function periodicMetrics(asset: AssetConfig): Set<string> {
  return new Set((asset.reporting?.revenue ?? []).filter((s) => s.settlement === 'periodic').map((s) => s.metric!));
}

/**
 * A periodic stream's payments spread evenly over the days each covers, then the unpaid days after the last covered one,
 * through `through`, at the last period's daily rate: provisional, and replaced when the payment lands (the payment row
 * is the only thing stored). Before the first payment there is no rate, so the unpaid days stay missing.
 */
export function periodicDaily(db: Db, assetId: string, metricKey: string, through: string): { days: Map<string, number>; provisional: Set<string> } {
  const days = new Map<string, number>();
  const provisional = new Set<string>();
  const rows = listActiveObservations(db, assetId, metricKey)
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
function dailyOf(db: Db, assetId: string, metricKey: string): Map<string, number> {
  const days = new Map<string, number>();
  for (const o of listActiveObservations(db, assetId, metricKey)) {
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
export function lastCompleteReportDay(db: Db, asset: AssetConfig): string | null {
  let last: string | null = null;
  const periodic = periodicMetrics(asset);
  for (const metric of reportFlowMetrics(asset)) {
    if (periodic.has(metric)) continue;
    const days = [...dailyOf(db, asset.id, metric).keys()].sort();
    const d = days.at(-1);
    if (d === undefined) return null;
    if (last === null || d < last) last = d;
  }
  return last;
}

export function loadHolderYieldReport(db: Db, asset: AssetConfig, day?: string): HolderYieldReport {
  const r = asset.reporting;
  if (!r) throw new Error(`assets/${asset.id}.yaml has no reporting block`);
  const target = day ?? lastCompleteReportDay(db, asset);
  if (target === null) throw new Error(`${asset.id}: no stored day for every report flow yet`);
  const asOf = new Date(Date.parse(`${addDays(target, 1)}T00:00:00.000Z`) + MS_PER_DAY - 1).toISOString(); // to the end of the next day: the levels read with that day's run
  const level = (key: string): number | null => {
    const rows = listActiveObservations(db, asset.id, key).filter((o) => o.status === 'confirmed');
    return latestLevel(rows, asOf)?.value ?? null;
  };
  const extra: Record<string, number | null> = {};
  for (const x of r.extra_cash ?? []) extra[x.metric] = level(x.metric);
  const disclosed = r.revenue_disclosed
    ? listActiveObservations(db, asset.id, r.revenue_disclosed)
        .filter((o) => o.status === 'confirmed' && o.observedAt <= asOf)
        .sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1))
        .map((o) => ({ observedAt: o.observedAt, value: o.value }))
    : [];
  const levels: ReportLevels = {
    price: level(STD_METRICS.price),
    totalSupply: level(STD_METRICS.totalSupply),
    circulatingSupply: asset.metrics[STD_METRICS.circulatingSupply] ? level(STD_METRICS.circulatingSupply) : null,
    stakedSupply: level(STD_METRICS.stakedSupply),
    lockedSupply: asset.metrics[STD_METRICS.lockedSupply] ? level(STD_METRICS.lockedSupply) : null,
    emissionRateAnnual: level(STD_METRICS.emissionRate),
    extra,
    ...(r.dilution ? { dilution: Object.fromEntries(r.dilution.map((d) => [d.id, { rate: level(d.metric), cap: d.cap_metric ? level(d.cap_metric) : null }])) } : {}),
    disclosed,
  };
  const periodic = periodicMetrics(asset);
  const provisional = new Map<string, Set<string>>();
  const daily = new Map(
    reportFlowMetrics(asset).map((m) => {
      if (!periodic.has(m)) return [m, dailyOf(db, asset.id, m)] as const;
      const p = periodicDaily(db, asset.id, m, target);
      provisional.set(m, p.provisional);
      return [m, p.days] as const;
    }),
  );
  return holderYieldReport({ asset, day: target, daily, provisional, levels });
}
