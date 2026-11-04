import { Command } from 'commander';
import { registerAgent } from './commands/agent.js';
import { registerAsset } from './commands/asset.js';
import { registerData } from './commands/data.js';
import { registerDb } from './commands/db.js';
import { registerDoc } from './commands/doc.js';
import { registerInbox } from './commands/inbox.js';
import { registerInit } from './commands/init.js';
import { registerPersona } from './commands/persona.js';
import { registerProposals } from './commands/proposals.js';
import { registerReport } from './commands/report.js';
import { registerTick } from './commands/tick.js';
import type { CliContext } from './util.js';

export type { CliContext } from './util.js';

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('orion')
    .description('Token revenue, holder-flow and supply data with provenance')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.stdout(s.trimEnd()),
      writeErr: (s) => ctx.stdout(s.trimEnd()),
    });
  registerInit(program, ctx);
  registerDb(program, ctx);
  registerAsset(program, ctx);
  registerData(program, ctx);
  registerProposals(program, ctx);
  registerTick(program, ctx);
  registerInbox(program, ctx);
  registerPersona(program, ctx);
  registerAgent(program, ctx);
  registerDoc(program, ctx);
  registerReport(program, ctx);
  return program;
}
