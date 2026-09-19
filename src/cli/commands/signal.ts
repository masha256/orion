import type { Command } from 'commander';
import { getLatestSignal, listSignals } from '../../db/runs.js';
import { emitSignal } from '../../signals/emit.js';
import { OrionError } from '../../types.js';
import { output, parseNumber, signalSummary, withDb, type CliContext } from '../util.js';

export function registerSignal(program: Command, ctx: CliContext): void {
  const signal = program.command('signal').description('read and emit stored signals');

  const latest = (assetId: string) => {
    const s = withDb(ctx, (db) => getLatestSignal(db, assetId));
    if (!s) throw new OrionError('no_signal', `no signal for ${assetId}; run "orion model run ${assetId}"`);
    return s;
  };

  signal
    .command('latest <asset>')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const s = latest(assetId);
      output(ctx, opts.json, s, () => signalSummary(s));
    });

  signal
    .command('history <asset>')
    .option('--limit <n>', 'maximum signals, newest first', '20')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { limit: string; json?: boolean }) => {
      const list = withDb(ctx, (db) => listSignals(db, assetId, parseNumber(opts.limit, '--limit')));
      output(ctx, opts.json, list, () =>
        list.length === 0
          ? ['no signals']
          : list.map((s) => `${s.generated_at}  ${s.status}  grade ${s.data_quality.grade}  12m ${s.horizons ? s.horizons['12m'].expected_target.toFixed(4) : 'n/a'}  ${s.signal_id}`),
      );
    });

  signal
    .command('emit <asset>')
    .description('write the latest signal as one JSON line to stdout, and append it to --out when given')
    .option('--out <file>', 'JSONL file to append to')
    .action((assetId: string, opts: { out?: string }) => {
      emitSignal(latest(assetId), { write: ctx.stdout, outFile: opts.out });
    });
}
