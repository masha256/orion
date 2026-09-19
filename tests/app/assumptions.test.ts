import { beforeEach, describe, expect, it } from 'vitest';
import { saveAssumptions } from '../../src/app/assumptions.js';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import { listAssumptionSets } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { OrionError } from '../../src/types.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { AS_OF } from '../helpers/obs.js';

let db: Db;
let asset: AssetConfig;
const NOW = new Date(AS_OF);

beforeEach(() => {
  db = openDb(':memory:');
  asset = parseAssetYaml(MINI_ASSET_YAML).config;
});

describe('saveAssumptions', () => {
  it('stores a valid set under the given author', () => {
    const set = saveAssumptions(db, asset, miniAssumptions(), { author: 'agent', rationale: 'first pass', now: NOW });
    expect(set.version).toBe(1);
    expect(set.author).toBe('agent');
    expect(set.rationale).toBe('first pass');
    expect(set.values.base.discount_rate_base).toBe(0.1);
  });

  it('refuses an out-of-bounds set and stores nothing', () => {
    expect(() => saveAssumptions(db, asset, miniAssumptions({ discount_rate_base: 0.9 }), { author: 'agent', rationale: 'too high', now: NOW }))
      .toThrow(OrionError);
    expect(listAssumptionSets(db, 'mini')).toEqual([]);
  });
});
