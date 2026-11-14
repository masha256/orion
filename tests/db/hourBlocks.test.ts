import { describe, expect, it } from 'vitest';
import { dbHourBlocks } from '../../src/db/hourBlocks.js';
import { useTestDb } from '../helpers/db.js';

// Phase 3 R2 Task 3: the hour-block cache (0008 hour_blocks): B(H) per chain, the first block at or after the hour.

const testDb = useTestDb();
const H = Date.parse('2026-11-05T18:00:00Z');

describe('hour_blocks', () => {
  it('stores B(H) per chain and hour; the first write wins (a chain fact is never rewritten), as day_blocks', async () => {
    const base = dbHourBlocks(testDb(), 8453);
    expect(await base.get(H)).toBeNull();
    await base.put(H, { number: 53_556_127n, timestamp: 1_793_901_601 });
    expect(await base.get(H)).toEqual({ number: 53_556_127n, timestamp: 1_793_901_601 });
    await base.put(H, { number: 1n, timestamp: 2 });
    expect(await base.get(H)).toEqual({ number: 53_556_127n, timestamp: 1_793_901_601 });
    // Another chain, another hour: separate rows.
    expect(await dbHourBlocks(testDb(), 1).get(H)).toBeNull();
    expect(await base.get(H + 3_600_000)).toBeNull();
    const row = await testDb().one<{ chain_id: number; hour: string; block: number; block_ts: number }>('SELECT chain_id, hour, block, block_ts FROM hour_blocks');
    expect({ ...row, hour: new Date(row!.hour).toISOString() }).toEqual({ chain_id: 8453, hour: '2026-11-05T18:00:00.000Z', block: 53_556_127, block_ts: 1_793_901_601 });
  });

  it('refuses an hour that is not the top of an hour', async () => {
    await expect(dbHourBlocks(testDb(), 1).put(H + 1000, { number: 1n, timestamp: 1 })).rejects.toMatchObject({ code: 'invalid_hour' });
    await expect(dbHourBlocks(testDb(), 1).get(H + 1000)).rejects.toMatchObject({ code: 'invalid_hour' });
  });
});
