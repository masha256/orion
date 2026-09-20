import { OrionError, type ObservationSource, type ObservationStatus } from '../types.js';
import type { Db } from './connection.js';

export interface Observation {
  id: number;
  assetId: string;
  metricKey: string;
  observedAt: string;
  periodDays: number | null;
  value: number;
  source: ObservationSource;
  sourceDetail: string | null;
  status: ObservationStatus;
  citationUrl: string | null;
  quotedText: string | null;
  fetchedAt: string;
  supersededBy: number | null;
}

export interface NewObservation {
  assetId: string;
  metricKey: string;
  observedAt: string;
  periodDays?: number | null;
  value: number;
  source: ObservationSource;
  sourceDetail?: string | null;
  status?: 'confirmed' | 'provisional';
  citationUrl?: string | null;
  quotedText?: string | null;
  fetchedAt: string;
}

interface Row {
  id: number;
  asset_id: string;
  metric_key: string;
  observed_at: string;
  period_days: number | null;
  value: number;
  source: ObservationSource;
  source_detail: string | null;
  status: ObservationStatus;
  citation_url: string | null;
  quoted_text: string | null;
  fetched_at: string;
  superseded_by: number | null;
}

function fromRow(r: Row): Observation {
  return {
    id: r.id,
    assetId: r.asset_id,
    metricKey: r.metric_key,
    observedAt: r.observed_at,
    periodDays: r.period_days,
    value: r.value,
    source: r.source,
    sourceDetail: r.source_detail,
    status: r.status,
    citationUrl: r.citation_url,
    quotedText: r.quoted_text,
    fetchedAt: r.fetched_at,
    supersededBy: r.superseded_by,
  };
}

function toIso(text: string): string {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new OrionError('invalid_timestamp', `invalid timestamp: ${text}`);
  return d.toISOString();
}

const ACTIVE = "superseded_by IS NULL AND status != 'rejected'";

export function getObservationsByIds(db: Db, ids: number[]): Observation[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${marks}) ORDER BY id`).all(...ids) as Row[];
  return rows.map(fromRow);
}

export function listActiveObservations(db: Db, assetId: string, metricKey?: string): Observation[] {
  const rows = (
    metricKey === undefined
      ? db.prepare(`SELECT * FROM observations WHERE asset_id = ? AND ${ACTIVE} ORDER BY observed_at, id`).all(assetId)
      : db
          .prepare(`SELECT * FROM observations WHERE asset_id = ? AND metric_key = ? AND ${ACTIVE} ORDER BY observed_at, id`)
          .all(assetId, metricKey)
  ) as Row[];
  return rows.map(fromRow);
}

/** Newest first. Active rows only, unless `includeInactive` (which adds superseded and rejected rows). */
export function listObservations(
  db: Db,
  assetId: string,
  metricKey: string,
  opts: { includeInactive?: boolean; limit?: number } = {},
): Observation[] {
  const where = opts.includeInactive ? '' : ` AND ${ACTIVE}`;
  const rows = db
    .prepare(`SELECT * FROM observations WHERE asset_id = ? AND metric_key = ?${where} ORDER BY observed_at DESC, id DESC LIMIT ?`)
    .all(assetId, metricKey, opts.limit ?? 10) as Row[];
  return rows.map(fromRow);
}

export function insertObservation(db: Db, input: NewObservation): Observation {
  if (!Number.isFinite(input.value)) throw new OrionError('invalid_value', 'observation value must be a finite number');
  if (input.periodDays !== undefined && input.periodDays !== null && !(Number.isFinite(input.periodDays) && input.periodDays > 0)) {
    throw new OrionError('invalid_period', `period days must be a finite number greater than 0, got ${input.periodDays}`);
  }
  const status = input.status ?? 'confirmed';
  if (status === 'provisional' && !input.citationUrl) {
    throw new OrionError('citation_required', 'a provisional observation requires a citation url');
  }
  const observedAt = toIso(input.observedAt);
  const fetchedAt = toIso(input.fetchedAt);

  const id = db.transaction(() => {
    // A confirmed row supersedes every active prior at this key; a provisional row supersedes only
    // other provisional rows, so provisional data can never knock out confirmed data.
    const onlyProvisional = status === 'provisional' ? " AND status = 'provisional'" : '';
    const prior = db
      .prepare(`SELECT id FROM observations WHERE asset_id = ? AND metric_key = ? AND observed_at = ? AND ${ACTIVE}${onlyProvisional}`)
      .all(input.assetId, input.metricKey, observedAt) as { id: number }[];
    const info = db
      .prepare(
        `INSERT INTO observations
           (asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.assetId, input.metricKey, observedAt, input.periodDays ?? null, input.value, input.source,
        input.sourceDetail ?? null, status, input.citationUrl ?? null, input.quotedText ?? null, fetchedAt,
      );
    const newId = Number(info.lastInsertRowid);
    for (const p of prior) db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(newId, p.id);
    return newId;
  })();

  return getObservationsByIds(db, [id])[0];
}

function activeObservation(db: Db, id: number): Observation {
  const o = getObservationsByIds(db, [id])[0];
  if (!o) throw new OrionError('observation_not_found', `no observation with id ${id}`);
  if (o.supersededBy !== null || o.status === 'rejected') {
    throw new OrionError('not_active', `observation ${id} is not active; it was already superseded or rejected`);
  }
  return o;
}

function activeProvisional(db: Db, id: number): Observation {
  const o = activeObservation(db, id);
  if (o.status !== 'provisional') {
    throw new OrionError('not_provisional', `observation ${id} is not an active provisional observation`);
  }
  return o;
}

export function confirmObservation(db: Db, id: number, nowIso: string): Observation {
  const o = activeProvisional(db, id);
  return insertObservation(db, {
    assetId: o.assetId,
    metricKey: o.metricKey,
    observedAt: o.observedAt,
    periodDays: o.periodDays,
    value: o.value,
    source: 'manual',
    sourceDetail: o.sourceDetail,
    status: 'confirmed',
    citationUrl: o.citationUrl,
    quotedText: o.quotedText,
    fetchedAt: nowIso,
  });
}

/** Retires any active observation, confirmed or provisional. The row itself is never deleted. */
export function rejectObservation(db: Db, id: number): void {
  activeObservation(db, id);
  db.prepare("UPDATE observations SET status = 'rejected' WHERE id = ?").run(id);
}
