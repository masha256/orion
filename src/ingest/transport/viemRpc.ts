import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from 'viem';
import { base } from 'viem/chains';
import { OrionError } from '../../types.js';
import type { CallResult, RpcFactory } from './rpc.js';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * Prefers viem's `shortMessage`, which never contains the RPC URL, over its full `message`, which
 * does (a keyed `ORION_BASE_RPC_URL` would otherwise land in `fetch_runs.detail`, anomaly details, and
 * the cron log). Falls back to the full message with any URL's path and query string stripped down to
 * its origin.
 */
export function cleanRpcErrorMessage(err: unknown): string {
  const shortMessage = (err as { shortMessage?: unknown } | null)?.shortMessage;
  if (typeof shortMessage === 'string' && shortMessage.length > 0) return shortMessage;
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/https?:\/\/\S+/g, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  });
}

/** The only file that imports viem. Base only, until a second chain is actually needed. */
export const createViemRpc: RpcFactory = (url, chainId) => {
  if (chainId !== base.id) throw new OrionError('unsupported_chain', `chain_id ${chainId} is not supported; only Base (${base.id}) is`);
  const client = createPublicClient({ chain: base, transport: http(url, { retryCount: 3, retryDelay: 1000, timeout: 20_000 }) });

  /** Every error leaving this file is safe to store and log: never the keyed RPC URL. */
  const clean = <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((err: unknown) => {
      throw new Error(cleanRpcErrorMessage(err));
    });

  return {
    latestBlock: () =>
      clean(async () => {
        const b = await client.getBlock();
        return { number: b.number, timestamp: Number(b.timestamp) };
      }),
    getBlock: (number) =>
      clean(async () => {
        const b = await client.getBlock({ blockNumber: number });
        return { number: b.number, timestamp: Number(b.timestamp) };
      }),
    multicall: (calls, blockNumber) =>
      clean(async () => {
        // One eth_call: the public Base RPC throttles bursts of separate calls, and the default
        // viem batch size would split a large read into many requests.
        const results = await client.multicall({
          allowFailure: true,
          blockNumber,
          batchSize: 100_000,
          contracts: calls.map((c) => ({
            address: c.address as Address,
            abi: parseAbi([c.signature]),
            functionName: c.functionName,
            args: c.args ?? [],
          })),
        });
        return results.map(
          (r): CallResult => (r.status === 'success' ? { ok: true, value: BigInt(r.result as bigint | number) } : { ok: false, error: cleanRpcErrorMessage(r.error) }),
        );
      }),
    getTransferLogs: (q) =>
      clean(async () => {
        const logs = await client.getLogs({
          address: q.token as Address,
          event: TRANSFER,
          args: { to: q.to as Address },
          fromBlock: q.fromBlock,
          toBlock: q.toBlock,
        });
        return logs.map((l) => {
          const ts = (l as { blockTimestamp?: bigint | null }).blockTimestamp;
          if (ts === undefined || ts === null) {
            throw new Error('the RPC did not return blockTimestamp on logs; use a Base RPC that does (https://mainnet.base.org does)');
          }
          if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null || l.args.from === undefined || l.args.value === undefined) {
            throw new Error('the RPC returned a pending or malformed Transfer log');
          }
          return { blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, from: l.args.from, value: l.args.value, timestamp: Number(ts) };
        });
      }),
  };
};
