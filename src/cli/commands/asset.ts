import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { loadSchedule } from '../../daemon/schedule.js';
import { listRegistry, type RegistryRow } from '../../db/registry.js';
import { activateAsset, pauseAsset, resumeAsset, seedRegistry } from '../../registry/actions.js';
import { loadAssetYamls, planReconcile, type RegistryDiff } from '../../registry/reconcile.js';
import { OrionError } from '../../types.js';
import { guarded, output, withDb, type CliContext } from '../util.js';

/** Who a registry change is recorded as: `--by`, else the login user. */
function byOf(by: string | undefined): string {
  const who = (by ?? process.env.USER ?? '').trim();
  if (who === '') throw new OrionError('by_required', 'who made the change is required (--by <who>; $USER is not set)');
  return who;
}

function registryLine(r: RegistryRow): string {
  const why = r.stateReason ? `: ${r.stateReason}` : '';
  const last = r.lastRunAt ? `${r.lastRunAt}${r.lastOutcome ? ` ${r.lastOutcome}` : ''} (job ${r.lastJobId ?? '?'})` : 'never';
  return `${r.assetId}  ${r.state}  since ${r.stateSince.slice(0, 10)} by ${r.stateBy}${why}  last run ${last}`;
}

function diffLines(d: RegistryDiff): string[] {
  const lines = [
    ...(d.added.length > 0 ? [`new (arrive inactive): ${d.added.join(', ')}`] : []),
    ...(d.missing.length > 0 ? [`YAML gone (become missing): ${d.missing.join(', ')}`] : []),
    ...(d.returned.length > 0 ? [`YAML back (return inactive): ${d.returned.join(', ')}`] : []),
    ...(d.configChanged.length > 0 ? [`config changed: ${d.configChanged.join(', ')}`] : []),
  ];
  return lines.length > 0 ? lines : ['registry matches the YAML'];
}

