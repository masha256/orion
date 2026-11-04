import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { splitForSlack } from '../../notify/format.js';
import type { JobContext, JobHandler, JobOutcome } from '../daemon.js';

/** The longest a scan may run (one post's download, ASR and analyst run fit well inside it). */
export const DISCLOSURE_WATCH_TIMEOUT_MS = 2 * 3_600_000;
/** The venv's yt-dlp is upgraded when its stamp is at least this old: X changes its player often. */
export const YTDLP_UPGRADE_EVERY_MS = 7 * 86_400_000;
const YTDLP_STAMP = '.ytdlp-upgraded';
const PIP_TIMEOUT_MS = 10 * 60_000;
/** After SIGTERM to the scan's process group, SIGKILL this much later. */
const KILL_GRACE_MS = 10_000;
const STDERR_LINE_MAX = 300;
const ALERT_PREFIX = 'ORION DISCLOSURE ALERT';
const OUTPUT_KEEP = 4000;

export interface DisclosureWatchOptions {
  timeoutMs?: number;
}

export interface DisclosureWatchResult {
  dryRun: boolean;
  /** Set when the scan ran dry only because no Anthropic credential was in the env (never on stage). */
  noCredentials?: boolean;
  exitCode: number | null;
  ytdlp: 'fresh' | 'upgraded' | 'failed' | 'no venv';
  warnings: string[];
  posts: number;
  delivered: boolean;
  /** The scan's stdout, kept (capped) when a post was not delivered. */
  undelivered?: string;
}

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

/** Anthropic credentials: never in a staging watcher's environment (it never starts a paid run). */
const ANTHROPIC_VARS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

/**
 * The env the watcher and pip run with: the job's env (the process env over `.env`), without unset values; on stage
 * without the Anthropic credentials, whatever the .env holds.
 */
function childEnv(ctx: JobContext, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.envVars)) if (v !== undefined && !(ctx.env === 'stage' && ANTHROPIC_VARS.has(k))) out[k] = v;
  return { ...out, ...extra };
}

/** Stage's dry scans remember the posts they processed here, so each is reported once, not every scan day. */
export const DRY_STATE_FILE = join('state', 'dry-seen.json');

/**
 * Runs `cmd args` in its own process group (the watcher starts yt-dlp, ffmpeg and node): on the timeout or an abort
 * the whole group gets SIGTERM, then SIGKILL after 10 s. Never rejects.
 */
function runProcess(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number, signal: AbortSignal): Promise<Exit> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(cmd, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const stop = (): void => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    let spawnError: string | undefined;
    child.on('error', (err) => {
      spawnError = err.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code: spawnError !== undefined && code === null ? 127 : code, stdout, stderr: spawnError ? `${stderr}\n${spawnError}` : stderr, timedOut, aborted, spawnError });
    });
  });
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return (lines.at(-1) ?? '').slice(0, STDERR_LINE_MAX);
}

/**
 * Weekly `pip install --upgrade yt-dlp` in the venv, before the scan. The stamp `<venv>/.ytdlp-upgraded` is touched
 * (to the job's time) only after a successful upgrade, so a failure is tried again the next day.
 */
async function upgradeYtDlp(ctx: JobContext, venv: string, warnings: string[]): Promise<DisclosureWatchResult['ytdlp']> {
  const pip = join(venv, 'bin', 'pip');
  if (!existsSync(pip)) return 'no venv';
  const stamp = join(venv, YTDLP_STAMP);
  const now = ctx.clock.now();
  if (existsSync(stamp) && now.getTime() - statSync(stamp).mtimeMs < YTDLP_UPGRADE_EVERY_MS) return 'fresh';
  const r = await runProcess(pip, ['install', '--upgrade', '--no-input', 'yt-dlp'], childEnv(ctx), PIP_TIMEOUT_MS, ctx.signal);
  if (r.code !== 0) {
    const why = r.timedOut ? `timed out after ${PIP_TIMEOUT_MS} ms` : `pip exit ${r.code}: ${lastLine(r.stderr)}`;
    warnings.push(`yt-dlp upgrade failed: ${why}`.trimEnd());
    ctx.log(`disclosure_watch: yt-dlp upgrade failed (${why}); the scan runs with the installed one`);
    return 'failed';
  }
  writeFileSync(stamp, '');
  utimesSync(stamp, now, now);
  ctx.log('disclosure_watch: yt-dlp upgraded');
  return 'upgraded';
}

