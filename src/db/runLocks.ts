import { OrionError } from '../types.js';
import { abandonRunningRuns } from './agentRuns.js';
import type { Db } from './connection.js';

/** Past any run's budgets, so a live run is never taken over; a killed one is, on the first acquire after this. */
export const LOCK_TTL_MS = 2 * 60 * 60 * 1000;

export interface RunLock {
  assetId: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

interface Row {
  asset_id: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

function fromRow(r: Row): RunLock {
  return { assetId: r.asset_id, holder: r.holder, acquiredAt: r.acquired_at, expiresAt: r.expires_at };
}

export async function getRunLock(db: Db, assetId: string): Promise<RunLock | null> {
  const row = await db.one<Row>('SELECT * FROM run_locks WHERE asset_id = $1', [assetId]);
  return row ? fromRow(row) : null;
}

/**
 * Takes the asset's lock for `holder`, or throws `run_in_progress` naming who holds it. An expired lock is taken over,
 * and every `running` agent run of the asset is marked `error/abandoned` at that moment: the process that held the lock
 * is gone, and this is how a stuck run is detected. Returns how many runs were abandoned and whether a prior lock existed.
 */
export async function acquireRunLock(db: Db, assetId: string, holder: string, nowIso: string): Promise<{ abandoned: number; tookOver: boolean }> {
  const now = new Date(nowIso).toISOString();
  const expires = new Date(new Date(nowIso).getTime() + LOCK_TTL_MS).toISOString();
  // In a transaction: the check reads before it writes.
  return db.tx(async (t) => {
    const held = await getRunLock(t, assetId);
    if (held && held.expiresAt > now) {
      throw new OrionError('run_in_progress', `asset ${assetId} is locked by ${held.holder} since ${held.acquiredAt}`);
    }
    await t.run(
      'INSERT INTO run_locks (asset_id, holder, acquired_at, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (asset_id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at',
      [assetId, holder, now, expires],
    );
    return { abandoned: held ? await abandonRunningRuns(t, assetId, now) : 0, tookOver: !!held };
  });
}

/** Only the holder's own row goes: a holder that outlived its TTL and was taken over must not delete the new holder's. */
export async function releaseRunLock(db: Db, assetId: string, holder: string): Promise<boolean> {
  return (await db.run('DELETE FROM run_locks WHERE asset_id = $1 AND holder = $2', [assetId, holder])).rowCount === 1;
}
