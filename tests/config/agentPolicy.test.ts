import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { budgetsFor, DEFAULT_BUDGETS, inputUnitsTenths, PROVISIONAL_MOVE_PCT } from '../../src/config/agentPolicy.js';
import { parseAssetYaml } from '../../src/config/load.js';
import type { OrionError } from '../../src/types.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

const withBands = (bands: string, extra = ''): string =>
  MINI_ASSET_YAML.replace('  rev_growth_y1: { min: -0.5, max: 5 }', `  rev_growth_y1: { min: -0.5, max: 5, ${bands} }`) + extra;

const messageOf = (yaml: string): string => {
  try {
    parseAssetYaml(yaml);
  } catch (err) {
    return (err as OrionError).message;
  }
  return '';
};

// The schema still accepts the valuation keys (bands, agent settings, review triggers) until the config keys go; the
// helpers that read them went with the valuation. These pin only that the schema checks them as before.
describe('agent bands', () => {
  it('rejects a band that is inverted or reaches outside the key-wide bounds', () => {
    expect(messageOf(withBands('base: { min: 2, max: 1 }'))).toMatch(/"rev_growth_y1" base band has min greater than max/);
    expect(messageOf(withBands('bull: { min: 1, max: 6 }'))).toMatch(/"rev_growth_y1" bull band must lie inside \[-0.5, 5\]/);
    expect(messageOf(withBands('bear: { min: -0.5, max: 0 }, base: { min: 0, max: 1 }, bull: { min: 1, max: 5 }'))).toBe('');
  });

  it('allows bands to overlap: whether they touch is calibration, not schema', () => {
    expect(messageOf(withBands('bear: { min: -0.5, max: 2 }, base: { min: 0, max: 3 }'))).toBe('');
  });
});

describe('agent settings', () => {
  it('defaults when the asset says nothing', () => {
    const asset = parseAssetYaml(MINI_ASSET_YAML).config;
    expect(budgetsFor(asset, 'disclosure')).toEqual(DEFAULT_BUDGETS.disclosure);
  });

  it('fixes the provisional move threshold at 25 percent', () => {
    expect(PROVISIONAL_MOVE_PCT).toBe(25);
  });

  it('applies partial overrides per run type and per field', () => {
    const asset = parseAssetYaml(
      `${MINI_ASSET_YAML}agent:\n  max_step_fraction: 0.1\n  budgets:\n    disclosure: { requests: 5, web_searches: 0 }\nreview_triggers:\n  provisional_move_pct: 40\n`,
    ).config;
    expect(budgetsFor(asset, 'disclosure')).toEqual({ ...DEFAULT_BUDGETS.disclosure, requests: 5, webSearches: 0 });
  });

  it('still accepts the budgets of the retired run types in a YAML, and they set nothing', () => {
    // The 13 asset YAMLs carry agent.budgets.{weekly,triage,deep,bootstrap} until the config keys go.
    const asset = parseAssetYaml(`${MINI_ASSET_YAML}agent:\n  budgets:\n    weekly: { requests: 5 }\n    triage: { requests: 6 }\n    deep: { requests: 7 }\n    bootstrap: { requests: 8 }\n`).config;
    expect(budgetsFor(asset, 'disclosure')).toEqual(DEFAULT_BUDGETS.disclosure);
  });

  it('reads an input_tokens override as input units', () => {
    const asset = parseAssetYaml(`${MINI_ASSET_YAML}agent:\n  budgets:\n    disclosure: { input_tokens: 2000000 }\n`).config;
    expect(budgetsFor(asset, 'disclosure')).toEqual({ ...DEFAULT_BUDGETS.disclosure, inputUnits: 2_000_000 });
  });

  it('keeps the default numbers', () => {
    expect(Object.keys(DEFAULT_BUDGETS)).toEqual(['disclosure']);
    expect(DEFAULT_BUDGETS.disclosure).toEqual({ requests: 25, inputUnits: 1_200_000, outputTokens: 40_000, webSearches: 3, webFetches: 5, proposals: 5 });
  });

  it('weights input in tenths, exactly', () => {
    expect(inputUnitsTenths({ inputTokens: 10, cacheReadTokens: 600, cacheWriteTokens: 400 })).toBe(5700);
  });

  it('rejects a step fraction outside (0, 1], an unknown budget field, and a non-positive move threshold', () => {
    expect(messageOf(`${MINI_ASSET_YAML}agent: { max_step_fraction: 0 }\n`)).toMatch(/agent\.max_step_fraction/);
    expect(messageOf(`${MINI_ASSET_YAML}agent: { max_step_fraction: 1.5 }\n`)).toMatch(/agent\.max_step_fraction/);
    expect(messageOf(`${MINI_ASSET_YAML}agent: { budgets: { weekly: { turns: 3 } } }\n`)).toMatch(/agent\.budgets\.weekly/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers: { provisional_move_pct: 0 }\n`)).toMatch(/provisional_move_pct must be a positive number/);
  });
});

describe('existing configs', () => {
  it('keep their hashes: the new keys are optional with no defaults', () => {
    const before = parseAssetYaml(MINI_ASSET_YAML);
    expect(before.config.agent).toBeUndefined();
    expect(Object.keys(before.config.assumptions.rev_growth_y1)).toEqual(['min', 'max']);
    // This pins that the fixtures still parse unchanged.
    for (const f of ['tests/fixtures/hype.yaml', 'tests/fixtures/aero.yaml']) {
      const parsed = parseAssetYaml(readFileSync(f, 'utf8')).config;
      expect(parsed.agent).toBeUndefined();
      for (const b of Object.values(parsed.assumptions)) expect(Object.keys(b).sort()).toEqual(['max', 'min']);
    }
  });
});

describe('review triggers', () => {
  it('rejects a non-positive threshold, a malformed calendar event, and an unknown key', () => {
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers: { driver_deviation_pct: -5 }\n`)).toMatch(/driver_deviation_pct must be a positive number/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "2026-02-30", note: "Invalid date" }\n`)).toMatch(/review_triggers\.calendar\.0\.date: must be a real date, YYYY-MM-DD/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "2026-13-45", note: "Invalid date" }\n`)).toMatch(/review_triggers\.calendar\.0\.date: must be a real date, YYYY-MM-DD/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "2026-02-28", note: "Valid date" }\n`)).toBe('');
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "October 1st", note: "Emission cut" }\n`)).toMatch(/review_triggers\.calendar\.0\.date: must be a date, YYYY-MM-DD/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "2026-10-01" }\n`)).toMatch(/review_triggers\.calendar\.0\.note/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers: { deviation_pct: 25 }\n`)).toMatch(/review_triggers/);
  });

  it('rejects duplicate calendar dates but accepts different dates', () => {
    expect(messageOf(
      `${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "2026-10-01", note: "Event 1" }\n    - { date: "2026-10-01", note: "Event 2" }\n`,
    )).toMatch(/review_triggers: calendar dates must be unique \(2026-10-01\)/);
    expect(messageOf(
      `${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "2026-10-01", note: "Event 1" }\n    - { date: "2026-10-02", note: "Event 2" }\n`,
    )).toBe('');
  });
});
