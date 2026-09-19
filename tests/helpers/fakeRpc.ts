import type { BlockRef, CallResult, ContractCall, LogQuery, RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';

export interface FakeRpcOptions {
  /** Timestamp of block 0, in unix seconds. */
  genesisTs: number;
  latest: bigint;
  blockTimeSec?: number;
  /** Override for irregular chains. Must be non-decreasing in n. */
  timestampOf?: (n: bigint) => number;
  /** Contract call results by callKey(). An Error makes that one call fail. */
  calls?: Record<string, bigint | Error>;
  logs?: Omit<TransferLog, 'timestamp'>[];
}

export interface FakeRpc extends RpcTransport {
  stats: { getBlock: number; multicall: number; logRanges: [bigint, bigint][] };
  failNextLogCalls(n: number): void;
  timestampOf(n: bigint): number;
  /** First block whose timestamp is at or after `ts`. Regular chains only. */
  blockAtOrAfter(ts: number): bigint;
}

export function callKey(address: string, functionName: string, args: readonly unknown[] = []): string {
  return `${address.toLowerCase()}.${functionName}(${args.map((a) => String(a).toLowerCase()).join(',')})`;
}

export function fakeRpc(o: FakeRpcOptions): FakeRpc {
  const blockTime = o.blockTimeSec ?? 2;
  const timestampOf = o.timestampOf ?? ((n: bigint) => o.genesisTs + Number(n) * blockTime);
  const stats: FakeRpc['stats'] = { getBlock: 0, multicall: 0, logRanges: [] };
  let failures = 0;

  const block = (n: bigint): BlockRef => {
    if (n < 0n || n > o.latest) throw new Error(`fake chain has no block ${n}`);
    return { number: n, timestamp: timestampOf(n) };
  };

  return {
    stats,
    timestampOf,
    blockAtOrAfter: (ts) => BigInt(Math.max(0, Math.ceil((ts - o.genesisTs) / blockTime))),
    failNextLogCalls(n) {
      failures = n;
    },
    async latestBlock() {
      return block(o.latest);
    },
    async getBlock(n) {
      stats.getBlock++;
      return block(n);
    },
    async multicall(calls: ContractCall[], _blockNumber: bigint): Promise<CallResult[]> {
      stats.multicall++;
      return calls.map((c) => {
        const hit = o.calls?.[callKey(c.address, c.functionName, c.args)];
        if (hit === undefined) return { ok: false, error: `no fake result for ${callKey(c.address, c.functionName, c.args)}` };
        return hit instanceof Error ? { ok: false, error: hit.message } : { ok: true, value: hit };
      });
    },
    async getTransferLogs(q: LogQuery): Promise<TransferLog[]> {
      stats.logRanges.push([q.fromBlock, q.toBlock]);
      if (q.toBlock - q.fromBlock + 1n > 2000n) throw new Error('query exceeds max block range 2000');
      if (failures > 0) {
        failures--;
        throw new Error('fake RPC failure');
      }
      return (o.logs ?? [])
        .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
        .map((l) => ({ ...l, timestamp: timestampOf(l.blockNumber) }));
    },
  };
}
