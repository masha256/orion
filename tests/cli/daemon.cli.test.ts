import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { beat, latestHeartbeat, requestDrain, startHeartbeat } from '../../src/db/heartbeat.js';
import { claimNextJob, enqueueJob, listJobs } from '../../src/db/jobs.js';
import { insertRegistryRow } from '../../src/db/registry.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { subprocessDbEnv, testCliContext, useTestDb } from '../helpers/db.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = useTestDb();
const NOW = '2026-11-03T02:00:00.000Z';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Every daemon process a test started is killed before the next test (and before the file's schema is dropped). */
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      const gone = new Promise((r) => c.once('exit', r));
      c.kill('SIGKILL');
      await gone;
    }
  }
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'orion-daemon-cli-'));
  dirs.push(h);
  mkdirSync(join(h, 'assets'));
  writeFileSync(join(h, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  copyFileSync(join(ROOT, 'schedule.yaml'), join(h, 'schedule.yaml'));
  return h;
}

/** The env of a CLI subprocess: the test schema and a scratch home/config root/env file, nothing else but PATH. */
function processEnv(h: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '', ...subprocessDbEnv(), ORION_HOME: h, ORION_CONFIG_ROOT: h, ORION_ENV_FILE: join(h, 'no.env') };
}

const ENTRY = ['--import', 'tsx', join(ROOT, 'src', 'cli', 'index.ts')];

function orionProcess(env: Record<string, string>, ...args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((done, reject) => {
    execFile(process.execPath, [...ENTRY, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        reject(err);
        return;
      }
      done({ stdout, stderr, exit: err ? (err.code as number) : 0 });
    });
  });
}

async function orion(h: string, ...args: string[]): Promise<{ out: string; exit: number[] }> {
  const lines: string[] = [];
  const exit: number[] = [];
  const program = buildProgram(testCliContext(h, { stdout: (l) => lines.push(l), now: () => new Date(NOW), setExitCode: (c) => exit.push(c) }));
  await program.parseAsync(args, { from: 'user' });
  return { out: lines.join('\n'), exit };
}

/** A daemon that is running job 1 (refresh mini). */
async function runningDaemon(): Promise<void> {
  await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
  await claimNextJob(db(), 'other-daemon', new Date(NOW), null);
  await startHeartbeat(db(), { daemonId: 'other-daemon', pid: 4242, host: 'venus', releaseTag: null, startedAt: NOW });
  await beat(db(), 'other-daemon', { currentJobId: 1, state: 'running' }, new Date(NOW));
}

