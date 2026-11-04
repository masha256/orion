import type { Command } from 'commander';
import { applyMigrations, migrationStatus, type MigrationStatus } from '../../db/pg/migrate.js';
import { guarded, output, withDb, type CliContext } from '../util.js';

function statusLines(s: MigrationStatus): string[] {
  const lines = [`schema ${s.schema}: ${s.state} (database at ${s.dbAt}, this build needs ${s.codeRequires})`];
  for (const p of s.pending) lines.push(`  pending ${String(p.id).padStart(4, '0')}_${p.name}${p.breaking ? ' (breaking)' : ''}`);
  for (const id of s.changed) lines.push(`  CHANGED ${String(id).padStart(4, '0')}: the applied file differs from this build's`);
  return lines;
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
}
