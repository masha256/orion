import { join } from 'node:path';
import type { Command } from 'commander';
import { tickAsset } from '../../app/tick.js';
import { emitTickReport } from '../../app/tickReport.js';
import { loadAsset } from '../../config/load.js';
import { emitSignal } from '../../signals/emit.js';
import { fetchSummary, ingestDepsFor, modelClientFor, signalSummary, withDbAsync, type CliContext } from '../util.js';

/** The two files tick always appends to, under ORION_HOME: the delivery path for the scheduler's reader. */
export const SIGNALS_FILE = 'signals.jsonl';
export const TICKS_FILE = 'ticks.jsonl';

export function registerTick(program: Command, ctx: CliContext): void {
  program
    .command('tick <asset>')
    .description(
      'the scheduled entry point: ingest, valuation and signal, trigger evaluation, then the one agent run that is due or triggered; ' +
        'stdout is the tick report (one JSON line), appended to ticks.jsonl; signals go to signals.jsonl; exit 0 completed or run_in_progress, 2 blocked, 1 no signal',
    )
    .option('--no-agent', 'evaluate the triggers without recording them and start no agent run; the report says what would have run')
    .option('--json', 'accepted for consistency; tick always writes JSON')
    .action(async (assetId: string, opts: { agent: boolean }) => {
      const loaded = loadAsset(ctx.home, assetId);
      const signalsFile = join(ctx.home, SIGNALS_FILE);
      const { report, exitCode } = await withDbAsync(ctx, (db) =>
        tickAsset(
          db, loaded,
          {
            home: ctx.home, now: ctx.now, fetchDeps: ingestDepsFor(ctx), modelClient: () => modelClientFor(ctx), reload: () => loadAsset(ctx.home, assetId),
            onSignal: (signal) => {
              emitSignal(signal, { write: () => undefined, outFile: signalsFile });
              // The rationale is model text; the tick's stderr is read by a second agent and carries none.
              for (const line of signalSummary(signal, { rationale: false })) ctx.stderr?.(line);
            },
            onFetch: (fetch) => {
              for (const line of fetchSummary(fetch)) ctx.stderr?.(line);
            },
            onProgress: (line) => ctx.stderr?.(line),
          },
          { noAgent: !opts.agent },
        ),
      );
      emitTickReport(report, {
        write: ctx.stdout, outFile: join(ctx.home, TICKS_FILE),
        onAppendError: (err) => ctx.stderr?.(`warning: the report could not be appended to ticks.jsonl (${err instanceof Error ? err.message : String(err)})`),
      });
      if (exitCode !== 0) ctx.setExitCode?.(exitCode);
    });
}
