import { Command } from 'commander';
import { registerAgent } from './commands/agent.js';
import { registerAsset } from './commands/asset.js';
import { registerData } from './commands/data.js';
import { registerInit } from './commands/init.js';
import { registerModel } from './commands/model.js';
import { registerPersona } from './commands/persona.js';
import { registerSignal } from './commands/signal.js';
import { registerUpdate } from './commands/update.js';
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
  registerUpdate(program, ctx);
  registerPersona(program, ctx);
  registerAgent(program, ctx);
  return program;
}