describe('orion daemon drain / undrain / status', () => {
  it('cli: daemon drain --wait 1s times out naming the running job', async () => {
    await runningDaemon();
    await beat(db(), 'other-daemon', { currentJobId: 1, state: 'running' }, new Date()); // the subprocess runs on the real clock: a fresh beat
    const h = home();
    const r = await orionProcess(processEnv(h), 'daemon', 'drain', '--wait', '1s');
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain('drain timed out; still running job 1 refresh mini');
    expect((await latestHeartbeat(db()))?.drainRequestedAt).not.toBeNull();
  }, 60_000);

  it('cli: daemon drain exits 0 once the daemon reports drained; undrain clears the request', async () => {
    await runningDaemon();
    await beat(db(), 'other-daemon', { currentJobId: null, state: 'drained' }, new Date(NOW));
    const h = home();
    const r = await orion(h, 'daemon', 'drain', '--wait', '5s');
    expect(r.exit).toEqual([]);
    expect(r.out).toContain('drained');
    expect((await latestHeartbeat(db()))?.drainRequestedAt).toBe(NOW);
    const u = await orion(h, 'daemon', 'undrain');
    expect(u.out).toContain('drain request cleared');
    expect((await latestHeartbeat(db()))?.drainRequestedAt).toBeNull();
  });

  it('cli: daemon drain (I-4) treats a heartbeat older than 2x the beat interval as a dead daemon: state gone, no wait', async () => {
    await runningDaemon();
    await beat(db(), 'other-daemon', { currentJobId: 1, state: 'running' }, new Date(Date.parse(NOW) - 31 * 60_000));
    const started = Date.now();
    const r = await orion(home(), 'daemon', 'drain', '--wait', '30m', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toEqual({ daemonId: 'other-daemon', state: 'gone', reason: 'heartbeat 2026-11-03T01:29:00.000Z is older than 30 min' });
    expect(Date.now() - started).toBeLessThan(10_000);
    // 29 min old: alive, so drain waits (and times out here)
    await beat(db(), 'other-daemon', { currentJobId: 1, state: 'running' }, new Date(Date.parse(NOW) - 29 * 60_000));
    expect(JSON.parse((await orion(home(), 'daemon', 'drain', '--wait', '1s', '--json')).out).error.code).toBe('drain_timeout');
  });

  it('cli: daemon drain with no daemon fails with no_daemon', async () => {
    const r = await orion(home(), 'daemon', 'drain', '--json');
    expect(r.exit).toEqual([1]);
    expect(JSON.parse(r.out).error.code).toBe('no_daemon');
  });

  it('cli: daemon status --json shows the env, heartbeat, registry, last jobs and next slots', async () => {
    await runningDaemon();
    await requestDrain(db(), new Date(NOW));
    await insertRegistryRow(db(), 'mini', 'active', 'h', { at: NOW, by: 't', reason: null, releaseTag: null });
    const r = await orion(home(), 'daemon', 'status', '--json');
    const s = JSON.parse(r.out);
    expect(Object.keys(s)).toEqual(['env', 'heartbeat', 'release', 'registry', 'last_jobs', 'next', 'soak', 'last_nightly']);
    expect([s.soak, s.last_nightly]).toEqual([null, null]);
    expect(s.env).toBe('dev');
    expect(s.heartbeat).toMatchObject({ daemonId: 'other-daemon', state: 'running', currentJobId: 1, drainRequestedAt: NOW });
    expect(s.release).toBeNull();
    expect(s.registry.map((x: { assetId: string }) => x.assetId)).toEqual(['mini']);
    expect(s.last_jobs.map((j: { id: number }) => j.id)).toEqual([1]);
    expect(s.next).toEqual([
      { key: 'nightly', slot: '2026-11-04T00:45:00.000Z' },
      { key: 'levels', slot: '2026-11-03T02:15:00.000Z' },
      { key: 'disclosure_watch', slot: '2026-11-03T16:40:00.000Z' },
      { key: 'retention', slot: '2026-11-03T03:30:00.000Z' },
    ]);
    const text = await orion(home(), 'daemon', 'status');
    expect(text.out).toContain('other-daemon');
  });
});

describe('orion daemon status: soak', () => {
  const TAG = 'orion-2026.11.03.1';
  /** A finished job of `kind`, as the scheduler (or run-now) made it under `tag`. */
  async function finished(kind: 'refresh' | 'nightly_report', assetId: string | null, slot: string, tag: string, result: unknown, o: { by?: string; status?: string } = {}) {
    const j = (await enqueueJob(db(), { kind, assetId, slot, releaseTag: tag, requestedBy: o.by }))!;
    await db().run('UPDATE jobs SET status = $2, result_json = $3, attempts = 1 WHERE id = $1', [j.id, o.status ?? 'done', JSON.stringify(result)]);
  }
  const tick = (failed: string[]) => ({ report: { ingest: { sources_failed: failed } }, fetchLines: [], alertFlags: [], levels: 0 });

  it("status: soak names the tag's first scheduled nightly and its failed sources; run-now nightlies do not count", async () => {
    const S1 = '2026-11-01T02:45:00.000Z';
    const S2 = '2026-11-02T02:45:00.000Z';
    // The older release's nightly, then the tag's scheduled one (a source failed, and one refresh failed whole).
    await finished('refresh', 'mini', S1, 'orion-2026.10.30.1', tick(['http_json:old']));
    await finished('nightly_report', null, S1, 'orion-2026.10.30.1', { delivered: true });
    await finished('refresh', 'mini', S2, TAG, tick(['coingecko:mini-token', 'http_json:https://api.example.test/stats']));
    await finished('refresh', 'other', S2, TAG, { report: { ingest: null }, fetchLines: [], alertFlags: [], levels: 0 }, { status: 'failed' });
    await finished('nightly_report', null, S2, TAG, { delivered: true });
    // A run-now nightly under the tag, newer: not a soak.
    await finished('nightly_report', null, '2026-11-03T01:30:00.000Z', TAG, { delivered: true }, { by: 'run-now:mike' });

    const release = { tag: TAG, commit: 'c', schema: 2, builtAt: 'b' };
    const lines: string[] = [];
    await buildProgram(testCliContext(home(), { stdout: (l) => lines.push(l), now: () => new Date(NOW), release })).parseAsync(['daemon', 'status', '--json'], { from: 'user' });
    const s = JSON.parse(lines.join('\n'));
    expect(s.soak).toEqual({
      tag: TAG, nightly_slot: S2, status: 'done', failed_sources: ['mini:coingecko:mini-token', 'mini:http_json:https://api.example.test/stats', 'other:*'],
    });
    expect(s.last_nightly).toEqual(s.soak);

    // A newer release that has not run its first nightly yet: no soak; last_nightly is still the tag's.
    const later: string[] = [];
    await buildProgram(testCliContext(home(), { stdout: (l) => later.push(l), now: () => new Date(NOW), release: { ...release, tag: 'orion-2026.11.04.1' } }))
      .parseAsync(['daemon', 'status', '--json'], { from: 'user' });
    const s2 = JSON.parse(later.join('\n'));
    expect(s2.soak).toBeNull();
    expect(s2.last_nightly).toMatchObject({ tag: TAG, nightly_slot: S2 });
    const text = await orion(home(), 'daemon', 'status');
    expect(text.out).toContain(`last nightly: ${S2} (release ${TAG}) done, failed sources: mini:coingecko:mini-token, mini:http_json:https://api.example.test/stats, other:*`);
  });
});

describe('orion daemon status: soak needs refreshes run on the tag (I-3)', () => {
  const TAG = 'orion-2026.11.03.1';
  const OLD = 'orion-2026.10.30.1';
  const S = '2026-11-03T02:45:00.000Z';
  async function finished(kind: 'refresh' | 'nightly_report', assetId: string | null, slot: string, tag: string, status = 'done') {
    const j = (await enqueueJob(db(), { kind, assetId, slot, releaseTag: tag }))!;
    await db().run('UPDATE jobs SET status = $2, result_json = $3, attempts = 1 WHERE id = $1', [j.id, status, JSON.stringify({ report: { ingest: { sources_failed: [] } } })]);
  }
  async function soak(): Promise<unknown> {
    const lines: string[] = [];
    await buildProgram(testCliContext(home(), { stdout: (l) => lines.push(l), now: () => new Date(NOW), release: { tag: TAG, commit: 'c', schema: 2, builtAt: 'b' } }))
      .parseAsync(['daemon', 'status', '--json'], { from: 'user' });
    return JSON.parse(lines.join('\n')).soak;
  }

  it('soak: a nightly deferred across the switch, whose refreshes ran on the previous release, is not a soak', async () => {
    await finished('refresh', 'mini', S, OLD);
    await finished('refresh', 'other', S, OLD);
    await finished('nightly_report', null, S, TAG); // claimed (and stamped) by the new daemon
    expect(await soak()).toBeNull();
  });

  it('soak: one refresh of the slot on the old release, or one still running, is not a soak', async () => {
    await finished('refresh', 'mini', S, TAG);
    await finished('refresh', 'other', S, OLD);
    await finished('nightly_report', null, S, TAG);
    expect(await soak()).toBeNull();
    await db().run("UPDATE jobs SET release_tag = $1 WHERE kind = 'refresh'", [TAG]);
    await db().run("UPDATE jobs SET status = 'running' WHERE kind = 'refresh' AND asset_id = 'other'");
    expect(await soak()).toBeNull();
    await db().run("UPDATE jobs SET status = 'done' WHERE kind = 'refresh' AND asset_id = 'other'");
    expect(await soak()).toMatchObject({ tag: TAG, nightly_slot: S });
  });

  it('soak: a slot with no refresh at all is not a soak', async () => {
    await finished('nightly_report', null, S, TAG);
    expect(await soak()).toBeNull();
  });
});

describe('orion job', () => {
  it('cli: job run-now nightly_report needs an explicit --slot (M-2)', async () => {
    const h = home();
    const r = await orion(h, 'job', 'run-now', 'nightly_report', '--by', 'mike', '--json');
    expect(r.exit).toEqual([1]);
    expect(JSON.parse(r.out).error.code).toBe('slot_required');
    const bad = await orion(h, 'job', 'run-now', 'nightly_report', '--slot', 'yesterday', '--json');
    expect(JSON.parse(bad.out).error.code).toBe('invalid_date');
    const ok = await orion(h, 'job', 'run-now', 'nightly_report', '--slot', '2026-11-03T00:45:00Z', '--by', 'mike', '--json');
    expect(JSON.parse(ok.out)).toMatchObject({ kind: 'nightly_report', slot: '2026-11-03T00:45:00.000Z', requestedBy: 'run-now:mike' });
  });

  it('cli: job run-now queues a job at now; refresh needs an active asset unless --force', async () => {
    const h = home();
    const refused = await orion(h, 'job', 'run-now', 'refresh', 'mini', '--by', 'mike', '--json');
    expect(refused.exit).toEqual([1]);
    expect(JSON.parse(refused.out).error.code).toBe('asset_not_active');
    const forced = await orion(h, 'job', 'run-now', 'refresh', 'mini', '--by', 'mike', '--force', '--json');
    expect(JSON.parse(forced.out)).toMatchObject({ id: 1, kind: 'refresh', assetId: 'mini', slot: NOW, runAfter: NOW, requestedBy: 'run-now:mike', status: 'queued' });
    await insertRegistryRow(db(), 'mini', 'active', 'h', { at: NOW, by: 't', reason: null, releaseTag: null });
    // The same slot again is refused rather than silently ignored.
    const dup = await orion(h, 'job', 'run-now', 'refresh', 'mini', '--by', 'mike', '--json');
    expect(JSON.parse(dup.out).error.code).toBe('job_exists');
    const levels = await orion(h, 'job', 'run-now', 'levels', '--by', 'mike');
    expect(levels.out).toBe(`queued job 3 levels slot ${NOW}`); // the refused duplicate used up id 2
    expect(JSON.parse((await orion(h, 'job', 'run-now', 'refresh', '--by', 'mike', '--json')).out).error.code).toBe('asset_required');
    expect(JSON.parse((await orion(h, 'job', 'run-now', 'levels', 'mini', '--by', 'mike', '--json')).out).error.code).toBe('asset_not_allowed');
    expect(JSON.parse((await orion(h, 'job', 'run-now', 'bogus', '--by', 'mike', '--json')).out).error.code).toBe('invalid_job_kind');
  });

  it('cli: job list filters by kind and since', async () => {
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-11-02T00:15:00.000Z' });
    await enqueueJob(db(), { kind: 'levels', assetId: null, slot: '2026-11-03T00:15:00.000Z' });
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-11-03T00:45:00.000Z' });
    const h = home();
    const all = JSON.parse((await orion(h, 'job', 'list', '--json')).out) as { id: number }[];
    expect(all.map((j) => j.id)).toEqual([3, 2, 1]);
    const lv = JSON.parse((await orion(h, 'job', 'list', '--kind', 'levels', '--since', '2026-11-03T00:00:00.000Z', '--json')).out) as { id: number }[];
    expect(lv.map((j) => j.id)).toEqual([2]);
    const text = await orion(h, 'job', 'list');
    expect(text.out.split('\n')[0]).toBe('3  refresh  mini  2026-11-03T00:45:00.000Z  queued  0/2');
  });
});

describe('the orion daemon process', () => {
  it('cli: orion daemon starts, a second one refuses with daemon_running, SIGTERM stops it cleanly', async () => {
    const h = home();
    const env = processEnv(h);
    const child = spawn(process.execPath, [...ENTRY, 'daemon'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr!.on('data', (b: Buffer) => { out += b.toString(); });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    await vi.waitFor(async () => expect((await latestHeartbeat(db()))?.state).toBe('running'), { timeout: 30_000, interval: 200 });
    const second = await orionProcess(env, 'daemon');
    expect(second.exit).toBe(1);
    expect(second.stderr).toContain('another orion daemon holds this database');
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect((await latestHeartbeat(db()))?.state).toBe('stopped');
    expect(existsSync(join(h, 'daemon.log'))).toBe(true);
    expect(out).toContain('daemon started');
    // The scheduler ran: the newest slots are queued or done (the stub handlers skip).
    expect((await listJobs(db(), {})).length).toBeGreaterThan(0);
  }, 90_000);
});
