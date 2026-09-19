import { OrionError } from '../types.js';
import type { Db } from './connection.js';

export type AnomalyKind = 'cross_check_mismatch' | 'unlisted_sender' | 'source_failure_streak' | 'revenue_disclosure_stale';
export type AnomalySeverity = 'degrading' | 'advisory';
export type AnomalyStatus = 'open' | 'resolved' | 'acknowledged';

export interface Anomaly {
  id: number;
  assetId: string;
  kind: AnomalyKind;
  /** '' for anomalies that belong to a source rather than a metric (source_failure_streak). */
  metricKey: string;
  dedupeKey: string;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  detail: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  note: string | null;
  decidedAt: string | null;
}

export interface RaiseAnomalyInput {
  assetId: string;
  kind: AnomalyKind;
  metricKey: string;
  dedupeKey: string;
  severity: AnomalySeverity;
  detail: Record<string, unknown>;
  seenAt: string;
}

interface Row {
  id: number;
  asset_id: string;
  kind: AnomalyKind;
  metric_key: string;
  dedupe_key: string;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  detail_json: string;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  note: string | null;
  decided_at: string | null;
}

function fromRow(r: Row): Anomaly {
  return {
    id: r.id, assetId: r.asset_id, kind: r.kind, metricKey: r.metric_key, dedupeKey: r.dedupe_key, severity: r.severity,
    status: r.status, detail: JSON.parse(r.detail_json) as Record<string, unknown>, occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, note: r.note, decidedAt: r.decided_at,
  };
}

export function getAnomaly(db: Db, id: number): Anomaly | null {
  const row = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Opens an anomaly, or counts a repeat when the same one is already open. A decided anomaly that recurs opens a new row. */
export function raiseAnomaly(db: Db, input: RaiseAnomalyInput): Anomaly {
  const seenAt = new Date(input.seenAt).toISOString();
  const detail = JSON.stringify(input.detail);
  const id = db.transaction(() => {
    const open = db
      .prepare("SELECT id FROM anomalies WHERE asset_id = ? AND kind = ? AND metric_key = ? AND dedupe_key = ? AND status = 'open'")
      .get(input.assetId, input.kind, input.metricKey, input.dedupeKey) as { id: number } | undefined;
    if (open) {
      db.prepare('UPDATE anomalies SET occurrences = occurrences + 1, last_seen_at = ?, detail_json = ?, severity = ? WHERE id = ?').run(
        seenAt, detail, input.severity, open.id,
      );
      return open.id;
    }
    const info = db
      .prepare(
        `INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, 1, ?, ?)`,
      )
      .run(input.assetId, input.kind, input.metricKey, input.dedupeKey, input.severity, detail, seenAt, seenAt);
    return Number(info.lastInsertRowid);
  })();
  return getAnomaly(db, id)!;
}

/** Newest first. Open anomalies only, unless `includeDecided`. */
export function listAnomalies(db: Db, filter: { assetId?: string; includeDecided?: boolean } = {}): Anomaly[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.assetId !== undefined) {
    where.push('asset_id = ?');
    params.push(filter.assetId);
  }
  if (!filter.includeDecided) where.push("status = 'open'");
  const sql = `SELECT * FROM anomalies ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
  return (db.prepare(sql).all(...params) as Row[]).map(fromRow);
}

/** Oldest first: the order a signal lists them in. */
export function listOpenAnomalies(db: Db, assetId: string): Anomaly[] {
  const rows = db.prepare("SELECT * FROM anomalies WHERE asset_id = ? AND status = 'open' ORDER BY id").all(assetId) as Row[];
  return rows.map(fromRow);
}

export function decideAnomaly(db: Db, id: number, status: 'resolved' | 'acknowledged', note: string, nowIso: string): Anomaly {
  if (note.trim() === '') throw new OrionError('note_required', 'a note is required: say why this anomaly is resolved or acknowledged');
  const current = getAnomaly(db, id);
  if (!current) throw new OrionError('anomaly_not_found', `no anomaly with id ${id}`);
  if (current.status !== 'open') throw new OrionError('anomaly_not_open', `anomaly ${id} is already ${current.status}`);
  db.prepare('UPDATE anomalies SET status = ?, note = ?, decided_at = ? WHERE id = ?').run(status, note.trim(), new Date(nowIso).toISOString(), id);
  return getAnomaly(db, id)!;
}
