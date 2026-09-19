import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { MINI_ASSET_YAML, miniAsset } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

describe('computeDrivers', () => {
  it('computes standard drivers for a complete data set', () => {
    const r = computeDrivers(miniAsset(), miniObservations(), AS_OF);
    expect(r.missing).toEqual([]);
    const d = r.drivers!;
    expect(d.price.value).toBe(10);
    expect(d.fdv.value).toBe(1000);
    expect(d.fdv.derived).toBe(true);
    expect(d.stakedRatio.value).toBe(0.5);
    expect(d.holderFlows[0].annualizedUsd.value).toBeCloseTo(100, 9);
    expect(d.holderFlows[0].captureRate).toBeCloseTo(0.1, 9);
    expect(d.captureRate).toBeCloseTo(0.1, 9);
    expect(d.emissionSchedule).toEqual([{ from: '2026-01-01T00:00:00.000Z', value: 0 }]);
    expect(d.marketCap).toBeNull();
  });

  it('computes real staking yield as staker APR minus inflation', () => {
    const d = computeDrivers(miniAsset(), miniObservations({ emission: 10 }), AS_OF).drivers!;
    // staker APR = 10 * 1 / 50 = 0.2 ; inflation = 10 / 100 = 0.1
    expect(d.realStakingYield.value).toBeCloseTo(0.1, 9);
  });

  it('reports missing required metrics and returns no drivers', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd');
    const r = computeDrivers(miniAsset(), list, AS_OF);
    expect(r.drivers).toBeNull();
    expect(r.missing).toEqual(['price_usd']);
  });

  it('reports a missing required extra metric', () => {
    const r = computeDrivers(miniAsset(), miniObservations(), AS_OF, ['diem_supply']);
    expect(r.missing).toEqual(['diem_supply']);
  });

  it('flags stale, critical, manual, and provisional metrics', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd' && o.metricKey !== 'staked_supply');
    list.push(obs('price_usd', 10, '2026-06-01'));
    list.push(obs('staked_supply', 50, '2026-06-29', { source: 'manual' }));
    list.push(obs('revenue_run_rate_usd', 1000, '2026-06-20', { source: 'manual', status: 'provisional' }));
    const r = computeDrivers(miniAsset(), list, AS_OF);
    expect(r.staleMetrics).toEqual(['price_usd']);
    expect(r.staleCritical).toEqual(['price_usd']);
    expect(r.manualMetrics).toEqual(['staked_supply']);
    expect(r.provisionalMetrics).toEqual(['revenue_run_rate_usd']);
    expect(r.drivers!.captureRate).toBeCloseTo(0.1, 9);
    expect(r.drivers!.fdv.provenance).toBe('onchain');
  });

  it('uses the oldest input observedAt for the derived holder-flow driver, not the newest', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'flow_usd.fees');
    list.push(obs('flow_usd.fees', 10, '2026-05-01', { periodDays: 30 }));
    list.push(obs('flow_usd.fees', 10, '2026-05-31', { periodDays: 30 }));
    list.push(obs('flow_usd.fees', 10, '2026-06-30', { periodDays: 30 }));
    const r = computeDrivers(miniAsset(), list, AS_OF);
    expect(r.staleMetrics).not.toContain('flow_usd.fees');
    expect(r.drivers!.holderFlows[0].annualizedUsd.observedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('puts non-standard level metrics in extra', () => {
    const yaml = MINI_ASSET_YAML.replace('holder_flows:', '  widget_count: { type: level, unit: count, staleness_days: 30 }\nholder_flows:');
    const asset = parseAssetYaml(yaml).config;
    const r = computeDrivers(asset, [...miniObservations(), obs('widget_count', 7, '2026-06-29')], AS_OF);
    expect(r.drivers!.extra.widget_count.value).toBe(7);
  });
});
