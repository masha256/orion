import type { WatchFiring } from '../types.js';
import type { Db } from './connection.js';

export type FetchOutcome = 'ok' | 'partial' | 'failed';
export type SourceStatus = 'ok' | 'failed' | 'skipped';

/** One cross-check comparison. `label` is 'level', or the month ('2026-08') of a monthly-sum comparison. */
export interface CrossCheckRecord {
  metricKey: string;
  sourceId: string;
  label: string;
  primary: number;
  check: number;
  diffPct: number;
  tolerancePct: number;
  ok: boolean;
}

/** A transfer to the sink from a sender that is not on the allowlist. Excluded from the flow. */
export interface UnlistedTransfer {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  tokens: number;
  day: string;
}

/** An active row from another source whose period overlaps a flow row the scan wants to write. */
export interface FlowConflict {
  metricKey: string;
  observationId: number;
  source: string;
  observedAt: string;
  periodDays: number | null;
  /** True when --adopt may reject it: only rows whose source is 'manual'. */
  adoptable: boolean;
}

export interface SourceOutcome {
  sourceId: string;
  status: SourceStatus;
  error: string | null;
  metricsWritten: string[];
  crossChecks: CrossCheckRecord[];
  unlistedTransfers: UnlistedTransfer[];
  conflicts: FlowConflict[];
  retiredObservationIds: number[];
  notes: string[];
}

export interface FetchRunDetail {
  sources: SourceOutcome[];
  /** Watch firings (src/ingest/watch.ts); present only when the fetch had any. */
  watch?: WatchFiring[];
}

export interface FetchRun {
  id: number;
  assetId: string;
  startedAt: string;
  endedAt: string;
  outcome: FetchOutcome;
  detail: FetchRunDetail;
}

export function emptySourceOutcome(sourceId: string): SourceOutcome {
  return {
    sourceId, status: 'ok', error: null, metricsWritten: [], crossChecks: [], unlistedTransfers: [],
    conflicts: [], retiredObservationIds: [], notes: [],
  };
}

interface Row {
  id: number;
  asset_id: string;
  started_at: string;
  ended_at: string;
  outcome: FetchOutcome;
  detail_json: string;
}

function fromRow(r: Row): FetchRun {
  return {
    id: r.id, assetId: r.asset_id, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
    detail: JSON.parse(r.detail_json) as FetchRunDetail,
  };
}

export async function insertFetchRun(db: Db, run: Omit<FetchRun, 'id'>): Promise<number> {
  const inserted = await db.run<{ id: number }>(
    'INSERT INTO fetch_runs (asset_id, started_at, ended_at, outcome, detail_json) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [run.assetId, run.startedAt, run.endedAt, run.outcome, JSON.stringify(run.detail)],
  );
  return Number(inserted.rows[0].id);
}

export async function listFetchRuns(db: Db, assetId: string, limit: number): Promise<FetchRun[]> {
  const rows = await db.all<Row>('SELECT * FROM fetch_runs WHERE asset_id = $1 ORDER BY id DESC LIMIT $2', [assetId, limit]);
  return rows.map(fromRow);
}

/**
 * The last `limit` attempted outcomes of one source, newest first. Runs that did not include the
 * source (a --metric run, say) and 'skipped' entries are passed over: a source that was not
 * attempted neither extends nor breaks a failure streak.
 */
export async function recentSourceStatuses(db: Db, assetId: string, sourceId: string, limit: number): Promise<SourceStatus[]> {
  // Per run, the first entry for the source (by position in detail_json.sources); a run whose first entry is skipped
  // is passed over, as is a run without the source.
  const rows = await db.all<{ status: SourceStatus }>(
    `SELECT status FROM (
       SELECT DISTINCT ON (f.id) f.id, s.e->>'status' AS status
       FROM fetch_runs f, json_array_elements(f.detail_json->'sources') WITH ORDINALITY AS s(e, ord)
       WHERE f.asset_id = $1 AND s.e->>'sourceId' = $2
       ORDER BY f.id DESC, s.ord) firsts
     WHERE status <> 'skipped' ORDER BY id DESC LIMIT $3`,
    [assetId, sourceId, limit],
  );
  return rows.map((r) => r.status);
}
