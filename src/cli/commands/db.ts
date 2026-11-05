import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { openDb } from '../../db/connection.js';
import { applyMigrations, migrationStatus, type MigrationStatus } from '../../db/pg/migrate.js';
import { checkSingleStatement, queryReadOnly, urlForRole } from '../../db/queryRo.js';
import { backfillProvenance, type BackfillResult } from '../../provenance/backfill.js';
import { OrionError } from '../../types.js';
import { databaseFor, guarded, output, withDb, type CliContext } from '../util.js';

function statusLines(s: MigrationStatus): string[] {
  const lines = [`schema ${s.schema}: ${s.state} (database at ${s.dbAt}, this build needs ${s.codeRequires})`];
  for (const p of s.pending) lines.push(`  pending ${String(p.id).padStart(4, '0')}_${p.name}${p.breaking ? ' (breaking)' : ''}`);
  for (const id of s.changed) lines.push(`  CHANGED ${String(id).padStart(4, '0')}: the applied file differs from this build's`);
  return lines;
}

function backfillLines(r: BackfillResult): string[] {
  const total = Object.values(r.mapped).reduce((s, n) => s + n, 0);
  return [
    `${r.dryRun ? 'would map' : 'mapped'} ${total} row(s) over ${Object.keys(r.mapped).length} metric(s); ${r.alreadySet} already had provenance; ${r.unmapped.length} cannot be mapped`,
    ...Object.entries(r.mapped).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `  ${k}: ${n}`),
    ...r.unmapped.map((u) => `  UNMAPPED #${u.id} ${u.assetId} ${u.metricKey} (${u.source}): ${u.reason}`),
  ];
}

export function registerDb(program: Command, ctx: CliContext): void {
  const db = program.command('db').description('the Postgres schema: where it stands, and applying migrations');

  db.command('status')
    .description('the schema against this build: current, behind (pending migrations), ahead, or changed')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const status = await withDb(ctx, (d) => migrationStatus(d), { checkSchema: false });
        output(ctx, opts.json, status, () => statusLines(status));
      }),
    );

  db.command('migrate')
    .description('apply the pending migrations (creates the schema if absent); a breaking one needs --breaking')
    .option('--breaking', 'also apply migrations marked -- breaking (not expand-only)')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean; breaking?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const result = await withDb(
          ctx,
          async (d) => {
            const { applied } = await applyMigrations(d, { breaking: opts.breaking });
            return { applied, status: await migrationStatus(d) };
          },
          { checkSchema: false },
        );
        output(ctx, opts.json, result, () => [
          result.applied.length === 0 ? 'nothing to apply' : `applied ${result.applied.join(', ')}`,
          ...statusLines(result.status),
        ]);
      }),
    );

  db.command('backfill-provenance')
    .description('map the provenance of every observation written before 0004 from its source columns and this release\'s asset YAML; --dry-run writes nothing')
    .option('--dry-run', 'list what would be mapped and what cannot be, write nothing')
    .option('--json', 'JSON output')
    .action((opts: { dryRun?: boolean; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const assets = listAssetIds(ctx.configRoot).map((id) => loadAsset(ctx.configRoot, id));
        const result = await withDb(ctx, (d) => backfillProvenance(d, assets, { dryRun: opts.dryRun === true }));
        output(ctx, opts.json, result, () => backfillLines(result));
      }),
    );

  db.command('query-ro')
    .description('one read-only SQL statement (READ ONLY transaction, 30 s timeout), rows as JSON; no backslash, no second statement')
    .argument('<sql>', 'the statement')
    .option('--role <name>', 'sign in as this role instead of the URL\'s user (orion-remote passes orion_prod_ro)')
    .option('--json', 'accepted; the output is always JSON')
    .action((sql: string, opts: { role?: string }) =>
      guarded(ctx, true, async () => {
        checkSingleStatement(sql);
        const base = databaseFor(ctx);
        const config = opts.role === undefined ? base : { ...base, url: urlForRole(base.url, opts.role) };
        const db = await openDb(config, { max: 1, checkSchema: false });
        try {
          const rows = await queryReadOnly(db, sql).catch((err: unknown) => {
            if (err instanceof OrionError) throw err;
            throw new OrionError('query_failed', err instanceof Error ? err.message : String(err));
          });
          ctx.stdout(JSON.stringify({ rows, rowCount: rows.length }, null, 2));
        } finally {
          await db.close();
        }
      }),
    );
}
