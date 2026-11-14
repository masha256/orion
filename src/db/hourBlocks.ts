import type { BlockRef } from '../ingest/transport/rpc.js';
import { OrionError } from '../types.js';
import type { Db } from './connection.js';
import { MS_PER_HOUR } from './prices.js';

/**
 * B(H): the first block at or after the top of a UTC hour, per chain (Phase 3 R2, plan P6; migration 0008). The price
 * writer reads every method at B(H+1h) and a cumulative TWAP from B(H), so each hour's block is searched once per chain
 * and kept here. Like day_blocks, a stored row is a fact of the chain once final, so it is never rewritten (the first
 * write wins); the writer stores only blocks well below the head.
 */
export interface HourBlockCache {
  get(hourMs: number): Promise<BlockRef | null>;
  put(hourMs: number, b: BlockRef): Promise<void>;
}

function hourIso(hourMs: number): string {
  if (!Number.isInteger(hourMs) || hourMs % MS_PER_HOUR !== 0) throw new OrionError('invalid_hour', `${hourMs} is not the top of a UTC hour`);
  return new Date(hourMs).toISOString();
}

export function dbHourBlocks(db: Db, chainId: number): HourBlockCache {
  return {
    async get(hourMs) {
      const row = await db.one<{ block: number | string; block_ts: number | string }>(
        'SELECT block, block_ts FROM hour_blocks WHERE chain_id = $1 AND hour = $2', [chainId, hourIso(hourMs)],
      );
      return row ? { number: BigInt(row.block), timestamp: Number(row.block_ts) } : null;
    },
    async put(hourMs, b) {
      await db.run(
        'INSERT INTO hour_blocks (chain_id, hour, block, block_ts) VALUES ($1, $2, $3, $4) ON CONFLICT (chain_id, hour) DO NOTHING',
        [chainId, hourIso(hourMs), b.number, b.timestamp],
      );
    },
  };
}
