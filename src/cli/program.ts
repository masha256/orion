import { Command } from 'commander';
import { registerAsset } from './commands/asset.js';
import { registerData } from './commands/data.js';
import { registerInit } from './commands/init.js';
import { registerModel } from './commands/model.js';
import { registerSignal } from './commands/signal.js';
import type { CliContext } from './util.js';

export type { CliContext } from './util.js';

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('orion')
    .description('Token valuation signals from deterministic models and versioned assumptions')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.stdout(s.trimEnd()),
      writeErr: (s) => ctx.stdout(s.trimEnd()),
    });
  registerInit(program, ctx);
  registerAsset(program, ctx);
  registerData(program, ctx);
  registerModel(program, ctx);
  registerSignal(program, ctx);
  return program;
}
