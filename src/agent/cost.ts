import type { AgentUsage } from '../db/agentRuns.js';

/**
 * List prices in USD per million tokens. Costs are never stored: runs keep token counts, and this table turns them into
 * an estimate when someone looks, so a price change never makes stored data wrong. Update it when prices change.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const USD_PER_WEB_SEARCH = 0.01;

/** Estimated USD for a run at list prices, or null for a model this table does not know. A fallback model's turns are priced as the requested model's. */
export function estimateCostUsd(model: string, usage: AgentUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const tokens = usage.inputTokens * p.input + usage.cacheReadTokens * p.cacheRead + usage.cacheWriteTokens * p.cacheWrite + usage.outputTokens * p.output;
  return tokens / 1_000_000 + usage.webSearches * USD_PER_WEB_SEARCH;
}
