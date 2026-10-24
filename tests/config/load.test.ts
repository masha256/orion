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

describe('metric watch', () => {
  const messageOf = (yaml: string) => {
    try {
      parseAssetYaml(yaml);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };
  const withWatched = (def: string) => MINI_ASSET_YAML.replace('metrics:\n', `metrics:\n  watched: ${def}\n`);
  const level = (extra: string) => withWatched(`{ type: level, unit: ratio, staleness_days: 3, ${extra} }`);
  const flow = (extra: string) => withWatched(`{ type: flow, unit: usd, staleness_days: 3, ${extra} }`);

  it('accepts one rule on a monitor-only metric: above on a flow, change_pct or outside on a level', () => {
    expect(parseAssetYaml(flow('monitor_only: true, watch: { above: 1000 }')).config.metrics.watched.watch).toEqual({ above: 1000 });
    expect(parseAssetYaml(level('monitor_only: true, watch: { change_pct: 5 }')).config.metrics.watched.watch).toEqual({ change_pct: 5 });
    expect(parseAssetYaml(level('monitor_only: true, watch: { outside: [0.5, 0.5] }')).config.metrics.watched.watch).toEqual({ outside: [0.5, 0.5] });
    expect(parseAssetYaml(level('monitor_only: true')).config.metrics.watched.watch).toBeUndefined();
  });

  it('refuses a watch without monitor_only, naming the metric', () => {
    expect(messageOf(level('watch: { change_pct: 5 }'))).toMatch(/"watched" has a watch, which is for monitor_only metrics/);
    expect(messageOf(level('monitor_only: false, watch: { change_pct: 5 }'))).toMatch(/"watched" has a watch, which is for monitor_only metrics/);
  });

  it('refuses two rules, no rule, a change_pct not above 0, and an outside with lo above hi', () => {
    expect(messageOf(level('monitor_only: true, watch: { change_pct: 5, outside: [0.4, 0.6] }'))).toMatch(/"watched" watch takes exactly one rule/);
    expect(messageOf(level('monitor_only: true, watch: {}'))).toMatch(/"watched" watch takes exactly one rule/);
    expect(messageOf(level('monitor_only: true, watch: { change_pct: 0 }'))).toMatch(/metrics\.watched\.watch\.change_pct/);
    expect(messageOf(level('monitor_only: true, watch: { outside: [0.6, 0.5] }'))).toMatch(/"watched" watch outside \[lo, hi\] needs lo <= hi/);
    expect(messageOf(level('monitor_only: true, watch: { below: 1 }'))).toMatch(/metrics\.watched\.watch: Unrecognized key: "below"/);
  });

  it('refuses above on a level and change_pct or outside on a flow', () => {
    expect(messageOf(level('monitor_only: true, watch: { above: 1 }'))).toMatch(/"watched" watch above is for flow metrics/);
    expect(messageOf(flow('monitor_only: true, watch: { change_pct: 5 }'))).toMatch(/"watched" watch change_pct is for level metrics/);
    expect(messageOf(flow('monitor_only: true, watch: { outside: [1, 2] }'))).toMatch(/"watched" watch outside is for level metrics/);
  });

  it('an asset without watch/share keeps its hash', () => {
    const asset = (id: string) => parseAssetYaml(readFileSync(fileURLToPath(new URL(`../../assets/${id}.yaml`, import.meta.url)), 'utf8')).hash;
    expect(asset('vvv')).toBe('979829372427f0f8ad9aedc21d8dd15ac178143ede8c9d8cc8f44d17e48775c4');
    expect(asset('hype')).toBe('181f84a5a610cb762d632385b9f027d8c77870ead15dbb076fd736a60666883a');
    expect(asset('aero')).toBe('d13ba5733eceae83d166a79f1ebda277cbb315068be1a3126b3365766341d4c7');
  });
});
