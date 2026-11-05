import { scrubLocator } from '../provenance/scrub.js';
import { codeVersion, disclosedProvenance, MAX_TX_REFS, type Json, type Locator, type Provenance, type ProvenanceMethod } from '../provenance/types.js';
import type { SourceType } from '../report/sourceTypes.js';
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
  /** Required (spec §3, plan correction 2): the 0004 columns are nullable, so this type is what makes provenance mandatory. */
  provenance: Provenance;
}

/** The 0004 columns of a stored row; every field null on history the backfill has not mapped yet. */
export interface StoredProvenance {
  id: number;
  metricKey: string;
  observedAt: string;
  periodDays: number | null;
  status: ObservationStatus;
  method: ProvenanceMethod | null;
  sourceType: SourceType | null;
  chain: string | null;
  locator: Locator | null;
  blockFrom: number | null;
  blockTo: number | null;
  txCount: number | null;
  txRefs: string[] | null;
  txDigest: string | null;
  responseDigest: string | null;
  inputs: Json | null;
  formula: string | null;
  coverage: Json | null;
  codeVersion: string | null;
  configHash: string | null;
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

interface ProvenanceRow {
  id: number;
  metric_key: string;
  observed_at: string;
  period_days: number | null;
  status: ObservationStatus;
  method: ProvenanceMethod | null;
  source_type: SourceType | null;
  chain: string | null;
  locator: Locator | null;
  block_from: number | null;
  block_to: number | null;
  tx_count: number | null;
  tx_refs: string[] | null;
  tx_digest: string | null;
  response_digest: string | null;
  inputs: Json | null;
  formula: string | null;
  coverage: Json | null;
  code_version: string | null;
  config_hash: string | null;
}

const PROVENANCE_COLUMNS =
  'id, metric_key, observed_at, period_days, status, method, source_type, chain, locator, block_from, block_to, tx_count, tx_refs, tx_digest, response_digest, inputs, formula, coverage, code_version, config_hash';

const fromProvenanceRow = (r: ProvenanceRow): StoredProvenance => ({
  id: r.id, metricKey: r.metric_key, observedAt: r.observed_at, periodDays: r.period_days, status: r.status, method: r.method,
  sourceType: r.source_type, chain: r.chain, locator: r.locator, blockFrom: r.block_from, blockTo: r.block_to, txCount: r.tx_count,
  txRefs: r.tx_refs, txDigest: r.tx_digest, responseDigest: r.response_digest, inputs: r.inputs, formula: r.formula, coverage: r.coverage,
  codeVersion: r.code_version, configHash: r.config_hash,
});

/** The provenance columns of the given rows (any status), by id. */
export async function getProvenanceByIds(db: Db, ids: number[]): Promise<StoredProvenance[]> {
  if (ids.length === 0) return [];
  return (await db.all<ProvenanceRow>(`SELECT ${PROVENANCE_COLUMNS} FROM observations WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids])).map(fromProvenanceRow);
}

/** The provenance of the asset's active rows of these metrics, oldest first. */
export async function listActiveProvenance(db: Db, assetId: string, metricKeys: string[]): Promise<StoredProvenance[]> {
  if (metricKeys.length === 0) return [];
  const rows = await db.all<ProvenanceRow>(
    `SELECT ${PROVENANCE_COLUMNS} FROM observations WHERE asset_id = $1 AND metric_key = ANY($2::text[]) AND superseded_by IS NULL AND status != 'rejected' ORDER BY observed_at, id`,
    [assetId, metricKeys],
  );
  return rows.map(fromProvenanceRow);
}

const jsonParam = (v: Json | null | undefined): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** Refuses a provenance the columns' CHECKs or the spec's rules would not take; returns it with the locator scrubbed. */
function checkedProvenance(p: Provenance, citationUrl: string | null): Provenance {
  if (!['measured', 'derived', 'disclosed'].includes(p.method)) throw new OrionError('invalid_provenance', `unknown provenance method ${String(p.method)}`);
  if (p.method === 'disclosed' && p.sourceType === 'disclosure' && !citationUrl) {
    throw new OrionError('citation_required', 'a disclosed observation requires a citation url');
  }
  if (p.txRefs && p.txRefs.length > MAX_TX_REFS) throw new OrionError('invalid_provenance', `at most ${MAX_TX_REFS} tx refs per row, got ${p.txRefs.length}`);
  if (!p.codeVersion || !p.configHash) throw new OrionError('invalid_provenance', 'provenance needs a code version and a config hash');
  return { ...p, locator: scrubLocator(p.locator) };
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
  const p = checkedProvenance(input.provenance, input.citationUrl ?? null);

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
           (asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at,
            method, source_type, chain, locator, block_from, block_to, tx_count, tx_refs, tx_digest, response_digest, inputs, formula,
            coverage, code_version, config_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15::jsonb, $16, $17, $18, $19::jsonb, $20, $21, $22::jsonb, $23, $24::jsonb, $25, $26)
         RETURNING id`,
        [
          input.assetId, input.metricKey, observedAt, input.periodDays ?? null, input.value, input.source,
          input.sourceDetail ?? null, status, input.citationUrl ?? null, input.quotedText ?? null, fetchedAt,
          p.method, p.sourceType, p.chain, JSON.stringify(p.locator), p.blockFrom ?? null, p.blockTo ?? null, p.txCount ?? null,
          jsonParam(p.txRefs), p.txDigest ?? null, p.responseDigest ?? null, jsonParam(p.inputs), p.formula ?? null, jsonParam(p.coverage),
          p.codeVersion, p.configHash,
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

/**
 * Confirms a provisional row as a new confirmed one. Its provenance is the provisional row's (a citation the analyst or a
 * person entered), marked approved by `by.approvedBy` at `nowIso`; a provisional row written before 0004 has none, so it is
 * built from its citation under `by.configHash`.
 */
export async function confirmObservation(db: Db, id: number, nowIso: string, by: { approvedBy: string; configHash: string }): Promise<Observation> {
  const assetId = await assetOf(db, id);
  return db.tx(
    async (t) => {
      const o = await activeProvisional(t, id);
      const [stored] = await getProvenanceByIds(t, [id]);
      const provenance: Provenance =
        stored?.method && stored.sourceType && stored.locator
          ? {
              method: stored.method, sourceType: stored.sourceType, chain: stored.chain,
              locator: stored.sourceType === 'disclosure' ? { ...stored.locator, approved_by: by.approvedBy, approved_at: nowIso } : stored.locator,
              blockFrom: stored.blockFrom, blockTo: stored.blockTo, txCount: stored.txCount, txRefs: stored.txRefs, txDigest: stored.txDigest,
              responseDigest: stored.responseDigest, inputs: stored.inputs, formula: stored.formula, coverage: stored.coverage,
              codeVersion: codeVersion(), configHash: stored.configHash ?? by.configHash,
            }
          : disclosedProvenance(by.configHash, { citationUrl: o.citationUrl, approvedBy: by.approvedBy, approvedAt: nowIso });
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
        provenance,
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
