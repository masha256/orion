import { scrubLocator } from '../provenance/scrub.js';
import { originOfRow } from '../provenance/origin.js';
import { codeVersion, disclosedProvenance, MAX_TX_REFS, type Json, type Locator, type Provenance, type ProvenanceMethod } from '../provenance/types.js';
import type { SourceType } from '../report/sourceTypes.js';
import { OrionError, type ObservationSource, type ObservationStatus } from '../types.js';
import type { Db } from './connection.js';
import { checkedTokens, type ObservationTokens } from './prices.js';

export interface Observation {
  id: number;
  assetId: string;
  metricKey: string;
  observedAt: string;
  periodDays: number | null;
  value: number;
  /** Derived from the row's provenance (`originOf`): the `source` column 0006 dropped held exactly this. */
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
  sourceDetail?: string | null;
  status?: 'confirmed' | 'provisional';
  citationUrl?: string | null;
  quotedText?: string | null;
  fetchedAt: string;
  /** Required (spec §3): the columns are NOT NULL since 0006, and the row's origin (`source`) is derived from it. */
  provenance: Provenance;
  /**
   * The row's amount in token units (0005, spec §4), written next to `value`, which keeps its meaning (USD for a
   * `flow_usd.*` row) until gate G3 (plan correction 2). Absent: the columns stay null. The token row must exist.
   */
  tokens?: ObservationTokens;
}

/** The provenance columns of a stored row (NOT NULL since 0006 where every writer sets them). */
export interface StoredProvenance {
  id: number;
  metricKey: string;
  observedAt: string;
  periodDays: number | null;
  status: ObservationStatus;
  method: ProvenanceMethod;
  sourceType: SourceType;
  chain: string | null;
  locator: Locator;
  blockFrom: number | null;
  blockTo: number | null;
  txCount: number | null;
  txRefs: string[] | null;
  txDigest: string | null;
  responseDigest: string | null;
  inputs: Json | null;
  formula: string | null;
  coverage: Json | null;
  codeVersion: string;
  configHash: string;
}

interface Row {
  id: number;
  asset_id: string;
  metric_key: string;
  observed_at: string;
  period_days: number | null;
  value: number;
  source_detail: string | null;
  status: ObservationStatus;
  citation_url: string | null;
  quoted_text: string | null;
  fetched_at: string;
  superseded_by: number | null;
  method: ProvenanceMethod;
  source_type: SourceType;
  locator: Locator;
  formula: string | null;
}

