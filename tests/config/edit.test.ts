import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { applyEditsToObject, applyEditsToYaml, changesAgentLimits, getAtPath, roundTrips } from '../../src/config/edit.js';
import { parseAssetYaml, rawConfig } from '../../src/config/load.js';
import type { ConfigEdit, OrionError } from '../../src/types.js';

const YAML = `# An asset, with comments that must survive.
id: mini
holder_flows:
  # the fee share
  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees, window_days: 91 }
  - { id: burn, kind: burn, capture_rule: programmatic, recipient_base: all, metric: flow_usd.burn, window_days: 91 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3 }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45 } # a key with a dot in it
reporting:
  window_days: 91 # days
  revenue:
    - { id: fees, metric: flow_usd.fees, settlement: daily }
chain: base
`;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

/** The lines that differ between two texts, as [before, after] pairs. Line counts must match. */
function changedLines(before: string, after: string): [string, string][] {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b.length).toBe(a.length);
  return a.flatMap((line, i): [string, string][] => (line === b[i] ? [] : [[line, b[i]]]));
}

describe('paths', () => {
  const obj = parseYaml(YAML) as unknown;

  it('selects map keys, list items by id, and list items by index', () => {
    expect(getAtPath(obj, ['holder_flows', 'burn', 'kind'])).toBe('burn');
    expect(getAtPath(obj, ['holder_flows', 0, 'id'])).toBe('fees');
    expect(getAtPath(obj, ['metrics', 'flow_usd.fees', 'staleness_days'])).toBe(45);
    expect(getAtPath(obj, ['reporting', 'revenue', 0, 'settlement'])).toBe('daily');
  });

  it('reads an absent last key as null, and refuses a path whose parent is missing', () => {
    expect(getAtPath(obj, ['metrics', 'price_usd', 'critical'])).toBeNull();
    expect(getAtPath(obj, ['agent'])).toBeNull();
    expect(codeOf(() => getAtPath(obj, ['agent', 'budgets']))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['holder_flows', 'nope', 'window_days']))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['holder_flows', 7]))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['id', 'x']))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['metrics', 0]))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, []))).toBe('invalid_path');
  });
});

describe('applyEditsToObject', () => {
  it('sets, adds, and deletes on a copy, leaving the input alone', () => {
    const obj = parseYaml(YAML) as Record<string, unknown>;
    const edits: ConfigEdit[] = [
      { path: ['holder_flows', 'fees', 'window_days'], value: 182 },
      { path: ['holder_flows', 'burn', 'window_days'], value: 182 },
      { path: ['metrics', 'price_usd', 'source'], value: { type: 'coingecko', id: 'mini', field: 'price' } },
      { path: ['reporting', 'window_days'], value: null },
    ];
    const out = applyEditsToObject(obj, edits);
    expect(getAtPath(out, ['holder_flows', 'fees', 'window_days'])).toBe(182);
    expect(getAtPath(out, ['metrics', 'price_usd'])).toEqual({ type: 'level', unit: 'usd', staleness_days: 3, source: { type: 'coingecko', id: 'mini', field: 'price' } });
    expect(getAtPath(out, ['reporting', 'window_days'])).toBeNull();
    expect(getAtPath(obj, ['holder_flows', 'fees', 'window_days'])).toBe(91);
    expect(getAtPath(obj, ['reporting', 'window_days'])).toBe(91);
  });

  it('removes a list item when its value is null', () => {
    const out = applyEditsToObject(parseYaml(YAML), [{ path: ['holder_flows', 'burn'], value: null }]);
    expect((getAtPath(out, ['holder_flows']) as unknown[]).length).toBe(1);
  });
});

