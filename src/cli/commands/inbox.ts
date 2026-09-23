import type { Command } from 'commander';
import { buildInbox, inboxLines } from '../../app/inbox.js';
import { loadAsset } from '../../config/load.js';
import { output, withDb, type CliContext } from '../util.js';

export function registerInbox(program: Command, ctx: CliContext): void {
  program
    .command('inbox <asset>')
    .description("everything awaiting your decision: provisional observations to confirm, pending proposals, open anomalies; ids and Orion's numbers only")
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const asset = loadAsset(ctx.home, assetId).config;
      const nowIso = ctx.now().toISOString();
      const inbox = withDb(ctx, (db) => buildInbox(db, asset, nowIso));
      output(ctx, opts.json, { asset: asset.id, as_of: nowIso, ...inbox }, () => inboxLines(inbox));
    });
}
