import { OrionError, type RunType } from '../types.js';
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

export async function startAgentRun(db: Db, input: StartAgentRunInput): Promise<number> {
  const inserted = await db.run<{ id: number }>(
    `INSERT INTO agent_runs (asset_id, persona, run_type, trigger_kind, trigger_detail_json, outcome, dry_run, config_hash, model, started_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9)
     RETURNING id`,
    [
      input.assetId, input.persona, input.runType, input.trigger, JSON.stringify(input.triggerDetail), input.dryRun ? 1 : 0,
      input.configHash, input.model, new Date(input.startedAt).toISOString(),
    ],
  );
  return Number(inserted.rows[0].id);
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
 * once. "Finished" means its transcript exists, not that its outcome left `running`: a lock takeover marks a run as
 * abandoned without a transcript, and if that process was alive after all, its one finish must still record what happened.
 */
export async function finishAgentRun(db: Db, id: number, input: FinishAgentRunInput): Promise<AgentRun> {
  const run = await db.one<{ asset_id: string }>('SELECT asset_id FROM agent_runs WHERE id = $1', [id]);
  // In one transaction: the already-finished check reads before anything is written, and another writer finishing the
  // run in between must not leave it finished twice (or the row `running` although its domain writes are live).
  await db.tx(
    async (t) => {
      const finished = await t.one('SELECT 1 FROM agent_transcripts WHERE run_id = $1', [id]);
      if (finished) throw new OrionError('agent_run_already_finished', `agent run ${id} was already finished; its record and transcript are not rewritten`);
      const u = input.usage;
      await t.run(
        `UPDATE agent_runs SET outcome = $1, ended_at = $2, requests = $3, input_tokens = $4, cache_read_tokens = $5, cache_write_tokens = $6,
           output_tokens = $7, web_searches = $8, web_fetches = $9, error = $10, summary_json = $11 WHERE id = $12`,
        [
          input.outcome, new Date(input.endedAt).toISOString(), u.requests, u.inputTokens, u.cacheReadTokens, u.cacheWriteTokens,
          u.outputTokens, u.webSearches, u.webFetches, input.error, input.summary === null ? null : JSON.stringify(input.summary), id,
        ],
      );
      await t.run('INSERT INTO agent_transcripts (run_id, messages_json) VALUES ($1, $2)', [id, JSON.stringify(input.transcript)]);
    },
    // No row: the insert below fails on its foreign key, as before; there is no asset to lock.
    run ? { lockAsset: run.asset_id } : {},
  );
  return (await getAgentRun(db, id))!;
}

export async function getAgentRun(db: Db, id: number): Promise<AgentRun | null> {
  const row = await db.one<Row>('SELECT * FROM agent_runs WHERE id = $1', [id]);
  return row ? fromRow(row) : null;
}

export async function getTranscript(db: Db, runId: number): Promise<unknown | null> {
  const row = await db.one<{ messages_json: string }>('SELECT messages_json FROM agent_transcripts WHERE run_id = $1', [runId]);
  return row ? (JSON.parse(row.messages_json) as unknown) : null;
}

/** Newest first. */
export async function listAgentRuns(db: Db, filter: { assetId?: string; limit?: number } = {}): Promise<AgentRun[]> {
  const limit = filter.limit ?? 20;
  const rows =
    filter.assetId === undefined
      ? await db.all<Row>('SELECT * FROM agent_runs ORDER BY id DESC LIMIT $1', [limit])
      : await db.all<Row>('SELECT * FROM agent_runs WHERE asset_id = $1 ORDER BY id DESC LIMIT $2', [filter.assetId, limit]);
  return rows.map(fromRow);
}

/**
 * A killed process leaves a `running` row behind. The run lock decides when that has happened (whoever holds an asset's
 * run lock knows no other process is running it); this marks the rows. Returns how many were marked.
 */
export async function abandonRunningRuns(db: Db, assetId: string, nowIso: string): Promise<number> {
  const result = await db.run(
    "UPDATE agent_runs SET outcome = 'error', error = 'abandoned', ended_at = $1 WHERE asset_id = $2 AND outcome = 'running'",
    [new Date(nowIso).toISOString(), assetId],
  );
  return result.rowCount;
}
