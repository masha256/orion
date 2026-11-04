import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrionPaths } from '../../src/cli/paths.js';
import type { OrionDb } from '../../src/db/connection.js';
import { activeAssetIds, Daemon, RESTART_RETRY_MS, type DaemonDeps, type JobHandler, type JobOutcome } from '../../src/daemon/daemon.js';
import { daemonLog, LOG_ROTATE_BYTES } from '../../src/daemon/log.js';
import { systemdNotifier } from '../../src/daemon/systemd.js';
import { clearDrain, latestHeartbeat, requestDrain } from '../../src/db/heartbeat.js';
import { claimNextJob, enqueueJob, listJobs, reapExpired, type JobKind } from '../../src/db/jobs.js';
import { insertRegistryRow, setRegistryState, type AssetState } from '../../src/db/registry.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { FakeClock } from '../helpers/clock.js';
import { testDbPair, useTestDb } from '../helpers/db.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = useTestDb();
const pair = testDbPair();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A dev config root: the repo's schedule.yaml and two assets (mini, other). */
function configRoot(opts: { badYaml?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'orion-daemon-'));
  dirs.push(root);
  mkdirSync(join(root, 'assets'));
  copyFileSync(join(ROOT, 'schedule.yaml'), join(root, 'schedule.yaml'));
  writeFileSync(join(root, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  writeFileSync(join(root, 'assets', 'other.yaml'), opts.badYaml ? 'id: other\nsymbol: OTHER\n' : MINI_ASSET_YAML.replace(/^id: mini$/m, 'id: other'));
  return root;
}

interface World {
  daemon: Daemon;
  posts: string[];
  systemd: string[];
  logs: string[];
}

function daemon(o: { db?: OrionDb; clock: FakeClock; root?: string; id?: string; handlers?: DaemonDeps['handlers']; allowRetire?: boolean }): World {
  const root = o.root ?? configRoot();
  const paths: OrionPaths = { home: root, configRoot: root, envFile: join(root, 'no.env'), release: null };
  const w: World = { posts: [], systemd: [], logs: [], daemon: undefined as unknown as Daemon };
  w.daemon = new Daemon({
    db: o.db ?? db(), clock: o.clock, env: 'dev', paths, handlers: o.handlers ?? {}, daemonId: o.id ?? 'd1',
    notifier: () => ({ post: async (text) => { w.posts.push(text); return { ok: true, attempts: 1 }; } }),
    systemd: { ready: () => w.systemd.push('READY'), watchdog: () => w.systemd.push('WATCHDOG'), stopping: () => w.systemd.push('STOPPING') },
    log: (line) => w.logs.push(line),
    activeAssets: activeAssetIds, allowRetire: o.allowRetire,
  });
  return w;
}

async function register(id: string, state: AssetState, since = '2026-10-01T00:00:00.000Z'): Promise<void> {
  const c = { at: since, by: 't', reason: null, releaseTag: null };
  await insertRegistryRow(db(), id, state === 'paused' ? 'active' : state, 'h', c);
  if (state === 'paused') await setRegistryState(db(), id, 'active', 'paused', c);
}

/** A handler that waits for the test to let it go. */
function gate(outcome: JobOutcome = { status: 'done', result: { ok: true } }): { handler: JobHandler; open(): void; started: Promise<void> } {
  let open!: () => void;
  let started!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const startedP = new Promise<void>((r) => { started = r; });
  return { handler: async () => { started(); await opened; return outcome; }, open: () => open(), started: startedP };
}

async function job(id: number): Promise<Record<string, unknown>> {
  return (await db().one('SELECT status, attempts, run_after, last_error, lease_expires_at, result_json FROM jobs WHERE id = $1', [id]))!;
}

const done: JobHandler = async () => ({ status: 'done', result: null });

describe('daemon scheduler', () => {
  it('daemon: two schedulers in the same slot insert one row per job', async () => {
    await register('mini', 'active');
    await register('other', 'active');
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    const root = configRoot();
    const [a, b] = pair();
    const n = await Promise.all([daemon({ db: a, clock, root }).daemon.schedulerTick(), daemon({ db: b, clock, root, id: 'd2' }).daemon.schedulerTick()]);
    // nightly 00:45 (2 refreshes + the report), levels 00:15, disclosure_watch and retention of the day before.
    expect(n[0] + n[1]).toBe(6);
    const rows = await db().all<{ kind: JobKind; asset_id: string | null; slot: string; n: number }>(
      'SELECT kind, asset_id, slot, count(*)::int AS n FROM jobs GROUP BY kind, asset_id, slot ORDER BY kind, asset_id',
    );
    expect(rows).toEqual([
      { kind: 'disclosure_watch', asset_id: null, slot: '2026-11-02T16:40:00.000Z', n: 1 },
      { kind: 'levels', asset_id: null, slot: '2026-11-03T00:15:00.000Z', n: 1 },
      { kind: 'nightly_report', asset_id: null, slot: '2026-11-03T00:45:00.000Z', n: 1 },
      { kind: 'refresh', asset_id: 'mini', slot: '2026-11-03T00:45:00.000Z', n: 1 },
      { kind: 'refresh', asset_id: 'other', slot: '2026-11-03T00:45:00.000Z', n: 1 },
      { kind: 'retention', asset_id: null, slot: '2026-11-02T03:30:00.000Z', n: 1 },
    ]);
    // Again in the same slot: nothing new.
    expect(await daemon({ db: a, clock, root }).daemon.schedulerTick()).toBe(0);
  });

  it('daemon: catch-up after 3 days down creates one nightly slot and one levels slot', async () => {
    await register('mini', 'active');
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    const { daemon: d } = daemon({ clock });
    await d.schedulerTick();
    clock.advance(3 * 86_400_000 + 30 * 60_000); // down from 11-03 01:00 to 11-06 01:30
    await d.schedulerTick();
    const slots = async (kind: JobKind): Promise<string[]> => (await listJobs(db(), { kind })).map((j) => j.slot).sort();
    expect(await slots('nightly_report')).toEqual(['2026-11-03T00:45:00.000Z', '2026-11-06T00:45:00.000Z']);
    expect(await slots('refresh')).toEqual(['2026-11-03T00:45:00.000Z', '2026-11-06T00:45:00.000Z']);
    expect(await slots('levels')).toEqual(['2026-11-03T00:15:00.000Z', '2026-11-06T01:15:00.000Z']);
  });

  it('daemon: a paused asset gets no refresh job', async () => {
    await register('mini', 'active');
    await register('other', 'paused');
    await register('third', 'inactive');
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    await daemon({ clock }).daemon.schedulerTick();
    expect((await listJobs(db(), { kind: 'refresh' })).map((j) => j.assetId)).toEqual(['mini']);
    expect(await listJobs(db(), { kind: 'nightly_report' })).toHaveLength(1);
  });
});

describe('daemon scheduler: activation time', () => {
  it('daemon: an asset activated after the nightly slot began gets no refresh for that slot, and one the next night', async () => {
    await register('mini', 'active');
    await register('other', 'active', '2026-11-03T00:50:00.000Z'); // activated 5 min after the 00:45 slot
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    const { daemon: d } = daemon({ clock });
    await d.schedulerTick();
    expect((await listJobs(db(), { kind: 'refresh' })).map((j) => [j.assetId, j.slot])).toEqual([['mini', '2026-11-03T00:45:00.000Z']]);
    clock.advance(86_400_000);
    await d.schedulerTick();
    expect((await listJobs(db(), { kind: 'refresh', slot: '2026-11-04T00:45:00.000Z' })).map((j) => j.assetId).sort()).toEqual(['mini', 'other']);
    // Activated exactly at the slot: that slot counts.
    expect(await activeAssetIds(db(), new Date('2026-11-03T00:50:00.000Z'))).toEqual(['mini', 'other']);
    expect(await activeAssetIds(db(), new Date('2026-11-03T00:49:59.999Z'))).toEqual(['mini']);
  });
});

describe('daemon start-up', () => {
  it('daemon: a running job from a dead daemon is re-queued once and announced', async () => {
    const clock = new FakeClock('2026-11-03T02:00:00.000Z');
    const slot = '2026-11-03T00:45:00.000Z';
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot });
    await claimNextJob(db(), 'dead-daemon', new Date('2026-11-03T01:00:00.000Z'), null);
    // A second one that had used its last attempt: failed, and said so.
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-11-03T01:15:00.000Z' });
    await claimNextJob(db(), 'dead-daemon', new Date('2026-11-03T01:16:00.000Z'), null);
    const root = configRoot();
    const w = daemon({ clock, root, handlers: { refresh: done } });
    await w.daemon.start();
    expect(await job(1)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'lease_expired' });
    expect(await job(2)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'lease_expired' });
    expect(w.posts).toEqual([
      'ORION RESTARTED dev after unclean exit, job 1 re-queued',
      'ORION RESTARTED dev after unclean exit, job 2 failed (lease_expired)',
    ]);
    expect(w.systemd).toEqual(['READY']);
    // It runs the re-queued job, then stops cleanly; the next daemon finds nothing to announce.
    expect(await w.daemon.workerTick()).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'done', attempts: 2 });
    w.daemon.requestStop();
    await w.daemon.run();
    expect((await latestHeartbeat(db()))?.state).toBe('stopped');
    const w2 = daemon({ clock, root, id: 'd2' });
    await w2.daemon.start();
    expect(w2.posts).toEqual([]);
    expect(await job(1)).toMatchObject({ status: 'done', attempts: 2 });
    w2.daemon.requestStop();
    await w2.daemon.run();
  });

  it('daemon: a second daemon on the same database refuses to start with daemon_running', async () => {
    const clock = new FakeClock('2026-11-03T02:00:00.000Z');
    const root = configRoot();
    const [a, b] = pair();
    const first = daemon({ db: a, clock, root });
    await first.daemon.start();
    const second = daemon({ db: b, clock, root, id: 'd2' });
    await expect(second.daemon.start()).rejects.toMatchObject({ code: 'daemon_running', message: 'another orion daemon holds this database' });
    expect(second.systemd).toEqual([]);
    expect((await db().all('SELECT daemon_id FROM daemon_heartbeat')).map((r) => r.daemon_id)).toEqual(['d1']);
    // Once the first has stopped, the lock is free.
    first.daemon.requestStop();
    await first.daemon.run();
    const third = daemon({ db: b, clock, root, id: 'd3' });
    await third.daemon.start();
    expect(third.systemd).toEqual(['READY']);
    third.daemon.requestStop();
    await third.daemon.run();
  });

  it('daemon: a start-up check failure (invalid YAML) exits before READY and inserts no heartbeat', async () => {
    const clock = new FakeClock('2026-11-03T02:00:00.000Z');
    const w = daemon({ clock, root: configRoot({ badYaml: true }) });
    await expect(w.daemon.start()).rejects.toMatchObject({ code: 'invalid_asset_config' });
    expect(w.systemd).toEqual([]);
    expect(await db().all('SELECT * FROM daemon_heartbeat')).toEqual([]);
    expect(await db().all('SELECT * FROM asset_registry')).toEqual([]);
    // It let go of the singleton lock on the way out.
    const ok = daemon({ clock, id: 'd2' });
    await ok.daemon.start();
    ok.daemon.requestStop();
    await ok.daemon.run();
  });

  it('daemon: a release that would retire every asset does not start, alerts Slack and writes nothing (I-3)', async () => {
    await register('mini', 'active');
    await register('other', 'active');
    const clock = new FakeClock('2026-11-03T02:00:00.000Z');
    const root = configRoot();
    rmSync(join(root, 'assets'), { recursive: true }); // a tarball without assets/
    const w = daemon({ clock, root });
    await expect(w.daemon.start()).rejects.toMatchObject({ code: 'reconcile_would_retire' });
    expect(w.posts).toEqual([
      'ORION ALERT dev: daemon not started: release (dev checkout) would retire every asset (mini, other); refused (orion daemon --allow-retire to accept)',
    ]);
    expect(w.systemd).toEqual([]);
    expect(await db().all('SELECT * FROM daemon_heartbeat')).toEqual([]);
    expect((await db().all<{ state: string }>('SELECT state FROM asset_registry ORDER BY asset_id')).map((r) => r.state)).toEqual(['active', 'active']);
    // --allow-retire: it starts and retires them.
    const ok = daemon({ clock, root, id: 'd2', allowRetire: true });
    await ok.daemon.start();
    expect((await db().all<{ state: string }>('SELECT state FROM asset_registry ORDER BY asset_id')).map((r) => r.state)).toEqual(['missing', 'missing']);
    ok.daemon.requestStop();
    await ok.daemon.run();
  });

  it('daemon: staging refuses to publish to the prod snapshot repo', async () => {
    const clock = new FakeClock('2026-11-03T02:00:00.000Z');
    const root = configRoot();
    writeFileSync(join(root, 'no.env'), 'ORION_PUBLISH=git:git@github.com:masha256/orion-data.git#main\n');
    const paths: OrionPaths = { home: root, configRoot: root, envFile: join(root, 'no.env'), release: null };
    const ready: string[] = [];
    const d = new Daemon({
      db: db(), clock, env: 'stage', paths, handlers: {}, daemonId: 'd1', log: () => undefined, activeAssets: activeAssetIds,
      notifier: () => ({ post: async () => ({ ok: true, attempts: 1 }) }),
      systemd: { ready: () => ready.push('READY'), watchdog: () => undefined, stopping: () => undefined },
    });
    await expect(d.start()).rejects.toMatchObject({ code: 'publish_repo_is_prod' });
    expect(ready).toEqual([]);
    expect(await db().all('SELECT * FROM daemon_heartbeat')).toEqual([]);
  });
});

