import type { Db } from './connection.js';

/** Where a resumable log scan stopped: the last fully written UTC day and that day's last block. */
export interface FetchCursor {
  lastBlock: number;
  lastDay: string;
}

export async function getCursor(db: Db, assetId: string, scanKey: string): Promise<FetchCursor | null> {
  const row = await db.one<{ last_block: number; last_day: string }>(
    'SELECT last_block, last_day FROM fetch_cursors WHERE asset_id = $1 AND scan_key = $2',
    [assetId, scanKey],
  );
  return row ? { lastBlock: row.last_block, lastDay: row.last_day } : null;
}

/** Moves the cursor forward. A cursor never moves backwards: a forced re-scan of old days leaves it alone. */
export async function advanceCursor(db: Db, assetId: string, scanKey: string, cursor: FetchCursor, nowIso: string): Promise<void> {
  await db.run(
    `INSERT INTO fetch_cursors (asset_id, scan_key, last_block, last_day, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (asset_id, scan_key) DO UPDATE SET
       last_block = excluded.last_block, last_day = excluded.last_day, updated_at = excluded.updated_at
     WHERE excluded.last_day > fetch_cursors.last_day`,
    [assetId, scanKey, cursor.lastBlock, cursor.lastDay, nowIso],
  );
}
