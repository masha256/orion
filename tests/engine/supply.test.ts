import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { emissionsBetween, forecastSupply } from '../../src/engine/supply.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

describe('emissionsBetween', () => {
  it('integrates a step schedule', () => {
    const steps = [
      { from: '2025-01-01T00:00:00.000Z', value: 1000 },
      { from: '2026-03-15T00:00:00.000Z', value: 500 }, // 73 days = 0.2 years after asOf
    ];
    expect(emissionsBetween(steps, '2026-01-01T00:00:00.000Z', 0, 0.5)).toBeCloseTo(1000 * 0.2 + 500 * 0.3, 9);
  });
  it('is zero before the first step', () => {
    expect(emissionsBetween([{ from: '2027-01-01T00:00:00.000Z', value: 500 }], '2026-01-01T00:00:00.000Z', 0, 0.5)).toBe(0);
  });
});

describe('forecastSupply', () => {
  const a = miniAssumptions().base;

  it('adds emissions and leaves a fee-share asset otherwise unchanged', () => {
    const drivers = computeDrivers(miniAsset(), miniObservations({ emission: 10 }), AS_OF).drivers!;
    expect(forecastSupply({ asset: miniAsset(), drivers, assumptions: a, horizonYears: 1, targetPrice: 10 })).toBeCloseTo(110, 9);
  });

  it('removes burned tokens along the price path', () => {
    const asset = miniAsset();
    asset.holder_flows[0].kind = 'burn';
    const list = miniObservations({ price: 1, revenue: 12000, supply: 100000, flowAnnual: 1200 });
    const drivers = computeDrivers(asset, list, AS_OF).drivers!;
    // 1200 USD per year at a flat price of 1 for half a year = 600 tokens
    expect(forecastSupply({ asset, drivers, assumptions: a, horizonYears: 0.5, targetPrice: 1 })).toBeCloseTo(100000 - 600, 6);
    // a higher target means a higher price path, so fewer tokens are burned
    const higher = forecastSupply({ asset, drivers, assumptions: a, horizonYears: 0.5, targetPrice: 3 });
    expect(higher).toBeGreaterThan(100000 - 600);
  });

  it('counts scheduled unlocks only on the circulating basis', () => {
    const asset = miniAsset();
    const list = [...miniObservations(), obs('circulating_supply', 40, '2026-06-29'), obs('scheduled_unlock_tokens', 5, '2026-09-01')];
    asset.metrics.circulating_supply = { ...asset.metrics.effective_supply };
    asset.metrics.scheduled_unlock_tokens = { ...asset.metrics.emission_rate_annual, type: 'event' };
    const total = computeDrivers(asset, list, AS_OF).drivers!;
    expect(forecastSupply({ asset, drivers: total, assumptions: a, horizonYears: 0.5, targetPrice: 10 })).toBeCloseTo(100, 9);
    asset.supply_basis = 'circulating';
    expect(forecastSupply({ asset, drivers: total, assumptions: a, horizonYears: 0.5, targetPrice: 10 })).toBeCloseTo(45, 9);
  });
});
