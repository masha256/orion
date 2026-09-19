export const SCENARIOS = ['bear', 'base', 'bull'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const HORIZONS = ['6m', '12m'] as const;
export type Horizon = (typeof HORIZONS)[number];
export const HORIZON_YEARS: Record<Horizon, number> = { '6m': 0.5, '12m': 1 };

export type Provenance = 'onchain' | 'api' | 'manual' | 'provisional';
export const PROVENANCE_RANK: Record<Provenance, number> = { onchain: 0, api: 1, manual: 2, provisional: 3 };

export type ObservationSource = 'onchain' | 'api' | 'manual';
export type ObservationStatus = 'confirmed' | 'provisional' | 'rejected';

export const MS_PER_DAY = 86_400_000;
export const DAYS_PER_YEAR = 365;

/** Standard metric keys. Fetchers (or manual entry) must produce these names. */
export const STD_METRICS = {
  price: 'price_usd',
  revenue: 'revenue_run_rate_usd',
  usageIndex: 'usage_index',
  effectiveSupply: 'effective_supply',
  circulatingSupply: 'circulating_supply',
  stakedSupply: 'staked_supply',
  lockedSupply: 'locked_supply',
  emissionRate: 'emission_rate_annual',
  stakerEmissionShare: 'staker_emission_share',
  scheduledUnlock: 'scheduled_unlock_tokens',
} as const;

export type ScenarioAssumptions = Record<string, number>;
export type AssumptionValues = Record<Scenario, ScenarioAssumptions>;

export class OrionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OrionError';
  }
}
