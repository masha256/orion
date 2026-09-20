import type { Signal } from '../signals/schema.js';
import { canonicalJson } from '../util/canonical.js';
import type { Db } from './connection.js';

export interface ValuationRunRow {
  id: number;
  assetId: string;
  snapshotId: number;
  assumptionSetId: number | null;
  engineVersion: string;
  configHash: string;
  status: string;
  outputJson: string | null;
  createdAt: string;
  /** The agent run that triggered this valuation. Not an engine input: replay ignores it. */
  agentRunId?: number | null;
}

export function saveConfigVersion(db: Db, hash: string, assetId: string, config: unknown, nowIso: string): void {
  db.prepare('INSERT OR IGNORE INTO config_versions (hash, asset_id, content_json, created_at) VALUES (?, ?, ?, ?)').run(
    hash, assetId, canonicalJson(config), nowIso,
  );
}

export function getConfigVersion(db: Db, hash: string): string | null {
  const row = db.prepare('SELECT content_json FROM config_versions WHERE hash = ?').get(hash) as { content_json: string } | undefined;
  return row?.content_json ?? null;
}

export function createSnapshot(db: Db, assetId: string, asOf: string, observationIds: number[], nowIso: string): number {
  const ids = [...observationIds].sort((a, b) => a - b);
  const info = db
    .prepare('INSERT INTO snapshots (asset_id, as_of, observation_ids, created_at) VALUES (?, ?, ?, ?)')
    .run(assetId, asOf, JSON.stringify(ids), nowIso);
  return Number(info.lastInsertRowid);
}

export function getSnapshot(db: Db, id: number): { id: number; assetId: string; asOf: string; observationIds: number[] } | null {
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as
    | { id: number; asset_id: string; as_of: string; observation_ids: string }
    | undefined;
  return row ? { id: row.id, assetId: row.asset_id, asOf: row.as_of, observationIds: JSON.parse(row.observation_ids) as number[] } : null;
}

export function insertValuationRun(db: Db, row: Omit<ValuationRunRow, 'id'>): number {
  const info = db
    .prepare(
      `INSERT INTO valuation_runs (asset_id, snapshot_id, assumption_set_id, engine_version, config_hash, status, output_json, created_at, agent_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.assetId, row.snapshotId, row.assumptionSetId, row.engineVersion, row.configHash, row.status, row.outputJson, row.createdAt,
      row.agentRunId ?? null,
    );
  return Number(info.lastInsertRowid);
}

export function updateRunStatus(db: Db, runId: number, status: string): void {
  db.prepare('UPDATE valuation_runs SET status = ? WHERE id = ?').run(status, runId);
}

export function getValuationRun(db: Db, id: number): ValuationRunRow | null {
  const r = db.prepare('SELECT * FROM valuation_runs WHERE id = ?').get(id) as
    | {
        id: number; asset_id: string; snapshot_id: number; assumption_set_id: number | null; engine_version: string;
        config_hash: string; status: string; output_json: string | null; created_at: string; agent_run_id: number | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id, assetId: r.asset_id, snapshotId: r.snapshot_id, assumptionSetId: r.assumption_set_id,
    engineVersion: r.engine_version, configHash: r.config_hash, status: r.status, outputJson: r.output_json, createdAt: r.created_at,
    agentRunId: r.agent_run_id,
  };
}

export function insertSignal(db: Db, runId: number, signal: Signal): void {
  db.prepare(
    'INSERT INTO signals (signal_id, run_id, asset_id, schema_version, status, payload_json, emitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(signal.signal_id, runId, signal.asset, signal.schema_version, signal.status, JSON.stringify(signal), signal.generated_at);
}

export function listSignals(db: Db, assetId: string, limit: number): Signal[] {
  // Newest by generated_at (stored in emitted_at), then by id: a backfilled --as-of run never becomes "latest".
  const rows = db.prepare('SELECT payload_json FROM signals WHERE asset_id = ? ORDER BY emitted_at DESC, id DESC LIMIT ?').all(assetId, limit) as {
    payload_json: string;
  }[];
  return rows.map((r) => JSON.parse(r.payload_json) as Signal);
}

export function getLatestSignal(db: Db, assetId: string): Signal | null {
  return listSignals(db, assetId, 1)[0] ?? null;
}
