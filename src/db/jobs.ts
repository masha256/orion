import type { Json } from '../provenance/types.js';
import { OrionError } from '../types.js';
import type { Db } from './connection.js';

/**
 * The daemon's job queue (spec 5.1-5.2). Every time is passed in (`now`), never read with `now()` in SQL, so a fake
 * clock rules. A job is claimed with `FOR UPDATE SKIP LOCKED` and held by a lease; a write by an owner whose lease was
 * taken away (reaped and re-claimed) is refused with `job_lease_lost`, so one run of a job never overwrites another's.
 */

export const JOB_KINDS = ['refresh', 'nightly_report', 'levels', 'snapshot_push', 'disclosure_watch', 'staging_refresh', 'retention', 'backfill'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** Lower runs first. A `backfill` (an operator's multi-hour re-scan) runs after every scheduled kind (plan P1). */
export const JOB_PRIORITY: Record<JobKind, number> = {
  staging_refresh: 5, refresh: 10, nightly_report: 20, snapshot_push: 30, levels: 40, disclosure_watch: 50, retention: 60, backfill: 70,
};

/**
 * A `refresh` gets one retry; everything else none (the next slot is the retry). A `backfill` is never re-run on its
 * own: a lease lost mid-run (a deploy switch) fails it rather than re-queueing it under the new release.
 */
export const MAX_ATTEMPTS: Record<JobKind, number> = {
  refresh: 2, nightly_report: 1, levels: 1, snapshot_push: 1, disclosure_watch: 1, staging_refresh: 1, retention: 1, backfill: 1,
};

/** A `backfill` job's request (`jobs.params_json`, 0007): re-scan these flow metrics this many days back. */
export interface BackfillParams {
  op: 'fetch';
  metrics: string[];
  backfillDays: number;
}

/** How long a claim holds a job without a renewal. */
export const LEASE_MS = 180_000;

export interface Job {
  id: number;
  kind: JobKind;
  assetId: string | null;
  slot: string;
  runAfter: string;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  result: unknown;
  releaseTag: string | null;
  requestedBy: string;
  lastError: string | null;
  /** `params_json` as stored; null for every scheduled kind. A handler validates it before use. */
  params: Json | null;
}

export interface NewJob {
  kind: JobKind;
  assetId: string | null;
  slot: string;
  /** Default: the slot. */
  runAfter?: string;
  /** Default: 'scheduler'. */
  requestedBy?: string;
  releaseTag?: string | null;
  /** Default: none. Only a `backfill` carries params. */
  params?: BackfillParams | null;
}

interface Row {
  id: number;
  kind: JobKind;
  asset_id: string | null;
  slot: string;
  run_after: string;
  priority: number;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  result_json: string | null;
  release_tag: string | null;
  requested_by: string;
  last_error: string | null;
  /** jsonb: node-postgres parses it. */
  params_json: Json | null;
}

function fromRow(r: Row): Job {
  return {
    id: r.id, kind: r.kind, assetId: r.asset_id, slot: r.slot, runAfter: r.run_after, priority: r.priority, status: r.status,
    attempts: r.attempts, maxAttempts: r.max_attempts, leaseOwner: r.lease_owner, leaseExpiresAt: r.lease_expires_at,
    startedAt: r.started_at, endedAt: r.ended_at, result: r.result_json === null ? null : (JSON.parse(r.result_json) as unknown),
    releaseTag: r.release_tag, requestedBy: r.requested_by, lastError: r.last_error,
    params: r.params_json ?? null,
  };
}

const leaseUntil = (now: Date): string => new Date(now.getTime() + LEASE_MS).toISOString();

/** Inserts the job once per (kind, asset, slot); null when that job already exists, whatever its status. */
export async function enqueueJob(db: Db, j: NewJob): Promise<Job | null> {
  const res = await db.run<Row>(
    `INSERT INTO jobs (kind, asset_id, slot, run_after, priority, status, attempts, max_attempts, release_tag, requested_by, params_json)
     VALUES ($1, $2, $3, $4, $5, 'queued', 0, $6, $7, $8, $9)
     ON CONFLICT ON CONSTRAINT jobs_slot_key DO NOTHING RETURNING *`,
    [
      j.kind, j.assetId, j.slot, j.runAfter ?? j.slot, JOB_PRIORITY[j.kind], MAX_ATTEMPTS[j.kind], j.releaseTag ?? null, j.requestedBy ?? 'scheduler',
      j.params == null ? null : JSON.stringify(j.params),
    ],
  );
  return res.rows[0] ? fromRow(res.rows[0]) : null;
}

/**
 * Claims the next due job (lowest priority, then oldest run_after, then id) for `owner`: running, one more attempt, a
 * lease of LEASE_MS from `now`, and the release that runs it. Concurrent claimers skip each other's locked rows, so no
 * two get the same job. Null when nothing is due.
 */
export async function claimNextJob(db: Db, owner: string, now: Date, releaseTag: string | null): Promise<Job | null> {
  const nowIso = now.toISOString();
  const res = await db.run<Row>(
    `UPDATE jobs SET status = 'running', lease_owner = $1, lease_expires_at = $3, attempts = attempts + 1, started_at = $2,
       ended_at = NULL, release_tag = $4
     WHERE status = 'queued' AND id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_after <= $2 ORDER BY priority, run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
    [owner, nowIso, leaseUntil(now), releaseTag],
  );
  return res.rows[0] ? fromRow(res.rows[0]) : null;
}

/** Extends `owner`'s lease to `now` + LEASE_MS; false when the job is no longer running under `owner`. */
export async function renewLease(db: Db, id: number, owner: string, now: Date): Promise<boolean> {
  const res = await db.run("UPDATE jobs SET lease_expires_at = $3 WHERE id = $1 AND lease_owner = $2 AND status = 'running'", [id, owner, leaseUntil(now)]);
  return res.rowCount > 0;
}

function leaseLost(id: number, owner: string): OrionError {
  return new OrionError('job_lease_lost', `job ${id} is no longer running under ${owner}`);
}

/** Ends `owner`'s run of the job. The owner stays on the row as who ran it; the lease is cleared. */
export async function finishJob(
  db: Db, id: number, owner: string, out: { status: 'done' | 'failed' | 'skipped'; result: unknown; error?: string }, now: Date,
): Promise<void> {
  const res = await db.run(
    `UPDATE jobs SET status = $3, result_json = $4, last_error = $5, ended_at = $6, lease_expires_at = NULL
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner, out.status, out.result === undefined ? null : JSON.stringify(out.result), out.error ?? null, now.toISOString()],
  );
  if (res.rowCount === 0) throw leaseLost(id, owner);
}

/**
 * Back to queued after a failed attempt, due at `runAfter`; the attempt counts. Refused with `retry_exhausted` when the
 * job has no attempt left (M-1: the cap holds whatever the caller does), with `job_lease_lost` when `owner` lost it.
 */
export async function retryJob(db: Db, id: number, owner: string, runAfter: Date, error: string): Promise<void> {
  const res = await db.run(
    `UPDATE jobs SET status = 'queued', run_after = $3, last_error = $4, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1 AND lease_owner = $2 AND status = 'running' AND attempts < max_attempts`,
    [id, owner, runAfter.toISOString(), error],
  );
  if (res.rowCount > 0) return;
  const row = await db.one<{ attempts: number; max_attempts: number }>(
    "SELECT attempts, max_attempts FROM jobs WHERE id = $1 AND lease_owner = $2 AND status = 'running'",
    [id, owner],
  );
  if (!row) throw leaseLost(id, owner);
  throw new OrionError('retry_exhausted', `job ${id} has used ${row.attempts} of ${row.max_attempts} attempts; it cannot be retried`);
}

/** Back to queued, due at `runAfter`, without using up an attempt (the job could not start yet). */
export async function deferJob(db: Db, id: number, owner: string, runAfter: Date): Promise<void> {
  const res = await db.run(
    `UPDATE jobs SET status = 'queued', run_after = $3, attempts = attempts - 1, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner, runAfter.toISOString()],
  );
  if (res.rowCount === 0) throw leaseLost(id, owner);
}

/** Running rows matching `where`: re-queued while attempts remain, else failed with `lease_expired`. One transaction. */
async function returnRunning(db: Db, where: string, params: string[], nowIso: string): Promise<{ requeued: Job[]; failed: Job[] }> {
  return await db.tx(async (tx) => {
    const n = params.length;
    const requeued = await tx.run<Row>(
      `UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, last_error = 'lease_expired'
       WHERE status = 'running' AND attempts < max_attempts${where} RETURNING *`,
      params,
    );
    const failed = await tx.run<Row>(
      `UPDATE jobs SET status = 'failed', lease_expires_at = NULL, last_error = 'lease_expired', ended_at = $${n + 1}
       WHERE status = 'running' AND attempts >= max_attempts${where} RETURNING *`,
      [...params, nowIso],
    );
    const byId = (a: Row, b: Row): number => a.id - b.id;
    return { requeued: requeued.rows.sort(byId).map(fromRow), failed: failed.rows.sort(byId).map(fromRow) };
  });
}

/**
 * Running jobs whose lease ran out before `now` (their owner died or hung). `exceptOwner`: never that owner's jobs: a
 * daemon does not reap its own running job (I-1): a wall-clock step can make its lease look expired while its handler
 * is still in flight; its own jobs from before a restart are taken back by `abandonRunning`.
 */
export async function reapExpired(db: Db, now: Date, exceptOwner?: string): Promise<{ requeued: Job[]; failed: Job[] }> {
  const nowIso = now.toISOString();
  if (exceptOwner === undefined) return await returnRunning(db, ' AND lease_expires_at < $1', [nowIso], nowIso);
  return await returnRunning(db, ' AND lease_expires_at < $1 AND lease_owner IS DISTINCT FROM $2', [nowIso, exceptOwner], nowIso);
}

/** Every running job, whatever its lease. Start-up only: the daemon singleton means none of them is still running. */
export async function abandonRunning(db: Db, now: Date): Promise<{ requeued: Job[]; failed: Job[] }> {
  return await returnRunning(db, '', [], now.toISOString());
}

/** One job by id; null when there is none. */
export async function getJob(db: Db, id: number): Promise<Job | null> {
  const r = await db.one<Row>('SELECT * FROM jobs WHERE id = $1', [id]);
  return r ? fromRow(r) : null;
}

/** Newest slot first. `since`: slots at or after it. Default limit 100. */
export async function listJobs(db: Db, f: { since?: string; kind?: JobKind; slot?: string; limit?: number }): Promise<Job[]> {
  const rows = await db.all<Row>(
    `SELECT * FROM jobs WHERE ($1::timestamptz IS NULL OR slot >= $1) AND ($2::text IS NULL OR kind = $2) AND ($3::timestamptz IS NULL OR slot = $3)
     ORDER BY slot DESC, id DESC LIMIT $4`,
    [f.since ?? null, f.kind ?? null, f.slot ?? null, f.limit ?? 100],
  );
  return rows.map(fromRow);
}

/** Deletes finished jobs (done, failed, skipped) whose slot is before `iso`; queued and running rows are kept. */
export async function deleteJobsBefore(db: Db, iso: string): Promise<number> {
  const res = await db.run("DELETE FROM jobs WHERE slot < $1 AND status IN ('done', 'failed', 'skipped')", [iso]);
  return res.rowCount;
}
