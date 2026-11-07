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
  /** For a function returning several values: the index of the one to read (it must be an integer). */
  pick?: number;
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

export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

export interface RpcTransport {
  latestBlock(): Promise<BlockRef>;
  /** The newest block under the chain's `finalized` tag. Optional: when present, transfer scans stop there (no reorg can
   * change what they read); level reads keep `latestBlock`. */
  finalizedBlock?(): Promise<BlockRef>;
  /** M-7: the depth below the head a scan stops at when `finalizedBlock` fails (the chain's `confirmations`). */
  confirmations?: bigint;
  getBlock(number: bigint): Promise<BlockRef>;
  /** One eth_call at one block. A failed call is reported in its slot; the batch itself only throws on transport failure. */
  multicall(calls: ContractCall[], blockNumber: bigint): Promise<CallResult[]>;
  /** One range of at most `maxLogRange` blocks. */
  getTransferLogs(q: LogQuery): Promise<TransferLog[]>;
  /** Runtime bytecode at an address ('0x' for none), for clone detection. Optional: only from_ignore_clones_of needs it. */
  getCode?(address: string): Promise<string>;
  /** Every log of one transaction's receipt (addresses and topics lowercased). Optional: only mint_sender needs it. */
  getReceiptLogs?(txHash: string): Promise<ReceiptLog[]>;
  /** Blocks one eth_getLogs call may span on this chain. Default MAX_LOG_RANGE (Base's cap). */
  readonly maxLogRange?: bigint;
  /** Nominal seconds per block, for the block search's first estimate. Default 2 when the transport states none. */
  readonly blockTimeSec?: number;
}

export type RpcFactory = (url: string, chainId: number) => RpcTransport;

/** The default log range: https://mainnet.base.org caps eth_getLogs at 2,000 blocks per call (error -32614 beyond that). */
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
  const range = rpc.maxLogRange ?? MAX_LOG_RANGE;
  if (range < 1n) throw new Error(`the log range must be at least one block, got ${range}`);
  for (let from = q.fromBlock; from <= q.toBlock; from += range) {
    const to = from + range - 1n < q.toBlock ? from + range - 1n : q.toBlock;
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
 * The first block whose timestamp is at or after `targetTs`. The first probe is estimated from the anchor at
 * `blockTimeSec` per block (default: the transport's own, else 2). After that the search keeps a bracket and estimates
 * from the blocks it has seen, not from the nominal rate: between two known blocks it interpolates on their own rate,
 * and while every probe is still at or after the target it steps back at least twice as far each time. A step that
 * does not halve the bracket is followed by a bisection. So a chain whose block time changes (Base went from 2 s to
 * 0.2 s at block ~53,556,072 on 2026-11-05) or halts is still found in a few dozen probes, and a regular chain in a
 * handful.
 */
export async function firstBlockAtOrAfter(
  rpc: RpcTransport,
  targetTs: number,
  anchor: BlockRef,
  latest: BlockRef,
  blockTimeSec = rpc.blockTimeSec ?? 2,
): Promise<BlockRef> {
  if (latest.timestamp < targetTs) throw new Error(`no block at or after ${new Date(targetTs * 1000).toISOString()} yet`);
  const clamp = (n: bigint): bigint => (n < 0n ? 0n : n > latest.number ? latest.number : n);
  const estimateFrom = (b: BlockRef): bigint => b.number + BigInt(Math.round((targetTs - b.timestamp) / blockTimeSec));
  /** Between a block before the target and one at or after it, on the rate those two blocks show. */
  const interpolate = (a: BlockRef, z: BlockRef): bigint => {
    const span = z.timestamp - a.timestamp;
    if (span <= 0) return (a.number + z.number) / 2n;
    return a.number + BigInt(Math.ceil(((targetTs - a.timestamp) / span) * Number(z.number - a.number)));
  };

  // Bracket the answer: `lo` is the highest block known to be before the target, `hi` the lowest
  // known to be at or after it. Probe the estimate while it falls strictly inside the bracket and the last step
  // halved it; otherwise bisect. A pure estimate-and-jump search ping-pongs across a chain halt.
  let lo: BlockRef | null = null;
  let hi: BlockRef = latest;
  let next = clamp(estimateFrom(anchor));
  let lastWidth: bigint | null = null;
  for (let i = 0; i < 64; i++) {
    if (hi.number === 0n || (lo !== null && hi.number - lo.number === 1n)) return hi;
    const b = await rpc.getBlock(next);
    const before = hi;
    if (b.timestamp < targetTs) lo = b;
    else hi = b;
    const lowest: bigint = lo === null ? 0n : lo.number + 1n;
    const highest: bigint = hi.number - 1n;
    if (lowest > highest) continue; // adjacent (or hi is block 0): the check at the top of the loop returns
    let estimate: bigint;
    if (lo !== null) {
      estimate = interpolate(lo, hi);
    } else {
      estimate = estimateFrom(b);
      // A second probe in a row at or after the target with nothing before it: the nominal rate overstates the
      // block time, so step back at least twice as far as the last step did.
      const moved = before.number - b.number;
      if (hi === b && before !== latest && moved > 0n && estimate > b.number - 2n * moved) estimate = b.number - 2n * moved;
      if (estimate < lowest) estimate = lowest;
    }
    const width = highest - lowest;
    const slow = lo !== null && lastWidth !== null && width * 2n > lastWidth;
    if (lo !== null) lastWidth = width;
    next = !slow && estimate >= lowest && estimate <= highest ? estimate : lo === null ? highest : (lowest + highest) / 2n;
  }
  throw new Error(`could not locate the first block at or after ${new Date(targetTs * 1000).toISOString()}`);
}
