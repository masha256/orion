import { describe, expect, it } from 'vitest';
import { createAssumptionSet, getAssumptionSetById, getLatestAssumptionSet, listAssumptionSets } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { miniAssumptions } from '../helpers/assets.js';

describe('assumption sets', () => {
  it('versions sets per asset and round-trips values', () => {
    const db = openDb(':memory:');
    expect(getLatestAssumptionSet(db, 'mini')).toBeNull();
    const v1 = createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'first', values: miniAssumptions(), createdAt: '2026-06-30T00:00:00Z' });
    const v2 = createAssumptionSet(db, {
      assetId: 'mini', author: 'user', rationale: 'second', values: miniAssumptions({ rev_growth_y1: 0.2 }), createdAt: '2026-07-01T00:00:00Z',
    });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2.parentVersion).toBe(1);
    expect(getLatestAssumptionSet(db, 'mini')!.values.base.rev_growth_y1).toBe(0.2);
    expect(getAssumptionSetById(db, v1.id)!.values).toEqual(miniAssumptions());
    expect(listAssumptionSets(db, 'mini').map((s) => s.rationale)).toEqual(['second', 'first']);
    expect(getLatestAssumptionSet(db, 'other')).toBeNull();
  });
});
