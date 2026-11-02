import type { RunnableRunType } from '../types.js';
import type { AgentUsage } from '../db/agentRuns.js';
import type { AssetConfig } from './schema.js';

export interface RunBudgets {
  /** Model requests, pause_turn resumes included. */
  requests: number;
  /** Input units: uncached ×1 + cache writes ×1.25 + cache reads ×0.1, summed over requests; the YAML key is `input_tokens`. */
  inputUnits: number;
  outputTokens: number;
  webSearches: number;
  webFetches: number;
  proposals: number;
}

/** What one input token counts toward the input budget, by kind. Fixed, and the same for every model. */
export const INPUT_UNIT_WEIGHTS = { uncached: 1, cacheWrite: 1.25, cacheRead: 0.1 } as const;

/** Input units spent, in tenths of a unit so the count is exact (0.1 is not, in a double; 12.5 × an integer is). */
export function inputUnitsTenths(u: Pick<AgentUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return 10 * u.inputTokens + 12.5 * u.cacheWriteTokens + u.cacheReadTokens;
}

/**
 * Percent move from the value in force beyond which a researched value on a critical metric becomes a proposal rather
 * than a provisional observation. Fixed; it was `review_triggers.provisional_move_pct`, 25 on every asset.
 */
export const PROVISIONAL_MOVE_PCT = 25;

/**
 * Per runnable run type. An asset YAML may still carry `agent.budgets` for the retired types (the schema accepts them
 * until the config keys go); nothing reads them.
 */
export const DEFAULT_BUDGETS: Record<RunnableRunType, RunBudgets> = {
  /** Reviews one stored document (an issuer's call or post) against Orion's numbers. Expected $1 to $3, about $7 worst case with no cache hits. */
  disclosure: { requests: 25, inputUnits: 1_200_000, outputTokens: 40_000, webSearches: 3, webFetches: 5, proposals: 5 },
};

export function budgetsFor(asset: AssetConfig, runType: RunnableRunType): RunBudgets {
  const d = DEFAULT_BUDGETS[runType];
  const o = asset.agent?.budgets?.[runType] ?? {};
  return {
    requests: o.requests ?? d.requests,
    inputUnits: o.input_tokens ?? d.inputUnits,
    outputTokens: o.output_tokens ?? d.outputTokens,
    webSearches: o.web_searches ?? d.webSearches,
    webFetches: o.web_fetches ?? d.webFetches,
    proposals: o.proposals ?? d.proposals,
  };
}
