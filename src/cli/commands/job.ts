import type { Command } from 'commander';
import { enqueueJob, JOB_KINDS, listJobs, type Job, type JobKind } from '../../db/jobs.js';
import { getRegistryRow } from '../../db/registry.js';
import { OrionError } from '../../types.js';
import { guarded, output, withDb, type CliContext } from '../util.js';
import { byOf } from './asset.js';

function jobKind(text: string): JobKind {
  if (!(JOB_KINDS as readonly string[]).includes(text)) throw new OrionError('invalid_job_kind', `job kind must be one of ${JOB_KINDS.join(', ')}, got "${text}"`);
  return text as JobKind;
}

function jobLine(j: Job): string {
  const err = j.lastError ? `  ${j.lastError}` : '';
  return `${j.id}  ${j.kind}  ${j.assetId ?? '-'}  ${j.slot}  ${j.status}  ${j.attempts}/${j.maxAttempts}${err}`;
}

export function registerJob(program: Command, ctx: CliContext): void {
  const job = program.command('job').description('the daemon\'s job queue: request a run now, list jobs');

  job
    .command('run-now <kind> [asset]')
    .description('queue a job for the daemon at slot = now (refresh needs an active asset unless --force)')
    .option('--by <who>', 'who (default $USER)')
    .option('--force', 'refresh an asset that is not active')
    .option('--json', 'JSON output')
    .action((kindText: string, asset: string | undefined, opts: { by?: string; force?: boolean; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const kind = jobKind(kindText);
        const by = byOf(opts.by);
        if (kind === 'refresh' && !asset) throw new OrionError('asset_required', 'job run-now refresh needs an asset');
        if (kind !== 'refresh' && asset) throw new OrionError('asset_not_allowed', `a ${kind} job is not per asset; leave out "${asset}"`);
        const slot = ctx.now().toISOString();
        const queued = await withDb(ctx, async (db) => {
          if (kind === 'refresh' && !opts.force) {
            const row = await getRegistryRow(db, asset!);
            if (row?.state !== 'active') {
              throw new OrionError('asset_not_active', `${asset} is ${row ? row.state : 'not in the registry'}; --force refreshes it anyway`);
            }
          }
          const j = await enqueueJob(db, { kind, assetId: asset ?? null, slot, requestedBy: `run-now:${by}`, releaseTag: ctx.release?.tag ?? null });
          if (!j) throw new OrionError('job_exists', `a ${kind}${asset ? ` ${asset}` : ''} job for slot ${slot} already exists`);
          return j;
        });
        output(ctx, opts.json, queued, () => [`queued job ${queued.id} ${queued.kind}${queued.assetId ? ` ${queued.assetId}` : ''} slot ${queued.slot}`]);
      }),
    );

  job
    .command('list')
    .description('jobs, newest slot first (100 at most)')
    .option('--since <iso>', 'slots at or after this instant')
    .option('--kind <kind>', 'one kind only')
    .option('--json', 'JSON output')
    .action((opts: { since?: string; kind?: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const kind = opts.kind === undefined ? undefined : jobKind(opts.kind);
        if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since))) throw new OrionError('invalid_date', `--since must be an ISO instant, got "${opts.since}"`);
        const since = opts.since === undefined ? undefined : new Date(opts.since).toISOString();
        const jobs = await withDb(ctx, (db) => listJobs(db, { since, kind }));
        output(ctx, opts.json, jobs, () => (jobs.length > 0 ? jobs.map(jobLine) : ['no jobs']));
      }),
    );
}
