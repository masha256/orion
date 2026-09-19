import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { validateAssetModules, validateAssumptions } from '../../src/engine/requirements.js';
import { runEngine } from '../../src/engine/run.js';
import {
  aeroAssumptions, aeroObservations, hypeAssumptions, hypeObservations, loadFixture,
} from '../fixtures/contrast.js';
import { AS_OF } from '../helpers/obs.js';

const SHARED = ['holder_cashflow', 'forward_multiple'];

describe('contrast assets are expressible as config only', () => {
  it.each(['hype', 'aero'] as const)('%s uses only shared modules and validates cleanly', (name) => {
    const asset = loadFixture(name);
    expect(asset.modules.every((m) => SHARED.includes(m.type))).toBe(true);
    expect(validateAssetModules(asset)).toEqual([]);
    expect(validateAssumptions(asset, name === 'hype' ? hypeAssumptions() : aeroAssumptions())).toEqual([]);
  });
});

describe('HYPE fixture', () => {
  const asset = loadFixture('hype');
  const target = (unlock: number) => {
    const drivers = computeDrivers(asset, hypeObservations(unlock), AS_OF).drivers!;
    return runEngine({ asset, drivers, assumptions: hypeAssumptions() }).horizons['6m'];
  };

  it('converges and reports a programmatic capture rate near 100 percent', () => {
    const drivers = computeDrivers(asset, hypeObservations(), AS_OF).drivers!;
    expect(drivers.captureRate).toBeCloseTo(0.97, 9);
    expect(drivers.holderFlows[0].captureRule).toBe('programmatic');
    const out = runEngine({ asset, drivers, assumptions: hypeAssumptions() });
    expect(out.converged).toBe(true);
    expect(out.horizons['12m'].expectedTarget).toBeGreaterThan(0);
  });

  it('scheduled unlocks dilute the per-token target on the circulating basis', () => {
    expect(target(100).expectedTarget).toBeLessThan(target(0).expectedTarget);
  });

  it('buy-and-hold purchases shrink circulating supply', () => {
    const s = target(0).scenarios.base;
    expect(s.supplyAtHorizon).toBeLessThan(300);
  });
});

describe('AERO fixture', () => {
  const asset = loadFixture('aero');
  const run = (emission: number) => {
    const drivers = computeDrivers(asset, aeroObservations(emission), AS_OF).drivers!;
    return runEngine({ asset, drivers, assumptions: aeroAssumptions() }).horizons['12m'];
  };

  it('records the locked recipient base in the breakdown', () => {
    const flows = run(200).modules.hc.breakdown.flows as Record<string, { recipient_base: string }>;
    expect(flows.fees.recipient_base).toBe('locked');
  });

  it('heavy emissions dilute the target but lift staker total return above price return', () => {
    const heavy = run(200);
    const none = run(0);
    expect(heavy.expectedTarget).toBeLessThan(none.expectedTarget);
    // fm = 1000 * 5 / 1200. hc no longer equals it: supply runs 1200, 1400, ... 2200 after the horizon,
    // so delta = 200/2200 and g_pt = -1/12, and twenty percent inflation costs hc about 40 percent.
    expect(heavy.modules.fm_flow.value).toBeCloseTo(5000 / 1200, 9);
    expect(heavy.modules.hc.value).toBeCloseTo(2.508729350189619, 9);
    expect(heavy.modules.hc.breakdown.supply_path).toEqual([1200, 1400, 1600, 1800, 2000, 2200]);
    expect(heavy.expectedTarget).toBeCloseTo(0.6 * 2.508729350189619 + 0.4 * (5000 / 1200), 9);
    expect(none.modules.hc.value).toBeCloseTo(5, 9); // no emissions: the 1.1.0 value, 1000 / 0.2 / 1000
    expect(heavy.stakedTotalReturnPct).toBeGreaterThan(heavy.upsidePct);
  });
});