describe('daemon worker', () => {
  it('daemon: a failed refresh is retried once no sooner than 10 minutes later, then stays failed', async () => {
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    let calls = 0;
    const w = daemon({ clock, handlers: { refresh: async () => { calls++; return { status: 'failed', result: { n: calls }, error: `rpc down ${calls}`, retryAfterMs: 600_000 }; } } });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
    expect(await w.daemon.workerTick()).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'rpc down 1', run_after: '2026-11-03T01:10:00.000Z' });
    clock.advance(599_999);
    expect(await w.daemon.workerTick()).toBe(false);
    clock.advance(1);
    expect(await w.daemon.workerTick()).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'failed', attempts: 2, last_error: 'rpc down 2', result_json: '{"n":2}' });
    clock.advance(3_600_000);
    expect(await w.daemon.workerTick()).toBe(false);
    expect(calls).toBe(2);
  });

  it("daemon: the refreshes of one slot share one HTTP cache; another slot's jobs get their own", async () => {
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    const seen: Map<string, Promise<unknown>>[] = [];
    const w = daemon({ clock, handlers: { refresh: async (j, ctx) => { seen.push(ctx.sharedHttpCache!(j.slot)); return { status: 'done', result: null }; } } });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'other', slot: '2026-11-03T00:45:00.000Z' });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:50:00.000Z' });
    for (let i = 0; i < 3; i++) expect(await w.daemon.workerTick()).toBe(true);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it('daemon: a handler that throws fails with its message capped at 300, retried after 10 minutes', async () => {
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    const w = daemon({ clock, handlers: { refresh: async () => { throw new Error('x'.repeat(400)); }, levels: async () => { throw new Error('boom'); } } });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-11-03T00:15:00.000Z' });
    expect(await w.daemon.workerTick()).toBe(true);
    const r = await job(1);
    expect(r).toMatchObject({ status: 'queued', attempts: 1, run_after: new Date(Date.parse('2026-11-03T01:00:00.000Z') + RESTART_RETRY_MS).toISOString() });
    expect(r.last_error).toBe('x'.repeat(300));
    // levels has one attempt: a throw fails it for good.
    expect(await w.daemon.workerTick()).toBe(true);
    expect(await job(2)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'boom' });
  });

  it('daemon: a deferred job does not consume an attempt', async () => {
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    const until = Date.parse('2026-11-03T01:05:00.000Z');
    let calls = 0;
    const w = daemon({ clock, handlers: { nightly_report: async () => (++calls === 1 ? { status: 'deferred', untilMs: until } : { status: 'done', result: 'sent' }) } });
    await enqueueJob(db(), { kind: 'nightly_report', assetId: null, slot: '2026-11-03T00:45:00.000Z' });
    expect(await w.daemon.workerTick()).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'queued', attempts: 0, run_after: '2026-11-03T01:05:00.000Z' });
    expect(await w.daemon.workerTick()).toBe(false);
    clock.advance(300_000);
    expect(await w.daemon.workerTick()).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'done', attempts: 1, result_json: '"sent"' });
  });

  it('daemon: the lease is renewed while a slow handler runs and expires when the handler hangs past 3 min without renewal', async () => {
    const [, other] = pair();
    // Renewed: the daemon's clock runs, so its renewal loop extends the lease every 60 s.
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    const g = gate();
    const w = daemon({ clock, handlers: { refresh: g.handler } });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
    const tick = w.daemon.workerTick();
    await g.started;
    for (let i = 1; i <= 4; i++) {
      clock.advance(60_000);
      const want = new Date(clock.now().getTime() + 180_000).toISOString();
      await vi.waitFor(async () => expect((await job(1)).lease_expires_at).toBe(want));
    }
    expect(await reapExpired(other, clock.now())).toEqual({ requeued: [], failed: [] });
    g.open();
    expect(await tick).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'done', attempts: 1 });

    // Hung: the daemon's clock stands still (no renewal); another daemon 4 min later reaps the lease.
    await db.reset();
    const frozen = new FakeClock('2026-11-03T01:00:00.000Z');
    const g2 = gate({ status: 'done', result: 'late' });
    const w2 = daemon({ clock: frozen, handlers: { refresh: g2.handler } });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
    const tick2 = w2.daemon.workerTick();
    await g2.started;
    const reaped = await reapExpired(other, new Date('2026-11-03T01:04:00.000Z'));
    expect(reaped.requeued.map((j) => j.id)).toEqual([1]);
    // The hung handler finally returns: its result is dropped, not written over the re-queued row (R-c6).
    g2.open();
    expect(await tick2).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'lease_expired', result_json: null });
    expect(w2.logs.some((l) => l.includes('job 1') && l.includes('lease lost') && l.includes('dropped'))).toBe(true);
  });

  it('daemon: the clock jumps 150 s forward mid-job, past the lease: the job is not reaped from its own daemon and runs once (I-1)', async () => {
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    let calls = 0;
    const g = gate();
    const counted: JobHandler = async (j, ctx) => { calls++; return await g.handler(j, ctx); };
    const w = daemon({ clock, handlers: { levels: counted } });
    // The same daemon's worker loop, entered again while its job runs (as a stalled loop would be): same owner id.
    const again = daemon({ clock, handlers: { levels: counted } });
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-11-03T00:15:00.000Z' });
    const tick = w.daemon.workerTick();
    await g.started;
    clock.advance(50_000); // 50 s on the monotonic clock: the 60 s renewal has not fired yet
    clock.jump(150_000); // the wall clock steps: now 01:03:20, the lease (01:03:00) has run out
    expect(await again.daemon.workerTick()).toBe(false); // its own expired lease is not reaped
    expect(await job(1)).toMatchObject({ status: 'running', attempts: 1 });
    clock.advance(10_000); // the renewal fires and extends the lease from the stepped clock
    const want = new Date(clock.now().getTime() + 180_000).toISOString();
    await vi.waitFor(async () => expect((await job(1)).lease_expires_at).toBe(want));
    g.open();
    expect(await tick).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'done', attempts: 1 });
    expect(await w.daemon.workerTick()).toBe(false);
    expect(calls).toBe(1);
    expect(w.logs.some((l) => l.includes('lease lost'))).toBe(false);
  });

  it('daemon: a renewal that finds the lease gone aborts the handler; its later Slack posts are not sent and its result is dropped (I-1)', async () => {
    const [, other] = pair();
    const clock = new FakeClock('2026-11-03T01:00:00.000Z');
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const seen: { aborted?: boolean; post?: unknown } = {};
    const handler: JobHandler = async (_j, ctx) => {
      started();
      await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r()));
      seen.aborted = ctx.signal.aborted;
      seen.post = await ctx.notify.post('ORION ALERT dev: should never be sent');
      return { status: 'done', result: 'late' };
    };
    const w = daemon({ clock, handlers: { refresh: handler } });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
    const tick = w.daemon.workerTick();
    await startedP;
    // Another daemon reaps the lease (a stall on this one); this daemon's next renewal sees it gone.
    expect((await reapExpired(other, new Date('2026-11-03T01:04:00.000Z'))).requeued.map((j) => j.id)).toEqual([1]);
    clock.advance(60_000);
    expect(await tick).toBe(true);
    expect(seen.aborted).toBe(true);
    expect(seen.post).toMatchObject({ ok: false, attempts: 0, error: 'job aborted: lease lost' });
    expect(w.posts).toEqual([]);
    // Re-queued, untouched by the aborted run's result.
    expect(await job(1)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'lease_expired', result_json: null });
    expect(w.logs.some((l) => l.includes('job 1') && l.includes('aborted') && l.includes('dropped'))).toBe(true);
  });

  it('daemon: drain finishes the current job, claims nothing new, reports drained; undrain resumes', async () => {
    const clock = new FakeClock('2026-11-03T02:00:00.000Z');
    const g = gate();
    const w = daemon({ clock, handlers: { levels: g.handler, retention: done } });
    await w.daemon.start();
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-11-03T01:15:00.000Z' });
    await enqueueJob(db(), { kind: 'retention', assetId: null, slot: '2026-11-03T01:30:00.000Z' });
    const tick = w.daemon.workerTick();
    await g.started;
    expect((await latestHeartbeat(db()))?.currentJobId).toBe(1);
    expect(await requestDrain(db(), clock.now())).toBe('d1');
    // While the job runs, the next lease renewal sees the request: state draining.
    clock.advance(60_000);
    await vi.waitFor(async () => expect((await latestHeartbeat(db()))?.state).toBe('draining'));
    g.open();
    expect(await tick).toBe(true);
    expect(await job(1)).toMatchObject({ status: 'done' });
    expect(await w.daemon.workerTick()).toBe(false);
    expect(await latestHeartbeat(db())).toMatchObject({ state: 'drained', currentJobId: null });
    expect(await job(2)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await clearDrain(db())).toBe(1);
    expect(await w.daemon.workerTick()).toBe(true);
    expect(await job(2)).toMatchObject({ status: 'done' });
    expect((await latestHeartbeat(db()))?.state).toBe('running');
    w.daemon.requestStop();
    await w.daemon.run();
  });
});

