import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { budgetsFor, DEFAULT_BUDGETS, inputUnitsTenths, PROVISIONAL_MOVE_PCT } from '../../src/config/agentPolicy.js';
import { parseAssetYaml } from '../../src/config/load.js';
import type { OrionError } from '../../src/types.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

const messageOf = (yaml: string): string => {
  try {
    parseAssetYaml(yaml);
  } catch (err) {
    return (err as OrionError).message;
  }
  return '';
};

describe('agent settings', () => {
  it('defaults when the asset says nothing', () => {
    const asset = parseAssetYaml(MINI_ASSET_YAML).config;
    expect(budgetsFor(asset, 'disclosure')).toEqual(DEFAULT_BUDGETS.disclosure);
  });

  it('fixes the provisional move threshold at 25 percent', () => {
    expect(PROVISIONAL_MOVE_PCT).toBe(25);
  });

  it('applies partial overrides per run type and per field', () => {
    const asset = parseAssetYaml(`${MINI_ASSET_YAML}agent:\n  budgets:\n    disclosure: { requests: 5, web_searches: 0 }\n`).config;
    expect(budgetsFor(asset, 'disclosure')).toEqual({ ...DEFAULT_BUDGETS.disclosure, requests: 5, webSearches: 0 });
  });

  it('refuses the budgets of the retired run types, the step fraction and the move threshold, by name', () => {
    for (const type of ['weekly', 'triage', 'deep', 'bootstrap']) {
      expect(messageOf(`${MINI_ASSET_YAML}agent:\n  budgets:\n    ${type}: { requests: 5 }\n`), type).toMatch(new RegExp(`agent\\.budgets: Unrecognized key: "${type}"`));
    }
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  max_step_fraction: 0.1\n`)).toMatch(/agent: Unrecognized key: "max_step_fraction"/);
    expect(messageOf(`${MINI_ASSET_YAML}review_triggers:\n  provisional_move_pct: 40\n`)).toMatch(/Unrecognized key: "review_triggers"/);
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

  it('rejects an unknown budget field', () => {
    expect(messageOf(`${MINI_ASSET_YAML}agent: { budgets: { disclosure: { turns: 3 } } }\n`)).toMatch(/agent\.budgets\.disclosure/);
  });
});

describe('existing configs', () => {
  it('the fixtures parse with no agent block', () => {
    expect(parseAssetYaml(MINI_ASSET_YAML).config.agent).toBeUndefined();
    for (const f of ['tests/fixtures/hype.yaml', 'tests/fixtures/aero.yaml']) expect(parseAssetYaml(readFileSync(f, 'utf8')).config.agent).toBeUndefined();
  });
});
