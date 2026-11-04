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

export async function getObservationsByIds(db: Db, ids: number[]): Promise<Observation[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<Row>('SELECT * FROM observations WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]);
  return rows.map(fromRow);
}

export async function listActiveObservations(db: Db, assetId: string, metricKey?: string): Promise<Observation[]> {
  const rows =
    metricKey === undefined
      ? await db.all<Row>(`SELECT * FROM observations WHERE asset_id = $1 AND ${ACTIVE} ORDER BY observed_at, id`, [assetId])
      : await db.all<Row>(`SELECT * FROM observations WHERE asset_id = $1 AND metric_key = $2 AND ${ACTIVE} ORDER BY observed_at, id`, [assetId, metricKey]);
  return rows.map(fromRow);
}

/** Newest first. Active rows only, unless `includeInactive` (which adds superseded and rejected rows). */
export async function listObservations(
  db: Db,
  assetId: string,
  metricKey: string,
  opts: { includeInactive?: boolean; limit?: number } = {},
): Promise<Observation[]> {
  const where = opts.includeInactive ? '' : ` AND ${ACTIVE}`;
  const rows = await db.all<Row>(
    `SELECT * FROM observations WHERE asset_id = $1 AND metric_key = $2${where} ORDER BY observed_at DESC, id DESC LIMIT $3`,
    [assetId, metricKey, opts.limit ?? 10],
  );
  return rows.map(fromRow);
}

export async function insertObservation(db: Db, input: NewObservation): Promise<Observation> {
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

  return db.tx(
    async (t) => {
      // A confirmed row supersedes every active prior at this key; a provisional row supersedes only
      // other provisional rows, so provisional data can never knock out confirmed data.
      const onlyProvisional = status === 'provisional' ? " AND status = 'provisional'" : '';
      const prior = await t.all<{ id: number }>(
        `SELECT id FROM observations WHERE asset_id = $1 AND metric_key = $2 AND observed_at = $3 AND ${ACTIVE}${onlyProvisional} ORDER BY id`,
        [input.assetId, input.metricKey, observedAt],
      );
      const inserted = await t.run<{ id: number }>(
        `INSERT INTO observations
           (asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          input.assetId, input.metricKey, observedAt, input.periodDays ?? null, input.value, input.source,
          input.sourceDetail ?? null, status, input.citationUrl ?? null, input.quotedText ?? null, fetchedAt,
        ],
      );
      const newId = Number(inserted.rows[0].id);
      for (const p of prior) await t.run('UPDATE observations SET superseded_by = $1 WHERE id = $2', [newId, p.id]);
      return (await getObservationsByIds(t, [newId]))[0];
    },
    { lockAsset: input.assetId },
  );
}

async function activeObservation(db: Db, id: number): Promise<Observation> {
  const o = (await getObservationsByIds(db, [id]))[0];
  if (!o) throw new OrionError('observation_not_found', `no observation with id ${id}`);
  if (o.supersededBy !== null || o.status === 'rejected') {
    throw new OrionError('not_active', `observation ${id} is not active; it was already superseded or rejected`);
  }
  return o;
}

async function activeProvisional(db: Db, id: number): Promise<Observation> {
  const o = await activeObservation(db, id);
  if (o.status !== 'provisional') {
    throw new OrionError('not_provisional', `observation ${id} is not an active provisional observation`);
  }
  return o;
}

/** The observation's asset, for the lock a read-then-write takes; throws when there is no such row. */
async function assetOf(db: Db, id: number): Promise<string> {
  const row = await db.one<{ asset_id: string }>('SELECT asset_id FROM observations WHERE id = $1', [id]);
  if (!row) throw new OrionError('observation_not_found', `no observation with id ${id}`);
  return row.asset_id;
}

export async function confirmObservation(db: Db, id: number, nowIso: string): Promise<Observation> {
  const assetId = await assetOf(db, id);
  return db.tx(
    async (t) => {
      const o = await activeProvisional(t, id);
      return insertObservation(t, {
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
    },
    { lockAsset: assetId },
  );
}

/** Retires any active observation, confirmed or provisional. The row itself is never deleted. */
export async function rejectObservation(db: Db, id: number): Promise<void> {
  const assetId = await assetOf(db, id);
  await db.tx(
    async (t) => {
      await activeObservation(t, id);
      await t.run("UPDATE observations SET status = 'rejected' WHERE id = $1", [id]);
    },
    { lockAsset: assetId },
  );
}
