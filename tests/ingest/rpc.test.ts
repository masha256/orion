import { describe, expect, it } from 'vitest';
import { firstBlockAtOrAfter, getLogsChunked, isLogRangeError, type TransferLog } from '../../src/ingest/transport/rpc.js';
import { DEFAULT_RPC_URLS } from '../../src/ingest/run.js';
import { CHAINS } from '../../src/ingest/transport/chains.js';
import { CHAIN_RPC_ENV } from '../../src/ingest/transport/chainRpcEnv.js';
import { cleanRpcErrorMessage, createViemRpc, createViemRpcWith, pickValue } from '../../src/ingest/transport/viemRpc.js';
import type { OrionError } from '../../src/types.js';
import { fakeJsonRpcFetch, fakeRpc } from '../helpers/fakeRpc.js';

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

  it('finds day starts on both sides of a block-time change (Base: 2 s to 0.2 s at block ~53,556,072, 2026-11-05)', async () => {
    // Measured 2026-11-06: 2.000 s/block before block 53,556,072 (2026-11-05T17:58:11Z), 0.200 s after. A search that
    // trusted the nominal rate alone undershot 10x per step and gave up after 64 probes ("could not locate ...").
    const S = 53_556_072n;
    const tsS = Date.parse('2026-11-05T17:58:11Z') / 1000;
    const timestampOf = (n: bigint): number => (n <= S ? tsS - Number(S - n) * 2 : tsS + Math.floor(Number(n - S) / 5));
    const latestN = S + 5n * 120_000n; // ~1.4 days after the switch
    const days = ['2026-10-20', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
    for (const blockTimeSec of [2, 0.2]) {
      for (const d of days) {
        const rpc = fakeRpc({ genesisTs: 0, latest: latestN, timestampOf, blockTimeSec });
        const latest = await rpc.latestBlock();
        const target = Date.parse(`${d}T00:00:00Z`) / 1000;
        const found = await firstBlockAtOrAfter(rpc, target, latest, latest);
        expect(found.timestamp, `${d} at ${blockTimeSec}`).toBeGreaterThanOrEqual(target);
        expect(timestampOf(found.number - 1n), `${d} at ${blockTimeSec}`).toBeLessThan(target);
        expect(rpc.stats.getBlock, `${d} at ${blockTimeSec}`).toBeLessThanOrEqual(40);
      }
    }
  });

  it('refuses a target the chain has not reached', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 100n });
    const latest = await rpc.latestBlock();
    await expect(firstBlockAtOrAfter(rpc, 10_000, latest, latest)).rejects.toThrow(/no block at or after/);
  });
});

describe('createViemRpc', () => {
  it('supports Base, Ethereum and BNB Chain, each with its own log range and block time', () => {
    expect(createViemRpc('http://localhost:1', 8453)).toMatchObject({ maxLogRange: 2000n, blockTimeSec: 0.2 });
    expect(createViemRpc('http://localhost:1', 1)).toMatchObject({ maxLogRange: 10_000n, blockTimeSec: 12 });
    expect(createViemRpc('http://localhost:1', 56)).toMatchObject({ maxLogRange: 50_000n, blockTimeSec: 0.45 });
    let err: OrionError | undefined;
    try {
      createViemRpc('http://localhost:1', 137);
    } catch (e) {
      err = e as OrionError;
    }
    expect(err?.code).toBe('unsupported_chain');
    expect(err?.message).toMatch(/supported: 1, 10, 56, 4663, 5042, 8453, 42161, 57073, 99901/);
  });

  it('supports OP, Arbitrum, Ink, Robinhood, Arc and Elysium (Elysium through defineChain), each from its chain row', () => {
    for (const id of [10, 42161, 57073, 4663, 5042, 99901]) {
      const info = CHAINS[id]!;
      expect(createViemRpc('http://localhost:1', id)).toMatchObject({ maxLogRange: info.maxLogRange, blockTimeSec: info.blockTimeSec, confirmations: info.confirmations });
    }
  });
});

