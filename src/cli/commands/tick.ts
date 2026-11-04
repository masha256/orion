import { join } from 'node:path';
import type { Command } from 'commander';
import { tickAsset } from '../../app/tick.js';
import { emitTickReport } from '../../app/tickReport.js';
import { loadAsset } from '../../config/load.js';
import { fetchSummary, ingestDepsFor, withDb, type CliContext } from '../util.js';

/** The file tick always appends its report to, under ORION_HOME: the delivery path for the scheduler's reader. */
export const TICKS_FILE = 'ticks.jsonl';

export function registerTick(program: Command, ctx: CliContext): void {
  program
    .command('tick <asset>')
    .description(
      'the scheduled entry point: lock, ingest (anomaly checks, watch rules), the holder-yield report for the latest complete day, unlock; starts no agent run; ' +
        'stdout is the tick report (one JSON line), appended to ticks.jsonl; ' +
        'exit 0 fetched and reported (or run_in_progress), 1 nothing fetched, 2 fetched but the report could not be built (report_unavailable) or is stale (report_stale)',
    )
    .option('--json', 'accepted for consistency; tick always writes JSON')
    .action(async (assetId: string) => {
      const loaded = loadAsset(ctx.configRoot, assetId);
      const { report, exitCode } = await withDb(ctx, (db) =>
        tickAsset(db, loaded, {
          home: ctx.home, now: ctx.now, fetchDeps: ingestDepsFor(ctx),
          onFetch: (fetch) => {
            for (const line of fetchSummary(fetch)) ctx.stderr?.(line);
          },
          onProgress: (line) => ctx.stderr?.(line),
        }),
      );
      emitTickReport(report, {
        write: ctx.stdout, outFile: join(ctx.home, TICKS_FILE),
        onAppendError: (err) => ctx.stderr?.(`warning: the report could not be appended to ticks.jsonl (${err instanceof Error ? err.message : String(err)})`),
      });
      if (exitCode !== 0) ctx.setExitCode?.(exitCode);
    });
}
