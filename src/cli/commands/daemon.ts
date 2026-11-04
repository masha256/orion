import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Command } from 'commander';
import { activeAssetIds, Daemon, defaultHandlers, realClock } from '../../daemon/daemon.js';
import { daemonLog } from '../../daemon/log.js';
import { loadSchedule, nextSlot, type ScheduleEntry } from '../../daemon/schedule.js';
import { realSpawn, systemdNotifier } from '../../daemon/systemd.js';
import { openDb } from '../../db/connection.js';
import { clearDrain, getHeartbeat, latestHeartbeat, requestDrain, type HeartbeatRow } from '../../db/heartbeat.js';
import { getJob, listJobs } from '../../db/jobs.js';
import { listRegistry } from '../../db/registry.js';
import { slackNotifier } from '../../notify/slack.js';
import { OrionError } from '../../types.js';
import { loadEnv } from '../env.js';
import { orionEnv, type OrionEnv } from '../paths.js';
import { databaseFor, guarded, output, withDb, type CliContext } from '../util.js';

/** How often `daemon drain` re-reads the heartbeat. */
const DRAIN_POLL_MS = 2_000;

/** `<n>ms`, `<n>s`, `<n>m` or `<n>h`. */
export function parseDuration(text: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text.trim());
  if (!m) throw new OrionError('invalid_duration', `a duration is <n>ms, <n>s, <n>m or <n>h (e.g. 30m), got "${text}"`);
  return Number(m[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
}

function envOf(ctx: CliContext): OrionEnv {
  return orionEnv(loadEnv(ctx.envFile, process.env));
}

/** The schedule's next slot per entry; none when the config root has no schedule.yaml. */
function nextSlots(ctx: CliContext, env: OrionEnv): { key: string; slot: string }[] {
  let entries: ScheduleEntry[];
  try {
    entries = loadSchedule(ctx.configRoot, env);
  } catch (err) {
    if (err instanceof OrionError && err.code === 'schedule_missing') return [];
    throw err;
  }
  const now = ctx.now();
  return entries.map((e) => ({ key: e.key, slot: nextSlot(e.cadence, now).toISOString() }));
}

function heartbeatLine(h: HeartbeatRow | null): string {
  if (!h) return 'daemon: never ran on this database';
  const job = h.currentJobId === null ? 'idle' : `running job ${h.currentJobId}`;
  const drain = h.drainRequestedAt ? `, drain requested ${h.drainRequestedAt}` : '';
  return `daemon ${h.daemonId} (pid ${h.pid} on ${h.host}, release ${h.releaseTag ?? '(dev checkout)'}): ${h.state}, ${job}, beat ${h.beatAt}${drain}`;
}

/** Runs the daemon in this process until SIGTERM or SIGINT (the systemd unit's `ExecStart`). */
async function runDaemon(ctx: CliContext): Promise<void> {
  const env = envOf(ctx);
  const log = daemonLog(ctx.home);
  const db = await openDb(databaseFor(ctx), { max: 4 });
  // The clock's timers do not hold the process open; this does, until the daemon has stopped.
  const keepAlive = setInterval(() => undefined, 1 << 30);
  const daemon = new Daemon({
    db, clock: realClock, env, paths: { home: ctx.home, configRoot: ctx.configRoot, envFile: ctx.envFile, release: ctx.release },
    handlers: defaultHandlers(),
    notifier: (vars) => slackNotifier({ webhookUrl: vars.SLACK_WEBHOOK_URL, fetch: globalThis.fetch, sleep: realClock.sleep, log }),
    systemd: systemdNotifier(realSpawn), log, daemonId: `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`,
    activeAssets: activeAssetIds,
  });
  const stop = (): void => daemon.requestStop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await daemon.start();
    await daemon.run();
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    clearInterval(keepAlive);
    await db.close();
  }
}

export function registerDaemon(program: Command, ctx: CliContext): void {
  const daemon = program
    .command('daemon')
    .description('run the scheduler and the job worker in the foreground (the orion-daemon systemd unit); see also drain, undrain, status')
    .action(() => runDaemon(ctx));

  daemon
    .command('drain')
    .description('ask the running daemon to finish its current job and claim nothing more; waits until it reports drained')
    .option('--wait <duration>', 'how long to wait (e.g. 90s, 30m)', '30m')
    .option('--json', 'JSON output')
    .action((_o: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ wait: string; json?: boolean }>();
      return guarded(ctx, opts.json, async () => {
        const waitMs = parseDuration(opts.wait);
        const result = await withDb(ctx, async (db) => {
          const id = await requestDrain(db, ctx.now());
          if (id === null) throw new OrionError('no_daemon', 'no daemon is running on this database (every heartbeat row is stopped)');
          const deadline = Date.now() + waitMs;
          for (;;) {
            const h = await getHeartbeat(db, id);
            if (!h || h.state === 'drained' || h.state === 'stopped') return { daemonId: id, state: h?.state ?? 'gone' };
            const left = deadline - Date.now();
            if (left <= 0) {
              const job = h.currentJobId === null ? null : await getJob(db, h.currentJobId);
              throw new OrionError(
                'drain_timeout',
                job ? `drain timed out; still running job ${job.id} ${job.kind} ${job.assetId ?? '-'}` : `drain timed out; daemon ${id} is ${h.state}`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(DRAIN_POLL_MS, left)));
          }
        });
        output(ctx, opts.json, result, () => [`daemon ${result.daemonId} ${result.state}`]);
      });
    });

  daemon
    .command('undrain')
    .description('withdraw a drain request: the daemon claims jobs again (a failed switch resumes the old daemon)')
    .option('--json', 'JSON output')
    .action((_o: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ json?: boolean }>();
      return guarded(ctx, opts.json, async () => {
        const cleared = await withDb(ctx, (db) => clearDrain(db));
        output(ctx, opts.json, { cleared }, () => [cleared > 0 ? `drain request cleared (${cleared} daemon)` : 'no drain request was set']);
      });
    });

  daemon
    .command('status')
    .description('the daemon heartbeat, release, registry, last 10 jobs and the next slots')
    .option('--json', 'JSON output')
    .action((_o: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ json?: boolean }>();
      return guarded(ctx, opts.json, async () => {
        const env = envOf(ctx);
        const next = nextSlots(ctx, env);
        const s = await withDb(ctx, async (db) => ({
          env,
          heartbeat: await latestHeartbeat(db),
          release: ctx.release,
          registry: await listRegistry(db),
          last_jobs: await listJobs(db, { limit: 10 }),
          next,
        }));
        output(ctx, opts.json, s, () => [
          `env ${s.env}, release ${s.release?.tag ?? '(dev checkout)'}`,
          heartbeatLine(s.heartbeat),
          `registry: ${s.registry.length === 0 ? 'empty' : s.registry.map((r) => `${r.assetId} ${r.state}`).join(', ')}`,
          'last jobs:',
          ...(s.last_jobs.length === 0 ? ['  none'] : s.last_jobs.map((j) => `  ${j.id} ${j.kind} ${j.assetId ?? '-'} ${j.slot} ${j.status}`)),
          'next:',
          ...s.next.map((n) => `  ${n.key} ${n.slot}`),
        ]);
      });
    });
}
