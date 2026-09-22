import type { Db } from '../db/connection.js';
import { acquireRunLock, releaseRunLock } from '../db/runLocks.js';

/**
 * Runs `fn` holding the asset's run lock, and releases it on every exit path. Only the commands that run for minutes and
 * spend money take it: `orion tick` and `orion agent run`. Throws `run_in_progress` (before calling `fn`) when another
 * holder has it. `onTakeover` hears how many stuck runs were abandoned when an expired lock was taken over.
 */
export async function withRunLock<T>(
  db: Db, assetId: string, holder: string, now: Date, fn: () => Promise<T>, opts: { onTakeover?: (abandoned: number) => void } = {},
): Promise<T> {
  const { abandoned } = acquireRunLock(db, assetId, holder, now.toISOString());
  if (abandoned > 0) opts.onTakeover?.(abandoned);
  try {
    return await fn();
  } finally {
    releaseRunLock(db, assetId, holder);
  }
}

export function lockHolder(command: string): string {
  return `${command} pid ${process.pid}`;
}