describe('daemon run loop', () => {
  it('daemon: run beats the watchdog every 30 s, the heartbeat at job start/end and every 15 min, and stops after the current job', async () => {
    const clock = new FakeClock('2026-11-03T01:20:00.000Z');
    const g = gate();
    const w = daemon({ clock, handlers: { levels: g.handler, nightly_report: done, disclosure_watch: done, retention: done } });
    await w.daemon.start();
    const started = (await latestHeartbeat(db()))!;
    const run = w.daemon.run();
    // The scheduler's first tick enqueues the newest slots; the nightly report runs first, then levels (01:15) blocks.
    await g.started;
    const atStart = (await latestHeartbeat(db()))!;
    expect(atStart.currentJobId).toBe((await listJobs(db(), { kind: 'levels' }))[0]!.id);
    expect(atStart.beatAt).toBe(started.beatAt); // the fake clock has not moved: same instant
    const watchdogs = (): number => w.systemd.filter((s) => s === 'WATCHDOG').length;
    const before = watchdogs();
    for (let i = 1; i <= 3; i++) {
      clock.advance(30_000);
      await vi.waitFor(() => expect(watchdogs()).toBe(before + i));
    }
    // Not on the 30 s beat: the row still says 01:20:00.
    expect((await latestHeartbeat(db()))!.beatAt).toBe('2026-11-03T01:20:00.000Z');
    clock.advance(15 * 60_000);
    await vi.waitFor(async () => expect((await latestHeartbeat(db()))!.beatAt).toBe(clock.now().toISOString()));
    w.daemon.requestStop();
    g.open();
    await run;
    expect(w.systemd).toContain('STOPPING');
    expect(await latestHeartbeat(db())).toMatchObject({ state: 'stopped', currentJobId: null });
    expect((await listJobs(db(), { kind: 'levels' }))[0]!.status).toBe('done');
    // Nothing claimed after the stop request.
    expect((await listJobs(db(), { kind: 'retention' }))[0]!.status).toBe('queued');
  });
});