export function registerAsset(program: Command, ctx: CliContext): void {
  const asset = program.command('asset').description('inspect and validate asset configs (edit the YAML files directly)');

  asset
    .command('list')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      const ids = listAssetIds(ctx.configRoot);
      output(ctx, opts.json, ids, () => (ids.length > 0 ? ids : ['no assets found in assets/']));
    });

  asset
    .command('show <id>')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      const loaded = loadAsset(ctx.configRoot, id);
      const c = loaded.config;
      output(ctx, opts.json, loaded, () => [
        `${c.symbol}  ${c.name}  (${c.id})`,
        `config hash ${loaded.hash}`,
        `metrics: ${Object.keys(c.metrics).join(', ')}`,
        `holder flows: ${c.holder_flows.map((f) => `${f.id} [${f.kind}, ${f.capture_rule}, ${f.recipient_base}]`).join('; ')}`,
      ]);
    });

  asset
    .command('validate [id]')
    .description('check asset YAMLs (and, without an id, schedule.yaml)')
    .option('--json', 'JSON output')
    .action((id: string | undefined, opts: { json?: boolean }) => {
      const check = (name: string, fn: () => unknown): { id: string; errors: string[] } => {
        try {
          fn();
          return { id: name, errors: [] };
        } catch (err) {
          if (err instanceof OrionError) return { id: name, errors: err.message.split('\n') };
          throw err;
        }
      };
      const results = (id ? [id] : listAssetIds(ctx.configRoot)).map((assetId) => check(assetId, () => loadAsset(ctx.configRoot, assetId)));
      // Without an id, the release's schedule.yaml too, when there is one (the daemon refuses to start on a bad one).
      // parseSchedule checks every entry and override whatever the env.
      if (!id && existsSync(join(ctx.configRoot, 'schedule.yaml'))) results.push(check('schedule.yaml', () => loadSchedule(ctx.configRoot, 'prod')));
      output(ctx, opts.json, results, () =>
        results.flatMap((r) => (r.errors.length === 0 ? [`${r.id}: ok`] : [`${r.id}:`, ...r.errors.map((e) => `  ${e}`)])),
      );
      const failed = results.filter((r) => r.errors.length > 0).map((r) => r.id);
      if (failed.length > 0) throw new OrionError('validation_failed', `validation failed for: ${failed.join(', ')}`);
    });

  asset
    .command('pause <id>')
    .description('stop running an asset from its next job (the registry; a running job finishes)')
    .option('--reason <text>', 'why (required)')
    .option('--by <who>', 'who (default $USER)')
    .option('--json', 'JSON output')
    .action((id: string, opts: { reason?: string; by?: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const by = byOf(opts.by);
        const r = await withDb(ctx, (db) => pauseAsset(db, id, { reason: opts.reason ?? '', by, now: ctx.now(), releaseTag: ctx.release?.tag ?? null }));
        output(ctx, opts.json, r, () => [`${id.toUpperCase()} paused (was ${r.from}): ${r.row.stateReason}`]);
      }),
    );

  asset
    .command('resume <id>')
    .description('end a pause: the asset returns to the state it was paused from (active or inactive)')
    .option('--by <who>', 'who (default $USER)')
    .option('--json', 'JSON output')
    .action((id: string, opts: { by?: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const by = byOf(opts.by);
        const r = await withDb(ctx, (db) => resumeAsset(db, id, { by, now: ctx.now(), releaseTag: ctx.release?.tag ?? null, configRoot: ctx.configRoot }));
        output(ctx, opts.json, r, () => [
          r.state !== 'active' ? `${id.toUpperCase()} ${r.state} (was paused ${r.pausedDays} days): asset activate starts it` :
          `${id.toUpperCase()} active (was paused ${r.pausedDays} days): flows backfill from their cursors` +
            (r.refillShort ? `; API series refill only ${r.backfillDays} days, so ${r.pausedDays - r.backfillDays!} paused days stay empty` : ''),
        ]);
      }),
    );

  asset
    .command('activate <id>')
    .description('start running an inactive asset (a new asset arrives inactive)')
    .option('--by <who>', 'who (default $USER)')
    .option('--json', 'JSON output')
    .action((id: string, opts: { by?: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const by = byOf(opts.by);
        const r = await withDb(ctx, (db) => activateAsset(db, id, { by, now: ctx.now(), releaseTag: ctx.release?.tag ?? null }));
        output(ctx, opts.json, r, () => [`${id.toUpperCase()} active (was ${r.from})`]);
      }),
    );

  const registry = asset
    .command('registry')
    .description('what runs: each asset\'s state, since when, by whom and why, and its last run')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const rows = await withDb(ctx, (db) => listRegistry(db));
        output(ctx, opts.json, rows, () => (rows.length > 0 ? rows.map(registryLine) : ['the asset registry is empty']));
      }),
    );

  registry
    .command('diff')
    .description('what the next reconcile would change, against the YAML in the config root (writes nothing)')
    .option('--json', 'JSON output')
    .action((_opts: unknown, cmd: Command) => {
      // `--json` is also an option of `asset registry`, which takes it before this sub-command sees it.
      const opts = cmd.optsWithGlobals<{ json?: boolean }>();
      return guarded(ctx, opts.json, async () => {
        const yamls = loadAssetYamls(ctx.configRoot);
        const diff = planReconcile(await withDb(ctx, (db) => listRegistry(db)), yamls);
        output(ctx, opts.json, diff, () => diffLines(diff));
      });
    });

  registry
    .command('seed')
    .description('cutover: an active row for every YAML that has no row yet; existing rows are left alone')
    .option('--reason <text>', 'why (required)')
    .option('--by <who>', 'who (required)')
    .option('--json', 'JSON output')
    .action((_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ reason?: string; by?: string; json?: boolean }>();
      return guarded(ctx, opts.json, async () => {
        if (!opts.reason?.trim()) throw new OrionError('reason_required', 'a reason is required (--reason <text>)');
        if (!opts.by?.trim()) throw new OrionError('by_required', 'who seeds the registry is required (--by <who>)');
        const r = await withDb(ctx, (db) =>
          seedRegistry(db, ctx.configRoot, { state: 'active', by: opts.by!.trim(), reason: opts.reason!, now: ctx.now(), releaseTag: ctx.release?.tag ?? null }),
        );
        output(ctx, opts.json, r, () =>
          r.seeded.length > 0
            ? [`seeded active: ${r.seeded.join(', ')}`, ...(r.existing.length > 0 ? [`already in the registry: ${r.existing.join(', ')}`] : [])]
            : [`nothing to seed: every YAML has a registry row (${r.existing.join(', ')})`],
        );
      });
    });
}
