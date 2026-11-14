import type { Command } from 'commander';
import { loadAsset } from '../../config/load.js';
import { parseBackfillParams, pricesBackfillRequest } from '../../daemon/jobs/backfill.js';
import { enqueueJob, JOB_KINDS, listJobs, type BackfillParams, type BackfillPricesParams, type Job, type JobKind } from '../../db/jobs.js';
import { getRegistryRow } from '../../db/registry.js';
import { loadPrices } from '../../prices/config.js';
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

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** Kinds that name an asset. */
const PER_ASSET: readonly JobKind[] = ['refresh', 'backfill'];

/** `job run-now backfill-prices`: a `backfill` job of op `prices` (Phase 3 R2 Task 7), not per asset. */
const BACKFILL_PRICES = 'backfill-prices';

interface RunNowOptions {
  by?: string;
  force?: boolean;
  slot?: string;
  metric: string[];
  backfillDays?: string;
  from?: string;
  to?: string;
  refs?: string;
  json?: boolean;
}

/**
 * `--metric` / `--backfill-days` into a backfill's params, checked against the asset's config the same way the handler
 * checks them (`parseBackfillParams`), so a bad request never reaches the queue. Both options are required for
 * `backfill` and refused for every other kind (`invalid_option`).
 */
function backfillParams(ctx: CliContext, kind: JobKind, asset: string | undefined, opts: RunNowOptions): BackfillParams | null {
  const given = opts.metric.length > 0 || opts.backfillDays !== undefined;
  if (kind !== 'backfill') {
    if (given) throw new OrionError('invalid_option', `--metric and --backfill-days go with job run-now backfill only, not ${kind}`);
    return null;
  }
  if (opts.metric.length === 0) throw new OrionError('invalid_option', 'job run-now backfill needs --metric <key> (repeatable)');
  if (opts.backfillDays === undefined) throw new OrionError('invalid_option', 'job run-now backfill needs --backfill-days <n>');
  const days = /^\d+$/.test(opts.backfillDays.trim()) ? Number(opts.backfillDays) : opts.backfillDays;
  return parseBackfillParams({ op: 'fetch', metrics: opts.metric, backfillDays: days }, loadAsset(ctx.configRoot, asset!).config);
}

/**
 * `--from` / `--to` / `--refs a,b` into a prices backfill's params (`pricesBackfillRequest`, R27): `to` frozen at enqueue
 * (no --to: today, UTC) and stored; an unknown ref, a day after today, from after to or a span over
 * PRICES_BACKFILL_MAX_DAYS (550) is refused before the queue. No asset, --slot, --metric or --backfill-days.
 */
function pricesParams(ctx: CliContext, asset: string | undefined, opts: RunNowOptions): BackfillPricesParams {
  if (asset !== undefined) throw new OrionError('asset_not_allowed', `a prices backfill is not per asset; leave out "${asset}"`);
  if (opts.metric.length > 0 || opts.backfillDays !== undefined || opts.slot !== undefined || opts.force) {
    throw new OrionError('invalid_option', 'job run-now backfill-prices takes --from, --to and --refs only (no --metric, --backfill-days, --slot or --force)');
  }
  if (opts.from === undefined) throw new OrionError('invalid_option', 'job run-now backfill-prices needs --from <YYYY-MM-DD>');
  const raw: Record<string, unknown> = { op: 'prices', from: opts.from };
  if (opts.to !== undefined) raw.to = opts.to;
  if (opts.refs !== undefined) raw.refs = opts.refs.split(',');
  return pricesBackfillRequest(raw, loadPrices(ctx.configRoot), ctx.now());
}

function paramsText(p: BackfillParams | null): string {
  if (p === null) return '';
  if (p.op === 'fetch') return `: ${p.metrics.join(', ')}, ${p.backfillDays} days`;
  return `: prices ${p.from}..${p.to ?? 'today'}, ${p.refs ? `refs ${p.refs.join(', ')}` : 'every ref'}`;
}

