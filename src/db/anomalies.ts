import { OrionError } from '../types.js';
import type { Db } from './connection.js';

export type AnomalyKind = 'cross_check_mismatch' | 'unlisted_sender' | 'source_failure_streak' | 'revenue_disclosure_stale' | 'revenue_payment';
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
  /** The persona that decided it, or null when the user did (and for every open anomaly). */
  decidedBy: string | null;
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
  decided_by: string | null;
}

function fromRow(r: Row): Anomaly {
  return {
    id: r.id, assetId: r.asset_id, kind: r.kind, metricKey: r.metric_key, dedupeKey: r.dedupe_key, severity: r.severity,
    status: r.status, detail: JSON.parse(r.detail_json) as Record<string, unknown>, occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, note: r.note, decidedAt: r.decided_at, decidedBy: r.decided_by,
  };
}

export async function getAnomaly(db: Db, id: number): Promise<Anomaly | null> {
  const row = await db.one<Row>('SELECT * FROM anomalies WHERE id = $1', [id]);
  return row ? fromRow(row) : null;
}

/**
 * The row a repeat of this condition would count against: the LATEST row with the same
 * (asset, kind, metric, dedupe key), when it is open or acknowledged. Null when there is none or
 * when the latest one was resolved: a resolved anomaly that recurs is news and opens a new row.
 */
export async function findStandingAnomaly(
  db: Db,
  key: { assetId: string; kind: AnomalyKind; metricKey: string; dedupeKey: string },
): Promise<Anomaly | null> {
  const row = await db.one<Row>(
    'SELECT * FROM anomalies WHERE asset_id = $1 AND kind = $2 AND metric_key = $3 AND dedupe_key = $4 ORDER BY id DESC LIMIT 1',
    [key.assetId, key.kind, key.metricKey, key.dedupeKey],
  );
  return row && row.status !== 'resolved' ? fromRow(row) : null;
}

/**
 * Opens an anomaly, or counts a repeat against the standing one. An acknowledgement stands: a
 * condition the user accepted keeps its acknowledged row (occurrences, last seen, detail, and
 * severity are updated) instead of reopening on every fetch. Only `resolved` plus recurrence opens
 * a new row.
 */
export async function raiseAnomaly(db: Db, input: RaiseAnomalyInput): Promise<Anomaly> {
  const seenAt = new Date(input.seenAt).toISOString();
  const detail = JSON.stringify(input.detail);
  return db.tx(
    async (t) => {
      const standing = await findStandingAnomaly(t, input);
      let id: number;
      if (standing) {
        await t.run('UPDATE anomalies SET occurrences = occurrences + 1, last_seen_at = $1, detail_json = $2, severity = $3 WHERE id = $4', [
          seenAt, detail, input.severity, standing.id,
        ]);
        id = standing.id;
      } else {
        const inserted = await t.run<{ id: number }>(
          `INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, 'open', $6, 1, $7, $8)
           RETURNING id`,
          [input.assetId, input.kind, input.metricKey, input.dedupeKey, input.severity, detail, seenAt, seenAt],
        );
        id = Number(inserted.rows[0].id);
      }
      return (await getAnomaly(t, id))!;
    },
    { lockAsset: input.assetId },
  );
}

/** Newest first. Open anomalies only, unless `includeDecided`. */
export async function listAnomalies(db: Db, filter: { assetId?: string; includeDecided?: boolean } = {}): Promise<Anomaly[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.assetId !== undefined) {
    params.push(filter.assetId);
    where.push(`asset_id = $${params.length}`);
  }
  if (!filter.includeDecided) where.push("status = 'open'");
  const sql = `SELECT * FROM anomalies ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
  return (await db.all<Row>(sql, params)).map(fromRow);
}

/** Oldest first. */
export async function listOpenAnomalies(db: Db, assetId: string): Promise<Anomaly[]> {
  const rows = await db.all<Row>("SELECT * FROM anomalies WHERE asset_id = $1 AND status = 'open' ORDER BY id", [assetId]);
  return rows.map(fromRow);
}

export async function decideAnomaly(
  db: Db,
  id: number,
  status: 'resolved' | 'acknowledged',
  note: string,
  nowIso: string,
  /** A persona name when the agent decides; omitted when the user does. */
  decidedBy: string | null = null,
): Promise<Anomaly> {
  if (note.trim() === '') throw new OrionError('note_required', 'a note is required: say why this anomaly is resolved or acknowledged');
  const found = await getAnomaly(db, id);
  if (!found) throw new OrionError('anomaly_not_found', `no anomaly with id ${id}`);
  return db.tx(
    async (t) => {
      const current = (await getAnomaly(t, id))!; // rows are never deleted
      // An open anomaly can be resolved or acknowledged. An acknowledged one can still be resolved:
      // that withdraws the standing acknowledgement, so the next occurrence opens a new anomaly.
      const allowed = current.status === 'open' || (current.status === 'acknowledged' && status === 'resolved');
      if (!allowed) throw new OrionError('anomaly_not_open', `anomaly ${id} is already ${current.status}`);
      await t.run('UPDATE anomalies SET status = $1, note = $2, decided_at = $3, decided_by = $4 WHERE id = $5', [
        status, note.trim(), new Date(nowIso).toISOString(), decidedBy, id,
      ]);
      return (await getAnomaly(t, id))!;
    },
    { lockAsset: found.assetId },
  );
}
