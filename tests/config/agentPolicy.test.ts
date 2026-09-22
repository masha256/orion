import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentBand, budgetsFor, calendarEvents, DEFAULT_BUDGETS, driverDeviationPct, keyBounds, maxStepFraction, provisionalMovePct } from '../../src/config/agentPolicy.js';
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

describe('agent bands', () => {
  it('uses the scenario band when there is one, else the key-wide bounds', () => {
    const asset = parseAssetYaml(withBands('base: { min: 0, max: 1 }')).config;
    expect(agentBand(asset, 'rev_growth_y1', 'base')).toEqual({ min: 0, max: 1 });
    expect(agentBand(asset, 'rev_growth_y1', 'bull')).toEqual({ min: -0.5, max: 5 });
    expect(keyBounds(asset, 'rev_growth_y1')).toEqual({ min: -0.5, max: 5 });
    expect(agentBand(asset, 'no_such_key', 'base')).toBeNull();
    expect(keyBounds(asset, 'no_such_key')).toBeNull();
  });

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
    expect(maxStepFraction(asset)).toBe(0.25);
    expect(provisionalMovePct(asset)).toBe(25);
    expect(budgetsFor(asset, 'deep')).toEqual(DEFAULT_BUDGETS.deep);
  });

  it('applies partial overrides per run type and per field', () => {
    const asset = parseAssetYaml(
      `${MINI_ASSET_YAML}agent:\n  max_step_fraction: 0.1\n  budgets:\n    weekly: { requests: 5, web_searches: 0 }\nreview_triggers:\n  provisional_move_pct: 40\n`,
    ).config;
    expect(maxStepFraction(asset)).toBe(0.1);
    expect(provisionalMovePct(asset)).toBe(40);
    expect(budgetsFor(asset, 'weekly')).toEqual({ ...DEFAULT_BUDGETS.weekly, requests: 5, webSearches: 0 });
    expect(budgetsFor(asset, 'triage')).toEqual(DEFAULT_BUDGETS.triage);
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
    // The golden test pins VVV's engine output hash; this pins that the fixtures still parse unchanged.
    for (const f of ['tests/fixtures/hype.yaml', 'tests/fixtures/aero.yaml', 'tests/fixtures/vvv-golden.yaml']) {
      const parsed = parseAssetYaml(readFileSync(f, 'utf8')).config;
      expect(parsed.agent).toBeUndefined();
      for (const b of Object.values(parsed.assumptions)) expect(Object.keys(b).sort()).toEqual(['max', 'min']);
    }
  });
});

describe('review triggers', () => {
  it('defaults the deviation threshold to 25 and the calendar to empty, and reads what the asset sets', () => {
    const asset = parseAssetYaml(MINI_ASSET_YAML).config;
    expect(driverDeviationPct(asset)).toBe(25);
    expect(calendarEvents(asset)).toEqual([]);
    const set = parseAssetYaml(`${MINI_ASSET_YAML}review_triggers:\n  driver_deviation_pct: 10\n  calendar:\n    - { date: "2026-10-01", note: "Emission cut" }\n`).config;
    expect(driverDeviationPct(set)).toBe(10);
    expect(calendarEvents(set)).toEqual([{ date: '2026-10-01', note: 'Emission cut' }]);
  });

  it('rejects a non-positive threshold, a malformed calendar event, and an unknown key', () => {
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers: { driver_deviation_pct: -5 }\n`)).toMatch(/driver_deviation_pct must be a positive number/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "October 1st", note: "Emission cut" }\n`)).toMatch(/review_triggers\.calendar\.0\.date: must be a date, YYYY-MM-DD/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  calendar:\n    - { date: "2026-10-01" }\n`)).toMatch(/review_triggers\.calendar\.0\.note/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers: { deviation_pct: 25 }\n`)).toMatch(/review_triggers/);
  });
});
