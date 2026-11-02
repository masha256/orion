import { budgetsFor } from '../config/agentPolicy.js';
import type { LoadedAsset } from '../config/load.js';
import { loadPersona, skillsFor } from '../config/personas.js';
import { finishAgentRun, startAgentRun, ZERO_USAGE, type AgentOutcome, type AgentRun, type AgentUsage } from '../db/agentRuns.js';
import { getAnomaly } from '../db/anomalies.js';
import type { Db } from '../db/connection.js';
import { getCoverage } from '../db/coverage.js';
import { getDocument } from '../db/documents.js';
import { OrionError, RUNNABLE_RUN_TYPES, type RunnableRunType } from '../types.js';
import { sha256 } from '../util/canonical.js';
import { buildContextPack, renderContextPack } from './context.js';
import { AgentConflict, Ledger, type CommitSummary, type StagedPreview } from './ledger.js';
import { runLoop, type LoopStop } from './loop.js';
import { webTools, type ModelClient, type ModelMessageParam } from './model.js';
import { buildSystemPrompt, JOURNAL_REMINDER, OPERATING_RULES } from './prompt.js';
import { fetchedPagesFrom } from './research.js';
import type { CitableDoc } from './guardrails.js';
import { AGENT_TOOLS, runTool, toApiTools, toolsForRun, type ToolContext } from './tools/index.js';

/**
 * Bump when a tool's behaviour or a guardrail changes: runs record which tool layer they ran under. 2.0.0: disclosure is
 * the only run type; the valuation tools, drivers and signal history left the pack and the tool list.
 */
export const TOOL_LAYER_VERSION = '2.0.0';

export interface RunAgentOptions {
  runType: RunnableRunType;
  /** An open anomaly to look into, shown in the pack. Context only. */
  anomalyId?: number;
  /** A lead for the agent to verify, shown in the pack. Never evidence. */
  note?: string;
  dryRun?: boolean;
  /** The stored document the run reads. Required. */
  docId?: number;
  /** The text of `assets/<id>.yaml` as the user wrote it, for the pack. The CLI reads it at preflight. Required. */
  assetYaml?: string;
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
  staged: StagedPreview;
  committed: CommitSummary | null;
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
  // Typed, but a caller in plain JS (or a stored run type cast through) must still not start a retired run.
  if (!(RUNNABLE_RUN_TYPES as readonly string[]).includes(opts.runType)) {
    throw new OrionError('invalid_run_type', `run type must be one of ${RUNNABLE_RUN_TYPES.join(', ')}, got ${String(opts.runType)}`);
  }
  const coverage = getCoverage(db, asset.id);
  if (!coverage) throw new OrionError('no_persona_assigned', `no persona covers ${asset.id}; run "orion persona assign ${asset.id} <name>"`);
  const persona = loadPersona(deps.home, coverage.persona);
  const skills = skillsFor(deps.home, opts.runType);
  const note = opts.note?.trim() || undefined;
  if (opts.docId === undefined) throw new OrionError('disclosure_needs_doc', 'a disclosure run needs --doc <id>');
  // Another asset's document is not found: the run may only ever cite its own asset's document.
  const document = getDocument(db, opts.docId);
  if (!document || document.assetId !== asset.id) throw new OrionError('doc_not_found', `no document ${opts.docId} on ${asset.id}`);
  if (opts.assetYaml === undefined) {
    throw new OrionError('disclosure_needs_asset_yaml', `a disclosure run needs the text of assets/${asset.id}.yaml for its pack`);
  }
  const targetDoc: CitableDoc = { id: document.id, kind: document.kind, sha256: document.sha256, text: document.text };
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
    assetId: asset.id, persona: persona.name, runType: opts.runType, trigger: 'manual',
    triggerDetail: {
      ...(opts.anomalyId !== undefined ? { anomalyId: opts.anomalyId } : {}),
      ...(note !== undefined ? { note } : {}),
      docId: document.id, docSha256: document.sha256,
    },
    dryRun: opts.dryRun === true, configHash, model: persona.model, startedAt: started.toISOString(),
  });

  // ---- the run: everything from here is recorded, never thrown ----
  const ledger = new Ledger(asset.id, persona.name);
  const messages: ModelMessageParam[] = [];
  const clientTools = toolsForRun(AGENT_TOOLS, opts.runType);
  const tools = [...toApiTools(clientTools), ...webTools(budgets)];
  let outcome: Exclude<AgentOutcome, 'running'> = 'error';
  let error: string | null = null;
  let usage: AgentUsage = { ...ZERO_USAGE };
  let responses: unknown[] = [];
  let committed: CommitSummary | null = null;
  let reserve: string | null = null;

  try {
    const pack = buildContextPack(db, loaded, ledger, {
      runType: opts.runType, budgets, now: started, trigger: { anomalyId: opts.anomalyId, note }, document, assetYaml: opts.assetYaml,
    });
    messages.push({ role: 'user', content: renderContextPack(pack) });
    const ctx: ToolContext = {
      db, loaded, ledger, now: deps.now, budgets, runType: opts.runType, fetchedPages: () => fetchedPagesFrom(messages),
      citableDocs: () => [targetDoc], targetDoc,
    };

    const loop = await runLoop({
      client, model: persona.model, effort: persona.effort, system, tools, messages, budgets,
      runTool: (name, input) => runTool(clientTools, ctx, name, input),
      isFinished: () => ledger.journal() !== null,
      reminder: JOURNAL_REMINDER,
    });
    usage = loop.usage;
    responses = loop.responses;
    reserve = loop.reserve;
    outcome = OUTCOME_OF[loop.stop];
    error = loop.stop === 'finished' ? null : loop.detail;

    if (outcome === 'completed' && opts.dryRun !== true) {
      // The metric definitions, the edit checks, and the run's config hash all came from `loaded`. If the file moved under the run,
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
      } else if (!current || current.hash !== loaded.hash) {
        outcome = 'conflict';
        error = `the asset config changed during the run (${loaded.hash.slice(0, 12)} -> ${current?.hash.slice(0, 12) ?? 'none'}); nothing was committed`;
      } else {
        try {
          committed = ledger.commit(db, { agentRunId: runId, now: deps.now() });
        } catch (err) {
          if (!(err instanceof AgentConflict)) throw err;
          outcome = 'conflict';
          error = err.message;
        }
      }
    }
  } catch (err) {
    outcome = 'error';
    error = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
  }

  const staged = ledger.preview();
  const finish = (transcript: unknown): AgentRun =>
    finishAgentRun(db, runId, {
      outcome, endedAt: deps.now().toISOString(), usage, error,
      summary: {
        committed, staged,
        // Only when the reserve request ran: a run that never needed it keeps the summary it always had.
        ...(reserve ? { reserve: { reason: reserve } } : {}),
      },
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
  return { run, staged, committed };
}
