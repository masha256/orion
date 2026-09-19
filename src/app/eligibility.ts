import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { listActiveObservations, type Observation } from '../db/observations.js';
import { buildSchedule, latestLevel } from '../drivers/select.js';
import { MS_PER_DAY } from '../types.js';

const ms = (iso: string): number => new Date(iso).getTime();
const byTimeThenId = (a: Observation, b: Observation): number =>
  a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1;

/**
 * Narrows eligible observations to what drivers can use at `asOf`, so a snapshot stays small under
 * daily fetching. Engine output must not change: among the metrics the asset DECLARES, everything
 * dropped here is something computeDrivers would ignore anyway. Observations of a metric the asset
 * does not declare are dropped too. That is the eligibility rule itself, unchanged since
 * sub-project 1 (eligibleObservations has always excluded them before computeDrivers runs), not an
 * optimization: computeDrivers would read scheduled_unlock_tokens without checking the declaration,
 * so never hand it rows that skipped this filter. Pure.
 */
export function narrowToUsable(asset: AssetConfig, observations: Observation[], asOf: string): Observation[] {
  const byMetric = new Map<string, Observation[]>();
  for (const o of observations) byMetric.set(o.metricKey, [...(byMetric.get(o.metricKey) ?? []), o]);

  // Only flow metrics that a holder flow references ever reach a driver. The larger window wins when two share a metric.
  const windowDays = new Map<string, number>();
  for (const f of asset.holder_flows) windowDays.set(f.metric, Math.max(windowDays.get(f.metric) ?? 0, f.window_days));

  const kept: Observation[] = [];
  for (const [key, all] of byMetric) {
    const def = asset.metrics[key];
    if (!def) continue;
    const list = [...all].sort(byTimeThenId);
    if (def.type === 'level') {
      const newest = latestLevel(list, asOf);
      if (newest) kept.push(newest);
    } else if (def.type === 'schedule') {
      kept.push(...buildSchedule(list, asOf).used);
    } else if (def.type === 'event') {
      kept.push(...list.filter((o) => o.observedAt > asOf));
    } else {
      const window = windowDays.get(key);
      if (window === undefined) continue;
      const past = list.filter((o) => o.observedAt <= asOf);
      if (past.length === 0) continue;
      // One day of margin beyond the trailing window: every row the window can touch is inside.
      const rangeStart = Math.max(...past.map((o) => ms(o.observedAt))) - (window + 1) * MS_PER_DAY;
      kept.push(...past.filter((o) => ms(o.observedAt) > rangeStart));
    }
  }
  return kept.sort(byTimeThenId);
}

export function eligibleObservations(db: Db, asset: AssetConfig, asOf: string): Observation[] {
  const active = listActiveObservations(db, asset.id).filter((o) => {
    const def = asset.metrics[o.metricKey];
    return def !== undefined && (o.status === 'confirmed' || def.allow_provisional);
  });
  // A confirmed and a provisional row can both be active at one key. Confirmed data wins, which
  // also keeps flows from counting the same period twice.
  const key = (o: Observation) => `${o.metricKey}@${o.observedAt}`;
  const confirmedKeys = new Set(active.filter((o) => o.status === 'confirmed').map(key));
  const eligible = active.filter((o) => o.status !== 'provisional' || !confirmedKeys.has(key(o)));
  return narrowToUsable(asset, eligible, asOf);
}
