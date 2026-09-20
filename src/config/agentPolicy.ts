import type { RunType, Scenario } from '../types.js';
import type { AssetConfig } from './schema.js';

export interface Range {
  min: number;
  max: number;
}

export interface RunBudgets {
  /** Model requests, pause_turn resumes included. */
  requests: number;
  /** Uncached input plus cache reads plus cache writes, summed over requests. */
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  webFetches: number;
  proposals: number;
}

export const DEFAULT_MAX_STEP_FRACTION = 0.25;
export const DEFAULT_PROVISIONAL_MOVE_PCT = 25;

export const DEFAULT_BUDGETS: Record<RunType, RunBudgets> = {
  weekly: { requests: 25, inputTokens: 600_000, outputTokens: 40_000, webSearches: 5, webFetches: 5, proposals: 10 },
  triage: { requests: 20, inputTokens: 500_000, outputTokens: 30_000, webSearches: 8, webFetches: 8, proposals: 10 },
  deep: { requests: 40, inputTokens: 2_000_000, outputTokens: 80_000, webSearches: 15, webFetches: 15, proposals: 10 },
};

/** Null when the asset defines no bounds for the key. */
export function keyBounds(asset: AssetConfig, key: string): Range | null {
  const b = asset.assumptions[key];
  return b ? { min: b.min, max: b.max } : null;
}

/** The range that binds the agent for this key and scenario: its band, or the key-wide bounds when it has none. */
export function agentBand(asset: AssetConfig, key: string, scenario: Scenario): Range | null {
  const b = asset.assumptions[key];
  if (!b) return null;
  const band = b[scenario];
  return band ? { min: band.min, max: band.max } : { min: b.min, max: b.max };
}

export function maxStepFraction(asset: AssetConfig): number {
  return asset.agent?.max_step_fraction ?? DEFAULT_MAX_STEP_FRACTION;
}

/** Percent move from the value in force beyond which a researched value on a critical metric becomes a proposal. */
export function provisionalMovePct(asset: AssetConfig): number {
  const v = asset.review_triggers.provisional_move_pct;
  return typeof v === 'number' ? v : DEFAULT_PROVISIONAL_MOVE_PCT;
}

export function budgetsFor(asset: AssetConfig, runType: RunType): RunBudgets {
  const d = DEFAULT_BUDGETS[runType];
  const o = asset.agent?.budgets?.[runType] ?? {};
  return {
    requests: o.requests ?? d.requests,
    inputTokens: o.input_tokens ?? d.inputTokens,
    outputTokens: o.output_tokens ?? d.outputTokens,
    webSearches: o.web_searches ?? d.webSearches,
    webFetches: o.web_fetches ?? d.webFetches,
    proposals: o.proposals ?? d.proposals,
  };
}