/** Alert lines first (in their order), then the rest: a Slack preview then shows the alert. */
function alertFirst(stdout: string): string[] {
  const lines = stdout.replace(/\n+$/, '').split('\n');
  return [...lines.filter((l) => l.startsWith(ALERT_PREFIX)), ...lines.filter((l) => !l.startsWith(ALERT_PREFIX))];
}

/**
 * The daily `disclosure_watch` job: runs the watcher's `scan` (`tools/disclosure-watcher` of the running release) with
 * the venv's Python (`$ORION_WATCHER_VENV`, default `~/watcher-venv`; `python3` from PATH when it has none). State,
 * log and transcripts go to `<ORION_HOME>/disclosure`. Stage always runs dry (`--dry-run`, findings to
 * `<home>/disclosure/dev-queue.dry.md`, seen posts in `<home>/disclosure/state/dry-seen.json`) and never gets an
 * Anthropic credential; so does an env with no Anthropic credential (the analyst cannot run; on prod
 * a post says so). Its stdout is the Slack message; a non-zero exit fails the job with an ORION ALERT.
 */
export function makeDisclosureWatchHandler(opts: DisclosureWatchOptions = {}): JobHandler {
  const timeoutMs = opts.timeoutMs ?? DISCLOSURE_WATCH_TIMEOUT_MS;
  return async (_job, ctx): Promise<JobOutcome> => {
    const home = ctx.paths.home;
    const base = join(home, 'disclosure');
    mkdirSync(base, { recursive: true });
    const venv = ctx.envVars.ORION_WATCHER_VENV?.trim() || join(homedir(), 'watcher-venv');
    const venvPython = join(venv, 'bin', 'python');
    const python = existsSync(venvPython) ? venvPython : 'python3';
    const script = join(ctx.paths.configRoot, 'tools', 'disclosure-watcher', 'bin', 'disclosure_watch.py');
    const hasCredentials = [ctx.envVars.ANTHROPIC_API_KEY, ctx.envVars.ANTHROPIC_AUTH_TOKEN].some((v) => (v ?? '').trim() !== '');
    const dryRun = ctx.env === 'stage' || !hasCredentials;
    const noCredentials = ctx.env !== 'stage' && !hasCredentials;

    const warnings: string[] = [];
    const ytdlp = await upgradeYtDlp(ctx, venv, warnings);

    const args = [script, 'scan', '--orion-home', home];
    if (dryRun) args.push('--dry-run', '--queue-file', join(base, 'dev-queue.dry.md'));
    if (ctx.env === 'stage') args.push('--dry-state', join(base, DRY_STATE_FILE));
    ctx.log(`disclosure_watch: ${dryRun ? 'dry ' : ''}scan with ${python}`);
    const r = await runProcess(python, args, childEnv(ctx, {
      ORION_DW_BASE_DIR: base, ORION_DW_REPO: ctx.paths.configRoot, ORION_NODE: process.execPath, ORION_HOME: home,
    }), timeoutMs, ctx.signal);

    const failure = r.timedOut ? `timed out after ${timeoutMs} ms` : r.code !== 0 ? `exit ${r.code}: ${lastLine(r.stderr)}` : null;
    const texts: string[] = [];
    if (failure !== null) {
      texts.push(r.timedOut
        ? `ORION ALERT ${ctx.env} disclosure_watch exit timeout: ${failure}`
        : `ORION ALERT ${ctx.env} disclosure_watch exit ${r.code}: ${lastLine(r.stderr)}`);
    }
    if (r.stdout.trim() !== '') {
      const lines = alertFirst(r.stdout);
      if (noCredentials) lines.unshift(`ORION ALERT ${ctx.env} disclosure_watch: no Anthropic credentials (ANTHROPIC_API_KEY) in the env file: the scan ran dry, nothing was filed`);
      texts.push(...splitForSlack([lines]));
    }
    let delivered = true;
    for (const text of texts) {
      if (ctx.signal.aborted) break;
      const res = await ctx.notify.post(text);
      if (!res.ok) delivered = false;
    }
    if (ctx.signal.aborted) delivered = false;
    const result: DisclosureWatchResult = {
      dryRun, ...(noCredentials ? { noCredentials } : {}), exitCode: r.code, ytdlp, warnings, posts: texts.length, delivered,
      ...(!delivered && r.stdout.trim() !== '' ? { undelivered: r.stdout.slice(0, OUTPUT_KEEP) } : {}),
    };
    if (!delivered) ctx.log('disclosure_watch: a post was not delivered; the output is kept in the result');
    if (failure !== null) return { status: 'failed', result, error: failure };
    return { status: 'done', result };
  };
}

export const disclosureWatchHandler: JobHandler = makeDisclosureWatchHandler();
