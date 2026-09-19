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
  const { runId, signal } = runValuation(db, loaded, now);
  return { fetch, runId, signal };
}
