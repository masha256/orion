import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { registerAdapter } from '../../src/ingest/adapters/registry.js';
import { buildPlan, hasSources } from '../../src/ingest/plan.js';
import type { OrionError } from '../../src/types.js';
import { miniAsset } from '../helpers/assets.js';
import { INGEST_ASSET_YAML, ingestAsset, POOL, SAFE, SINK, TOKEN } from '../helpers/ingestAsset.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

describe('buildPlan', () => {
  const plan = buildPlan(ingestAsset().config);

  it('batches requests by source, primaries and cross-checks alike, in config order', () => {
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'primary:circulating_supply']],
      ['http_json:https://api.example.test/stats', ['cross_check:price_usd', 'cross_check:effective_supply']],
      ['chain_levels', ['primary:effective_supply', 'primary:staked_supply', 'primary:emission_rate_annual']],
      ['defillama:mini:dailyHoldersRevenue', ['cross_check:flow_usd.fees']],
    ]);
    expect(plan.needsRpc).toBe(true);
    expect(plan.derived).toEqual([]);
  });

  it('uses the cross-check tolerance, falling back to the metric tolerance', () => {
    const checks = plan.batches[1].requests;
    expect(checks[0].tolerancePct).toBe(2);
    expect(checks[1].tolerancePct).toBe(0.1); // effective_supply.tolerance_pct
  });

  it('groups transfer_flow metrics that share token, sink, and allowlist into one scan', () => {
    expect(plan.flowGroups).toHaveLength(1);
    const g = plan.flowGroups[0];
    expect(g.scanKey).toMatch(/^[0-9a-f]{16}$/);
    expect(g.sourceId).toBe('transfer_flow:token>burn_sink[pool,safe]');
    expect(g.token).toBe(TOKEN);
    expect(g.sink).toBe(SINK);
    expect(g.allowlist).toEqual([{ name: 'pool', address: POOL }, { name: 'safe', address: SAFE }]);
    expect(g.members).toEqual([
      { metricKey: 'flow_usd.fees', unit: 'usd', countFrom: [POOL, SAFE], priceCoingeckoId: 'mini-token' },
      { metricKey: 'flow_tokens.fees', unit: 'tokens', countFrom: [POOL, SAFE], priceCoingeckoId: null },
      { metricKey: 'flow_usd.fees_programmatic', unit: 'usd', countFrom: [POOL], priceCoingeckoId: 'mini-token' },
    ]);
  });

  it('starts a separate scan for a different allowlist, with a different cursor key', () => {
    const yaml = INGEST_ASSET_YAML.replace('from_allowlist: [pool, safe], unit: tokens }', 'from_allowlist: [pool], unit: tokens }');
    const groups = buildPlan(parseAssetYaml(yaml).config).flowGroups;
    expect(groups).toHaveLength(2);
    expect(groups[0].scanKey).not.toBe(groups[1].scanKey);
  });

  it('narrows to the requested metrics, cross-checks included', () => {
    const p = buildPlan(ingestAsset().config, { metrics: ['price_usd'] });
    expect(p.batches.map((b) => b.sourceId)).toEqual(['coingecko', 'http_json:https://api.example.test/stats']);
    expect(p.batches.flatMap((b) => b.requests).every((r) => r.metricKey === 'price_usd')).toBe(true);
    expect(p.flowGroups).toEqual([]);
    expect(p.needsRpc).toBe(false);
    // A metric fed by a transfer_flow shares its scan cursor with the group: narrowing to one member
    // must not starve the others of the days this run scans, so every member comes along.
    const flowPlan = buildPlan(ingestAsset().config, { metrics: ['flow_tokens.fees'] });
    expect(flowPlan.flowGroups[0].members.map((m) => m.metricKey)).toEqual(['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic']);
    expect(flowPlan.batches.flatMap((b) => b.requests)).toContainEqual(expect.objectContaining({ metricKey: 'flow_usd.fees', role: 'cross_check' }));
  });

  it('lists derived metrics apart and flags adapters that need the chain', () => {
    registerAdapter({ name: 'test.chain', needsRpc: true, run: async () => ({ kind: 'level', value: 1, observedAt: '', source: 'onchain', detail: '' }) });
    const yaml = INGEST_ASSET_YAML
      .replace('  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }',
        '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30, source: { type: adapter, name: test.chain } }\n' +
        '  usage_index: { type: level, unit: usd_per_day, staleness_days: 7, source: { type: derived, name: burn_momentum, params: { metric: flow_usd.fees_programmatic, days: 30 } } }');
    const p = buildPlan(parseAssetYaml(yaml).config, { metrics: ['staker_emission_share', 'usage_index'] });
    expect(p.batches.map((b) => b.sourceId)).toEqual(['adapter:test.chain']);
    expect(p.derived.map((r) => r.metricKey)).toEqual(['usage_index']);
    expect(p.needsRpc).toBe(true);
  });

  it('rejects bad requests and bad configuration', () => {
    const asset = ingestAsset().config;
    expect(codeOf(() => buildPlan(asset, { metrics: ['nope'] }))).toBe('unknown_metric');
    expect(codeOf(() => buildPlan(asset, { metrics: ['revenue_run_rate_usd'] }))).toBe('no_source');
    const unknown = INGEST_ASSET_YAML.replace('  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }',
      '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30, source: { type: adapter, name: never.registered } }');
    expect(codeOf(() => buildPlan(parseAssetYaml(unknown).config))).toBe('unknown_adapter');
  });

  it('needs an ingest block when only an adapter reads the chain', () => {
    registerAdapter({ name: 'test.chain', needsRpc: true, run: async () => ({ kind: 'level', value: 1, observedAt: '', source: 'onchain', detail: '' }) });
    const asset = miniAsset();
    asset.metrics.staker_emission_share.source = { type: 'adapter', name: 'test.chain', params: {} };
    expect(codeOf(() => buildPlan(asset))).toBe('invalid_source_config');
  });

  it('knows whether an asset has anything to fetch', () => {
    expect(hasSources(ingestAsset().config)).toBe(true);
    expect(hasSources(miniAsset())).toBe(false);
    expect(buildPlan(miniAsset())).toEqual({ batches: [], flowGroups: [], derived: [], needsRpc: false });
  });
});
