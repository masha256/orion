import { abandonRunningRuns } from '../db/agentRuns.js';
import type { OrionDb } from '../db/connection.js';
import { OrionError } from '../types.js';

/**
 * Runs `fn` holding the asset's run lock (a Postgres session advisory lock on its own connection, named `holder`), and
 * releases it on every exit path. Only the commands that run for minutes and spend money take it: `orion tick` and
 * `orion agent run`. Throws `run_in_progress` (before calling `fn`) naming the holder and since when, while another
 * process has it. The lock dies with its holder's connection, so a killed run frees it at once; the next holder then
 * marks that asset's orphaned `running` agent runs `error/abandoned`, and `onTakeover` hears how many. A release failure
 * never masks `fn`'s outcome: `onReleaseError` hears about it, and the lock still goes when its connection ends.
 */
export async function withRunLock<T>(
  db: OrionDb, assetId: string, holder: string, now: Date, fn: () => Promise<T>, opts: { onTakeover?: (abandoned: number) => void; onReleaseError?: (err: unknown) => void } = {},
): Promise<T> {
  const lock = await db.tryAssetRunLock(assetId, holder);
  if (!lock) {
    const held = await db.assetRunLockHolder(assetId);
    throw new OrionError('run_in_progress', `asset ${assetId} is locked by ${held?.holder ?? 'another process'} since ${held?.since ?? 'unknown'}`);
  }
  try {
    // Holding the lock means no other process runs this asset: a run still marked `running` is an orphan.
    const abandoned = await abandonRunningRuns(db, assetId, now.toISOString());
    if (abandoned > 0) opts.onTakeover?.(abandoned);
    return await fn();
  } finally {
    try {
      await lock.release();
    } catch (err) {
      opts.onReleaseError?.(err);
    }
  }
}

export function lockHolder(command: string): string {
  return `${command} pid ${process.pid}`;
}
