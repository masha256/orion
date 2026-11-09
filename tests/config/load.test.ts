import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadAsset, parseAssetObject, parseAssetYaml } from '../../src/config/load.js';
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
    expect(config.contracts).toEqual({});
    expect(config.holder_flows[0].window_days).toBe(90);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the mini fixture\'s parsed-config hash, so no schema default is added silently', () => {
    // A new default changes every parsed config, and so every asset's config hash. Moving this pin must be on purpose.
    expect(parseAssetYaml(MINI_ASSET_YAML).hash).toBe('c8cc46425acb05d4fd7e211aa648d8c284b29d3ccd9dfdfde6d5cdad4030f830');
  });

  it('gives the same hash regardless of YAML key order', () => {
    const reordered = MINI_ASSET_YAML.replace('id: mini\nsymbol: MINI', 'symbol: MINI\nid: mini');
    expect(parseAssetYaml(reordered).hash).toBe(parseAssetYaml(MINI_ASSET_YAML).hash);
  });

  it('rejects a holder flow whose metric is not a flow metric', () => {
    const bad = MINI_ASSET_YAML.replace('metric: flow_usd.fees }', 'metric: price_usd }');
    expect(() => parseAssetYaml(bad)).toThrow(/flow/);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseAssetYaml(MINI_ASSET_YAML + '\nsurprise: true\n')).toThrow();
  });
});

describe('loadAsset', () => {
  it('load: a YAML syntax error is invalid_asset_config naming the file and the line', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-load-'));
    try {
      mkdirSync(join(root, 'assets'));
      writeFileSync(join(root, 'assets', 'bad.yaml'), 'id: bad\nsymbol: BAD\nname: [unclosed\n');
      let caught: unknown;
      try {
        loadAsset(root, 'bad');
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code: 'invalid_asset_config' });
      const msg = (caught as Error).message;
      expect(msg.startsWith(`${join(root, 'assets', 'bad.yaml')}: not valid YAML at line `)).toBe(true);
      expect(msg).toMatch(/: not valid YAML at line \d+: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the valuation config keys are gone', () => {
  const messageOf = (yaml: string): string => {
    try {
      parseAssetYaml(yaml);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };

  it('schema: each removed key is refused by name', () => {
    // A stale YAML (an old branch, a hand edit) must fail loudly and say which key, not load with the key ignored.
    const stale: [string, string][] = [
      ['modules', 'modules:\n  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }\n'],
      ['assumptions', 'assumptions:\n  rev_growth_y1: { min: -0.5, max: 5 }\n'],
      ['scenario_probabilities', 'scenario_probabilities: { bear: 0.25, base: 0.5, bull: 0.25 }\n'],
      ['review_triggers', 'review_triggers:\n  provisional_move_pct: 25\n'],
      ['peer_set', 'peer_set: []\n'],
      ['total_return_variants', 'total_return_variants: []\n'],
      ['supply_basis', 'supply_basis: effective_total\n'],
      ['cadence', 'agent:\n  cadence: { weekly_days: 7 }\n'],
      ['max_step_fraction', 'agent:\n  max_step_fraction: 0.25\n'],
      ['weekly', 'agent:\n  budgets:\n    weekly: { input_tokens: 2000000 }\n'],
    ];
    for (const [key, snippet] of stale) {
      const message = messageOf(`${MINI_ASSET_YAML}${snippet}`);
      expect(message, key).toContain(`Unrecognized key: "${key}"`);
    }
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  cadence: { weekly_days: 7 }\n`)).toMatch(/^agent: /);
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  budgets:\n    weekly: { input_tokens: 2000000 }\n`)).toMatch(/^agent\.budgets: /);
    // The one budget kept: the disclosure run's.
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  budgets:\n    disclosure: { input_tokens: 2000000 }\n`)).toBe('');
  });

  it('schema: an asset without revenue_run_rate_usd loads', () => {
    const yaml = MINI_ASSET_YAML.replace(/^ {2}revenue_run_rate_usd:.*\n/m, '');
    expect(yaml).not.toContain('revenue_run_rate_usd');
    expect(parseAssetYaml(yaml).config.metrics.revenue_run_rate_usd).toBeUndefined();
    // Nor is staker_emission_share required any more (D1(a): kept on the 13 assets, dropped from the required list).
    expect(() => parseAssetYaml(yaml.replace(/^ {2}staker_emission_share:.*\n/m, ''))).not.toThrow();
  });

  it('schema: an asset without price_usd is refused', () => {
    // The four the report reads stay required.
    for (const key of ['price_usd', 'total_supply', 'staked_supply', 'emission_rate_annual']) {
      const yaml = MINI_ASSET_YAML.replace(new RegExp(`^ {2}${key}:.*\\n`, 'm'), '');
      expect(messageOf(yaml), key).toContain(`required standard metric "${key}" is not defined`);
    }
  });

  it('schema: a standard or holder-flow metric cannot be monitor_only', () => {
    expect(messageOf(MINI_ASSET_YAML.replace('flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, critical: true }', 'flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, monitor_only: true }')))
      .toContain('"flow_usd.fees" is a standard or holder-flow metric and cannot be monitor_only');
    expect(messageOf(MINI_ASSET_YAML.replace('staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }', 'staker_emission_share: { type: level, unit: ratio, staleness_days: 30, monitor_only: true }')))
      .toContain('"staker_emission_share" is a standard or holder-flow metric and cannot be monitor_only');
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
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    expect(parseAssetYaml(litYaml).hash).toBe('a3685331c2301c67faaf931814655cde3cf416a307fe26638b98f578f0dcce4a');
    expect(parseAssetObject(parseYaml(litYaml)).hash).toBe('a3685331c2301c67faaf931814655cde3cf416a307fe26638b98f578f0dcce4a');
    // Another valid schedule loads (and is a different config from the file's 36 monthly tranches).
    const good = parseAssetObject(withTranches({ first: '2027-01-29', every_months: 3, count: 12 }));
    expect(good.config.metrics.unlocks_next_year.source).toMatchObject({ params: { tranches: { first: '2027-01-29', every_months: 3, count: 12 } } });
    expect(good.hash).not.toBe('a3685331c2301c67faaf931814655cde3cf416a307fe26638b98f578f0dcce4a');
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
    // Re-pinned 2026-10-26: window 90 -> 91 days on every asset (Mike); no watch/share key involved.
    // Re-pinned 2026-11-01: the valuation keys and valuation-only metrics left (Phase 1); no watch/share key involved.
    // Re-pinned 2026-11-04: income_statement v2 block added (Phase 2 Task 2); no watch/share key involved.
    // Re-pinned 2026-11-09 (aero only): the Aero contracts (spec 2026-11-09-orion-aero-supply-design.md); no watch/share key involved.
    expect(asset('vvv')).toBe('433d0306b2cad2849a717180e24568d5c0bf3ed3c62455c2208b470c9ed3f4f5');
    expect(asset('hype')).toBe('7a52e7974c9c90234ac9ac27d6d0495291b047aa04d566e02e89c1801c284296');
    expect(asset('aero')).toBe('e9e96f3c78e997fdc260433fe6bb1aa4e3958b959d0c3679ff9219a9aaaa9779');
  });
});
