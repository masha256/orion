import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { OrionEnv } from '../../src/cli/paths.js';
import { defaultHandlers, type JobContext } from '../../src/daemon/daemon.js';
import {
  DISCLOSURE_WATCH_TIMEOUT_MS, disclosureWatchHandler, makeDisclosureWatchHandler, YTDLP_UPGRADE_EVERY_MS,
} from '../../src/daemon/jobs/disclosureWatch.js';
import type { OrionDb } from '../../src/db/connection.js';
import type { Job } from '../../src/db/jobs.js';
import { FakeClock } from '../helpers/clock.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = '2026-11-03T16:40:00.000Z';
const SECRET_DB = 'postgresql://orion_stage:hunter2@/orion_stage';
const SECRET_KEY = 'sk-ant-test-not-a-real-key';

/**
 * A server layout in a scratch dir: `venv/bin/python` and `venv/bin/pip` are shell fakes that append their argv, the
 * NAMES of their environment and the watcher's three path variables (never a secret's value) to `calls.log`. The fake
 * python prints `venv/stdout.txt`, writes `venv/stderr.txt` to stderr and exits with `venv/exit` (default 0).
 */
function world(): { root: string; venv: string; home: string; configRoot: string; calls(): string[]; set(f: string, s: string): void } {
  const root = mkdtempSync(join(tmpdir(), 'orion-dw-'));
  dirs.push(root);
  const venv = join(root, 'watcher-venv');
  const home = join(root, 'home');
  const configRoot = join(root, 'current');
  mkdirSync(join(venv, 'bin'), { recursive: true });
  mkdirSync(home);
  mkdirSync(join(configRoot, 'tools', 'disclosure-watcher', 'bin'), { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(join(venv, 'bin', 'python'), [
    '#!/bin/sh',
    `v=${JSON.stringify(venv)}`,
    `{ echo "python: $*"; echo "env: $(env | cut -d= -f1 | sort | tr '\\n' ' ')"; echo "paths: base=$ORION_DW_BASE_DIR repo=$ORION_DW_REPO home=$ORION_HOME node=$ORION_NODE"; } >> ${JSON.stringify(log)}`,
    '[ -f "$v/stdout.txt" ] && cat "$v/stdout.txt"',
    '[ -f "$v/stderr.txt" ] && cat "$v/stderr.txt" >&2',
    '[ -f "$v/sleep" ] && exec sleep "$(cat "$v/sleep")"',
    'exit "$(cat "$v/exit" 2>/dev/null || echo 0)"',
    '',
  ].join('\n'));
  writeFileSync(join(venv, 'bin', 'pip'), [
    '#!/bin/sh',
    `v=${JSON.stringify(venv)}`,
    `echo "pip: $*" >> ${JSON.stringify(log)}`,
    'exit "$(cat "$v/pip-exit" 2>/dev/null || echo 0)"',
    '',
  ].join('\n'));
  chmodSync(join(venv, 'bin', 'python'), 0o755);
  chmodSync(join(venv, 'bin', 'pip'), 0o755);
  return {
    root, venv, home, configRoot,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    set: (f, s) => writeFileSync(join(venv, f), s),
  };
}

interface Run { ctx: JobContext; posts: string[]; logs: string[]; clock: FakeClock }

function run(w: ReturnType<typeof world>, env: OrionEnv, over: Record<string, string | undefined> = {}, now = NOW): Run {
  const posts: string[] = [];
  const logs: string[] = [];
  const clock = new FakeClock(now);
  const ctx: JobContext = {
    db: undefined as unknown as OrionDb, clock, env,
    paths: { home: w.home, configRoot: w.configRoot, envFile: join(w.root, 'shared.env'), release: null },
    envVars: { PATH: process.env.PATH, ORION_WATCHER_VENV: w.venv, ORION_DATABASE_URL: SECRET_DB, ANTHROPIC_API_KEY: SECRET_KEY, ...over },
    notify: { post: async (text) => (posts.push(text), { ok: true, attempts: 1 }) },
    signal: new AbortController().signal,
    enqueue: async () => null,
    log: (l) => logs.push(l),
  };
  return { ctx, posts, logs, clock };
}

const job = (id = 1): Job => ({ id, kind: 'disclosure_watch', assetId: null, slot: NOW, status: 'running', attempts: 1, maxAttempts: 1 }) as Job;

/** A fresh yt-dlp stamp, so a test that is not about the upgrade sees no pip call. */
function freshStamp(w: ReturnType<typeof world>, now = NOW): void {
  const stamp = join(w.venv, '.ytdlp-upgraded');
  writeFileSync(stamp, '');
  const t = new Date(Date.parse(now) - DAY);
  utimesSync(stamp, t, t);
}

describe('disclosureWatch', () => {
  it('disclosureWatch: stdout is posted, stage passes --dry-run with the dry queue file, a non-zero exit alerts', async () => {
    expect(DISCLOSURE_WATCH_TIMEOUT_MS).toBe(2 * 3_600_000);
    const w = world();
    freshStamp(w);
    const script = join(w.configRoot, 'tools', 'disclosure-watcher', 'bin', 'disclosure_watch.py');

    // Stage: dry, and the output's alert line comes first in the post.
    w.set('stdout.txt', 'ORION DISCLOSURE lit | LIT investor update 2026Q3 | posted 2026-10-22\nORION DISCLOSURE ALERT lit: download failed for post 1: boom\n');
    const stage = run(w, 'stage');
    const out = await disclosureWatchHandler(job(), stage.ctx);
    expect(out).toMatchObject({ status: 'done', result: { dryRun: true, exitCode: 0, delivered: true } });
    expect(stage.posts).toEqual(['ORION DISCLOSURE ALERT lit: download failed for post 1: boom\nORION DISCLOSURE lit | LIT investor update 2026Q3 | posted 2026-10-22']);
    const dryQueue = join(w.home, 'disclosure', 'dev-queue.dry.md');
    expect(w.calls().filter((l) => l.startsWith('python: '))).toEqual([`python: ${script} scan --orion-home ${w.home} --dry-run --queue-file ${dryQueue}`]);
    expect(w.calls()).toContain(`paths: base=${join(w.home, 'disclosure')} repo=${w.configRoot} home=${w.home} node=${process.execPath}`);
    const names = w.calls().find((l) => l.startsWith('env: '))!.split(' ');
    for (const n of ['ORION_DW_BASE_DIR', 'ORION_DW_REPO', 'ORION_NODE', 'ORION_HOME', 'ORION_DATABASE_URL', 'ANTHROPIC_API_KEY']) expect(names).toContain(n);
    // Secrets reach the child's environment only: never the result, a post or a log line.
    const said = JSON.stringify([out, stage.posts, stage.logs]);
    expect(said).not.toContain('hunter2');
    expect(said).not.toContain(SECRET_KEY);

    // Prod with a key: a real scan (no --dry-run); a quiet run posts nothing.
    rmSync(join(w.venv, 'stdout.txt'));
    rmSync(join(w.root, 'calls.log'));
    const prod = run(w, 'prod');
    expect(await disclosureWatchHandler(job(2), prod.ctx)).toMatchObject({ status: 'done', result: { dryRun: false, exitCode: 0 } });
    expect(prod.posts).toEqual([]);
    expect(w.calls().filter((l) => l.startsWith('python: '))).toEqual([`python: ${script} scan --orion-home ${w.home}`]);

    // A crash: failed, and one ALERT with the last stderr line, capped at 300.
    w.set('exit', '3');
    w.set('stderr.txt', `Traceback (most recent call last):\n  File "x"\nValueError: ${'b'.repeat(400)}\n\n`);
    const crash = run(w, 'prod');
    const failed = await disclosureWatchHandler(job(3), crash.ctx);
    const alert = `ORION ALERT prod disclosure_watch exit 3: ValueError: ${'b'.repeat(400)}`.slice(0, 'ORION ALERT prod disclosure_watch exit 3: '.length + 300);
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/^exit 3: ValueError: b+$/) });
    expect(crash.posts).toEqual([alert]);

    // Output from a crashed run is still posted, after the alert.
    w.set('stdout.txt', 'ORION DISCLOSURE lit | partial\n');
    const both = run(w, 'stage');
    expect(await disclosureWatchHandler(job(4), both.ctx)).toMatchObject({ status: 'failed' });
    expect(both.posts).toHaveLength(2);
    expect(both.posts[0]).toMatch(/^ORION ALERT stage disclosure_watch exit 3: ValueError/);
    expect(both.posts[1]).toBe('ORION DISCLOSURE lit | partial');
  });

  it('disclosureWatch: without Anthropic credentials the scan runs dry; on prod a post says so, on stage it never fails the job', async () => {
    const w = world();
    freshStamp(w);
    w.set('stdout.txt', 'ORION DISCLOSURE lit | LIT investor update 2026Q3\n');
    const prod = run(w, 'prod', { ANTHROPIC_API_KEY: '  ' });
    expect(await disclosureWatchHandler(job(), prod.ctx)).toMatchObject({ status: 'done', result: { dryRun: true, noCredentials: true } });
    expect(w.calls().filter((l) => l.startsWith('python: '))[0]).toContain(' --dry-run --queue-file ');
    expect(prod.posts).toEqual(['ORION ALERT prod disclosure_watch: no Anthropic credentials (ANTHROPIC_API_KEY) in the env file: the scan ran dry, nothing was filed\nORION DISCLOSURE lit | LIT investor update 2026Q3']);
    // An auth token counts as a credential.
    const token = run(w, 'prod', { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: 'tok' });
    expect(await disclosureWatchHandler(job(2), token.ctx)).toMatchObject({ result: { dryRun: false } });
    // Stage has no key: dry anyway, no extra line, done.
    const stage = run(w, 'stage', { ANTHROPIC_API_KEY: undefined });
    expect(await disclosureWatchHandler(job(3), stage.ctx)).toMatchObject({ status: 'done', result: { dryRun: true } });
    expect(stage.posts).toEqual(['ORION DISCLOSURE lit | LIT investor update 2026Q3']);
  });

  it('disclosureWatch: yt-dlp is upgraded at most weekly', async () => {
    expect(YTDLP_UPGRADE_EVERY_MS).toBe(7 * DAY);
    const w = world();
    const stamp = join(w.venv, '.ytdlp-upgraded');
    const pips = (): string[] => w.calls().filter((l) => l.startsWith('pip: '));
    const order = (): string[] => w.calls().filter((l) => /^(pip|python): /.test(l)).map((l) => l.split(':')[0]!);

    // No stamp yet: upgrade first, then the scan; the stamp is the job's time.
    const first = run(w, 'prod');
    expect(await disclosureWatchHandler(job(1), first.ctx)).toMatchObject({ status: 'done', result: { ytdlp: 'upgraded' } });
    expect(pips()).toEqual(['pip: install --upgrade --no-input yt-dlp']);
    expect(order()).toEqual(['pip', 'python']);
    expect(statSync(stamp).mtimeMs).toBe(Date.parse(NOW));

    // 6 days later: no upgrade.
    const later = run(w, 'prod', {}, new Date(Date.parse(NOW) + 6 * DAY).toISOString());
    expect(await disclosureWatchHandler(job(2), later.ctx)).toMatchObject({ result: { ytdlp: 'fresh' } });
    expect(pips()).toHaveLength(1);

    // 7 days and a minute after the stamp: upgraded again.
    const week = new Date(Date.parse(NOW) + 7 * DAY + 60_000).toISOString();
    expect(await disclosureWatchHandler(job(3), run(w, 'prod', {}, week).ctx)).toMatchObject({ result: { ytdlp: 'upgraded' } });
    expect(pips()).toHaveLength(2);
    expect(statSync(stamp).mtimeMs).toBe(Date.parse(week));

    // A failed upgrade: a warning in the result, the scan still runs, the stamp stays (tomorrow tries again).
    w.set('pip-exit', '1');
    const nextWeek = new Date(Date.parse(week) + 8 * DAY).toISOString();
    const fail = run(w, 'prod', {}, nextWeek);
    const out = await disclosureWatchHandler(job(4), fail.ctx);
    expect(out).toMatchObject({ status: 'done', result: { ytdlp: 'failed', warnings: [expect.stringMatching(/^yt-dlp upgrade failed: pip exit 1/)] } });
    expect(order().slice(-2)).toEqual(['pip', 'python']);
    expect(statSync(stamp).mtimeMs).toBe(Date.parse(week));
    expect(fail.posts).toEqual([]);

    // No venv: python3 from PATH runs the scan, and there is nothing to upgrade.
    const bare = world();
    const ctx = run(bare, 'prod', { ORION_WATCHER_VENV: join(bare.root, 'no-venv') }).ctx;
    const fakeBin = join(bare.root, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'python3'), `#!/bin/sh\necho "python3: $*" >> ${JSON.stringify(join(bare.root, 'calls.log'))}\n`);
    chmodSync(join(fakeBin, 'python3'), 0o755);
    ctx.envVars.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;
    expect(await disclosureWatchHandler(job(5), ctx)).toMatchObject({ status: 'done', result: { ytdlp: 'no venv' } });
    expect(bare.calls()).toEqual([`python3: ${join(bare.configRoot, 'tools', 'disclosure-watcher', 'bin', 'disclosure_watch.py')} scan --orion-home ${bare.home}`]);
  });

  it('disclosureWatch: a scan past the timeout is killed and alerts; the handler is wired', async () => {
    const w = world();
    freshStamp(w);
    w.set('sleep', '30');
    const r = run(w, 'prod');
    const started = Date.now();
    const out = await makeDisclosureWatchHandler({ timeoutMs: 300 })(job(), r.ctx);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toMatchObject({ status: 'failed', error: 'timed out after 300 ms' });
    expect(r.posts).toEqual(['ORION ALERT prod disclosure_watch exit timeout: timed out after 300 ms']);
    expect(defaultHandlers().disclosure_watch).toBe(disclosureWatchHandler);
  });
});
