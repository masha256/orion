import type { LoadedAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { fetchAsset, type FetchDeps, type FetchResult } from '../ingest/run.js';
import type { Signal } from '../signals/schema.js';
import { runValuation } from './valuation.js';

/**
 * Fetch, then value, then hand back the signal. The valuation runs even when some sources failed:
 * the last good observation stays in force until it goes stale, and the signal says so.
 * Only a configuration error throws.
 */
export async function updateAsset(
  db: Db,
  loaded: LoadedAsset,
  now: Date,
  deps: FetchDeps,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<{ fetch: FetchResult; runId: number; signal: Signal }> {
  const fetch = await fetchAsset(db, loaded, now, deps, { onProgress: opts.onProgress });
  // Chain levels are stamped with the latest block's time, which is read AFTER `now` was captured for
  // the fetch; by the time the fetch returns, the chain head may be ahead of `now`. Valuing at `now`
  // would then make latestLevel skip what the fetch just wrote (observedAt > asOf). Value no earlier
  // than the newest thing the fetch wrote, and no earlier than the current time either.
  // A schedule metric's later steps are dated in the future on purpose (CRV's coded cut, a year out): only its
  // earliest step written, the one in force, counts, else the valuation would run at the date of the next cut.
  const metrics = loaded.config.metrics;
  const firstScheduleStep = new Map<string, number>();
  for (const w of fetch.written) {
    if (metrics[w.metricKey]?.type !== 'schedule') continue;
    const t = Date.parse(w.observedAt);
    firstScheduleStep.set(w.metricKey, Math.min(firstScheduleStep.get(w.metricKey) ?? Infinity, t));
  }
  const newestWritten = fetch.written.reduce((max, w) => {
    const t = Date.parse(w.observedAt);
    if (metrics[w.metricKey]?.type === 'schedule' && t > firstScheduleStep.get(w.metricKey)!) return max;
    return Math.max(max, t);
  }, 0);
  const asOf = new Date(Math.max(deps.now().getTime(), newestWritten));
  const { runId, signal } = runValuation(db, loaded, asOf);
  return { fetch, runId, signal };
}