export function registerJob(program: Command, ctx: CliContext): void {
  const job = program.command('job').description('the daemon\'s job queue: request a run now, list jobs');

  job
    .command('run-now <kind> [asset]')
    .description(
      'queue a job for the daemon at slot = now (refresh needs an active asset unless --force; nightly_report needs --slot; '
        + 'backfill needs --metric and --backfill-days, any asset state; backfill-prices needs --from, a backfill of op prices)',
    )
    .option('--by <who>', 'who (default $USER)')
    .option('--slot <iso>', 'the slot (nightly_report: required, the scheduled slot to report again, e.g. 2026-11-03T00:45:00Z)')
    .option('--force', 'refresh an asset that is not active')
    .option('--metric <key>', 'backfill: a flow metric to re-scan (repeatable)', collect, [])
    .option('--backfill-days <n>', 'backfill: re-scan this many days back (1-400), ignoring the saved cursor')
    .option('--from <day>', 'backfill-prices: the first UTC day (YYYY-MM-DD) to write chain prices for')
    .option('--to <day>', 'backfill-prices: the last UTC day (default: today, frozen at enqueue); at most 550 days from --from')
    .option('--refs <a,b>', 'backfill-prices: prices.yaml refs, comma-separated (default: every ref)')
    .option('--json', 'JSON output')
    .action((kindText: string, asset: string | undefined, opts: RunNowOptions) =>
      guarded(ctx, opts.json, async () => {
        const prices = kindText === BACKFILL_PRICES;
        if (!prices && (opts.from !== undefined || opts.to !== undefined || opts.refs !== undefined)) {
          throw new OrionError('invalid_option', `--from, --to and --refs go with job run-now ${BACKFILL_PRICES} only, not ${kindText}`);
        }
        const kind = prices ? 'backfill' : jobKind(kindText);
        const by = byOf(opts.by);
        const pricesRequest = prices ? pricesParams(ctx, asset, opts) : null;
        if (!prices && PER_ASSET.includes(kind) && !asset) throw new OrionError('asset_required', `job run-now ${kind} needs an asset`);
        if (!PER_ASSET.includes(kind) && asset) throw new OrionError('asset_not_allowed', `a ${kind} job is not per asset; leave out "${asset}"`);
        // M-2: a nightly at slot = now reports the wrong day, before that day's refreshes, and pings the dead-man off
        // schedule; name the scheduled slot to report again.
        if (kind === 'nightly_report' && opts.slot === undefined) {
          throw new OrionError('slot_required', 'job run-now nightly_report needs --slot <iso> (the scheduled slot to report again, e.g. 2026-11-03T00:45:00Z)');
        }
        if (opts.slot !== undefined && Number.isNaN(Date.parse(opts.slot))) throw new OrionError('invalid_date', `--slot must be an ISO instant, got "${opts.slot}"`);
        const slot = opts.slot === undefined ? ctx.now().toISOString() : new Date(opts.slot).toISOString();
        const params: BackfillParams | null = pricesRequest ?? backfillParams(ctx, kind, asset, opts);
        const queued = await withDb(ctx, async (db) => {
          if (kind === 'refresh' && !opts.force) {
            const row = await getRegistryRow(db, asset!);
            if (row?.state !== 'active') {
              throw new OrionError('asset_not_active', `${asset} is ${row ? row.state : 'not in the registry'}; --force refreshes it anyway`);
            }
          }
          const j = await enqueueJob(db, { kind, assetId: asset ?? null, slot, requestedBy: `run-now:${by}`, releaseTag: ctx.release?.tag ?? null, params });
          if (!j) throw new OrionError('job_exists', `a ${kind}${asset ? ` ${asset}` : ''} job for slot ${slot} already exists`);
          return j;
        });
        const what = paramsText(params);
        output(ctx, opts.json, queued, () => [`queued job ${queued.id} ${queued.kind}${queued.assetId ? ` ${queued.assetId}` : ''} slot ${queued.slot}${what}`]);
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
