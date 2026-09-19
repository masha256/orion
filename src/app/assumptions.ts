import type { AssetConfig } from '../config/schema.js';
import { createAssumptionSet, type AssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { validateAssumptions } from '../engine/requirements.js';
import { OrionError, type AssumptionValues } from '../types.js';

/**
 * The one validated write path for assumption sets: every caller (CLI today, the agent next)
 * goes through here, so nothing can store a set that the engine would refuse.
 */
export function saveAssumptions(
  db: Db,
  asset: AssetConfig,
  values: AssumptionValues,
  opts: { author: string; rationale: string; now: Date },
): AssumptionSet {
  const errors = validateAssumptions(asset, values);
  if (errors.length > 0) throw new OrionError('invalid_assumptions', errors.join('\n'));
  return createAssumptionSet(db, {
    assetId: asset.id,
    author: opts.author,
    rationale: opts.rationale,
    values,
    createdAt: opts.now.toISOString(),
  });
}
