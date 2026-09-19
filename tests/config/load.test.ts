import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
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
