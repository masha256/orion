import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import {
  JOB_KINDS, JOB_PRIORITY, LEASE_MS, MAX_ATTEMPTS, abandonRunning, claimNextJob, deferJob, deleteJobsBefore, enqueueJob, finishJob,
  getJob, listJobs, reapExpired, renewLease, retryJob,
} from '../../src/db/jobs.js';
import { testDatabaseConfig, useTestDb } from '../helpers/db.js';

const db = useTestDb();

const SLOT = '2026-11-03T00:45:00.000Z';
const at = (iso: string): Date => new Date(iso);
const plus = (iso: string, ms: number): Date => new Date(new Date(iso).getTime() + ms);

describe('jobs store', () => {
  it('jobs: the constants are the plan\'s', () => {
    expect(JOB_KINDS).toEqual(['refresh', 'nightly_report', 'levels', 'snapshot_push', 'disclosure_watch', 'staging_refresh', 'retention', 'backfill']);
    expect(JOB_PRIORITY).toEqual({ staging_refresh: 5, refresh: 10, nightly_report: 20, snapshot_push: 30, levels: 40, disclosure_watch: 50, retention: 60, backfill: 70 });
    expect(MAX_ATTEMPTS.refresh).toBe(2);
    for (const k of JOB_KINDS.filter((k) => k !== 'refresh')) expect(MAX_ATTEMPTS[k]).toBe(1);
    expect(LEASE_MS).toBe(180_000);
  });

  it('jobs: enqueue fills the defaults from the kind', async () => {
    const j = await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT });
    expect(j).toEqual({
      id: 1, kind: 'refresh', assetId: 'aero', slot: SLOT, runAfter: SLOT, priority: 10, status: 'queued', attempts: 0, maxAttempts: 2,
      leaseOwner: null, leaseExpiresAt: null, startedAt: null, endedAt: null, result: null, releaseTag: null, requestedBy: 'scheduler', lastError: null, params: null,
    });
    const manual = await enqueueJob(db(), { kind: 'snapshot_push', assetId: null, slot: SLOT, runAfter: '2026-11-03T01:00:00.000Z', requestedBy: 'mike', releaseTag: 'orion-2026.11.03.1' });
    expect(manual).toMatchObject({ runAfter: '2026-11-03T01:00:00.000Z', requestedBy: 'mike', releaseTag: 'orion-2026.11.03.1', priority: 30, maxAttempts: 1 });
  });

  it('jobs: a backfill job carries its params (params_json) through enqueue, claim, get and list; other kinds have none', async () => {
    const params = { op: 'fetch' as const, metrics: ['flow_usd.fees', 'flow_tokens.fees'], backfillDays: 120 };
    const j = await enqueueJob(db(), { kind: 'backfill', assetId: 'crv', slot: SLOT, requestedBy: 'run-now:mike', params });
    expect(j).toMatchObject({ kind: 'backfill', assetId: 'crv', priority: 70, maxAttempts: 1, params });
    expect((await getJob(db(), j!.id))!.params).toEqual(params);
    expect((await listJobs(db(), { kind: 'backfill' })).map((x) => x.params)).toEqual([params]);
    expect((await claimNextJob(db(), 'w1', at(SLOT), null))!.params).toEqual(params);
    expect((await enqueueJob(db(), { kind: 'levels', assetId: null, slot: SLOT }))!.params).toBeNull();
    expect((await db().one<{ t: string }>('SELECT jsonb_typeof(params_json) AS t FROM jobs WHERE id = $1', [j!.id]))!.t).toBe('object');
  });

  it('jobs: the same (kind, null, slot) enqueued twice gives one row', async () => {
    expect(await enqueueJob(db(), { kind: 'levels', assetId: null, slot: SLOT })).not.toBeNull();
    expect(await enqueueJob(db(), { kind: 'levels', assetId: null, slot: SLOT })).toBeNull();
    expect(await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT })).not.toBeNull();
    expect(await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT })).toBeNull();
    // A different asset or slot is a different job.
    expect(await enqueueJob(db(), { kind: 'refresh', assetId: 'cake', slot: SLOT })).not.toBeNull();
    expect(await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-11-03T01:15:00.000Z' })).not.toBeNull();
    // Even a terminal job keeps its slot: a clock replay inserts nothing new.
    const c = await claimNextJob(db(), 'w1', at(SLOT), null);
    await finishJob(db(), c!.id, 'w1', { status: 'done', result: null }, at(SLOT));
    expect(await enqueueJob(db(), { kind: c!.kind, assetId: c!.assetId, slot: c!.slot })).toBeNull();
    const n = await db().one<{ n: number }>('SELECT count(*)::int AS n FROM jobs');
    expect(n!.n).toBe(4);
  });

  it('jobs: claim takes the lowest priority, then oldest run_after, then id, and skips future run_after', async () => {
    const now = '2026-11-03T02:00:00.000Z';
    await enqueueJob(db(), { kind: 'retention', assetId: null, slot: '2026-11-03T00:00:00.000Z' }); // 1: priority 60
    await enqueueJob(db(), { kind: 'refresh', assetId: 'b', slot: SLOT, runAfter: '2026-11-03T01:00:00.000Z' }); // 2: 10, later
    await enqueueJob(db(), { kind: 'refresh', assetId: 'a', slot: SLOT }); // 3: 10, older run_after
    await enqueueJob(db(), { kind: 'refresh', assetId: 'c', slot: SLOT }); // 4: 10, same run_after as 3, higher id
    await enqueueJob(db(), { kind: 'staging_refresh', assetId: null, slot: SLOT, runAfter: '2026-11-03T03:00:00.000Z' }); // 5: 5, future
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: SLOT }); // 6: 40
    const order: number[] = [];
    for (;;) {
      const j = await claimNextJob(db(), 'w1', at(now), 'orion-2026.11.03.1');
      if (!j) break;
      order.push(j.id);
      expect(j).toMatchObject({ status: 'running', attempts: 1, leaseOwner: 'w1', startedAt: now, leaseExpiresAt: plus(now, LEASE_MS).toISOString(), releaseTag: 'orion-2026.11.03.1' });
    }
    expect(order).toEqual([3, 4, 2, 6, 1]);
    // The future job becomes due at its run_after, not before.
    expect(await claimNextJob(db(), 'w1', plus('2026-11-03T03:00:00.000Z', -1), null)).toBeNull();
    expect((await claimNextJob(db(), 'w1', at('2026-11-03T03:00:00.000Z'), null))?.id).toBe(5);
  });

  it('jobs: two concurrent claims on two pool clients never return the same job', async () => {
    for (let i = 0; i < 10; i++) await enqueueJob(db(), { kind: 'refresh', assetId: `a${i}`, slot: SLOT });
    const a = await openDb(testDatabaseConfig(), { max: 5 });
    const b = await openDb(testDatabaseConfig(), { max: 5 });
    try {
      const claims = await Promise.all(Array.from({ length: 20 }, async (_, i) => await claimNextJob(i % 2 === 0 ? a : b, `w${i}`, at(SLOT), null)));
      const ids = claims.filter((j) => j !== null).map((j) => j.id);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
      expect(claims.filter((j) => j === null)).toHaveLength(10);
      // Every row was claimed exactly once.
      const rows = await db().all<{ attempts: number; status: string }>('SELECT attempts, status FROM jobs');
      expect(rows.every((r) => r.attempts === 1 && r.status === 'running')).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('jobs: renewLease returns false after another owner re-claimed the row', async () => {
    await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT });
    const mine = await claimNextJob(db(), 'old', at(SLOT), null);
    const t1 = plus(SLOT, 60_000);
    expect(await renewLease(db(), mine!.id, 'old', t1)).toBe(true);
    expect((await listJobs(db(), {}))[0]!.leaseExpiresAt).toBe(plus(t1.toISOString(), LEASE_MS).toISOString());
    expect(await renewLease(db(), mine!.id, 'someone-else', t1)).toBe(false);
    // The old owner stalls past its lease; the reaper re-queues the job and a new owner takes it.
    const late = plus(t1.toISOString(), LEASE_MS + 1);
    expect((await reapExpired(db(), late)).requeued.map((j) => j.id)).toEqual([mine!.id]);
    const theirs = await claimNextJob(db(), 'new', late, null);
    expect(theirs).toMatchObject({ id: mine!.id, leaseOwner: 'new', attempts: 2 });
    expect(await renewLease(db(), mine!.id, 'old', late)).toBe(false);
    // Nor can the old owner finish, retry or defer what is no longer its job.
    await expect(finishJob(db(), mine!.id, 'old', { status: 'done', result: { x: 1 } }, late)).rejects.toMatchObject({ code: 'job_lease_lost' });
    await expect(retryJob(db(), mine!.id, 'old', late, 'boom')).rejects.toMatchObject({ code: 'job_lease_lost' });
    await expect(deferJob(db(), mine!.id, 'old', late)).rejects.toMatchObject({ code: 'job_lease_lost' });
    expect((await listJobs(db(), {}))[0]).toMatchObject({ status: 'running', leaseOwner: 'new' });
    // A finished job's lease cannot be renewed.
    await finishJob(db(), mine!.id, 'new', { status: 'done', result: { ok: true } }, late);
    expect(await renewLease(db(), mine!.id, 'new', late)).toBe(false);
  });

  it('jobs: reapExpired requeues while attempts remain and fails with lease_expired when not', async () => {
    await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT }); // max 2
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: SLOT }); // max 1
    const r = await claimNextJob(db(), 'w', at(SLOT), null);
    const l = await claimNextJob(db(), 'w', at(SLOT), null);
    expect([r!.kind, l!.kind]).toEqual(['refresh', 'levels']);
    // Not yet expired: nothing.
    expect(await reapExpired(db(), plus(SLOT, LEASE_MS - 1))).toEqual({ requeued: [], failed: [] });
    const t = plus(SLOT, LEASE_MS + 1);
    const first = await reapExpired(db(), t);
    expect(first.requeued.map((j) => [j.id, j.status, j.leaseOwner, j.leaseExpiresAt])).toEqual([[r!.id, 'queued', null, null]]);
    expect(first.failed.map((j) => [j.id, j.status, j.lastError, j.endedAt])).toEqual([[l!.id, 'failed', 'lease_expired', t.toISOString()]]);
    // Reaping again changes nothing.
    expect(await reapExpired(db(), t)).toEqual({ requeued: [], failed: [] });
    // The re-queued refresh runs its second attempt; when that lease expires too, it fails.
    const again = await claimNextJob(db(), 'w2', t, null);
    expect(again).toMatchObject({ id: r!.id, attempts: 2 });
    const t2 = plus(t.toISOString(), LEASE_MS + 1);
    const second = await reapExpired(db(), t2);
    expect(second.requeued).toEqual([]);
    expect(second.failed.map((j) => [j.id, j.lastError])).toEqual([[r!.id, 'lease_expired']]);
    expect(await claimNextJob(db(), 'w3', t2, null)).toBeNull();
  });

  it('jobs: abandonRunning takes every running row, whatever its lease', async () => {
    await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT });
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: SLOT });
    await enqueueJob(db(), { kind: 'retention', assetId: null, slot: SLOT });
    await claimNextJob(db(), 'dead', at(SLOT), null);
    await claimNextJob(db(), 'dead', at(SLOT), null);
    const out = await abandonRunning(db(), plus(SLOT, 1000)); // leases still valid
    expect(out.requeued.map((j) => j.kind)).toEqual(['refresh']);
    expect(out.failed.map((j) => [j.kind, j.lastError])).toEqual([['levels', 'lease_expired']]);
    expect((await listJobs(db(), { kind: 'retention' }))[0]!.status).toBe('queued'); // a queued row is left alone
  });

  it('jobs: reapExpired with exceptOwner never reaps that owner\'s own expired lease (I-1)', async () => {
    await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'cake', slot: SLOT });
    const mine = await claimNextJob(db(), 'me', at(SLOT), null);
    const theirs = await claimNextJob(db(), 'them', at(SLOT), null);
    const late = plus(SLOT, LEASE_MS + 1);
    const out = await reapExpired(db(), late, 'me');
    expect(out.requeued.map((j) => j.id)).toEqual([theirs!.id]);
    expect((await listJobs(db(), {})).find((j) => j.id === mine!.id)).toMatchObject({ status: 'running', leaseOwner: 'me' });
    // Its owner can still renew and finish it.
    expect(await renewLease(db(), mine!.id, 'me', late)).toBe(true);
    await finishJob(db(), mine!.id, 'me', { status: 'done', result: null }, late);
  });

  it('jobs: retryJob refuses a job with no attempts left (retry_exhausted), the row unchanged (M-1)', async () => {
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: SLOT }); // max 1
    const j = await claimNextJob(db(), 'w', at(SLOT), null);
    await expect(retryJob(db(), j!.id, 'w', plus(SLOT, 600_000), 'boom')).rejects.toMatchObject({ code: 'retry_exhausted' });
    expect((await listJobs(db(), {}))[0]).toMatchObject({ status: 'running', attempts: 1, leaseOwner: 'w', lastError: null });
    // Not the owner: still job_lease_lost, not retry_exhausted.
    await expect(retryJob(db(), j!.id, 'other', plus(SLOT, 600_000), 'boom')).rejects.toMatchObject({ code: 'job_lease_lost' });
  });

  it('jobs: deferJob does not consume an attempt', async () => {
    await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT });
    const j = await claimNextJob(db(), 'w', at(SLOT), null);
    expect(j!.attempts).toBe(1);
    const later = plus(SLOT, 600_000);
    await deferJob(db(), j!.id, 'w', later);
    const deferred = (await listJobs(db(), {}))[0]!;
    expect(deferred).toMatchObject({ status: 'queued', attempts: 0, runAfter: later.toISOString(), leaseOwner: null, leaseExpiresAt: null });
    expect(await claimNextJob(db(), 'w', plus(SLOT, 1), null)).toBeNull();
    expect((await claimNextJob(db(), 'w', later, null))!.attempts).toBe(1);
  });

  it('jobs: retryJob re-queues with the error and a later run_after; finishJob stores the result', async () => {
    await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT });
    const j = await claimNextJob(db(), 'w', at(SLOT), null);
    const later = plus(SLOT, 600_000);
    await retryJob(db(), j!.id, 'w', later, 'rpc timeout');
    expect((await listJobs(db(), {}))[0]).toMatchObject({ status: 'queued', attempts: 1, runAfter: later.toISOString(), lastError: 'rpc timeout', leaseOwner: null });
    const k = await claimNextJob(db(), 'w', later, null);
    expect(k!.attempts).toBe(2);
    await finishJob(db(), k!.id, 'w', { status: 'failed', result: { sources: ['x'] }, error: 'rpc timeout again' }, plus(later.toISOString(), 5000));
    expect((await listJobs(db(), {}))[0]).toMatchObject({
      status: 'failed', result: { sources: ['x'] }, lastError: 'rpc timeout again', endedAt: plus(later.toISOString(), 5000).toISOString(), leaseExpiresAt: null,
    });
  });

  it('jobs: listJobs filters and deleteJobsBefore removes only old terminal rows', async () => {
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-08-01T00:15:00.000Z' });
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-08-01T01:15:00.000Z' });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'aero', slot: SLOT });
    const old = await claimNextJob(db(), 'w', at(SLOT), null); // refresh first (priority)
    await finishJob(db(), old!.id, 'w', { status: 'done', result: null }, at(SLOT));
    const l1 = await claimNextJob(db(), 'w', at(SLOT), null);
    await finishJob(db(), l1!.id, 'w', { status: 'skipped', result: null }, at(SLOT));
    expect((await listJobs(db(), { kind: 'levels' })).map((j) => j.slot)).toEqual(['2026-08-01T01:15:00.000Z', '2026-08-01T00:15:00.000Z']);
    expect((await listJobs(db(), { slot: SLOT })).map((j) => j.kind)).toEqual(['refresh']);
    expect((await listJobs(db(), { since: '2026-08-01T01:00:00.000Z' })).map((j) => j.id)).toEqual([3, 2]);
    expect(await listJobs(db(), { limit: 1 })).toHaveLength(1);
    // Before 2026-09-01: two levels rows, but the queued one stays.
    expect(await deleteJobsBefore(db(), '2026-09-01T00:00:00.000Z')).toBe(1);
    expect((await listJobs(db(), {})).map((j) => [j.id, j.status])).toEqual([[3, 'done'], [2, 'queued']]);
  });
});
