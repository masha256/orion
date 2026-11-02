import type { LoadedAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { getRunLock } from '../db/runLocks.js';
import { fetchAsset, type FetchDeps, type FetchResult } from '../ingest/run.js';
import { loadHolderYieldReport } from '../report/load.js';
import { OrionError } from '../types.js';
import { buildInbox, emptyInbox } from './inbox.js';
import { lockHolder, withRunLock } from './lock.js';
import { summarizeHolderYield, tickId, type TickReport } from './tickReport.js';

export interface TickDeps {
  home: string;
  now: () => Date;
  fetchDeps: FetchDeps;
  /** The fetch's full result, for the caller's own summary; the report keeps only failures, raised anomalies and watch firings. */
  onFetch?: (fetch: FetchResult) => void;
  onProgress?: (line: string) => void;
}

export interface TickResult {
  report: TickReport;
  /** 0: the fetch ran and the report was built, or `run_in_progress`; 1: nothing fetched (the ingest threw); 2: the fetch ran but the report could not be built. */
  exitCode: 0 | 1 | 2;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The report promises Orion's own codes; a library error's text is not Orion's, so it is capped rather than trusted whole.
const errorOf = (err: unknown): { code: string; message: string } =>
  err instanceof OrionError
    ? { code: err.code, message: err.message.slice(0, 300) }
    : { code: err instanceof Error ? err.constructor.name : 'error', message: message(err).slice(0, 300) };

/**
 * The scheduled loop, in one process: lock, ingest (with its anomaly checks and watch rules), the holder-yield report for
 * the latest complete day, unlock, then the inbox. No agent run, ever. The report is the answer, whatever happened; only
 * a bug escapes as a throw.
 */
export async function tickAsset(db: Db, loaded: LoadedAsset, deps: TickDeps): Promise<TickResult> {
  const asset = loaded.config;
  const started = deps.now();
  const report: TickReport = {
    schema_version: 2, tick_id: tickId(asset.id, started), asset: asset.id, started_at: started.toISOString(), ended_at: started.toISOString(),
    outcome: 'completed', lock: null, ingest: null, holder_yield: null, report_error: null, inbox: emptyInbox(), error: null,
  };

  try {
    await withRunLock(db, asset.id, lockHolder('tick'), started, async () => {
      // ---- ingest ----
      try {
        const fetch = await fetchAsset(db, loaded, started, deps.fetchDeps, { onProgress: deps.onProgress });
        deps.onFetch?.(fetch);
        report.ingest = {
          fetch_run_id: fetch.fetchRunId,
          outcome: fetch.outcome,
          sources_failed: fetch.sources.filter((s) => s.status === 'failed').map((s) => s.sourceId),
          anomalies_raised: fetch.anomalies.filter((a) => a.status === 'open').map((a) => ({ id: a.id, kind: a.kind, metric: a.metricKey, severity: a.severity })),
          ...(fetch.watch.length > 0 ? { watch: fetch.watch.map((f) => ({ metric: f.metric, rule: f.rule, value: f.value, previous: f.previous, day: f.day })) } : {}),
        };
      } catch (err) {
        report.error = errorOf(err);
        return;
      }

      // ---- the holder-yield report ----
      // Every live asset has a reporting block; one without has no report to build, which is not a failure.
      if (!asset.reporting) return;
      try {
        report.holder_yield = summarizeHolderYield(loadHolderYieldReport(db, asset));
      } catch (err) {
        report.report_error = { code: 'report_unavailable', message: message(err).slice(0, 300) };
        deps.onProgress?.(`report unavailable: ${report.report_error.message}`);
      }
    }, {
      onTakeover: (n) => deps.onProgress?.(`took over an expired run lock; ${n} stuck run(s) marked abandoned`),
      onReleaseError: (err) => deps.onProgress?.(`warning: the run lock could not be released (${message(err)}); the next tick finds it held until it expires`),
    });
  } catch (err) {
    if (!(err instanceof OrionError) || err.code !== 'run_in_progress') throw err;
    const lock = getRunLock(db, asset.id);
    report.outcome = 'run_in_progress';
    report.lock = lock ? { holder: lock.holder, acquired_at: lock.acquiredAt } : { holder: 'unknown', acquired_at: started.toISOString() };
    deps.onProgress?.(err.message);
  }

  // Outside the lock: a plain read, so a tick that never got the lock still reports the queue.
  try {
    report.inbox = buildInbox(db, asset, deps.now().toISOString());
  } catch (err) {
    deps.onProgress?.(`warning: the inbox could not be built (${message(err)}); the report lists nothing to decide`);
  }
  report.ended_at = deps.now().toISOString();
  if (report.error) report.outcome = 'error';
  const exitCode: 0 | 1 | 2 =
    report.outcome === 'run_in_progress' ? 0 : report.ingest === null ? 1 : report.report_error !== null ? 2 : 0;
  return { report, exitCode };
}
