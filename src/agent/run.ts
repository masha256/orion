import { runValuation } from '../app/valuation.js';
import { budgetsFor } from '../config/agentPolicy.js';
import type { LoadedAsset } from '../config/load.js';
import { loadPersona, skillsFor } from '../config/personas.js';
import { finishAgentRun, startAgentRun, ZERO_USAGE, type AgentOutcome, type AgentRun, type AgentUsage } from '../db/agentRuns.js';
import { getAnomaly } from '../db/anomalies.js';
import { getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { getCoverage } from '../db/coverage.js';
import type { Firing } from '../db/triggerFirings.js';
import type { Signal } from '../signals/schema.js';
import { OrionError, type RunType } from '../types.js';
import { sha256 } from '../util/canonical.js';
import { buildContextPack, renderContextPack } from './context.js';
import { AgentConflict, Ledger, movesSignal, type CommitSummary } from './ledger.js';
import { runLoop, type LoopStop } from './loop.js';
import { webTools, type ModelClient, type ModelMessageParam } from './model.js';
import { buildSystemPrompt, JOURNAL_REMINDER, OPERATING_RULES } from './prompt.js';
import { fetchedPagesFrom } from './research.js';
import { AGENT_TOOLS, runTool, toApiTools, type ToolContext } from './tools/index.js';

/** Bump when a tool's behaviour or a guardrail changes: runs record which tool layer they ran under. */
export const TOOL_LAYER_VERSION = '1.0.0';

/** Why `orion tick` launched the run. Absent, the run was launched by hand and is recorded as `manual`. */
export interface RunTriggerContext {
  /** `schedule`: the run was due; `trigger`: it is a triage run for the firings. Either way the firings are in the pack. */
  kind: 'schedule' | 'trigger';
  firings: Firing[];
}

export interface RunAgentOptions {
  runType: RunType;
  anomalyId?: number;
  note?: string;
  dryRun?: boolean;
  trigger?: RunTriggerContext;
}

export interface RunAgentDeps {
  home: string;
  now: () => Date;
  /** Built during preflight, so missing credentials fail before a run row exists. Tests pass a scripted model. */
  modelClient: () => ModelClient;
  /**
   * Reads the asset config again, from wherever `loaded` came from. Called once, just before the commit: a run that was
   * checked against the config it began on must not commit under a config the user changed while it ran. Required: a
   * caller that forgot it would silently lose that check.
   */
  reload: () => LoadedAsset;
}

export interface RunAgentResult {
  run: AgentRun;
  /** What the run staged. After a commit this is what was written; on a dry run or a failed run, what would have been. */
  staged: ReturnType<Ledger['preview']>;
  committed: CommitSummary | null;
  /** The signal the run produced, when its commit wrote something that can move one. */
  signal: Signal | null;
}

const OUTCOME_OF: Record<LoopStop, Exclude<AgentOutcome, 'running'>> = {
  finished: 'completed', budget_exhausted: 'budget_exhausted', refused: 'refused', no_journal: 'no_journal', error: 'error',
};

/**
 * One agent run. Preflight failures throw before any model call and before a run row exists. After that nothing throws:
 * whatever happens is recorded on the run row, with the transcript and token usage, and the domain writes are all or nothing.
 */
export async function runAgent(db: Db, loaded: LoadedAsset, opts: RunAgentOptions, deps: RunAgentDeps): Promise<RunAgentResult> {
  const asset = loaded.config;

  // ---- preflight: costs nothing ----
  const coverage = getCoverage(db, asset.id);
  if (!coverage) throw new OrionError('no_persona_assigned', `no persona covers ${asset.id}; run "orion persona assign ${asset.id} <name>"`);
  const persona = loadPersona(deps.home, coverage.persona);
  const skills = skillsFor(deps.home, opts.runType);
  const startSet = getLatestAssumptionSet(db, asset.id);
  if (!startSet) throw new OrionError('no_assumption_set', `no assumption set for ${asset.id}; import one first`);
  const note = opts.note?.trim() || undefined;
  const firings = opts.trigger?.firings ?? [];
  if (opts.runType === 'triage' && opts.anomalyId === undefined && note === undefined && firings.length === 0) {
    throw new OrionError('triage_needs_target', 'a triage run needs --anomaly <id>, --note <text>, or both');
  }
  if (opts.anomalyId !== undefined) {
    const target = getAnomaly(db, opts.anomalyId);
    if (!target || target.assetId !== asset.id) throw new OrionError('anomaly_not_found', `no anomaly ${opts.anomalyId} on ${asset.id}`);
    if (target.status !== 'open') throw new OrionError('anomaly_not_open', `anomaly ${opts.anomalyId} is already ${target.status}`);
  }
  const client = deps.modelClient();

  const started = deps.now();
  const budgets = budgetsFor(asset, opts.runType);
  const system = buildSystemPrompt(persona, skills, opts.runType);
  const configHash = sha256([loaded.hash, persona.hash, ...skills.map((s) => s.hash), TOOL_LAYER_VERSION, sha256(OPERATING_RULES)].join('\n'));
  const runId = startAgentRun(db, {
    assetId: asset.id, persona: persona.name, runType: opts.runType, trigger: opts.trigger?.kind ?? 'manual',
    triggerDetail: {
      ...(opts.anomalyId !== undefined ? { anomalyId: opts.anomalyId } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(opts.trigger ? { firings: firings.map((f) => ({ kind: f.kind, key: f.key, detail: f.detail })) } : {}),
    },
    dryRun: opts.dryRun === true, configHash, model: persona.model, startedAt: started.toISOString(),
  });

  // ---- the run: everything from here is recorded, never thrown ----
  const ledger = new Ledger(asset.id, persona.name, startSet);
  const messages: ModelMessageParam[] = [];
  const tools = [...toApiTools(AGENT_TOOLS), ...webTools(budgets)];
  let outcome: Exclude<AgentOutcome, 'running'> = 'error';
  let error: string | null = null;
  let usage: AgentUsage = { ...ZERO_USAGE };
  let responses: unknown[] = [];
  let committed: CommitSummary | null = null;
  let signal: Signal | null = null;
  let valuationError: string | null = null;

  try {
    const pack = buildContextPack(db, loaded, ledger, { runType: opts.runType, budgets, now: started, trigger: { anomalyId: opts.anomalyId, note, firings } });
    messages.push({ role: 'user', content: renderContextPack(pack) });
    const ctx: ToolContext = { db, loaded, ledger, now: deps.now, budgets, fetchedPages: () => fetchedPagesFrom(messages) };

    const loop = await runLoop({
      client, model: persona.model, effort: persona.effort, system, tools, messages, budgets,
      runTool: (name, input) => runTool(AGENT_TOOLS, ctx, name, input),
      isFinished: () => ledger.journal() !== null,
      reminder: JOURNAL_REMINDER,
    });
    usage = loop.usage;
    responses = loop.responses;
    outcome = OUTCOME_OF[loop.stop];
    error = loop.stop === 'finished' ? null : loop.detail;

    if (outcome === 'completed' && opts.dryRun !== true) {
      // Bands, bounds, the move guard, and the run's config hash all came from `loaded`. If the file moved under the run,
      // every check it passed was against a config that is no longer the one in force: commit nothing.
      // A reload that throws is the same situation with the file half-edited: a conflict, not a fault in the run.
      let current: LoadedAsset | undefined;
      let reloadError: string | null = null;
      try {
        current = deps.reload();
      } catch (err) {
        reloadError = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
      }
      if (reloadError !== null) {
        outcome = 'conflict';
        error = `the asset config could not be reloaded at the end of the run (${reloadError}); nothing was committed`;
      } else if (current && current.hash !== loaded.hash) {
        outcome = 'conflict';
        error = `the asset config changed during the run (${loaded.hash.slice(0, 12)} -> ${current.hash.slice(0, 12)}); nothing was committed`;
      } else {
        try {
          committed = ledger.commit(db, asset, { agentRunId: runId, now: deps.now() });
        } catch (err) {
          if (!(err instanceof AgentConflict)) throw err;
          outcome = 'conflict';
          error = err.message;
        }
        // A failure here is caught below: the commit stands, and the next `orion update` values the asset as usual.
        if (committed && movesSignal(committed)) signal = runValuation(db, loaded, deps.now(), { agentRunId: runId }).signal;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    // Once the commit has gone through, its writes are live. Calling the run `error` would hide them and invite a rerun.
    if (committed) valuationError = message;
    else {
      outcome = 'error';
      error = message;
    }
  }

  const staged = ledger.preview();
  const finish = (transcript: unknown): AgentRun =>
    finishAgentRun(db, runId, {
      outcome, endedAt: deps.now().toISOString(), usage, error,
      summary: { committed, staged, signal_id: signal?.signal_id ?? null, valuation_error: valuationError },
      transcript,
    });

  let run: AgentRun;
  try {
    run = finish({ system, tools: tools.map((t) => ('name' in t ? t.name : t.type)), messages, responses });
  } catch (err) {
    // The run row matters more than the transcript: left `running`, the next lock takeover calls it `error/abandoned`
    // while its writes are live. Try once more with a transcript that cannot itself be the problem. A second failure is real.
    run = finish({ error: err instanceof Error ? err.message : String(err), note: 'the full transcript could not be stored' });
  }
  return { run, staged, committed, signal };
}
