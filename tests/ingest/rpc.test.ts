import { describe, expect, it } from 'vitest';
import { firstBlockAtOrAfter, getLogsChunked, type TransferLog } from '../../src/ingest/transport/rpc.js';
import { cleanRpcErrorMessage, createViemRpc } from '../../src/ingest/transport/viemRpc.js';
import type { OrionError } from '../../src/types.js';
import { fakeRpc } from '../helpers/fakeRpc.js';

const noSleep = { sleep: async () => undefined };
const log = (blockNumber: bigint, logIndex = 0): Omit<TransferLog, 'timestamp'> => ({
  blockNumber, logIndex, txHash: `0x${blockNumber.toString(16)}`, from: '0xabc', value: 1n,
});
const Q = { token: '0xt', to: '0x0' };

async function collect(gen: AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: TransferLog[] }>) {
  const out: { fromBlock: bigint; toBlock: bigint; logs: TransferLog[] }[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('getLogsChunked', () => {
  it('walks a range in chunks of at most 2000 blocks and stamps each log with its block time', async () => {
    const rpc = fakeRpc({ genesisTs: 1_000_001, latest: 10_000n, logs: [log(5n), log(1999n), log(2000n), log(4500n, 3), log(4500n, 1)] });
    const chunks = await collect(getLogsChunked(rpc, { ...Q, fromBlock: 0n, toBlock: 4500n }, noSleep));
    expect(chunks.map((c) => [c.fromBlock, c.toBlock])).toEqual([[0n, 1999n], [2000n, 3999n], [4000n, 4500n]]);
    expect(chunks[0].logs.map((l) => l.blockNumber)).toEqual([5n, 1999n]);
    expect(chunks[0].logs[0].timestamp).toBe(1_000_001 + 10);
    expect(chunks[2].logs.map((l) => l.logIndex)).toEqual([1, 3]); // sorted by block, then log index
  });

  it('retries a failed chunk and carries on', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 10_000n, logs: [log(10n)] });
    rpc.failNextLogCalls(3);
    const sleeps: number[] = [];
    const chunks = await collect(getLogsChunked(rpc, { ...Q, fromBlock: 0n, toBlock: 100n }, { sleep: async (ms) => void sleeps.push(ms) }));
    expect(chunks).toHaveLength(1);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('throws after one attempt and three retries, naming the block range', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 10_000n });
    rpc.failNextLogCalls(4);
    await expect(collect(getLogsChunked(rpc, { ...Q, fromBlock: 0n, toBlock: 100n }, noSleep))).rejects.toThrow(/blocks 0-100.*4 attempts/);
  });
});

describe('firstBlockAtOrAfter', () => {
  it('lands exactly on a regular two-second chain in a handful of calls', async () => {
    const rpc = fakeRpc({ genesisTs: 1_000_001, latest: 5_000_000n }); // odd seconds, like Base
    const latest = await rpc.latestBlock();
    const target = 1_000_001 + 2 * 1_234_567 - 1; // between two blocks
    const found = await firstBlockAtOrAfter(rpc, target, latest, latest);
    expect(found.number).toBe(1_234_567n);
    expect(found.timestamp).toBeGreaterThanOrEqual(target);
    expect(rpc.timestampOf(found.number - 1n)).toBeLessThan(target);
    expect(rpc.stats.getBlock).toBeLessThanOrEqual(4);
  });

  it('returns a block whose timestamp equals the target', async () => {
    const rpc = fakeRpc({ genesisTs: 1_000_000, latest: 1_000_000n });
    const latest = await rpc.latestBlock();
    expect((await firstBlockAtOrAfter(rpc, 1_000_000 + 2 * 777, latest, latest)).number).toBe(777n);
  });

  it('still converges when block times are irregular', async () => {
    // Two-second blocks with a ten-minute halt after block 1000.
    const timestampOf = (n: bigint) => 5_000 + Number(n) * 2 + (n > 1000n ? 600 : 0);
    const rpc = fakeRpc({ genesisTs: 5_000, latest: 100_000n, timestampOf });
    const latest = await rpc.latestBlock();
    for (const target of [5_000 + 2 * 1000 + 1, 5_000 + 2 * 1000 + 300, 5_000 + 2 * 50_000 + 601]) {
      const found = await firstBlockAtOrAfter(rpc, target, latest, latest);
      expect(found.timestamp).toBeGreaterThanOrEqual(target);
      expect(timestampOf(found.number - 1n)).toBeLessThan(target);
    }
  });

  it('refuses a target the chain has not reached', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 100n });
    const latest = await rpc.latestBlock();
    await expect(firstBlockAtOrAfter(rpc, 10_000, latest, latest)).rejects.toThrow(/no block at or after/);
  });
});

describe('createViemRpc', () => {
  it('supports Base only', () => {
    expect(() => createViemRpc('http://localhost:1', 8453)).not.toThrow();
    let code: string | undefined;
    try {
      createViemRpc('http://localhost:1', 1);
    } catch (err) {
      code = (err as OrionError).code;
    }
    expect(code).toBe('unsupported_chain');
  });
});

describe('cleanRpcErrorMessage', () => {
  it('prefers a viem-style shortMessage over the full message', () => {
    const err = { shortMessage: 'The contract function reverted.', message: 'The contract function "totalSupply" reverted.\n\nURL: https://mainnet.base.org/?key=SECRET\n...' };
    expect(cleanRpcErrorMessage(err)).toBe('The contract function reverted.');
  });

  it('falls back to the full message with any URL trimmed down to its origin', () => {
    const err = new Error('HTTP request failed. URL: https://mainnet.base.org/rpc?key=SECRET Status: 503');
    expect(cleanRpcErrorMessage(err)).toBe('HTTP request failed. URL: https://mainnet.base.org Status: 503');
  });

  it('handles a non-Error value and a message with no URL', () => {
    expect(cleanRpcErrorMessage('boom')).toBe('boom');
    expect(cleanRpcErrorMessage(new Error('connection refused'))).toBe('connection refused');
  });
});
