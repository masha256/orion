import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import type { Observation } from '../../src/db/observations.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { requiredExtraMetrics } from '../../src/engine/requirements.js';
import { runEngine } from '../../src/engine/run.js';
import type { AssumptionValues } from '../../src/types.js';
import { canonicalJson } from '../../src/util/canonical.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const AS_OF = '2026-09-18T12:00:00.000Z';

let nextId = 1;
function row(metricKey: string, value: number, observedAt: string, opts: Partial<Observation> = {}): Observation {
  const iso = new Date(observedAt).toISOString();
  return {
    id: nextId++,
    assetId: 'vvv',
    metricKey,
    observedAt: iso,
    periodDays: null,
    value,
    source: 'manual',
    sourceDetail: 'research pass 2026-09-18',
    status: 'confirmed',
    citationUrl: null,
    quotedText: null,
    fetchedAt: AS_OF,
    supersededBy: null,
    ...opts,
  };
}

/** Mirrors calibration/vvv-seed-2026-09-18.sh: same values, same dates, same period days. */
function seedObservations(): Observation[] {
  return [
    row('price_usd', 27.46, '2026-09-18'),
    row('effective_supply', 81003579, '2026-09-18'),
    row('circulating_supply', 48350000, '2026-09-18'),
    row('staked_supply', 33964988, '2026-09-18'),
    row('locked_supply', 8969695, '2026-09-18'),
    row('staker_emission_share', 0.947, '2026-09-18'),
    row('emission_rate_annual', 2500000, '2026-09-01'),
    row('emission_rate_annual', 2000000, '2026-10-01'),
    row('flow_usd.burn', 241800, '2026-07-01', { periodDays: 30 }),
    row('flow_usd.burn', 445200, '2026-08-01', { periodDays: 31 }),
    row('flow_usd.burn', 702700, '2026-09-01', { periodDays: 31 }),
    row('flow_usd.burn', 676500, '2026-09-18', { periodDays: 17 }),
    row('diem_supply', 37759.6, '2026-09-18'),
    row('diem_target_supply', 40000, '2026-09-14'),
    row('diem_price_usd', 2057.69, '2026-09-18'),
    row('diem_locked_yield_share', 0.8, '2026-09-18'),
    // Revenue is a secondhand disclosure: provisional, and eligible because the metric allows it.
    row('revenue_run_rate_usd', 100000000, '2026-08-17', {
      status: 'provisional',
      citationUrl: 'https://coincodex.com/article/90258/vvv-spikes-20-as-venice-ai-tops-100m-annualized-revenue/',
      quotedText: 'Venice just crossed $100m annualized revenue',
    }),
  ];
}

function draftAssumptions(): AssumptionValues {
  const raw = parseYaml(readFileSync(`${ROOT}/tests/fixtures/vvv-golden-assumptions.yaml`, 'utf8')) as Record<string, Record<string, number>>;
  return {
    bear: { ...raw.all, ...raw.bear },
    base: { ...raw.all, ...raw.base },
    bull: { ...raw.all, ...raw.bull },
  };
}

// Reads frozen fixture copies, not assets/vvv.yaml or calibration/: recalibrating VVV must not
// move this hash. Only engine or driver math may.
describe('VVV end to end on the frozen golden config, seed data, and draft assumptions', () => {
  const { config } = parseAssetYaml(readFileSync(`${ROOT}/tests/fixtures/vvv-golden.yaml`, 'utf8'));
  const report = computeDrivers(config, seedObservations(), AS_OF, requiredExtraMetrics(config));
  const drivers = report.drivers!;
  const output = runEngine({ asset: config, drivers, assumptions: draftAssumptions() });
  const h12 = output.horizons['12m'];
  const h6 = output.horizons['6m'];

  it('computes drivers from the seed data with nothing missing or overlapping', () => {
    expect(report.missing).toEqual([]);
    expect(report.overlappingFlowMetrics).toEqual([]);
    expect(report.provisionalMetrics).toEqual(['revenue_run_rate_usd']);
    // The 90 days of reported burns ending 2026-09-18 are 88660 + 445200 + 702700 + 676500 USD,
    // annualized over 90 days and divided by the 100M revenue run rate.
    expect(drivers.captureRate).toBeCloseTo((((241800 * 11) / 30 + 445200 + 702700 + 676500) * 365) / 90 / 1e8, 12);
    expect(drivers.captureRate).toBeCloseTo(0.07758521111111111, 12);
  });

  it('produces the expected 12 month valuation', () => {
    expect(output.converged).toBe(true);
    expect(output.spot).toBe(27.46);
    expect(h12.expectedTarget).toBeCloseTo(33.09189067465379, 6);
    expect(h12.modules.hc.value).toBeCloseTo(13.680588298103167, 6); // 17.0932 under engine 1.1.0, before post-horizon dilution
    expect(h12.modules.fm_revenue.value).toBeCloseTo(73.24089032332991, 6);
    expect(h12.modules.fm_holder_flow.value).toBeCloseTo(18.10761428046546, 6);
    expect(h12.modules.diem.value).toBeCloseTo(0.215103974273912, 6);
    expect(h12.scenarios.base.supplyAtHorizon).toBeCloseTo(82479613.28300588, 2);
    expect(h12.modules.hc.breakdown.net_dilution_terminal).toBeCloseTo(2000000 / 92479613.28300588, 9);
  });

  it('produces the expected 6 month valuation', () => {
    expect(h6.expectedTarget).toBeCloseTo(23.54875825524369, 6);
    expect(h6.modules.hc.value).toBeCloseTo(12.840285411368317, 6);
    expect(h6.modules.fm_revenue.value).toBeCloseTo(49.7747476937811, 6);
    expect(h6.modules.fm_holder_flow.value).toBeCloseTo(10.605299526641362, 6);
    expect(h6.modules.diem.value).toBeCloseTo(0.29862992456962256, 6);
    expect(h6.scenarios.base.supplyAtHorizon).toBeCloseTo(81775278.851763, 2);
  });

  it('carries the utility_claim component alongside the estimates and keeps it out of dispersion', () => {
    for (const h of [h6, h12]) {
      expect(h.modules.diem.type).toBe('utility_claim');
      expect(h.modules.diem.kind).toBe('component');
      expect(h.modules.diem.weight).toBeNull();

      const estimates = ['hc', 'fm_revenue', 'fm_holder_flow'].map((id) => h.modules[id].value);
      const blended = 0.4 * h.modules.hc.value + 0.3 * h.modules.fm_revenue.value + 0.3 * h.modules.fm_holder_flow.value;
      expect(h.dispersion).toBeCloseTo((Math.max(...estimates) - Math.min(...estimates)) / blended, 12);
      // the component is added on top of the weighted estimates, so it lifts the target without
      // widening the spread the estimates disagree by
      expect(h.expectedTarget).toBeGreaterThan(blended);
    }
  });

  it('reproduces the pinned engine output byte for byte', () => {
    const hash = createHash('sha256').update(canonicalJson(output)).digest('hex');
    // Changing this hash means engine or driver math changed: bump ENGINE_VERSION in
    // src/engine/version.ts, then update the hash.
    expect(hash).toBe('6b3f9fa36241c2071c0108d5b5d0b2cf5dba2d0ccd574c65f53da9e3c519311a');
  });
});
