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

export function getRunLock(db: Db, assetId: string): RunLock | null {
  const row = db.prepare('SELECT * FROM run_locks WHERE asset_id = ?').get(assetId) as Row | undefined;
  return row ? fromRow(row) : null;
}

/**
 * Takes the asset's lock for `holder`, or throws `run_in_progress` naming who holds it. An expired lock is taken over,
 * and every `running` agent run of the asset is marked `error/abandoned` at that moment: the process that held the lock
 * is gone, and this is how a stuck run is detected. Returns how many runs were abandoned and whether a prior lock existed.
 */
export function acquireRunLock(db: Db, assetId: string, holder: string, nowIso: string): { abandoned: number; tookOver: boolean } {
  const now = new Date(nowIso).toISOString();
  const expires = new Date(new Date(nowIso).getTime() + LOCK_TTL_MS).toISOString();
  // IMMEDIATE: the check reads before it writes; a deferred transaction losing that race fails outright.
  return db.transaction(() => {
    const held = getRunLock(db, assetId);
    if (held && held.expiresAt > now) {
      throw new OrionError('run_in_progress', `asset ${assetId} is locked by ${held.holder} since ${held.acquiredAt}`);
    }
    db.prepare(
      'INSERT INTO run_locks (asset_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (asset_id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at',
    ).run(assetId, holder, now, expires);
    return { abandoned: held ? abandonRunningRuns(db, assetId, now) : 0, tookOver: !!held };
  }).immediate();
}

/** Only the holder's own row goes: a holder that outlived its TTL and was taken over must not delete the new holder's. */
export function releaseRunLock(db: Db, assetId: string, holder: string): boolean {
  return db.prepare('DELETE FROM run_locks WHERE asset_id = ? AND holder = ?').run(assetId, holder).changes === 1;
}
