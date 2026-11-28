import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import {
  chunkedMulticallData, MAX_LOG_RANGE, splitGetLogs,
  type BlockLog, type BlockRef, type CallResult, type ContractCall, type DataCall, type DataCallResult, type LogQuery, type RawLogQuery, type ReceiptLog, type RpcTransport, type TransferLog,
} from '../../src/ingest/transport/rpc.js';

export interface FakeRpcOptions {
  /** Timestamp of block 0, in unix seconds. */
  genesisTs: number;
  latest: bigint;
  blockTimeSec?: number;
  /** Override for irregular chains. Must be non-decreasing in n. */
  timestampOf?: (n: bigint) => number;
  /** Contract call results by callKey(). An Error makes that one call fail. */
  calls?: Record<string, bigint | Error>;
  /** Per-block overrides of `calls` (archive reads at an earlier block): keys found here win over `calls`. */
  callsAt?: (blockNumber: bigint) => Record<string, bigint | Error> | undefined;
  /**
   * The chain's logs. An array: the Transfer logs `getTransferLogs` serves. A function: what `getLogs` serves for one
   * request (a range already split at maxLogRange); it may throw, e.g. a provider's range error, which getLogs halves on.
   */
  logs?: Omit<TransferLog, 'timestamp'>[] | ((q: RawLogQuery) => BlockLog[]);
  /** Raw eth_call results for `multicallData`: the return data of one inner call, or null for a call that reverts. */
  dataCalls?: (address: string, data: string, block: bigint) => string | null;
  /** Exposed as the transport's maxLogRange; the fake refuses wider queries. Default 2000 (Base), left unexposed. */
  maxLogRange?: bigint;
  /** Runtime code by lowercased address, for getCode; anything else has none ('0x'). */
  code?: Record<string, string>;
  /** Receipt logs by tx hash, for getReceiptLogs; anything else has none. */
  receipts?: Record<string, ReceiptLog[]>;
}

export interface FakeRpc extends RpcTransport {
  /** `multicallData`: eth_calls (chunks) sent; `getLogs`: eth_getLogs requests sent, refused ones included. */
  stats: { getBlock: number; multicall: number; logRanges: [bigint, bigint][]; getCode: number; receipts: number; multicallData: number; getLogs: number };
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
  const stats: FakeRpc['stats'] = { getBlock: 0, multicall: 0, logRanges: [], getCode: 0, receipts: 0, multicallData: 0, getLogs: 0 };
  let failures = 0;

  const block = (n: bigint): BlockRef => {
    if (n < 0n || n > o.latest) throw new Error(`fake chain has no block ${n}`);
    return { number: n, timestamp: timestampOf(n) };
  };

