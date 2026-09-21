import { MS_PER_DAY, OrionError, type RunType } from '../types.js';
import type { Db } from './connection.js';

export type AgentOutcome = 'running' | 'completed' | 'budget_exhausted' | 'refused' | 'no_journal' | 'conflict' | 'error';

export interface AgentUsage {
  requests: number;
  /** Uncached input tokens. The budget counts this plus both cache figures. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  webSearches: number;
  webFetches: number;
}

export const ZERO_USAGE: AgentUsage = {
  requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, webSearches: 0, webFetches: 0,
};

export interface AgentRun {
  id: number;
  assetId: string;
  persona: string;
  runType: RunType;
  trigger: string;
  triggerDetail: Record<string, unknown>;
  outcome: AgentOutcome;
  dryRun: boolean;
  configHash: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  usage: AgentUsage;
  error: string | null;
  summary: Record<string, unknown> | null;
}

interface Row {
  id: number;
  asset_id: string;
  persona: string;
  run_type: RunType;
  trigger_kind: string;
  trigger_detail_json: string;
  outcome: AgentOutcome;
  dry_run: number;
  config_hash: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  requests: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  web_searches: number;
  web_fetches: number;
  error: string | null;
  summary_json: string | null;
}

function fromRow(r: Row): AgentRun {
  return {
    id: r.id, assetId: r.asset_id, persona: r.persona, runType: r.run_type, trigger: r.trigger_kind,
    triggerDetail: JSON.parse(r.trigger_detail_json) as Record<string, unknown>, outcome: r.outcome, dryRun: r.dry_run === 1,
    configHash: r.config_hash, model: r.model, startedAt: r.started_at, endedAt: r.ended_at,
    usage: {
      requests: r.requests, inputTokens: r.input_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens,
      outputTokens: r.output_tokens, webSearches: r.web_searches, webFetches: r.web_fetches,
    },
    error: r.error,
    summary: r.summary_json === null ? null : (JSON.parse(r.summary_json) as Record<string, unknown>),
  };
}

export interface StartAgentRunInput {
  assetId: string;
  persona: string;
  runType: RunType;
  trigger: string;
  triggerDetail: Record<string, unknown>;
  dryRun: boolean;
  configHash: string;
  model: string;
  startedAt: string;
}

export function startAgentRun(db: Db, input: StartAgentRunInput): number {
  const info = db
    .prepare(
      `INSERT INTO agent_runs (asset_id, persona, run_type, trigger_kind, trigger_detail_json, outcome, dry_run, config_hash, model, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    .run(
      input.assetId, input.persona, input.runType, input.trigger, JSON.stringify(input.triggerDetail), input.dryRun ? 1 : 0,
      input.configHash, input.model, new Date(input.startedAt).toISOString(),
    );
  return Number(info.lastInsertRowid);
}

export interface FinishAgentRunInput {
  outcome: Exclude<AgentOutcome, 'running'>;
  endedAt: string;
  usage: AgentUsage;
  error: string | null;
  summary: Record<string, unknown> | null;
  /** The full message history plus per-response metadata. Stored apart from the run row. */
  transcript: unknown;
}

/**
 * The run record survives whatever the outcome: this is never part of the ledger's transaction. A run is finished exactly
 * once. "Finished" means its transcript exists, not that its outcome left `running`: abandonStaleRuns marks a run as
 * abandoned without a transcript, and if that process was alive after all, its one finish must still record what happened.
 */
export function finishAgentRun(db: Db, id: number, input: FinishAgentRunInput): AgentRun {
  // IMMEDIATE: the already-finished check reads before anything is written, and a deferred transaction would take the
  // write lock only afterwards. Another connection committing in between would fail this one outright, leaving the run
  // row `running` although its domain writes are live.
  db.transaction(() => {
    const finished = db.prepare('SELECT 1 FROM agent_transcripts WHERE run_id = ?').get(id);
    if (finished) throw new OrionError('agent_run_already_finished', `agent run ${id} was already finished; its record and transcript are not rewritten`);
    const u = input.usage;
    db.prepare(
      `UPDATE agent_runs SET outcome = ?, ended_at = ?, requests = ?, input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
         output_tokens = ?, web_searches = ?, web_fetches = ?, error = ?, summary_json = ? WHERE id = ?`,
    ).run(
      input.outcome, new Date(input.endedAt).toISOString(), u.requests, u.inputTokens, u.cacheReadTokens, u.cacheWriteTokens,
      u.outputTokens, u.webSearches, u.webFetches, input.error, input.summary === null ? null : JSON.stringify(input.summary), id,
    );
    db.prepare(
      'INSERT INTO agent_transcripts (run_id, messages_json) VALUES (?, ?)',
    ).run(id, JSON.stringify(input.transcript));
  }).immediate();
  return getAgentRun(db, id)!;
}

export function getAgentRun(db: Db, id: number): AgentRun | null {
  const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function getTranscript(db: Db, runId: number): unknown | null {
  const row = db.prepare('SELECT messages_json FROM agent_transcripts WHERE run_id = ?').get(runId) as { messages_json: string } | undefined;
  return row ? (JSON.parse(row.messages_json) as unknown) : null;
}

/** Newest first. */
export function listAgentRuns(db: Db, filter: { assetId?: string; limit?: number } = {}): AgentRun[] {
  const limit = filter.limit ?? 20;
  const rows = (
    filter.assetId === undefined
      ? db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM agent_runs WHERE asset_id = ? ORDER BY id DESC LIMIT ?').all(filter.assetId, limit)
  ) as Row[];
  return rows.map(fromRow);
}

/** The newest completed, non-dry run for the asset: what "since the previous agent run" means. */
export function lastCompletedRun(db: Db, assetId: string): AgentRun | null {
  const row = db
    .prepare("SELECT * FROM agent_runs WHERE asset_id = ? AND outcome = 'completed' AND dry_run = 0 ORDER BY id DESC LIMIT 1")
    .get(assetId) as Row | undefined;
  return row ? fromRow(row) : null;
}

const ABANDON_AFTER_MS = MS_PER_DAY / 24;

/** A killed process leaves a `running` row behind. There is no run lock yet, so age is the only test. Returns how many were marked. */
export function abandonStaleRuns(db: Db, assetId: string, nowIso: string): number {
  const cutoff = new Date(new Date(nowIso).getTime() - ABANDON_AFTER_MS).toISOString();
  const info = db
    .prepare("UPDATE agent_runs SET outcome = 'error', error = 'abandoned', ended_at = ? WHERE asset_id = ? AND outcome = 'running' AND started_at < ?")
    .run(new Date(nowIso).toISOString(), assetId, cutoff);
  return info.changes;
}
