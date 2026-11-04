import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import type { AssetConfig } from '../../config/schema.js';
import { loadSchedule, nextSlot } from '../../daemon/schedule.js';
import { migrationStatus } from '../../db/pg/migrate.js';
import { listRegistry, type RegistryRow } from '../../db/registry.js';
import { activateAsset, pauseAsset, resumeAsset, seedRegistry } from '../../registry/actions.js';
import { loadAssetYamls, planReconcile, reconcileFromDisk, type RegistryDiff } from '../../registry/reconcile.js';
import { listingBar } from '../../report/incomeStatement.js';
import { OrionError } from '../../types.js';
import { loadEnv } from '../env.js';
import { orionEnv } from '../paths.js';
import { guarded, output, withDb, type CliContext } from '../util.js';

/** Who a registry change (or a requested job) is recorded as: `--by`, else the login user. */
export function byOf(by: string | undefined): string {
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

/** The next nightly slot from now (ISO), or null when the config root has no schedule.yaml or no nightly entry. */
function nextNightly(ctx: CliContext): string | null {
  if (!existsSync(join(ctx.configRoot, 'schedule.yaml'))) return null;
  const nightly = loadSchedule(ctx.configRoot, orionEnv(loadEnv(ctx.envFile, process.env))).find((e) => e.key === 'nightly');
  return nightly ? nextSlot(nightly.cadence, ctx.now()).toISOString() : null;
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
      type Result = { id: string; errors: string[]; listingBar?: ReturnType<typeof listingBar> };
      /** `fn` returns the loaded asset config (schedule.yaml: null). */
      const check = (name: string, fn: () => AssetConfig | null): Result => {
        try {
          const config = fn();
          // The listing bar (D6) is reported, never an error: it gates new listings (AERO, HYPE and PUMP fail it today).
          return config?.income_statement ? { id: name, errors: [], listingBar: listingBar(config) } : { id: name, errors: [] };
        } catch (err) {
          if (err instanceof OrionError) return { id: name, errors: err.message.split('\n') };
          throw err;
        }
      };
      const results: Result[] = (id ? [id] : listAssetIds(ctx.configRoot)).map((assetId) => check(assetId, () => loadAsset(ctx.configRoot, assetId).config));
      // Without an id, the release's schedule.yaml too, when there is one (the daemon refuses to start on a bad one).
      // parseSchedule checks every entry and override whatever the env.
      if (!id && existsSync(join(ctx.configRoot, 'schedule.yaml'))) results.push(check('schedule.yaml', () => (loadSchedule(ctx.configRoot, 'prod'), null)));
      output(ctx, opts.json, results, () =>
        results.flatMap((r) => {
          if (r.errors.length > 0) return [`${r.id}:`, ...r.errors.map((e) => `  ${e}`)];
          const bar = r.listingBar;
          if (!bar) return [`${r.id}: ok`];
          return [`${r.id}: ok`, `  listing bar (D6): ${bar.ok ? 'ok' : `fails: ${bar.failing.map((f) => `${f.line} (${f.sourceType ?? 'no source'})`).join(', ')}`}`];
        }),
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
        // A nightly slot that began before the activation has no refresh for this asset (the daemon skips it).
        const firstRefresh = nextNightly(ctx);
        const runNow = `orion job run-now refresh ${id}`;
        output(ctx, opts.json, { ...r, firstRefresh, runNow }, () => [
          `${id.toUpperCase()} active (was ${r.from})`,
          firstRefresh ? `first nightly refresh at ${firstRefresh}; to refresh now: ${runNow}` : `to refresh now: ${runNow}`,
        ]);
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
        // Read-only, so a schema behind this build is fine (I-6): orion-remote install runs the diff of a release whose
        // migrations switch has not applied yet. The registry table may not exist at all yet: then it is empty.
        const { rows, pending } = await withDb(
          ctx,
          async (db) => {
            const status = await migrationStatus(db);
            const has = await db.one("SELECT 1 AS x FROM pg_tables WHERE schemaname = $1 AND tablename = 'asset_registry'", [db.schema]);
            return { rows: has ? await listRegistry(db) : [], pending: status.pending.map((p) => p.id) };
          },
          { checkSchema: false },
        );
        const diff = planReconcile(rows, yamls);
        const shown = pending.length > 0 ? { ...diff, schemaPending: pending } : diff;
        output(ctx, opts.json, shown, () => [...diffLines(diff), ...(pending.length > 0 ? [`(schema behind this build: migration(s) ${pending.join(', ')} pending)`] : [])]);
      });
    });

  registry
    .command('reconcile')
    .description('apply what the daemon applies at start-up (registry diff); retiring every asset or more than 2 at once needs --allow-retire')
    .option('--allow-retire', 'accept a reconcile that retires every asset, or more than 2 at once (refused otherwise)')
    .option('--json', 'JSON output')
    .action((_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ allowRetire?: boolean; json?: boolean }>();
      return guarded(ctx, opts.json, async () => {
        const diff = await withDb(ctx, (db) =>
          reconcileFromDisk(db, ctx.configRoot, ctx.release?.tag ?? null, ctx.now(), { allowRetire: opts.allowRetire === true }),
        );
        output(ctx, opts.json, diff, () => diffLines(diff));
      });
    });

  registry
    .command('seed [ids...]')
    .description('cutover only: an active row for each YAML named (or --all), into an empty registry; refused once any row exists')
    .option('--all', 'every YAML in the config root')
    .option('--reason <text>', 'why (required)')
    .option('--by <who>', 'who (required)')
    .option('--json', 'JSON output')
    .action((ids: string[], _opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ all?: boolean; reason?: string; by?: string; json?: boolean }>();
      return guarded(ctx, opts.json, async () => {
        if (opts.all === true && ids.length > 0) throw new OrionError('seed_ids_required', 'name the assets to seed or give --all, not both');
        if (opts.all !== true && ids.length === 0) throw new OrionError('seed_ids_required', 'name the assets to seed, or --all');
        if (!opts.reason?.trim()) throw new OrionError('reason_required', 'a reason is required (--reason <text>)');
        if (!opts.by?.trim()) throw new OrionError('by_required', 'who seeds the registry is required (--by <who>)');
        const r = await withDb(ctx, (db) =>
          seedRegistry(db, ctx.configRoot, {
            ids: opts.all === true ? 'all' : ids, state: 'active', by: opts.by!.trim(), reason: opts.reason!, now: ctx.now(), releaseTag: ctx.release?.tag ?? null,
          }),
        );
        output(ctx, opts.json, r, () => [r.seeded.length > 0 ? `seeded active: ${r.seeded.join(', ')}` : 'nothing to seed: the config root has no asset YAML']);
      });
    });
}
