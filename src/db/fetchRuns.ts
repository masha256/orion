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

export function insertFetchRun(db: Db, run: Omit<FetchRun, 'id'>): number {
  const info = db
    .prepare('INSERT INTO fetch_runs (asset_id, started_at, ended_at, outcome, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(run.assetId, run.startedAt, run.endedAt, run.outcome, JSON.stringify(run.detail));
  return Number(info.lastInsertRowid);
}

export function listFetchRuns(db: Db, assetId: string, limit: number): FetchRun[] {
  const rows = db.prepare('SELECT * FROM fetch_runs WHERE asset_id = ? ORDER BY id DESC LIMIT ?').all(assetId, limit) as Row[];
  return rows.map(fromRow);
}

/**
 * The last `limit` attempted outcomes of one source, newest first. Runs that did not include the
 * source (a --metric run, say) and 'skipped' entries are passed over: a source that was not
 * attempted neither extends nor breaks a failure streak.
 */
export function recentSourceStatuses(db: Db, assetId: string, sourceId: string, limit: number): SourceStatus[] {
  const out: SourceStatus[] = [];
  const rows = db.prepare('SELECT * FROM fetch_runs WHERE asset_id = ? ORDER BY id DESC').iterate(assetId) as IterableIterator<Row>;
  for (const row of rows) {
    const entry = fromRow(row).detail.sources.find((s) => s.sourceId === sourceId);
    if (!entry || entry.status === 'skipped') continue;
    out.push(entry.status);
    if (out.length >= limit) break;
  }
  return out;
}
