import type { Db } from './connection.js';

/** The asset registry (spec 5.3): YAML in the release decides what exists, this table what runs. */

export type AssetState = 'inactive' | 'active' | 'paused' | 'missing';

/** Every registry write takes this advisory lock, so a reconcile and a pause never interleave. */
export const REGISTRY_LOCK = 'orion:registry';

export interface RegistryRow {
  assetId: string;
  state: AssetState;
  stateSince: string;
  stateBy: string;
  stateReason: string | null;
  /** The state a paused asset left (`inactive` or `active`), which resume restores; null unless paused. */
  pausedFrom: AssetState | null;
  configHash: string;
  firstSeenRelease: string | null;
  lastJobId: number | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
}

export interface StateEvent {
  id: number;
  assetId: string;
  fromState: AssetState | null;
  toState: AssetState;
  at: string;
  by: string;
  reason: string | null;
  releaseTag: string | null;
}

/** One state change: who, when, why, and the release it happened under. */
export interface StateChange {
  at: string;
  by: string;
  reason: string | null;
  releaseTag: string | null;
}

interface Row {
  asset_id: string;
  state: AssetState;
  state_since: string;
  state_by: string;
  state_reason: string | null;
  paused_from: AssetState | null;
  config_hash: string;
  first_seen_release: string | null;
  last_job_id: number | null;
  last_run_at: string | null;
  last_outcome: string | null;
}

interface EventRow {
  id: number;
  asset_id: string;
  from_state: AssetState | null;
  to_state: AssetState;
  at: string;
  by: string;
  reason: string | null;
  release_tag: string | null;
}

function fromRow(r: Row): RegistryRow {
  return {
    assetId: r.asset_id, state: r.state, stateSince: r.state_since, stateBy: r.state_by, stateReason: r.state_reason, pausedFrom: r.paused_from,
    configHash: r.config_hash, firstSeenRelease: r.first_seen_release, lastJobId: r.last_job_id, lastRunAt: r.last_run_at,
    lastOutcome: r.last_outcome,
  };
}

function fromEventRow(r: EventRow): StateEvent {
  return { id: r.id, assetId: r.asset_id, fromState: r.from_state, toState: r.to_state, at: r.at, by: r.by, reason: r.reason, releaseTag: r.release_tag };
}

export async function listRegistry(db: Db): Promise<RegistryRow[]> {
  return (await db.all<Row>('SELECT * FROM asset_registry ORDER BY asset_id')).map(fromRow);
}

export async function getRegistryRow(db: Db, id: string): Promise<RegistryRow | null> {
  const row = await db.one<Row>('SELECT * FROM asset_registry WHERE asset_id = $1', [id]);
  return row ? fromRow(row) : null;
}

/** The row, locked for update until the enclosing transaction ends. */
export async function lockRegistryRow(db: Db, id: string): Promise<RegistryRow | null> {
  const row = await db.one<Row>('SELECT * FROM asset_registry WHERE asset_id = $1 FOR UPDATE', [id]);
  return row ? fromRow(row) : null;
}

/** The asset's last job, as the nightly report and `asset registry` show it. */
export async function recordRun(db: Db, assetId: string, jobId: number, at: string, outcome: string): Promise<void> {
  await db.run('UPDATE asset_registry SET last_job_id = $2, last_run_at = $3, last_outcome = $4 WHERE asset_id = $1', [assetId, jobId, at, outcome]);
}

/** Newest first. */
export async function listStateEvents(db: Db, assetId: string, limit: number): Promise<StateEvent[]> {
  const rows = await db.all<EventRow>('SELECT * FROM asset_state_events WHERE asset_id = $1 ORDER BY id DESC LIMIT $2', [assetId, limit]);
  return rows.map(fromEventRow);
}

async function insertEvent(db: Db, assetId: string, from: AssetState | null, to: AssetState, c: StateChange): Promise<void> {
  await db.run(
    'INSERT INTO asset_state_events (asset_id, from_state, to_state, at, by, reason, release_tag) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [assetId, from, to, c.at, c.by, c.reason, c.releaseTag],
  );
}

/** A new row in `state`, with its event (from nothing). Call inside a transaction. */
export async function insertRegistryRow(db: Db, assetId: string, state: AssetState, configHash: string, c: StateChange): Promise<void> {
  await db.run(
    `INSERT INTO asset_registry (asset_id, state, state_since, state_by, state_reason, config_hash, first_seen_release)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [assetId, state, c.at, c.by, c.reason, configHash, c.releaseTag],
  );
  await insertEvent(db, assetId, null, state, c);
}

/**
 * Moves an existing row from `from` to `to`, with its event. Call inside a transaction, on a row read `FOR UPDATE`.
 * Moving to `paused` stores `from` as `paused_from` (resume restores it, R-c5); any other move clears it.
 */
export async function setRegistryState(db: Db, assetId: string, from: AssetState, to: AssetState, c: StateChange): Promise<void> {
  const pausedFrom = to === 'paused' ? from : null;
  await db.run(
    'UPDATE asset_registry SET state = $2, state_since = $3, state_by = $4, state_reason = $5, paused_from = $6 WHERE asset_id = $1',
    [assetId, to, c.at, c.by, c.reason, pausedFrom],
  );
  await insertEvent(db, assetId, from, to, c);
}

/** The hash of the YAML the release carries. Not a state change: no event. */
export async function setConfigHash(db: Db, assetId: string, hash: string): Promise<void> {
  await db.run('UPDATE asset_registry SET config_hash = $2 WHERE asset_id = $1', [assetId, hash]);
}
