import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import { OrionError } from '../../types.js';
import { firstBlockAtOrAfter, MULTICALL_DATA_CHUNK, type BlockLog, type BlockRef, type RpcTransport } from '../transport/rpc.js';

/**
 * One typed read: the ABI holding `functionName` (abi.ts), its target and arguments. The reader encodes it, and decodes
 * the return with viem: a single output comes back as its value (a struct as an object), several outputs as an array;
 * uints of 48 bits or fewer and int24 decode as JS numbers, wider ones as bigint.
 */
export interface TypedCall {
  address: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * The pool scan's view of one chain (Phase 3 R4). Engine tests fake it directly; `rpcChainReader` builds it over an
 * RpcTransport. `call` returns one slot per call, null where the call reverted (or its return did not decode); a
 * transport failure throws. `logs` returns the raw logs of `address` with first topic `topic0` in [from, to].
 */
export interface ChainReader {
  readonly chainId: number;
  /** The first block whose timestamp is at or after `tsSec` (firstBlockAtOrAfter; never block-time arithmetic). */
  blockAt(tsSec: number): Promise<BlockRef>;
  call<T = unknown>(calls: TypedCall[], block: bigint): Promise<(T | null)[]>;
  logs(address: string[], topic0: string, from: bigint, to: bigint): Promise<BlockLog[]>;
}

/**
 * A ChainReader over an RpcTransport's `multicallData` (Multicall3 aggregate3, `chunk` inner calls per eth_call, default
 * MULTICALL_DATA_CHUNK) and `getLogs` (which splits at the transport's maxLogRange and halves on range refusals). Block
 * searches anchor on the newest block, read once per reader, and on blocks found earlier (a day's two boundaries share
 * most of the search).
 */
export function rpcChainReader(rpc: RpcTransport, chainId: number, opts: { chunk?: number } = {}): ChainReader {
  let latest: Promise<BlockRef> | null = null;
  const found = new Map<number, BlockRef>();
  return {
    chainId,
    async blockAt(tsSec) {
      const hit = found.get(tsSec);
      if (hit) return hit;
      latest ??= rpc.latestBlock();
      const head = await latest;
      // Anchor on the found block closest in time to the target (the head when none is known yet).
      let anchor = head;
      for (const b of found.values()) if (Math.abs(b.timestamp - tsSec) < Math.abs(anchor.timestamp - tsSec)) anchor = b;
      const b = await firstBlockAtOrAfter(rpc, tsSec, anchor, head);
      found.set(tsSec, b);
      return b;
    },
    async call<T = unknown>(calls: TypedCall[], block: bigint): Promise<(T | null)[]> {
      if (calls.length === 0) return [];
      if (!rpc.multicallData) throw new OrionError('rpc_unsupported', `chain ${chainId}: the RPC transport has no multicallData (the pool scan needs raw multicalls)`);
      const data = calls.map((c) => ({
        address: c.address,
        data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as Parameters<typeof encodeFunctionData>[0]),
      }));
      const results = await rpc.multicallData(data, block, { chunk: opts.chunk ?? MULTICALL_DATA_CHUNK });
      return results.map((r, i) => {
        if (!r.ok || r.data === '0x') return null;
        try {
          return decodeFunctionResult({ abi: calls[i].abi, functionName: calls[i].functionName, data: r.data } as Parameters<typeof decodeFunctionResult>[0]) as T;
        } catch {
          return null;
        }
      });
    },
    async logs(address, topic0, from, to) {
      if (address.length === 0) return [];
      if (!rpc.getLogs) throw new OrionError('rpc_unsupported', `chain ${chainId}: the RPC transport has no getLogs (the pool scan needs raw logs)`);
      return rpc.getLogs({ address, topic0, fromBlock: from, toBlock: to });
    },
  };
}