describe('the chain table', () => {
  it('gives Base a keyless default RPC and Ethereum and BNB Chain none', () => {
    expect(CHAINS[8453]).toMatchObject({ name: 'Base', maxLogRange: 2000n, blockTimeSec: 0.2, defaultRpcUrl: 'https://mainnet.base.org', confirmations: 9000n });
    expect(CHAINS[1]).toMatchObject({ name: 'Ethereum', maxLogRange: 10_000n, blockTimeSec: 12, defaultRpcUrl: null });
    expect(CHAINS[56]).toMatchObject({ name: 'BNB Chain', maxLogRange: 50_000n, blockTimeSec: 0.45, defaultRpcUrl: null });
    expect(DEFAULT_RPC_URLS).toEqual({ 8453: 'https://mainnet.base.org' });
  });

  it('holds the six R4 chains with their measured values and no keyless default', () => {
    expect(CHAINS[10]).toEqual({ id: 10, name: 'optimism', maxLogRange: 1_000_000n, blockTimeSec: 2, defaultRpcUrl: null, confirmations: 900n });
    expect(CHAINS[42161]).toEqual({ id: 42161, name: 'arbitrum', maxLogRange: 1_000_000n, blockTimeSec: 0.3, defaultRpcUrl: null, confirmations: 7200n });
    expect(CHAINS[57073]).toEqual({ id: 57073, name: 'ink', maxLogRange: 10_000n, blockTimeSec: 1, defaultRpcUrl: null, confirmations: 1800n });
    expect(CHAINS[4663]).toEqual({ id: 4663, name: 'robinhood', maxLogRange: 1_000_000n, blockTimeSec: 0.11, defaultRpcUrl: null, confirmations: 18_000n });
    expect(CHAINS[5042]).toEqual({ id: 5042, name: 'arc', maxLogRange: 1_000_000n, blockTimeSec: 0.5, defaultRpcUrl: null, confirmations: 3600n });
    expect(CHAINS[99901]).toEqual({ id: 99901, name: 'elysium', maxLogRange: 1_000_000n, blockTimeSec: 0.15, defaultRpcUrl: null, confirmations: 12_000n });
  });

  it('names one RPC env var per chain', () => {
    expect(CHAIN_RPC_ENV).toEqual({
      1: 'ORION_ETH_RPC_URL', 10: 'ORION_OP_RPC_URL', 56: 'ORION_BNB_RPC_URL', 4663: 'ORION_ROBINHOOD_RPC_URL', 5042: 'ORION_ARC_RPC_URL',
      8453: 'ORION_BASE_RPC_URL', 42161: 'ORION_ARB_RPC_URL', 57073: 'ORION_INK_RPC_URL', 99901: 'ORION_ELYSIUM_RPC_URL',
    });
    expect(Object.keys(CHAIN_RPC_ENV).map(Number).sort((a, b) => a - b)).toEqual(Object.keys(CHAINS).map(Number).sort((a, b) => a - b));
  });
});

