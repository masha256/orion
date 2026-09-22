import type { Db } from '../db/connection.js';
import { acquireRunLock, releaseRunLock } from '../db/runLocks.js';

/**
 * Runs `fn` holding the asset's run lock, and releases it on every exit path. Only the commands that run for minutes and
 * spend money take it: `orion tick` and `orion agent run`. Throws `run_in_progress` (before calling `fn`) when another
 * holder has it. `onTakeover` hears about a lock taken over (expired, existing runs may be abandoned). A release failure
 * never masks `fn`'s outcome: the 2-hour TTL bounds any leaked lock, and the optional callback hears about it.
 */
export async function withRunLock<T>(
  db: Db, assetId: string, holder: string, now: Date, fn: () => Promise<T>, opts: { onTakeover?: (abandoned: number) => void; onReleaseError?: (err: unknown) => void } = {},
): Promise<T> {
  const { abandoned, tookOver } = acquireRunLock(db, assetId, holder, now.toISOString());
  if (tookOver) opts.onTakeover?.(abandoned);
  try {
    return await fn();
  } finally {
    try {
      releaseRunLock(db, assetId, holder);
    } catch (err) {
      opts.onReleaseError?.(err);
    }
  }
}

export function lockHolder(command: string): string {
  return `${command} pid ${process.pid}`;
}
