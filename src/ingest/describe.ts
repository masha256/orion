import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { listFetchRuns, type SourceStatus } from '../db/fetchRuns.js';
import { listActiveObservations } from '../db/observations.js';
import { latestLevel } from '../drivers/select.js';
import { MS_PER_DAY } from '../types.js';
import { sourceId } from './sourceId.js';

export interface SourceRow {
  metric: string;
  type: string;
  sourceId: string;
  crossChecks: { sourceId: string; tolerancePct: number }[];
  /** The source's entry in the most recent of the last 20 fetch runs that attempted it. */
  lastFetch: { at: string; status: SourceStatus; error: string | null } | null;
  valueInForce: { value: number; observedAt: string; ageDays: number } | null;
}

/** One row per metric that has a source: what feeds it, what checks it, how the last fetch went, how old its value is. */
export function describeSources(db: Db, asset: AssetConfig, now: Date): SourceRow[] {
  const runs = listFetchRuns(db, asset.id, 20);
  const nowIso = now.toISOString();
  const rows: SourceRow[] = [];
  for (const [metric, def] of Object.entries(asset.metrics)) {
    if (!def.source) continue;
    const id = sourceId(def.source);
    let lastFetch: SourceRow['lastFetch'] = null;
    for (const run of runs) {
      const entry = run.detail.sources.find((s) => s.sourceId === id);
      if (entry) {
        lastFetch = { at: run.startedAt, status: entry.status, error: entry.error };
        break;
      }
    }
    const newest = latestLevel(listActiveObservations(db, asset.id, metric), nowIso);
    rows.push({
      metric,
      type: def.source.type,
      sourceId: id,
      crossChecks: (def.cross_checks ?? []).map((c) => ({ sourceId: sourceId(c.source), tolerancePct: c.tolerance_pct ?? def.tolerance_pct })),
      lastFetch,
      valueInForce: newest
        ? { value: newest.value, observedAt: newest.observedAt, ageDays: (now.getTime() - new Date(newest.observedAt).getTime()) / MS_PER_DAY }
        : null,
    });
  }
  return rows;
}
