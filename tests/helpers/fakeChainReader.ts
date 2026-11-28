import type { ChainReader, TypedCall } from '../../src/ingest/poolscan/reader.js';
import type { BlockLog, BlockRef } from '../../src/ingest/transport/rpc.js';

/** One inner call the engine asked a fake ChainReader for. */
export interface RecordedCall {
  address: string;
  functionName: string;
  args: readonly unknown[];
  block: bigint;
}

export interface FakeChainReader extends ChainReader {
  stats: {
    calls: RecordedCall[];
    /** `call()` invocations (one per batch the engine sent). */
    batches: number;
    logs: { address: string[]; topic0: string; from: bigint; to: bigint }[];
    blockAt: number[];
  };
}

export interface FakeChainReaderOptions {
  chainId: number;
  /** The block for a timestamp (the engine asks only for day starts); throw for anything unexpected. */
  blockAt(tsSec: number): BlockRef;
  /** One call's decoded result: null = the call reverts; undefined = the fake has no answer (the test fails loudly). */
  answer(call: TypedCall, block: bigint): unknown;
  /** Logs for one request (the engine has already split the range). */
  logs?(address: string[], topic0: string, from: bigint, to: bigint): BlockLog[];
}

/** A ChainReader over canned answers, recording every call, batch and log request (no RPC, no network). */
export function fakeChainReader(o: FakeChainReaderOptions): FakeChainReader {
  const stats: FakeChainReader['stats'] = { calls: [], batches: 0, logs: [], blockAt: [] };
  return {
    chainId: o.chainId,
    stats,
    async blockAt(tsSec) {
      stats.blockAt.push(tsSec);
      return o.blockAt(tsSec);
    },
    async call<T = unknown>(calls: TypedCall[], block: bigint): Promise<(T | null)[]> {
      stats.batches++;
      return calls.map((c) => {
        stats.calls.push({ address: c.address.toLowerCase(), functionName: c.functionName, args: c.args ?? [], block });
        const r = o.answer(c, block);
        if (r === undefined) throw new Error(`fake reader has no answer for ${c.address}.${c.functionName}(${(c.args ?? []).join(',')}) at ${block}`);
        return r as T | null;
      });
    },
    async logs(address, topic0, from, to) {
      stats.logs.push({ address, topic0, from, to });
      return o.logs?.(address, topic0, from, to) ?? [];
    },
  };
}
