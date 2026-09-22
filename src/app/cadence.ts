import { cadenceFor } from '../config/agentPolicy.js';
import type { AssetConfig } from '../config/schema.js';
import { lastAttemptAt } from '../db/agentRuns.js';
import type { Db } from '../db/connection.js';
import { MS_PER_DAY } from '../types.js';

/**
 * The scheduled run `orion tick` owes the asset now, if any. A run type is due when no non-dry run of it started within
 * its interval; a deep run also counts as that week's weekly. Every attempt counts, whatever its trigger or outcome, so a
 * failed run waits out its interval rather than being retried daily, and a run the user launched by hand is not repeated.
 * Deep comes first: on a fresh asset the first scheduled run is the full review.
 */
export function dueRunType(db: Db, asset: AssetConfig, now: Date): 'deep' | 'weekly' | null {
  const cadence = cadenceFor(asset);
  const elapsedDays = (since: string | null) => (since === null ? Infinity : (now.getTime() - new Date(since).getTime()) / MS_PER_DAY);
  // The two ends of the interval are read after fetches of different length; half a tick of slack keeps a run from
  // slipping a day on jitter.
  if (elapsedDays(lastAttemptAt(db, asset.id, ['deep'])) >= cadence.deepDays - 0.5) return 'deep';
  if (elapsedDays(lastAttemptAt(db, asset.id, ['weekly', 'deep'])) >= cadence.weeklyDays - 0.5) return 'weekly';
  return null;
}
