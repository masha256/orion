import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { OrionError } from '../../types.js';
import { chainInfo, supportedChainIds } from './chains.js';
import type { CallResult, RpcFactory } from './rpc.js';

const VIEM_CHAINS: Record<number, Chain> = { [base.id]: base, [mainnet.id]: mainnet };

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * Prefers viem's `shortMessage`, which never contains the RPC URL, over its full `message`, which
 * does (a keyed `ORION_BASE_RPC_URL` would otherwise land in `fetch_runs.detail`, anomaly details, and
 * the cron log). Falls back to the full message with any URL's path and query string stripped down to
 * its origin.
 */
/**
 * The integer a read returns: the result itself, or for a multi-value return the `pick`-th value. Orion reads only
 * unsigned quantities, so a negative value (an int128 field) is refused rather than passed on.
 */
export function pickValue(result: unknown, pick: number | undefined): CallResult {
  const raw = pick === undefined ? result : Array.isArray(result) ? result[pick] : undefined;
  if (typeof raw !== 'bigint' && typeof raw !== 'number') {
    return { ok: false, error: pick === undefined ? 'the call returned no integer' : `the call returned no integer at position ${pick}` };
  }
  const value = BigInt(raw);
  if (value < 0n) return { ok: false, error: `the call returned a negative value (${value})` };
  return { ok: true, value };
}

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

/** The only file that imports viem. The chains are those of `chains.ts` that viem also knows. */
export const createViemRpc: RpcFactory = (url, chainId) => {
  const info = chainInfo(chainId);
  const chain = VIEM_CHAINS[chainId];
  if (!info || !chain) {
    throw new OrionError('unsupported_chain', `chain_id ${chainId} is not supported; supported: ${supportedChainIds().join(', ')}`);
  }
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 3, retryDelay: 1000, timeout: 20_000 }) });

  /** Every error leaving this file is safe to store and log: never the keyed RPC URL. */
  const clean = <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((err: unknown) => {
      throw new Error(cleanRpcErrorMessage(err));
    });

  return {
    maxLogRange: info.maxLogRange,
    blockTimeSec: info.blockTimeSec,
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
        // One eth_call: public RPCs throttle bursts of separate calls, and the default
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
        return results.map((r, i): CallResult => {
          if (r.status !== 'success') return { ok: false, error: cleanRpcErrorMessage(r.error) };
          return pickValue(r.result, calls[i].pick);
        });
      }),
    getCode: (address) => clean(async () => (await client.getCode({ address: address as Address })) ?? '0x'),
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
            throw new Error(`the RPC did not return blockTimestamp on logs; use a ${info.name} RPC that does`);
          }
          if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null || l.args.from === undefined || l.args.value === undefined) {
            throw new Error('the RPC returned a pending or malformed Transfer log');
          }
          return { blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, from: l.args.from, value: l.args.value, timestamp: Number(ts) };
        });
      }),
  };
};
