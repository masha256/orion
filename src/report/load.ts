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
  return [...new Set([...asset.holder_flows.map((f) => f.metric), ...(r?.revenue ?? []), ...(r?.volume ?? [])])];
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

/** The newest day that every holder flow has: the default day a report covers. */
export function lastCompleteReportDay(db: Db, asset: AssetConfig): string | null {
  let last: string | null = null;
  for (const f of asset.holder_flows) {
    const days = [...dailyOf(db, asset.id, f.metric).keys()].sort();
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
  if (target === null) throw new Error(`${asset.id}: no stored day for every holder flow yet`);
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
    effectiveSupply: level(STD_METRICS.effectiveSupply),
    stakedSupply: level(STD_METRICS.stakedSupply),
    lockedSupply: asset.metrics[STD_METRICS.lockedSupply] ? level(STD_METRICS.lockedSupply) : null,
    emissionRateAnnual: level(STD_METRICS.emissionRate),
    extra,
    disclosed,
  };
  const daily = new Map(reportFlowMetrics(asset).map((m) => [m, dailyOf(db, asset.id, m)] as const));
  return holderYieldReport({ asset, day: target, daily, levels });
}
