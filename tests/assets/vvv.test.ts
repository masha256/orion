import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadAsset } from '../../src/config/load.js';
import { requiredExtraMetrics, validateAssetModules, validateAssumptions } from '../../src/engine/requirements.js';
import type { AssumptionValues } from '../../src/types.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('assets/vvv.yaml', () => {
  it('is a valid asset with bounds for every required assumption', () => {
    const { config } = loadAsset(ROOT, 'vvv');
    expect(validateAssetModules(config)).toEqual([]);
    expect(requiredExtraMetrics(config)).toEqual(['diem_locked_yield_share', 'diem_price_usd', 'diem_supply', 'diem_target_supply']);
  });

  it('ships a calibrated assumption file that passes validation against the live bounds', () => {
    const { config } = loadAsset(ROOT, 'vvv');
    const raw = parseYaml(readFileSync(`${ROOT}/calibration/vvv-assumptions.yaml`, 'utf8')) as Record<string, Record<string, number>>;
    const values: AssumptionValues = {
      bear: { ...raw.all, ...raw.bear },
      base: { ...raw.all, ...raw.base },
      bull: { ...raw.all, ...raw.bull },
    };
    expect(validateAssumptions(config, values)).toEqual([]);
  });
});
