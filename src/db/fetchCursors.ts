import type { Db } from './connection.js';

/** Where a resumable log scan stopped: the last fully written UTC day and that day's last block. */
export interface FetchCursor {
  lastBlock: number;
  lastDay: string;
}

export function getCursor(db: Db, assetId: string, scanKey: string): FetchCursor | null {
  const row = db.prepare('SELECT last_block, last_day FROM fetch_cursors WHERE asset_id = ? AND scan_key = ?').get(assetId, scanKey) as
    | { last_block: number; last_day: string }
    | undefined;
  return row ? { lastBlock: row.last_block, lastDay: row.last_day } : null;
}

/** Moves the cursor forward. A cursor never moves backwards: a forced re-scan of old days leaves it alone. */
export function advanceCursor(db: Db, assetId: string, scanKey: string, cursor: FetchCursor, nowIso: string): void {
  db.prepare(
    `INSERT INTO fetch_cursors (asset_id, scan_key, last_block, last_day, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (asset_id, scan_key) DO UPDATE SET
       last_block = excluded.last_block, last_day = excluded.last_day, updated_at = excluded.updated_at
     WHERE excluded.last_day > fetch_cursors.last_day`,
  ).run(assetId, scanKey, cursor.lastBlock, cursor.lastDay, nowIso);
}