  const cap = o.maxLogRange ?? 2000n;
  return {
    ...(o.maxLogRange !== undefined ? { maxLogRange: o.maxLogRange } : {}),
    ...(o.blockTimeSec !== undefined ? { blockTimeSec: o.blockTimeSec } : {}),
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
    async multicall(calls: ContractCall[], blockNumber: bigint): Promise<CallResult[]> {
      stats.multicall++;
      const at = o.callsAt?.(blockNumber);
      return calls.map((c) => {
        const key = callKey(c.address, c.functionName, c.args) + (c.pick !== undefined ? `[${c.pick}]` : '');
        const hit = at?.[key] ?? o.calls?.[key];
        if (hit === undefined) return { ok: false, error: `no fake result for ${callKey(c.address, c.functionName, c.args)}` };
        return hit instanceof Error ? { ok: false, error: hit.message } : { ok: true, value: hit };
      });
    },
    async multicallData(calls: DataCall[], blockNumber: bigint, opts?: { chunk?: number }): Promise<DataCallResult[]> {
      return chunkedMulticallData(
        async (chunk) => {
          stats.multicallData++;
          return chunk.map((c): DataCallResult => {
            const data = o.dataCalls?.(c.address.toLowerCase(), c.data, blockNumber) ?? null;
            return data === null ? { ok: false, error: `execution reverted (no fake result for ${c.address} ${c.data})` } : { ok: true, data: data as `0x${string}` };
          });
        },
        calls,
        opts?.chunk,
      );
    },
    async getLogs(q: RawLogQuery): Promise<BlockLog[]> {
      const serve = o.logs;
      return splitGetLogs(
        async (part) => {
          stats.getLogs++;
          return typeof serve === 'function' ? serve(part) : [];
        },
        q,
        o.maxLogRange ?? MAX_LOG_RANGE,
      );
    },
    async getReceiptLogs(txHash: string): Promise<ReceiptLog[]> {
      stats.receipts++;
      return o.receipts?.[txHash] ?? [];
    },
    async getCode(address: string): Promise<string> {
      stats.getCode++;
      return o.code?.[address.toLowerCase()] ?? '0x';
    },
    async getTransferLogs(q: LogQuery): Promise<TransferLog[]> {
      stats.logRanges.push([q.fromBlock, q.toBlock]);
      if (q.toBlock - q.fromBlock + 1n > cap) throw new Error(`query exceeds max block range ${cap}`);
      if (failures > 0) {
        failures--;
        throw new Error('fake RPC failure');
      }
      return (Array.isArray(o.logs) ? o.logs : [])
        .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
        .map((l) => ({ ...l, timestamp: timestampOf(l.blockNumber) }));
    },
  };
}


/**
 * A JSON-RPC node behind viem's `fetchFn` (no network): for the viem transport's own encoding of `multicallData`
 * (Multicall3 aggregate3) and `getLogs`. `call(to, data)` answers one inner call (null: it reverts); `logs(q)` answers one
 * eth_getLogs request, or returns a JSON-RPC error object to refuse it. `requests` records every request in order, and
 * `innerCallsPerRequest` the inner calls of each aggregate3 eth_call.
 */
export function fakeJsonRpcFetch(o: {
  call?: (to: string, data: string) => string | null;
  logs?: (q: { fromBlock: bigint; toBlock: bigint }) => { address: string; topics: string[]; data: string; blockNumber: bigint; logIndex: number }[] | { code: number; message: string };
}): {
  fetchFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requests: { method: string; params: any[] }[];
  innerCallsPerRequest: number[];
} {
  const AGGREGATE3 = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)']);
  const requests: { method: string; params: any[] }[] = [];
  const innerCallsPerRequest: number[] = [];
  const hex = (n: bigint | number) => `0x${n.toString(16)}`;
  const answer = (req: { id: number; method: string; params: any[] }): unknown => {
    requests.push({ method: req.method, params: req.params });
    if (req.method === 'eth_call') {
      const { args } = decodeFunctionData({ abi: AGGREGATE3, data: req.params[0].data });
      const inner = args[0] as readonly { target: string; allowFailure: boolean; callData: `0x${string}` }[];
      innerCallsPerRequest.push(inner.length);
      const out = inner.map((c) => {
        const data = o.call?.(c.target, c.callData) ?? null;
        return data === null ? { success: false, returnData: '0x' as `0x${string}` } : { success: true, returnData: data as `0x${string}` };
      });
      return { jsonrpc: '2.0', id: req.id, result: encodeFunctionResult({ abi: AGGREGATE3, functionName: 'aggregate3', result: out }) };
    }
    if (req.method === 'eth_getLogs') {
      const r = o.logs?.({ fromBlock: BigInt(req.params[0].fromBlock), toBlock: BigInt(req.params[0].toBlock) }) ?? [];
      if (!Array.isArray(r)) return { jsonrpc: '2.0', id: req.id, error: r };
      return {
        jsonrpc: '2.0', id: req.id,
        result: r.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: hex(l.blockNumber), logIndex: hex(l.logIndex), transactionHash: '0x' + '00'.repeat(32), removed: false })),
      };
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `the fake node has no ${req.method}` } };
  };
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as unknown;
    const reply = Array.isArray(body) ? body.map((b) => answer(b)) : answer(body as never);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, requests, innerCallsPerRequest };
}