describe('daemon lock liveness', () => {
  it('daemon: a heartbeat finds the singleton lock connection dead: the daemon stops and run fails with daemon_lock_lost', async () => {
    const clock = new FakeClock('2026-11-03T01:20:00.000Z');
    const w = daemon({ clock });
    await w.daemon.start();
    const pid = (await db().one<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = 'orion daemon d1'"))?.pid;
    expect(pid).toBeTypeOf('number');
    await db().run('SELECT pg_terminate_backend($1)', [pid!]);
    for (let i = 0; i < 50 && (await db().assetRunLockHolder('orion:daemon')); i++) await new Promise((r) => setTimeout(r, 50));
    const run = w.daemon.run().then(() => null, (err: unknown) => err); // settled at once: no unhandled rejection
    // The heartbeat (a job start, or the 15 min beat from the 30 s watchdog) pings the lock connection.
    for (let i = 0; i < 31 && w.logs.every((l) => !l.includes('singleton lock lost')); i++) {
      clock.advance(30_000);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await run).toMatchObject({ code: 'daemon_lock_lost' });
    expect(w.systemd).toContain('STOPPING');
    expect(w.logs.some((l) => l.includes('singleton lock lost'))).toBe(true);
    expect((await latestHeartbeat(db()))?.state).toBe('stopped');
  });
});

describe('systemd and the log', () => {
  it('systemd: notify runs systemd-notify only when NOTIFY_SOCKET is set', () => {
    const calls: string[][] = [];
    const spawn = (cmd: string, args: string[]): void => { calls.push([cmd, ...args]); };
    const off = systemdNotifier(spawn, {});
    off.ready();
    off.watchdog();
    off.stopping();
    expect(calls).toEqual([]);
    const on = systemdNotifier(spawn, { NOTIFY_SOCKET: '/run/user/1000/systemd/notify' });
    on.ready();
    on.watchdog();
    on.stopping();
    const pid = `--pid=${process.pid}`;
    expect(calls).toEqual([['systemd-notify', pid, 'READY=1'], ['systemd-notify', pid, 'WATCHDOG=1'], ['systemd-notify', pid, 'STOPPING=1']]);
  });

  it('log: lines go to stdout and daemon.log, rotated to daemon.log.1 at 10 MB', () => {
    const home = mkdtempSync(join(tmpdir(), 'orion-daemon-log-'));
    dirs.push(home);
    const out: string[] = [];
    const log = daemonLog(home, { stdout: (s) => out.push(s), now: () => new Date('2026-11-03T01:00:00.000Z') });
    log('hello');
    expect(out).toEqual(['2026-11-03T01:00:00.000Z hello']);
    expect(readFileSync(join(home, 'daemon.log'), 'utf8')).toBe('2026-11-03T01:00:00.000Z hello\n');
    writeFileSync(join(home, 'daemon.log'), 'x'.repeat(LOG_ROTATE_BYTES));
    log('after');
    expect(statSync(join(home, 'daemon.log.1')).size).toBe(LOG_ROTATE_BYTES);
    expect(readFileSync(join(home, 'daemon.log'), 'utf8')).toBe('2026-11-03T01:00:00.000Z after\n');
  });
});
