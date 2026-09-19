import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import type { Observation } from '../../src/db/observations.js';
import type { AssumptionValues } from '../../src/types.js';
import { AS_OF, obs } from '../helpers/obs.js';

export function loadFixture(name: 'hype' | 'aero'): AssetConfig {
  const path = fileURLToPath(new URL(`./${name}.yaml`, import.meta.url));
  return parseAssetYaml(readFileSync(path, 'utf8')).config;
}

const flow = (assetId: string, metric: string, annual: number): Observation =>
  obs(metric, (annual * 90) / 365, AS_OF, { assetId, periodDays: 90 });
const at = (assetId: string, metric: string, value: number, when = '2026-06-29'): Observation =>
  obs(metric, value, when, { assetId });

/** Revenue 1000, buyback 970 per year (capture 0.97), price 10, circulating 300 of 1000, unlock of 100 in 3 months. */
export function hypeObservations(unlockTokens = 100): Observation[] {
  return [
    at('hype', 'price_usd', 10),
    at('hype', 'revenue_run_rate_usd', 1000),
    at('hype', 'effective_supply', 1000),
    at('hype', 'circulating_supply', 300),
    at('hype', 'staked_supply', 400),
    at('hype', 'staker_emission_share', 1),
    obs('emission_rate_annual', 0, '2026-01-01', { assetId: 'hype', fetchedAt: '2026-06-29T00:00:00.000Z' }),
    obs('scheduled_unlock_tokens', unlockTokens, '2026-09-30', { assetId: 'hype', fetchedAt: '2026-06-29T00:00:00.000Z' }),
    flow('hype', 'flow_usd.buyback', 970),
  ];
}

/** Revenue 1000, all of it to lockers (capture 1.0), supply 1000, emissions 200 per year (20 percent inflation). */
export function aeroObservations(emission = 200): Observation[] {
  return [
    at('aero', 'price_usd', 5),
    at('aero', 'revenue_run_rate_usd', 1000),
    at('aero', 'effective_supply', 1000),
    at('aero', 'staked_supply', 500),
    at('aero', 'locked_supply', 500),
    at('aero', 'staker_emission_share', 1),
    obs('emission_rate_annual', emission, '2026-01-01', { assetId: 'aero', fetchedAt: '2026-06-29T00:00:00.000Z' }),
    flow('aero', 'flow_usd.fees', 1000),
  ];
}

const same = (one: Record<string, number>): AssumptionValues => ({ bear: { ...one }, base: { ...one }, bull: { ...one } });

export function hypeAssumptions(): AssumptionValues {
  return same({
    rev_growth_y1: 0, growth_fade_years: 1, terminal_growth: 0,
    'capture_rate_terminal.buyback': 0.97, 'capture_ramp_years.buyback': 0,
    discount_rate_base: 0.1, discount_premium_programmatic: 0.05,
    'multiple.fm_flow': 10, regime_multiplier: 1, staked_ratio_horizon: 0.4,
  });
}

export function aeroAssumptions(): AssumptionValues {
  return same({
    rev_growth_y1: 0, growth_fade_years: 1, terminal_growth: 0,
    'capture_rate_terminal.fees': 1, 'capture_ramp_years.fees': 0,
    discount_rate_base: 0.2, 'multiple.fm_flow': 5, regime_multiplier: 1, staked_ratio_horizon: 0.5,
  });
}
