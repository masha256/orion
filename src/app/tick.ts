import type { ModelClient } from '../agent/model.js';
import { runAgent, type RunTriggerContext } from '../agent/run.js';
import { cadenceFor } from '../config/agentPolicy.js';
import type { LoadedAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { getProposal } from '../db/proposals.js';
import { getRunLock } from '../db/runLocks.js';
import { attachRun, type Firing } from '../db/triggerFirings.js';
import type { FetchDeps, FetchResult } from '../ingest/run.js';
import type { Signal } from '../signals/schema.js';
import { OrionError, type RunType } from '../types.js';
import { dueRunType } from './cadence.js';
import { lockHolder, withRunLock } from './lock.js';
import { tickId, type TickReport } from './tickReport.js';
import { evaluateTriggers } from './triggers.js';
import { updateAsset } from './update.js';

export interface TickDeps {
  home: string;
  now: () => Date;
  fetchDeps: FetchDeps;
  modelClient: () => ModelClient;
  reload: () => LoadedAsset;
  /** Every signal the tick produces, the moment it exists: the data-only one first, the agent's (if any) after. */
  onSignal: (signal: Signal) => void;
  /** The fetch's full result, for the caller's own summary; the report keeps only failures and raised anomalies. */
  onFetch?: (fetch: FetchResult) => void;
  onProgress?: (line: string) => void;
}

export interface TickOptions {
  /** Evaluate the triggers without recording them and start no agent run; the report says what would have run. */
  noAgent?: boolean;
}

export interface TickResult {
  report: TickReport;
  /** 0: a signal, ok or degraded, or `run_in_progress`; 2: the signal is blocked; 1: no signal. The agent stage never changes it. */
  exitCode: 0 | 1 | 2;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The report promises Orion's own codes; an SDK error's text is provider-controlled, so it is capped rather than trusted whole.
const errorOf = (err: unknown): { code: string; message: string } =>
  err instanceof OrionError
    ? { code: err.code, message: err.message.slice(0, 300) }
    : { code: err instanceof Error ? err.constructor.name : 'error', message: message(err).slice(0, 300) };

/**
 * The scheduled loop, in one process: lock, ingest and signal, trigger evaluation, then the one agent run that is due or
 * triggered. Nothing here spawns a process. The report is the answer, whatever happened; only a bug escapes as a throw.
 */
export async function tickAsset(db: Db, loaded: LoadedAsset, deps: TickDeps, opts: TickOptions = {}): Promise<TickResult> {
  const asset = loaded.config;
  const started = deps.now();
  const report: TickReport = {
    schema_version: 1, tick_id: tickId(asset.id, started), asset: asset.id, started_at: started.toISOString(), ended_at: started.toISOString(),
    outcome: 'completed', lock: null, ingest: null, signal: null, triggers_fired: [], triggers_recorded: false, agent: null, agent_would_run: null, error: null,
  };
  const finish = (): TickResult => {
    report.ended_at = deps.now().toISOString();
    if (report.error) report.outcome = 'error';
    const exitCode = report.signal === null ? (report.outcome === 'run_in_progress' ? 0 : 1) : report.signal.status === 'blocked' ? 2 : 0;
    return { report, exitCode };
  };

  try {
    await withRunLock(db, asset.id, lockHolder('tick'), started, async () => {
      // ---- ingest and signal ----
      let signal: Signal;
      try {
        const update = await updateAsset(db, loaded, started, deps.fetchDeps, { onProgress: deps.onProgress });
        deps.onFetch?.(update.fetch);
        signal = update.signal;
        report.ingest = {
          fetch_run_id: update.fetch.fetchRunId,
          outcome: update.fetch.outcome,
          sources_failed: update.fetch.sources.filter((s) => s.status === 'failed').map((s) => s.sourceId),
          anomalies_raised: update.fetch.anomalies.filter((a) => a.status === 'open').map((a) => ({ id: a.id, kind: a.kind, metric: a.metricKey, severity: a.severity })),
        };
      } catch (err) {
        report.error = errorOf(err);
        return;
      }
      try {
        deps.onSignal(signal);
      } catch (err) {
        deps.onProgress?.(`warning: the signal could not be delivered (${message(err)}); it is in the database`);
      }
      report.signal = {
        signal_id: signal.signal_id, status: signal.status, grade: signal.data_quality.grade,
        expected_target_12m: signal.horizons?.['12m'].expected_target ?? null, target_delta_pct: signal.change.target_delta_pct, cause: signal.change.cause,
      };

      // ---- triggers ----
      const agentAllowed = opts.noAgent !== true && cadenceFor(asset).enabled;
      // The trigger and cadence clock is deliberately deps.now(), not the valuation's asOf (which may sit ahead of now by the chain head): the fetch can take minutes.
      const evaluation = evaluateTriggers(db, loaded, deps.now(), { record: agentAllowed });
      report.triggers_fired = evaluation.fired.map((f) => ({ kind: f.kind, key: f.key, detail: f.detail }));
      report.triggers_recorded = agentAllowed;

      // ---- the one agent run ----
      const due = dueRunType(db, asset, deps.now());
      const choice: { runType: RunType; trigger: RunTriggerContext } | null = due
        ? { runType: due, trigger: { kind: 'schedule', firings: evaluation.fired } }
        : evaluation.fired.length > 0
          ? { runType: 'triage', trigger: { kind: 'trigger', firings: evaluation.fired } }
          : null;
      if (!choice) return;
      if (!agentAllowed) {
        report.agent_would_run = { run_type: choice.runType, trigger_kind: choice.trigger.kind };
        return;
      }
      report.agent = await agentStage(db, loaded, deps, choice.runType, choice.trigger);
      if (report.agent.run_id !== null) {
        try {
          attachRun(db, evaluation.fired.map((f) => f.id), report.agent.run_id);
        } catch (err) {
          deps.onProgress?.(`warning: the firings could not be linked to agent run #${report.agent.run_id} (${message(err)})`);
        }
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
  return finish();
}

/** Runs the agent and reduces the result to ids, kinds, and counts. Whatever `runAgent` throws is recorded, never rethrown. */
async function agentStage(db: Db, loaded: LoadedAsset, deps: TickDeps, runType: RunType, trigger: RunTriggerContext): Promise<NonNullable<TickReport['agent']>> {
  const stage: NonNullable<TickReport['agent']> = {
    run_type: runType, trigger_kind: trigger.kind, run_id: null, outcome: null, usage: null, committed: null, proposals: [], signal_id: null, error: null,
  };
  deps.onProgress?.(`agent ${runType} run (${trigger.kind}${trigger.firings.length > 0 ? `: ${trigger.firings.map((f: Firing) => `${f.kind} ${f.key}`).join(', ')}` : ''})`);
  try {
    const result = await runAgent(db, loaded, { runType, trigger }, { home: deps.home, now: deps.now, modelClient: deps.modelClient, reload: deps.reload });
    const u = result.run.usage;
    stage.run_id = result.run.id;
    stage.outcome = result.run.outcome;
    stage.usage = { requests: u.requests, input_tokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, output_tokens: u.outputTokens, web_searches: u.webSearches, web_fetches: u.webFetches };
    stage.committed = result.committed && {
      assumption_set_version: result.committed.setVersion, observations: result.committed.observationIds.length,
      anomalies_resolved: result.committed.resolvedAnomalyIds.length, journal: result.committed.journalId === null ? 0 : 1,
    };
    stage.proposals = (result.committed?.proposalIds ?? []).map((id) => ({ id, kind: getProposal(db, id)?.change.kind ?? 'unknown' }));
    stage.signal_id = result.signal?.signal_id ?? null;
    if (result.run.outcome !== 'completed') stage.error = { code: result.run.outcome, message: (result.run.error ?? '').slice(0, 300) };
    deps.onProgress?.(`agent run #${result.run.id} ${result.run.outcome}`);
    if (result.signal) {
      try {
        deps.onSignal(result.signal);
      } catch (err) {
        deps.onProgress?.(`warning: the agent's signal could not be delivered (${message(err)}); it is in the database`);
      }
    }
  } catch (err) {
    stage.error = errorOf(err);
    deps.onProgress?.(`agent run failed before it could be recorded: ${stage.error.code}: ${stage.error.message}`);
  }
  return stage;
}
