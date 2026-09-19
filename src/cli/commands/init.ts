import type { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dbPath, output, withDb, type CliContext } from '../util.js';

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('create the project layout and database in the Orion home directory')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      for (const d of ['assets', 'personas', 'skills', 'calibration']) mkdirSync(join(ctx.home, d), { recursive: true });
      withDb(ctx, () => undefined);
      output(ctx, opts.json, { home: ctx.home, db: dbPath(ctx) }, () => [`initialized ${ctx.home}`]);
    });
}
