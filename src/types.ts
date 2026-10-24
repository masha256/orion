export const SCENARIOS = ['bear', 'base', 'bull'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const HORIZONS = ['6m', '12m'] as const;
export type Horizon = (typeof HORIZONS)[number];
export const HORIZON_YEARS: Record<Horizon, number> = { '6m': 0.5, '12m': 1 };

export type Provenance = 'onchain' | 'api' | 'manual' | 'provisional';
export const PROVENANCE_RANK: Record<Provenance, number> = { onchain: 0, api: 1, manual: 2, provisional: 3 };

export type ObservationSource = 'onchain' | 'api' | 'manual';
export type ObservationStatus = 'confirmed' | 'provisional' | 'rejected';

export const RUN_TYPES = ['weekly', 'triage', 'deep', 'bootstrap', 'disclosure'] as const;
export type RunType = (typeof RUN_TYPES)[number];

/** A monitor-only metric's watch rules (config `metrics.<key>.watch`; evaluated in src/ingest/watch.ts). */
export const WATCH_RULES = ['above', 'change_pct', 'outside'] as const;
export type WatchRule = (typeof WATCH_RULES)[number];

/**
 * A watched monitor-only metric that moved this fetch. Reported in the fetch run's detail and the tick report, never as an
 * anomaly: every open anomaly fires the `open_anomaly` trigger, which starts a paid analyst run, and display data must
 * never wake the analyst. `day` is the last covered day for a flow (the day before its period end, where it is stored;
 * for a one-day flow, the covered day), the reading's UTC date for a level. Here, not in src/ingest, because the db layer
 * stores it (fetch_runs.detail_json.watch).
 */
export interface WatchFiring {
  metric: string;
  rule: WatchRule;
  value: number;
  previous: number | null;
  day: string;
}

export const MS_PER_DAY = 86_400_000;
export const DAYS_PER_YEAR = 365;

/** Standard metric keys. Fetchers (or manual entry) must produce these names. */
export const STD_METRICS = {
  price: 'price_usd',
  revenue: 'revenue_run_rate_usd',
  usageIndex: 'usage_index',
  totalSupply: 'total_supply',
  circulatingSupply: 'circulating_supply',
  stakedSupply: 'staked_supply',
  lockedSupply: 'locked_supply',
  emissionRate: 'emission_rate_annual',
  stakerEmissionShare: 'staker_emission_share',
  scheduledUnlock: 'scheduled_unlock_tokens',
} as const;

/** Addresses a place in an asset config. A string selects a map key, or the item with that `id` in a list of items that have ids. A number selects by index. */
export type PathSegment = string | number;
export interface ConfigEdit {
  path: PathSegment[];
  /** `null` deletes the key. */
  value: unknown;
}

export type ScenarioAssumptions = Record<string, number>;
export type AssumptionValues = Record<Scenario, ScenarioAssumptions>;

export class OrionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OrionError';
  }
}
