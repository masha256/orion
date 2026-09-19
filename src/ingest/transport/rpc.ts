/** A block number and its timestamp in unix seconds. */
export interface BlockRef {
  number: bigint;
  timestamp: number;
}

/** `signature` is a human-readable ABI item, e.g. 'function totalSupply() view returns (uint256)'. */
export interface ContractCall {
  address: string;
  signature: string;
  functionName: string;
  args?: readonly unknown[];
}

/** Every read Orion makes returns an unsigned integer. */
export type CallResult = { ok: true; value: bigint } | { ok: false; error: string };

/** A decoded ERC-20 Transfer to the queried sink, stamped with its own block time (unix seconds). */
export interface TransferLog {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  from: string;
  value: bigint;
  timestamp: number;
}

export interface LogQuery {
  token: string;
  to: string;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface RpcTransport {
  latestBlock(): Promise<BlockRef>;
  getBlock(number: bigint): Promise<BlockRef>;
  /** One eth_call at one block. A failed call is reported in its slot; the batch itself only throws on transport failure. */
  multicall(calls: ContractCall[], blockNumber: bigint): Promise<CallResult[]>;
  /** One range of at most MAX_LOG_RANGE blocks. */
  getTransferLogs(q: LogQuery): Promise<TransferLog[]>;
}

export type RpcFactory = (url: string, chainId: number) => RpcTransport;

/** https://mainnet.base.org caps eth_getLogs at 2,000 blocks per call (error -32614 beyond that). */
export const MAX_LOG_RANGE = 2000n;

/**
 * Walks [fromBlock, toBlock] in chunks. Each chunk gets one attempt plus three retries; when it
 * still fails the generator throws, and the caller keeps whatever it already committed.
 */
export async function* getLogsChunked(
  rpc: RpcTransport,
  q: LogQuery,
  opts: { sleep(ms: number): Promise<void>; attempts?: number; backoffMs?: number },
): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: TransferLog[] }> {
  const attempts = opts.attempts ?? 4;
  const backoffMs = opts.backoffMs ?? 1000;
  for (let from = q.fromBlock; from <= q.toBlock; from += MAX_LOG_RANGE) {
    const to = from + MAX_LOG_RANGE - 1n < q.toBlock ? from + MAX_LOG_RANGE - 1n : q.toBlock;
    let logs: TransferLog[] | null = null;
    let failure = '';
    for (let attempt = 1; attempt <= attempts && logs === null; attempt++) {
      try {
        logs = await rpc.getTransferLogs({ token: q.token, to: q.to, fromBlock: from, toBlock: to });
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        if (attempt < attempts) await opts.sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
    if (logs === null) throw new Error(`eth_getLogs failed for blocks ${from}-${to} after ${attempts} attempts: ${failure}`);
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    yield { fromBlock: from, toBlock: to, logs };
  }
}

/**
 * The first block whose timestamp is at or after `targetTs`. Estimates from the anchor at
 * `blockTimeSec` per block, then corrects; it converges on irregular chains too, just more slowly.
 */
export async function firstBlockAtOrAfter(
  rpc: RpcTransport,
  targetTs: number,
  anchor: BlockRef,
  latest: BlockRef,
  blockTimeSec = 2,
): Promise<BlockRef> {
  if (latest.timestamp < targetTs) throw new Error(`no block at or after ${new Date(targetTs * 1000).toISOString()} yet`);
  const clamp = (n: bigint): bigint => (n < 0n ? 0n : n > latest.number ? latest.number : n);
  const estimateFrom = (b: BlockRef): bigint => b.number + BigInt(Math.round((targetTs - b.timestamp) / blockTimeSec));

  // Bracket the answer: `lo` is the highest block known to be before the target, `hi` the lowest
  // known to be at or after it. Probe the time-based estimate while it falls strictly inside the
  // bracket; otherwise bisect. A pure estimate-and-jump search ping-pongs across a chain halt.
  let lo: BlockRef | null = null;
  let hi: BlockRef = latest;
  let next = clamp(estimateFrom(anchor));
  for (let i = 0; i < 64; i++) {
    if (hi.number === 0n || (lo !== null && hi.number - lo.number === 1n)) return hi;
    const b = await rpc.getBlock(next);
    if (b.timestamp < targetTs) lo = b;
    else hi = b;
    const lowest: bigint = lo === null ? 0n : lo.number + 1n;
    const highest: bigint = hi.number - 1n;
    if (lowest > highest) continue; // adjacent (or hi is block 0): the check at the top of the loop returns
    const estimate = estimateFrom(b);
    next = estimate >= lowest && estimate <= highest ? estimate : lo === null ? highest : (lowest + highest) / 2n;
  }
  throw new Error(`could not locate the first block at or after ${new Date(targetTs * 1000).toISOString()}`);
}
