import type { Command } from 'commander';
import { updateAsset } from '../../app/update.js';
import { loadAsset } from '../../config/load.js';
import { emitSignal } from '../../signals/emit.js';
import { fetchSummary, ingestDepsFor, withDbAsync, type CliContext } from '../util.js';

export function registerUpdate(program: Command, ctx: CliContext): void {
  program
    .command('update <asset>')
    .description('fetch, run the valuation, and emit the signal as one JSON line; exit 0 ok or degraded, 2 blocked, 1 error')
    .option('--out <file>', 'JSONL file to append the signal to')
    .option('--json', 'accepted for consistency; update always writes JSON')
    .action(async (assetId: string, opts: { out?: string }) => {
      const loaded = loadAsset(ctx.home, assetId);
      const { fetch, signal } = await withDbAsync(ctx, (db) =>
        updateAsset(db, loaded, ctx.now(), ingestDepsFor(ctx), { onProgress: (line) => ctx.stderr?.(line) }),
      );
      for (const line of fetchSummary(fetch)) ctx.stderr?.(line);
      emitSignal(signal, { write: ctx.stdout, outFile: opts.out });
      if (signal.status === 'blocked') ctx.setExitCode?.(2);
    });
}
