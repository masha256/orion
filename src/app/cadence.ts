import { cadenceFor } from '../config/agentPolicy.js';
import type { AssetConfig } from '../config/schema.js';
import { lastAttemptAt } from '../db/agentRuns.js';
import { getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { MS_PER_DAY } from '../types.js';

/**
 * The scheduled run `orion tick` owes the asset now, if any. With no assumption set only a bootstrap is ever due; weekly and deep
 * are due only once a set exists. A run type is due when no non-dry run of it started within its interval; a deep run also
 * counts as that week's weekly, and a bootstrap counts as both. Every attempt counts, whatever its trigger or outcome, so a failed
 * run waits out its interval rather than being retried daily, and a run the user launched by hand is not repeated.
 */
export function dueRunType(db: Db, asset: AssetConfig, now: Date): 'bootstrap' | 'deep' | 'weekly' | null {
  const cadence = cadenceFor(asset);
  const elapsedDays = (since: string | null) => (since === null ? Infinity : (now.getTime() - new Date(since).getTime()) / MS_PER_DAY);
  // With no assumption set only a bootstrap can run (weekly and deep fail preflight): the first at once, a retry after a
  // failed one on the weekly interval, so a bootstrap that ran out of budget is not retried daily at its full cost.
  if (getLatestAssumptionSet(db, asset.id) === null) {
    return elapsedDays(lastAttemptAt(db, asset.id, ['bootstrap'])) >= cadence.weeklyDays - 0.5 ? 'bootstrap' : null;
  }
  const lastFull = lastAttemptAt(db, asset.id, ['deep', 'bootstrap']);
  if (lastFull === null) return 'bootstrap';
  // The two ends of the interval are read after fetches of different length; half a tick of slack keeps a run from
  // slipping a day on jitter.
  if (elapsedDays(lastFull) >= cadence.deepDays - 0.5) return 'deep';
  if (elapsedDays(lastAttemptAt(db, asset.id, ['weekly', 'deep', 'bootstrap'])) >= cadence.weeklyDays - 0.5) return 'weekly';
  return null;
}