describe('a chain with a wider log range and slower blocks', () => {
  it('chunks by the transport\'s own range', async () => {
    const rpc = fakeRpc({ genesisTs: 1_000_000, latest: 100_000n, blockTimeSec: 12, maxLogRange: 10_000n, logs: [log(9_999n), log(10_000n), log(25_000n)] });
    const chunks = await collect(getLogsChunked(rpc, { ...Q, fromBlock: 0n, toBlock: 25_000n }, noSleep));
    expect(chunks.map((c) => [c.fromBlock, c.toBlock])).toEqual([[0n, 9_999n], [10_000n, 19_999n], [20_000n, 25_000n]]);
    expect(chunks.flatMap((c) => c.logs.map((l) => l.blockNumber))).toEqual([9_999n, 10_000n, 25_000n]);
  });

  it('finds a block from the transport\'s own block time in a handful of calls', async () => {
    const rpc = fakeRpc({ genesisTs: 1_600_000_000, latest: 3_000_000n, blockTimeSec: 12 });
    const latest = await rpc.latestBlock();
    const target = 1_600_000_000 + 12 * 1_234_567 - 5;
    const found = await firstBlockAtOrAfter(rpc, target, latest, latest);
    expect(found.number).toBe(1_234_567n);
    expect(rpc.stats.getBlock).toBeLessThanOrEqual(4);
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

  it('strips a key carried in the URL path, as Alchemy\'s is', () => {
    const err = new Error('HTTP request failed. URL: https://eth-mainnet.g.alchemy.com/v2/alch_SECRET Status: 429');
    expect(cleanRpcErrorMessage(err)).toBe('HTTP request failed. URL: https://eth-mainnet.g.alchemy.com Status: 429');
  });

  it('handles a non-Error value and a message with no URL', () => {
    expect(cleanRpcErrorMessage('boom')).toBe('boom');
    expect(cleanRpcErrorMessage(new Error('connection refused'))).toBe('connection refused');
  });
});

describe('pickValue', () => {
  it('reads a single integer, or one value of a multi-value return', () => {
    expect(pickValue(5n, undefined)).toEqual({ ok: true, value: 5n });
    expect(pickValue(7, undefined)).toEqual({ ok: true, value: 7n });
    expect(pickValue([83n, 1916784000n], 0)).toEqual({ ok: true, value: 83n });
    expect(pickValue([83n, 1916784000n], 1)).toEqual({ ok: true, value: 1916784000n });
  });

  it('refuses a missing position, a non-integer, and a negative value', () => {
    expect(pickValue([1n], 3)).toEqual({ ok: false, error: 'the call returned no integer at position 3' });
    expect(pickValue('0xabc', undefined)).toEqual({ ok: false, error: 'the call returned no integer' });
    expect(pickValue([-4n, 0n], 0)).toEqual({ ok: false, error: 'the call returned a negative value (-4)' });
  });
});

describe('multicallData (Multicall3 aggregate3, raw calldata, Phase 3 R4)', () => {
  const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}`, data: `0x${i.toString(16).padStart(8, '0')}` as `0x${string}` }));
  /** Echo: each inner call returns its own calldata, so order is visible; a target ending in ...dead fails. */
  const echo = (to: string, data: string) => (to.toLowerCase().endsWith('dead') ? null : data);

  it('multicallData chunks 1000 calls into 3 eth_calls and keeps order', async () => {
    const node = fakeJsonRpcFetch({ call: echo });
    const rpc = createViemRpcWith('http://localhost:1', 8453, { fetchFn: node.fetchFn });
    const out = await rpc.multicallData!(calls(1000), 123n);
    expect(node.requests.filter((r) => r.method === 'eth_call')).toHaveLength(3); // 400 + 400 + 200
    expect(node.innerCallsPerRequest).toEqual([400, 400, 200]);
    expect(node.requests.every((r) => r.method !== 'eth_call' || r.params[1] === '0x7b')).toBe(true); // every chunk at block 123
    expect(out.map((r) => (r.ok ? r.data : null))).toEqual(calls(1000).map((c) => c.data));
  });

  it('honours a smaller chunk', async () => {
    const node = fakeJsonRpcFetch({ call: echo });
    const rpc = createViemRpcWith('http://localhost:1', 8453, { fetchFn: node.fetchFn });
    await rpc.multicallData!(calls(10), 1n, { chunk: 4 });
    expect(node.innerCallsPerRequest).toEqual([4, 4, 2]);
  });

  it('a failed inner call is reported in its slot', async () => {
    const node = fakeJsonRpcFetch({ call: echo });
    const rpc = createViemRpcWith('http://localhost:1', 8453, { fetchFn: node.fetchFn });
    const list = calls(3);
    list[1] = { address: '0x000000000000000000000000000000000000dead', data: '0x12345678' };
    const out = await rpc.multicallData!(list, 5n);
    expect(out).toEqual([{ ok: true, data: list[0].data }, { ok: false, error: expect.stringMatching(/reverted/) }, { ok: true, data: list[2].data }]);
  });

  it('fakeRpc serves dataCalls in chunks, counting one multicallData per eth_call, and fails a null slot', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 10n, dataCalls: (a, d, b) => (a.endsWith('3') ? null : `${d}${b.toString(16).padStart(2, '0')}`) });
    const out = await rpc.multicallData!(calls(5), 7n, { chunk: 2 });
    expect(rpc.stats.multicallData).toBe(3);
    expect(out[0]).toEqual({ ok: true, data: '0x0000000007' });
    expect(out[2]).toMatchObject({ ok: false });
  });
});

describe('getLogs (raw logs by address list and topic0, Phase 3 R4)', () => {
  const TOPIC = '0x' + 'ab'.repeat(32);
  const ADDR = ['0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb'];

  it('getLogs splits 25,000 blocks at Ink maxLogRange 10,000 into 3 requests', async () => {
    const node = fakeJsonRpcFetch({ logs: (q) => [{ address: ADDR[0], topics: [TOPIC], data: '0x01', blockNumber: q.fromBlock, logIndex: 0 }] });
    const rpc = createViemRpcWith('http://localhost:1', 57073, { fetchFn: node.fetchFn });
    expect(rpc.maxLogRange).toBe(10_000n);
    const logs = await rpc.getLogs!({ address: ADDR, topic0: TOPIC, fromBlock: 0n, toBlock: 24_999n });
    const ranges = node.requests.filter((r) => r.method === 'eth_getLogs').map((r) => [r.params[0].fromBlock, r.params[0].toBlock]);
    expect(ranges).toEqual([['0x0', '0x270f'], ['0x2710', '0x4e1f'], ['0x4e20', '0x61a7']]);
    expect(node.requests.find((r) => r.method === 'eth_getLogs')!.params[0]).toMatchObject({ address: ADDR, topics: [TOPIC] });
    expect(logs.map((l) => l.blockNumber)).toEqual([0n, 10_000n, 20_000n]);
    expect(logs[0]).toEqual({ address: ADDR[0], topics: [TOPIC], data: '0x01', logIndex: 0, blockNumber: 0n });
  });

  it('getLogs halves on a range error', async () => {
    // The provider refuses more than 2,500 blocks with a "too many results" error.
    const node = fakeJsonRpcFetch({
      logs: (q) => {
        if (q.toBlock - q.fromBlock + 1n > 2_500n) return { code: -32602, message: 'query returned more than 10000 results' };
        return [{ address: ADDR[1], topics: [TOPIC], data: '0x', blockNumber: q.toBlock, logIndex: 1 }];
      },
    });
    const rpc = createViemRpcWith('http://localhost:1', 57073, { fetchFn: node.fetchFn });
    const logs = await rpc.getLogs!({ address: ADDR, topic0: TOPIC, fromBlock: 0n, toBlock: 9_999n });
    const ok = node.requests.filter((r) => r.method === 'eth_getLogs').map((r) => [BigInt(r.params[0].fromBlock), BigInt(r.params[0].toBlock)]);
    // 10,000 is refused, then each 5,000 half, then each 2,500 quarter is served, in block order.
    expect(ok).toEqual([[0n, 9_999n], [0n, 4_999n], [0n, 2_499n], [2_500n, 4_999n], [5_000n, 9_999n], [5_000n, 7_499n], [7_500n, 9_999n]]);
    expect(logs.map((l) => l.blockNumber)).toEqual([2_499n, 4_999n, 7_499n, 9_999n]);
  });

  it('a rate limit is never taken for a range error: thrown at once, not halved (429, "Too Many Requests", -32005 rate limited)', async () => {
    const limits = [
      'HTTP request failed. Status: 429 URL: https://rpc.example Details: Too Many Requests',
      'Too Many Requests',
      'daily request count exceeded, request rate limited -32005',
      'Your app has exceeded its compute units per second capacity',
      'rate limit exceeded',
    ];
    for (const msg of limits) {
      expect(isLogRangeError(new Error(msg)), msg).toBe(false);
      const rpc = fakeRpc({ genesisTs: 0, latest: 10n, maxLogRange: 10_000n, logs: () => { throw new Error(msg); } });
      await expect(rpc.getLogs!({ address: ADDR, topic0: TOPIC, fromBlock: 0n, toBlock: 9_999n })).rejects.toThrow(msg);
      expect(rpc.stats.getLogs, msg).toBe(1);
    }
    // Real range refusals still halve, -32005 with range wording included (Infura's "more than 10000 results").
    for (const msg of ['query returned more than 10000 results -32005', 'block range too large', 'exceed maximum block range: 2000', 'Log response size exceeded', 'too many results', '-32005']) {
      expect(isLogRangeError(new Error(msg)), msg).toBe(true);
    }
  });

  it('throws after 8 halvings, and passes any other error straight on', async () => {
    const always = fakeRpc({ genesisTs: 0, latest: 10n, maxLogRange: 10_000n, logs: () => { throw new Error('block range too large'); } });
    await expect(always.getLogs!({ address: ADDR, topic0: TOPIC, fromBlock: 0n, toBlock: 9_999n })).rejects.toThrow(/8 halvings/);
    expect(always.stats.getLogs).toBe(9); // the range itself, then one half at each of 8 depths
    const broken = fakeRpc({ genesisTs: 0, latest: 10n, logs: () => { throw new Error('connection reset'); } });
    await expect(broken.getLogs!({ address: ADDR, topic0: TOPIC, fromBlock: 0n, toBlock: 10n })).rejects.toThrow('connection reset');
    expect(broken.stats.getLogs).toBe(1);
  });

  it('fakeRpc splits at its maxLogRange and counts each request', async () => {
    const seen: [bigint, bigint][] = [];
    const rpc = fakeRpc({ genesisTs: 0, latest: 10n, maxLogRange: 10_000n, logs: (q) => (seen.push([q.fromBlock, q.toBlock]), []) });
    await rpc.getLogs!({ address: ADDR, topic0: TOPIC, fromBlock: 0n, toBlock: 24_999n });
    expect(seen).toEqual([[0n, 9_999n], [10_000n, 19_999n], [20_000n, 24_999n]]);
    expect(rpc.stats.getLogs).toBe(3);
  });
});