interface ProvenanceRow {
  id: number;
  metric_key: string;
  observed_at: string;
  period_days: number | null;
  status: ObservationStatus;
  method: ProvenanceMethod;
  source_type: SourceType;
  chain: string | null;
  locator: Locator;
  block_from: number | null;
  block_to: number | null;
  tx_count: number | null;
  tx_refs: string[] | null;
  tx_digest: string | null;
  response_digest: string | null;
  inputs: Json | null;
  formula: string | null;
  coverage: Json | null;
  code_version: string;
  config_hash: string;
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
    source: originOfRow(r),
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
  const tk = input.tokens ? checkedTokens(input.tokens) : null;

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
           (asset_id, metric_key, observed_at, period_days, value, source_detail, status, citation_url, quoted_text, fetched_at,
            method, source_type, chain, locator, block_from, block_to, tx_count, tx_refs, tx_digest, response_digest, inputs, formula,
            coverage, code_version, config_hash, token_ref, amount, hourly_amounts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14::jsonb, $15, $16, $17, $18::jsonb, $19, $20, $21::jsonb, $22, $23::jsonb, $24, $25,
                 $26, $27, $28::jsonb)
         RETURNING id`,
        [
          input.assetId, input.metricKey, observedAt, input.periodDays ?? null, input.value,
          input.sourceDetail ?? null, status, input.citationUrl ?? null, input.quotedText ?? null, fetchedAt,
          p.method, p.sourceType, p.chain, JSON.stringify(p.locator), p.blockFrom ?? null, p.blockTo ?? null, p.txCount ?? null,
          jsonParam(p.txRefs), p.txDigest ?? null, p.responseDigest ?? null, jsonParam(p.inputs), p.formula ?? null, jsonParam(p.coverage),
          p.codeVersion, p.configHash,
          tk?.tokenRef ?? null, tk?.amount ?? null, tk?.hourlyAmounts ? JSON.stringify(tk.hourlyAmounts) : null,
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
 * person entered), marked approved by `by.approvedBy` at `nowIso`. Every row carries one since 0006; `by.configHash` is
 * the fallback the confirm callers still pass (a row with none is built from its citation under it).
 */
export async function confirmObservation(db: Db, id: number, nowIso: string, by: { approvedBy: string; configHash: string }): Promise<Observation> {
  const assetId = await assetOf(db, id);
  return db.tx(
    async (t) => {
      const o = await activeProvisional(t, id);
      const [stored] = await getProvenanceByIds(t, [id]);
      const provenance: Provenance =
        stored !== undefined
          ? {
              method: stored.method, sourceType: stored.sourceType, chain: stored.chain,
              locator: stored.sourceType === 'disclosure' ? { ...stored.locator, approved_by: by.approvedBy, approved_at: nowIso } : stored.locator,
              blockFrom: stored.blockFrom, blockTo: stored.blockTo, txCount: stored.txCount, txRefs: stored.txRefs, txDigest: stored.txDigest,
              responseDigest: stored.responseDigest, inputs: stored.inputs, formula: stored.formula, coverage: stored.coverage,
              codeVersion: codeVersion(), configHash: stored.configHash,
            }
          : disclosedProvenance(by.configHash, { citationUrl: o.citationUrl, approvedBy: by.approvedBy, approvedAt: nowIso });
      return insertObservation(t, {
        assetId: o.assetId,
        metricKey: o.metricKey,
        observedAt: o.observedAt,
        periodDays: o.periodDays,
        value: o.value,
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

/** The 0005 columns of a stored row: null on rows written before 0005 that the token backfill has not filled. */
export interface StoredTokens {
  id: number;
  tokenRef: string | null;
  amount: number | null;
  hourlyAmounts: number[] | null;
}

export async function getTokensByIds(db: Db, ids: number[]): Promise<StoredTokens[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<{ id: number; token_ref: string | null; amount: number | null; hourly_amounts: number[] | null }>(
    'SELECT id, token_ref, amount, hourly_amounts FROM observations WHERE id = ANY($1::bigint[]) ORDER BY id',
    [ids],
  );
  return rows.map((r) => ({ id: r.id, tokenRef: r.token_ref, amount: r.amount, hourlyAmounts: r.hourly_amounts }));
}

/**
 * Fills the token columns of one active row that has none (the token backfill, Task 7). Only `token_ref`, `amount` and
 * `hourly_amounts` change: never `value`, never a new row. Returns false when the row already had tokens, or is no
 * longer active (a concurrent write got there first), and then changes nothing.
 */
export async function fillObservationTokens(db: Db, id: number, tokens: ObservationTokens): Promise<boolean> {
  const t = checkedTokens(tokens);
  const r = await db.run(
    `UPDATE observations SET token_ref = $2, amount = $3, hourly_amounts = $4::jsonb
     WHERE id = $1 AND amount IS NULL AND ${ACTIVE}`,
    [id, t.tokenRef, t.amount, t.hourlyAmounts ? JSON.stringify(t.hourlyAmounts) : null],
  );
  return r.rowCount === 1;
}

/** Whether the row is still active (neither superseded nor rejected); false when there is no such row. */
export async function isActiveObservation(db: Db, id: number): Promise<boolean> {
  return (await db.one<{ id: number }>(`SELECT id FROM observations WHERE id = $1 AND ${ACTIVE}`, [id])) !== undefined;
}
