import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseAssetObject, parseAssetYaml } from '../../src/config/load.js';
import { registerAdapter } from '../../src/ingest/adapters/registry.js';
import { canonicalJson } from '../../src/util/canonical.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});

describe('parseAssetYaml', () => {
  it('parses a valid asset and applies defaults', () => {
    const { config, hash } = parseAssetYaml(MINI_ASSET_YAML);
    expect(config.supply_basis).toBe('effective_total');
    expect(config.scenario_probabilities).toEqual({ bear: 0.25, base: 0.5, bull: 0.25 });
    expect(config.holder_flows[0].window_days).toBe(90);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same hash regardless of YAML key order', () => {
    const reordered = MINI_ASSET_YAML.replace('id: mini\nsymbol: MINI', 'symbol: MINI\nid: mini');
    expect(parseAssetYaml(reordered).hash).toBe(parseAssetYaml(MINI_ASSET_YAML).hash);
  });

  it('rejects estimate weights that do not sum to 1', () => {
    const bad = MINI_ASSET_YAML.replace('weight: 1 }', 'weight: 0.7 }');
    expect(() => parseAssetYaml(bad)).toThrow(/weights/);
  });

  it('rejects a holder flow whose metric is not a flow metric', () => {
    const bad = MINI_ASSET_YAML.replace('metric: flow_usd.fees }', 'metric: price_usd }');
    expect(() => parseAssetYaml(bad)).toThrow(/flow/);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseAssetYaml(MINI_ASSET_YAML + '\nsurprise: true\n')).toThrow();
  });

  it('requires circulating_supply when supply_basis is circulating', () => {
    expect(() => parseAssetYaml(MINI_ASSET_YAML + '\nsupply_basis: circulating\n')).toThrow(/circulating_supply/);
  });
});

describe('adapter params validation', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const litYaml = readFileSync(`${ROOT}/assets/lit.yaml`, 'utf8');
  const withTranches = (tranches: unknown) => {
    const obj = parseYaml(litYaml) as { metrics: Record<string, { source: { params: Record<string, unknown> } }> };
    obj.metrics.unlocks_next_year.source.params.tranches = tranches;
    return obj;
  };
  // A stand-in adapter whose validateParams refuses everything but { ok: true }, used as a cross-check.
  registerAdapter({ name: 'test_checked', needsRpc: false, validateParams: (p) => (p.ok === true ? [] : ['ok: must be true']), run: () => Promise.reject(new Error('not run')) });

  it('parseAssetObject surfaces the refusal with the metric path; assets/lit.yaml still loads and keeps its hash', () => {
    expect(parseAssetYaml(litYaml).hash).toBe('ad683e198b9b97af4d0067e339b89323b1711fe3e689fbb7f9fd404353f926a5');
    expect(parseAssetObject(parseYaml(litYaml)).hash).toBe('ad683e198b9b97af4d0067e339b89323b1711fe3e689fbb7f9fd404353f926a5');
    // A valid schedule loads (and is a different config).
    const good = parseAssetObject(withTranches({ first: '2027-01-29', every_months: 1, count: 36 }));
    expect(good.config.metrics.unlocks_next_year.source).toMatchObject({ params: { tranches: { first: '2027-01-29', every_months: 1, count: 36 } } });
    expect(good.hash).not.toBe('ad683e198b9b97af4d0067e339b89323b1711fe3e689fbb7f9fd404353f926a5');
    // A malformed one is refused with the metric path, through the object path (filing) and the YAML path (approve).
    const bad = withTranches({ first: '2027-01-29', every_months: 13, count: 36 });
    expect(() => parseAssetObject(bad)).toThrow(expect.objectContaining({ code: 'invalid_asset_config', message: expect.stringContaining('metrics.unlocks_next_year.source.params: tranches.every_months') }));
    expect(() => parseAssetYaml(stringifyYaml(bad))).toThrow(/metrics\.unlocks_next_year\.source\.params: tranches\.every_months/);
  });

  it('checks cross-check adapter sources too, and leaves adapters without validateParams alone', () => {
    const yaml = (ok: boolean) =>
      MINI_ASSET_YAML.replace(
        'staked_supply: { type: level, unit: tokens, staleness_days: 7 }',
        `staked_supply: { type: level, unit: tokens, staleness_days: 7, source: { type: adapter, name: lit.treasury_buys_daily, params: { anything: 1 } }, cross_checks: [ { source: { type: adapter, name: test_checked, params: { ok: ${ok} } } } ] }`,
      );
    expect(yaml(true)).toContain('test_checked');
    expect(() => parseAssetYaml(yaml(true))).not.toThrow();
    expect(() => parseAssetYaml(yaml(false))).toThrow(/metrics\.staked_supply\.cross_checks\.0\.source\.params: ok: must be true/);
  });
});
