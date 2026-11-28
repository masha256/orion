import { createPublicClient, defineChain, http, numberToHex, parseAbi, parseAbiItem, type Address, type Chain, type HttpTransportConfig } from 'viem';
import { arbitrum, arc, base, bsc, ink, mainnet, optimism, robinhood } from 'viem/chains';
import { OrionError } from '../../types.js';
import { chainInfo, supportedChainIds } from './chains.js';
import { chunkedMulticallData, LogRangeError, isLogRangeError, splitGetLogs, type BlockLog, type CallResult, type DataCallResult, type RpcFactory, type RpcTransport } from './rpc.js';

/**
 * Elysium (99901) is not in the vendored viem. Only multicall3 matters to Orion's reads; there is no default RPC URL
 * (ORION_ELYSIUM_RPC_URL is always passed), and the native currency is a placeholder defineChain requires.
 */
const elysium = defineChain({
  id: 99901,
  name: 'Elysium',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

const VIEM_CHAINS: Record<number, Chain> = Object.fromEntries(
  [base, mainnet, bsc, optimism, arbitrum, ink, robinhood, arc, elysium].map((c): [number, Chain] => [c.id, c]),
);

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** Multicall3's aggregate3 (allowFailure per call), for `multicallData`'s raw calls. Declared `view` (it is payable on chain; the
 * selector is the same) so it is read with eth_call. */
const AGGREGATE3 = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)']);

/** The raw eth_getLogs entry `getLogs` maps (hex quantities). */
interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  logIndex: string | null;
}

/** An error's full text for classification (viem keeps the provider's wording in `details`); never stored. */
const rawErrorText = (err: unknown): string => {
  const e = err as { message?: unknown; details?: unknown; code?: unknown } | null;
  return [e?.message, e?.details, typeof e?.code === 'number' ? String(e.code) : undefined].filter((x) => typeof x === 'string').join(' ');
};

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
export const createViemRpc: RpcFactory = (url, chainId) => createViemRpcWith(url, chainId);

/**
 * createViemRpc with transport options: `fetchFn` lets a test serve JSON-RPC from memory (tests/helpers/fakeRpc.ts
 * fakeJsonRpcFetch), so the aggregate3 and eth_getLogs encodings are exercised with no network.
 */
export function createViemRpcWith(url: string, chainId: number, opts: { fetchFn?: HttpTransportConfig['fetchFn'] } = {}): RpcTransport {
  const info = chainInfo(chainId);
  const chain = VIEM_CHAINS[chainId];
  if (!info || !chain) {
    throw new OrionError('unsupported_chain', `chain_id ${chainId} is not supported; supported: ${supportedChainIds().join(', ')}`);
  }
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 3, retryDelay: 1000, timeout: 20_000, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) }) });
  const multicall3 = chain.contracts?.multicall3?.address;

  /** Every error leaving this file is safe to store and log: never the keyed RPC URL. */
  const clean = <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((err: unknown) => {
      throw new Error(cleanRpcErrorMessage(err));
    });

  return {
    maxLogRange: info.maxLogRange,
    blockTimeSec: info.blockTimeSec,
    confirmations: info.confirmations,
    latestBlock: () =>
      clean(async () => {
        const b = await client.getBlock();
        return { number: b.number, timestamp: Number(b.timestamp) };
      }),
    finalizedBlock: () =>
      clean(async () => {
        const b = await client.getBlock({ blockTag: 'finalized' });
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
    multicallData: (calls, blockNumber, o) =>
      clean(async () => {
        if (multicall3 === undefined) throw new Error(`${info.name} has no Multicall3 address`);
        // One eth_call per chunk, each its own request under the transport's 20 s timeout.
        return await chunkedMulticallData(
          async (chunk) => {
            const results = await client.readContract({
              address: multicall3, abi: AGGREGATE3, functionName: 'aggregate3', blockNumber,
              args: [chunk.map((c) => ({ target: c.address as Address, allowFailure: true, callData: c.data }))],
            });
            return results.map((r): DataCallResult => (r.success ? { ok: true, data: r.returnData } : { ok: false, error: `execution reverted${r.returnData !== '0x' ? ` (${r.returnData.slice(0, 74)})` : ''}` }));
          },
          calls,
          o?.chunk,
        );
      }),
    getLogs: (q) =>
      clean(async () =>
        await splitGetLogs(
          async (part) => {
            let raw: RpcLog[];
            try {
              raw = (await client.request({
                method: 'eth_getLogs',
                params: [{ address: part.address as Address[], topics: [part.topic0 as `0x${string}`], fromBlock: numberToHex(part.fromBlock), toBlock: numberToHex(part.toBlock) }],
              })) as unknown as RpcLog[];
            } catch (err) {
              // Classified on the provider's own wording, then passed on clean (never the keyed URL).
              if (isLogRangeError(new Error(rawErrorText(err)))) throw new LogRangeError(cleanRpcErrorMessage(err));
              throw err;
            }
            return raw.map((l): BlockLog => {
              if (l.blockNumber === null || l.logIndex === null) throw new Error('the RPC returned a pending log');
              return { address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data, logIndex: Number(BigInt(l.logIndex)), blockNumber: BigInt(l.blockNumber) };
            });
          },
          q,
          info.maxLogRange,
        ),
      ),
    getReceiptLogs: (txHash) =>
      clean(async () => {
        const r = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        return r.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data, logIndex: l.logIndex }));
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
}
