import type { BlockRef } from '../ingest/transport/rpc.js';
import type { Db } from './connection.js';

/**
 * The first block at or after 00:00 UTC of a day, per chain (N9): every asset on a chain scans the same day boundaries,
 * so one search per chain and day serves them all. A boundary is a fact of the chain once it is final, so a stored row
 * is never rewritten (the first write wins).
 */
export interface DayBlockCache {
  get(day: string): Promise<BlockRef | null>;
  put(day: string, b: BlockRef): Promise<void>;
}

export function dbDayBlocks(db: Db, chainId: number): DayBlockCache {
  return {
    async get(day) {
      const row = await db.one<{ first_block: number; first_block_ts: number }>(
        'SELECT first_block, first_block_ts FROM day_blocks WHERE chain_id = $1 AND day = $2', [chainId, day],
      );
      return row ? { number: BigInt(row.first_block), timestamp: Number(row.first_block_ts) } : null;
    },
    async put(day, b) {
      await db.run(
        'INSERT INTO day_blocks (chain_id, day, first_block, first_block_ts) VALUES ($1, $2, $3, $4) ON CONFLICT (chain_id, day) DO NOTHING',
        [chainId, day, b.number, b.timestamp],
      );
    },
  };
}