describe('applyEditsToYaml', () => {
  it('round-trips the fixture unchanged', () => {
    expect(roundTrips(YAML)).toBe(true);
    expect(applyEditsToYaml(YAML, [])).toBe(YAML);
  });

  it('changes a scalar in place: only that line differs, and the comment on it survives', () => {
    const out = applyEditsToYaml(YAML, [{ path: ['reporting', 'window_days'], value: 182 }]);
    expect(changedLines(YAML, out)).toEqual([['  window_days: 91 # days', '  window_days: 182 # days']]);
  });

  it('edits inside flow maps, by id, keeping flow style and every other line', () => {
    const out = applyEditsToYaml(YAML, [
      { path: ['holder_flows', 'fees', 'window_days'], value: 182 },
      { path: ['holder_flows', 'burn', 'window_days'], value: 182 },
      { path: ['metrics', 'flow_usd.fees', 'staleness_days'], value: 60 },
    ]);
    expect(changedLines(YAML, out)).toEqual([
      [
        '  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees, window_days: 91 }',
        '  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees, window_days: 182 }',
      ],
      [
        '  - { id: burn, kind: burn, capture_rule: programmatic, recipient_base: all, metric: flow_usd.burn, window_days: 91 }',
        '  - { id: burn, kind: burn, capture_rule: programmatic, recipient_base: all, metric: flow_usd.burn, window_days: 182 }',
      ],
      ['  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45 } # a key with a dot in it', '  flow_usd.fees: { type: flow, unit: usd, staleness_days: 60 } # a key with a dot in it'],
    ]);
  });

  it('adds a nested flow map on the same line', () => {
    const out = applyEditsToYaml(YAML, [{ path: ['metrics', 'price_usd', 'source'], value: { type: 'coingecko', id: 'mini', field: 'price' } }]);
    expect(changedLines(YAML, out)).toEqual([['  price_usd: { type: level, unit: usd, staleness_days: 3 }', '  price_usd: { type: level, unit: usd, staleness_days: 3, source: { type: coingecko, id: mini, field: price } }']]);
  });

  it('deletes a key', () => {
    const out = applyEditsToYaml(YAML, [{ path: ['chain'], value: null }]);
    expect(out).toBe(YAML.replace('chain: base\n', ''));
  });

  it('yields the same config as editing the object', () => {
    const edits: ConfigEdit[] = [
      { path: ['holder_flows', 'fees', 'window_days'], value: 182 },
      { path: ['metrics', 'price_usd', 'critical'], value: true },
      { path: ['reporting', 'volume'], value: ['flow_usd.fees'] },
      { path: ['chain'], value: null },
    ];
    expect(parseYaml(applyEditsToYaml(YAML, edits))).toEqual(applyEditsToObject(parseYaml(YAML), edits));
  });

  it('refuses a bad path and invalid YAML', () => {
    expect(codeOf(() => applyEditsToYaml(YAML, [{ path: ['holder_flows', 'nope', 'window_days'], value: 1 }]))).toBe('invalid_path');
    expect(codeOf(() => applyEditsToYaml('a: [unclosed', []))).toBe('invalid_yaml');
  });

  it('refuses prototype keys in a path, in every mode, and pollutes nothing', () => {
    const obj = parseYaml(YAML) as unknown;
    for (const bad of [['__proto__', 'polluted'], ['constructor', 'prototype', 'polluted'], ['metrics', '__proto__', 'polluted'], ['holder_flows', 'prototype']]) {
      expect(codeOf(() => applyEditsToObject(obj, [{ path: bad, value: 'x' }]))).toBe('invalid_path');
      expect(codeOf(() => applyEditsToYaml(YAML, [{ path: bad, value: 'x' }]))).toBe('invalid_path');
      expect(codeOf(() => getAtPath(obj, bad))).toBe('invalid_path');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // An inherited property is not a config key: it reads as absent, and a path through it has no parent.
    expect(getAtPath(obj, ['metrics', 'toString'])).toBeNull();
    expect(codeOf(() => getAtPath(obj, ['metrics', 'toString', 'name']))).toBe('invalid_path');
  });

  it('removes the same list item from the YAML as from the object, and a later edit sees the shifted list', () => {
    const edits: ConfigEdit[] = [
      { path: ['holder_flows', 'fees'], value: null },
      { path: ['holder_flows', 0, 'window_days'], value: 182 },
    ];
    const fromYaml = parseYaml(applyEditsToYaml(YAML, edits)) as unknown;
    expect(fromYaml).toEqual(applyEditsToObject(parseYaml(YAML), edits));
    expect((getAtPath(fromYaml, ['holder_flows']) as { id: string; window_days: number }[]).map((f) => [f.id, f.window_days])).toEqual([['burn', 182]]);
  });
});

describe('the real VVV config', () => {
  const text = readFileSync('assets/vvv.yaml', 'utf8');

  it('round-trips byte for byte, so an approved proposal diffs as the edit and nothing else', () => {
    // If this fails after a hand edit, the usual cause is a flow list written `[a, b]`; this file writes `[ a, b ]`.
    expect(roundTrips(text)).toBe(true);
  });

  it('takes a holder flow change and a new metric setting as two changed lines', () => {
    const out = applyEditsToYaml(text, [
      { path: ['holder_flows', 'burn', 'window_days'], value: 182 },
      { path: ['metrics', 'revenue_run_rate_usd', 'staleness_days'], value: 120 },
    ]);
    const changed = changedLines(text, out);
    expect(changed).toHaveLength(2);
    expect(changed[0][1]).toBe('  revenue_run_rate_usd: { type: level, unit: usd, cadence: event, staleness_days: 120, critical: true }');
    expect(changed[1][1]).toContain('window_days: 182');
  });

  it('keeps the raw object on the loaded asset, without schema defaults', () => {
    const loaded = parseAssetYaml(text);
    expect(getAtPath(rawConfig(loaded), ['metrics', 'revenue_run_rate_usd', 'fetcher'])).toBeNull();
    expect(loaded.config.metrics.revenue_run_rate_usd.fetcher).toBe('manual');
    expect(rawConfig({ config: loaded.config, hash: loaded.hash })).toBe(loaded.config);
  });
});

describe('edits that change what the agent may do by itself', () => {
  const changes = (path: (string | number)[]): boolean => changesAgentLimits([{ path, value: 1 }]);

  it('flags a metric\'s source, provisional flag, or criticality', () => {
    expect(changes(['metrics', 'revenue_run_rate_usd', 'source'])).toBe(true);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'allow_provisional'])).toBe(true);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'critical'])).toBe(true);
  });

  it('flags a whole-node edit that replaces a limit along with everything around it', () => {
    // A proposal that rewrites metrics.<key> wholesale can flip critical, allow_provisional or source without naming them.
    expect(changes(['metrics'])).toBe(true);
    expect(changes(['metrics', 'revenue_run_rate_usd'])).toBe(true);
  });

  it('leaves ordinary config alone', () => {
    expect(changes(['holder_flows', 'fees', 'window_days'])).toBe(false);
    expect(changes(['reporting', 'window_days'])).toBe(false);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'staleness_days'])).toBe(false);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'source', 'field'])).toBe(false); // not the source itself
    expect(changesAgentLimits([])).toBe(false);
  });

  it('flags a batch where any one edit reaches a limit', () => {
    expect(changesAgentLimits([{ path: ['holder_flows', 'fees', 'window_days'], value: 1 }, { path: ['metrics', 'price_usd', 'critical'], value: false }])).toBe(true);
  });
});
