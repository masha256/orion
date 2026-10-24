import type { AssetConfig } from '../config/schema.js';
import type { Observation } from '../db/observations.js';
import { MS_PER_DAY, type WatchFiring } from '../types.js';
import { utcDay } from './time.js';
import type { WrittenObservation } from './types.js';

// Defined in src/types.ts (the db layer stores a firing); re-exported for the ingest and app layers.
export { WATCH_RULES, type WatchFiring, type WatchRule } from '../types.js';

/** Per watched metric: its active observations' values by observedAt (normalized ISO), taken before the fetch writes. */
export type WatchSnapshot = Map<string, Map<string, number>>;

const iso = (at: string): string => new Date(at).toISOString();

export function watchSnapshot(asset: AssetConfig, observations: (metricKey: string) => Observation[]): WatchSnapshot {
  const out: WatchSnapshot = new Map();
  for (const [key, def] of Object.entries(asset.metrics)) {
    if (def.watch === undefined) continue;
    out.set(key, new Map(observations(key).map((o) => [iso(o.observedAt), o.value])));
  }
  return out;
}

/** The newest value in the snapshot strictly before `observedAt`, or null. */
export function previousLevelIn(before: WatchSnapshot): (metricKey: string, observedAt: string) => number | null {
  return (metricKey, observedAt) => {
    const at = Date.parse(observedAt);
    let best: { at: number; value: number } | null = null;
    for (const [k, value] of before.get(metricKey) ?? []) {
      const t = Date.parse(k);
      if (t < at && (best === null || t > best.at)) best = { at: t, value };
    }
    return best?.value ?? null;
  };
}

/**
 * The watch rules against what this fetch wrote (or, on a dry run, would write).
 * - `above` (flows): a day over the threshold, unless the row it replaces was already over it, so a day re-read in the
 *   revision window is reported once. `previous` is the replaced row's value.
 * - `change_pct` (levels): more than that many percent away from the previous reading (`previousLevel`).
 * - `outside` (levels): below lo or above hi, on every fetch while it stays there.
 */
export function evaluateWatches(
  asset: AssetConfig,
  before: WatchSnapshot,
  written: WrittenObservation[],
  previousLevel: (metricKey: string, observedAt: string) => number | null,
): WatchFiring[] {
  const firings: WatchFiring[] = [];
  for (const w of written) {
    const watch = asset.metrics[w.metricKey]?.watch;
    if (watch === undefined) continue;
    const metric = w.metricKey;
    const value = w.value;
    if (watch.above !== undefined) {
      const previous = before.get(metric)?.get(iso(w.observedAt)) ?? null;
      if (value > watch.above && !(previous !== null && previous > watch.above)) {
        firings.push({ metric, rule: 'above', value, previous, day: utcDay(Date.parse(w.observedAt) - MS_PER_DAY) });
      }
      continue;
    }
    const previous = previousLevel(metric, w.observedAt);
    const day = utcDay(Date.parse(w.observedAt));
    if (watch.change_pct !== undefined) {
      if (previous === null) continue;
      const movePct = previous === 0 ? (value === 0 ? 0 : Infinity) : (Math.abs(value - previous) / Math.abs(previous)) * 100;
      if (movePct > watch.change_pct) firings.push({ metric, rule: 'change_pct', value, previous, day });
      continue;
    }
    if (watch.outside !== undefined) {
      const [lo, hi] = watch.outside;
      if (value < lo || value > hi) firings.push({ metric, rule: 'outside', value, previous, day });
    }
  }
  return firings;
}
