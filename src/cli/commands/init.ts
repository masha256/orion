import type { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { output, type CliContext } from '../util.js';

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('create the project layout (assets/, personas/, skills/) in the Orion home directory; the database is set up with orion db migrate')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      for (const d of ['assets', 'personas', 'skills']) mkdirSync(join(ctx.home, d), { recursive: true });
      output(ctx, opts.json, { home: ctx.home }, () => [`initialized ${ctx.home}`]);
    });
}
