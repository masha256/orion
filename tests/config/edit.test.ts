import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { applyEditsToObject, applyEditsToYaml, changesAgentLimits, getAtPath, roundTrips } from '../../src/config/edit.js';
import { parseAssetYaml, rawConfig } from '../../src/config/load.js';
import type { ConfigEdit, OrionError } from '../../src/types.js';

const YAML = `# An asset, with comments that must survive.
id: mini
modules:
  # the cash-flow estimate
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.6 }
  - { id: fm, type: forward_multiple, kind: estimate, weight: 0.4, params: { basis: revenue } }
assumptions:
  rev_growth_y1: { min: -0.5, max: 5 }
  capture_rate_terminal.fees: { min: 0, max: 1 } # a key with a dot in it
review_triggers:
  revenue_stale_move_pct: 30 # percent
  calendar:
    - { date: "2026-10-01", note: "Emission cut" }
supply_basis: effective_total
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
    expect(getAtPath(obj, ['modules', 'fm', 'weight'])).toBe(0.4);
    expect(getAtPath(obj, ['modules', 0, 'id'])).toBe('hc');
    expect(getAtPath(obj, ['assumptions', 'capture_rate_terminal.fees', 'max'])).toBe(1);
    expect(getAtPath(obj, ['review_triggers', 'calendar', 0, 'note'])).toBe('Emission cut');
  });

  it('reads an absent last key as null, and refuses a path whose parent is missing', () => {
    expect(getAtPath(obj, ['assumptions', 'rev_growth_y1', 'base'])).toBeNull();
    expect(getAtPath(obj, ['agent'])).toBeNull();
    expect(codeOf(() => getAtPath(obj, ['agent', 'budgets']))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['modules', 'nope', 'weight']))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['modules', 7]))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['id', 'x']))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, ['assumptions', 0]))).toBe('invalid_path');
    expect(codeOf(() => getAtPath(obj, []))).toBe('invalid_path');
  });
});

describe('applyEditsToObject', () => {
  it('sets, adds, and deletes on a copy, leaving the input alone', () => {
    const obj = parseYaml(YAML) as Record<string, unknown>;
    const edits: ConfigEdit[] = [
      { path: ['modules', 'hc', 'weight'], value: 0.5 },
      { path: ['modules', 'fm', 'weight'], value: 0.5 },
      { path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 1 } },
      { path: ['review_triggers', 'revenue_stale_move_pct'], value: null },
    ];
    const out = applyEditsToObject(obj, edits);
    expect(getAtPath(out, ['modules', 'hc', 'weight'])).toBe(0.5);
    expect(getAtPath(out, ['assumptions', 'rev_growth_y1'])).toEqual({ min: -0.5, max: 5, base: { min: 0, max: 1 } });
    expect(getAtPath(out, ['review_triggers', 'revenue_stale_move_pct'])).toBeNull();
    expect(getAtPath(obj, ['modules', 'hc', 'weight'])).toBe(0.6);
    expect(getAtPath(obj, ['review_triggers', 'revenue_stale_move_pct'])).toBe(30);
  });

  it('removes a list item when its value is null', () => {
    const out = applyEditsToObject(parseYaml(YAML), [{ path: ['modules', 'fm'], value: null }]);
    expect((getAtPath(out, ['modules']) as unknown[]).length).toBe(1);
  });
});

describe('applyEditsToYaml', () => {
  it('round-trips the fixture unchanged', () => {
    expect(roundTrips(YAML)).toBe(true);
    expect(applyEditsToYaml(YAML, [])).toBe(YAML);
  });

  it('changes a scalar in place: only that line differs, and the comment on it survives', () => {
    const out = applyEditsToYaml(YAML, [{ path: ['review_triggers', 'revenue_stale_move_pct'], value: 40 }]);
    expect(changedLines(YAML, out)).toEqual([['  revenue_stale_move_pct: 30 # percent', '  revenue_stale_move_pct: 40 # percent']]);
  });

  it('edits inside flow maps, by id, keeping flow style and every other line', () => {
    const out = applyEditsToYaml(YAML, [
      { path: ['modules', 'hc', 'weight'], value: 0.5 },
      { path: ['modules', 'fm', 'weight'], value: 0.5 },
      { path: ['assumptions', 'capture_rate_terminal.fees', 'max'], value: 0.8 },
    ]);
    expect(changedLines(YAML, out)).toEqual([
      ['  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.6 }', '  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.5 }'],
      [
        '  - { id: fm, type: forward_multiple, kind: estimate, weight: 0.4, params: { basis: revenue } }',
        '  - { id: fm, type: forward_multiple, kind: estimate, weight: 0.5, params: { basis: revenue } }',
      ],
      ['  capture_rate_terminal.fees: { min: 0, max: 1 } # a key with a dot in it', '  capture_rate_terminal.fees: { min: 0, max: 0.8 } # a key with a dot in it'],
    ]);
  });

  it('adds an agent band as a nested flow map on the same line', () => {
    const out = applyEditsToYaml(YAML, [{ path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 1 } }]);
    expect(changedLines(YAML, out)).toEqual([['  rev_growth_y1: { min: -0.5, max: 5 }', '  rev_growth_y1: { min: -0.5, max: 5, base: { min: 0, max: 1 } }']]);
  });

  it('deletes a key', () => {
    const out = applyEditsToYaml(YAML, [{ path: ['supply_basis'], value: null }]);
    expect(out).toBe(YAML.replace('supply_basis: effective_total\n', ''));
  });

  it('yields the same config as editing the object', () => {
    const edits: ConfigEdit[] = [
      { path: ['modules', 'hc', 'weight'], value: 0.5 },
      { path: ['assumptions', 'rev_growth_y1', 'bull'], value: { min: 1, max: 5 } },
      { path: ['review_triggers', 'calendar'], value: [{ date: '2026-11-01', note: 'Unlock' }] },
      { path: ['supply_basis'], value: null },
    ];
    expect(parseYaml(applyEditsToYaml(YAML, edits))).toEqual(applyEditsToObject(parseYaml(YAML), edits));
  });

  it('refuses a bad path and invalid YAML', () => {
    expect(codeOf(() => applyEditsToYaml(YAML, [{ path: ['modules', 'nope', 'weight'], value: 1 }]))).toBe('invalid_path');
    expect(codeOf(() => applyEditsToYaml('a: [unclosed', []))).toBe('invalid_yaml');
  });

  it('refuses prototype keys in a path, in every mode, and pollutes nothing', () => {
    const obj = parseYaml(YAML) as unknown;
    for (const bad of [['__proto__', 'polluted'], ['constructor', 'prototype', 'polluted'], ['assumptions', '__proto__', 'polluted'], ['modules', 'prototype']]) {
      expect(codeOf(() => applyEditsToObject(obj, [{ path: bad, value: 'x' }]))).toBe('invalid_path');
      expect(codeOf(() => applyEditsToYaml(YAML, [{ path: bad, value: 'x' }]))).toBe('invalid_path');
      expect(codeOf(() => getAtPath(obj, bad))).toBe('invalid_path');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // An inherited property is not a config key: it reads as absent, and a path through it has no parent.
    expect(getAtPath(obj, ['assumptions', 'toString'])).toBeNull();
    expect(codeOf(() => getAtPath(obj, ['assumptions', 'toString', 'name']))).toBe('invalid_path');
  });

  it('removes the same list item from the YAML as from the object, and a later edit sees the shifted list', () => {
    const edits: ConfigEdit[] = [
      { path: ['modules', 'hc'], value: null },
      { path: ['modules', 0, 'weight'], value: 1 },
    ];
    const fromYaml = parseYaml(applyEditsToYaml(YAML, edits)) as unknown;
    expect(fromYaml).toEqual(applyEditsToObject(parseYaml(YAML), edits));
    expect((getAtPath(fromYaml, ['modules']) as { id: string; weight: number }[]).map((m) => [m.id, m.weight])).toEqual([['fm', 1]]);
  });
});

describe('the real VVV config', () => {
  const text = readFileSync('assets/vvv.yaml', 'utf8');

  it('round-trips byte for byte, so an approved proposal diffs as the edit and nothing else', () => {
    // If this fails after a hand edit, the usual cause is a flow list written `[a, b]`; this file writes `[ a, b ]`.
    expect(roundTrips(text)).toBe(true);
  });

  it('takes a weight change and a new band as two changed lines', () => {
    const out = applyEditsToYaml(text, [
      { path: ['modules', 'fm_revenue', 'weight'], value: 0.35 },
      { path: ['assumptions', 'growth_fade_years', 'base'], value: { min: 3, max: 5 } },
    ]);
    const changed = changedLines(text, out);
    expect(changed).toHaveLength(2);
    expect(changed[0][1]).toContain('weight: 0.35');
    expect(changed[1][1]).toBe('  growth_fade_years: { min: 1, max: 8, base: { min: 3, max: 5 } }');
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

  it('flags bands and bounds, the move threshold, and a metric\'s source, provisional flag, or criticality', () => {
    expect(changes(['assumptions', 'rev_growth_y1', 'base'])).toBe(true);
    expect(changes(['assumptions', 'rev_growth_y1'])).toBe(true);
    expect(changes(['assumptions'])).toBe(true);
    expect(changes(['review_triggers', 'provisional_move_pct'])).toBe(true);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'source'])).toBe(true);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'allow_provisional'])).toBe(true);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'critical'])).toBe(true);
  });

  it('leaves ordinary config alone', () => {
    expect(changes(['modules', 'hc', 'weight'])).toBe(false);
    expect(changes(['scenario_probabilities'])).toBe(false);
    expect(changes(['review_triggers', 'revenue_stale_move_pct'])).toBe(false);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'staleness_days'])).toBe(false);
    expect(changes(['metrics', 'revenue_run_rate_usd', 'source', 'field'])).toBe(false); // not the source itself
    expect(changesAgentLimits([])).toBe(false);
  });

  it('flags a batch where any one edit reaches a limit', () => {
    expect(changesAgentLimits([{ path: ['modules', 'hc', 'weight'], value: 1 }, { path: ['assumptions', 'rev_growth_y1', 'max'], value: 9 }])).toBe(true);
  });
});
