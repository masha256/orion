import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import {
  requiredAssumptionKeys, requiredExtraMetrics, validateAssetModules, validateAssumptions,
} from '../../src/engine/requirements.js';
import { MINI_ASSET_YAML, miniAsset, miniAssumptions } from '../helpers/assets.js';

describe('requirements', () => {
  it('lists required assumption keys for the mini asset', () => {
    expect(requiredAssumptionKeys(miniAsset())).toEqual([
      'capture_ramp_years.fees', 'capture_rate_terminal.fees', 'discount_rate_base',
      'growth_fade_years', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(miniAsset())).toEqual([]);
  });

  it('accepts a valid asset and valid assumptions', () => {
    expect(validateAssetModules(miniAsset())).toEqual([]);
    expect(validateAssumptions(miniAsset(), miniAssumptions())).toEqual([]);
  });

  it('reports unknown module types, disallowed kinds, and missing bounds', () => {
    const unknown = parseAssetYaml(MINI_ASSET_YAML.replace('type: holder_cashflow', 'type: nope')).config;
    expect(validateAssetModules(unknown).join('\n')).toMatch(/unknown module type/);
    const noBound = parseAssetYaml(MINI_ASSET_YAML.replace('  discount_rate_base: { min: 0.05, max: 0.5 }\n', '')).config;
    expect(validateAssetModules(noBound).join('\n')).toMatch(/discount_rate_base/);
  });

  it('reports missing, unknown, and out-of-bounds assumptions', () => {
    const values = miniAssumptions({ discount_rate_base: 0.9 });
    delete values.bear.rev_growth_y1;
    values.bull.mystery = 1;
    const errors = validateAssumptions(miniAsset(), values).join('\n');
    expect(errors).toMatch(/bear: missing rev_growth_y1/);
    expect(errors).toMatch(/bull: unknown key mystery/);
    expect(errors).toMatch(/discount_rate_base .* outside/);
  });

  it('can skip bounds for what-if runs but still checks the math', () => {
    const values = miniAssumptions({ discount_rate_base: 0.9 });
    expect(validateAssumptions(miniAsset(), values, { checkBounds: false })).toEqual([]);
    const broken = miniAssumptions({ terminal_growth: 0.2 });
    expect(validateAssumptions(miniAsset(), broken, { checkBounds: false }).join('\n')).toMatch(/must exceed terminal growth/);
  });
});
