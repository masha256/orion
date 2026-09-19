import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import type { AssumptionValues } from '../../src/types.js';

export const MINI_ASSET_YAML = `
id: mini
symbol: MINI
name: Mini Test Asset
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }
  effective_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, critical: true }
holder_flows:
  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees }
modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }
assumptions:
  rev_growth_y1: { min: -0.5, max: 5 }
  growth_fade_years: { min: 0, max: 10 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.fees: { min: 0, max: 1 }
  capture_ramp_years.fees: { min: 0, max: 10 }
  discount_rate_base: { min: 0.05, max: 0.5 }
  staked_ratio_horizon: { min: 0.05, max: 0.95 }
`;

export function miniAsset(): AssetConfig {
  return parseAssetYaml(MINI_ASSET_YAML).config;
}

/** Flat world: no growth, capture stays at 10 percent, 10 percent discount rate. Same in every scenario. */
export function miniAssumptions(over: Partial<Record<string, number>> = {}): AssumptionValues {
  const one = {
    rev_growth_y1: 0,
    growth_fade_years: 1,
    terminal_growth: 0,
    'capture_rate_terminal.fees': 0.1,
    'capture_ramp_years.fees': 0,
    discount_rate_base: 0.1,
    staked_ratio_horizon: 0.5,
    ...over,
  } as Record<string, number>;
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}
