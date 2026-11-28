import { OrionError } from '../../types.js';
import { CHAINLINK_FEED_ABI, CL_POOL_PRICE_ABI, ERC20_ABI, MULTICALL3_ABI, MULTICALL3_ADDRESS, V2_POOL_PRICE_ABI } from './abi.js';
import type { ChainReader, TypedCall } from './reader.js';
import type { Anchor, ChainDayScan, ChainScan, ScanFactory } from './types.js';

/**
 * The pool scan's on-chain prices (Phase 3 R4, spec §4.3; method from phase3-r4-scoping onchain-revenue.md §3 and
 * scripts/pricing.py + final_eval.py `composite`). No third-party price is read.
 *
 * 1. Anchors: the configured token → Chainlink USD feed list, read at e−1 (a `feed_chain_id` feed: on that chain at the
 *    first block at or after e−1's timestamp). `description()` must equal the configured string, else the run fails
 *    (`anchor_feed_mismatch`). A feed older than `feedMaxAgeSec` at e−1's timestamp drops its anchor for the day
 *    (`anchorsDropped`); the token then prices through the graph.
 * 2. Graph: hop by hop (≤ `maxHops`), each unpriced token takes its deepest pool against a token priced in an earlier hop,
 *    depth = the priced side's `balanceOf(pool)` × its price, and only pools with depth ≥ `floorUsd`. A CL edge is the
 *    `twapSec` TWAP from observe([twapSec, 0]) ending at e−1, or slot0 spot when observe reverts (too few observations;
 *    `graph_spot_fallback`, carried to tokens priced off that token). A V2 edge is getReserves at e−1 on the curve of the
 *    pool's creating factory (stable x³y+xy³ marginal price, volatile y/x); `stable()` is never read.
 * 3. Own-pool fallback (`fallback`): a token the graph leaves unpriced is valued, for one pool's fees only, at that pool's
 *    edge price against its other side when that side is priced.
 * 4. Everything else is unpriced. `estimate` (the same graph with floor 0 and 6 hops) sizes it for coverage only.
 *
 * Failed reads: a feed, slot0, reserves or e−1 timestamp read that reverts fails the run (`pool_scan_read_failed`). Two
 * token-side reads do not: a token whose `decimals()` reverts has no route (unpriced), and a `balanceOf(pool)` that
 * reverts counts as 0 depth. Those are the token contract's behaviour, and one junk token must not stop the day.
 */

export type PriceHow = 'anchor' | 'graph' | 'graph_spot_fallback';

export interface PriceOpts {
  /** Least priced-side balance (USD) of a graph edge. */
  floorUsd?: number;
  maxHops?: number;
  /** CL TWAP window ending at e−1. */
  twapSec?: number;
  /** A feed older than this at e−1 drops its anchor (26 h: Chainlink heartbeats are ≤ 24 h). */
  feedMaxAgeSec?: number;
}
export const PRICE_DEFAULTS: Required<PriceOpts> = { floorUsd: 10_000, maxHops: 3, twapSec: 1800, feedMaxAgeSec: 93_600 };
/** The coverage-estimate graph (`PriceBook.estimate`). */
export const COVERAGE_GRAPH = { floorUsd: 0, maxHops: 6 } as const;

export interface PriceSource {
  pool: string;
  hop: number;
  /** The priced side's balance in USD when the edge was taken. */
  depthUsd: number;
}

export interface PriceBook {
  chainId: number;
  /** USD per whole token, by lowercased token: anchors and graph prices. */
  usd: Map<string, number>;
  how: Map<string, PriceHow>;
  /** The graph edge each graph-priced token took. */
  sources: Map<string, PriceSource>;
  /** A token `usd` lacks, valued at `pool`'s edge price against its priced other side; null otherwise. */
  fallback(pool: string, token: string): number | null;
  /** Tokens whose anchor feed was stale at e−1 (lowercased; the token was then left to the graph). */
  anchorsDropped: string[];
  /** The floor-0, 6-hop graph's prices: for sizing unpriced fees in coverage only, never a value. */
  estimate: Map<string, number>;
  /** Token decimals read at e−1; a token absent here has no decimals() and no price. */
  decimals: Map<string, number>;
}

const lc = (a: string) => a.toLowerCase();

interface Edge {
  pool: string;
  token0: string;
  token1: string;
  /** Whole token1 per whole token0, or null when the pool gives no usable price. */
  price: number | null;
  /** CL price from slot0 because observe() reverted. */
  spot: boolean;
  bal: [bigint, bigint];
}

interface FeedRead { anchor: Anchor; block: bigint; reads: [unknown, unknown, unknown] }

const feedCalls = (feed: string): TypedCall[] =>
  (['description', 'decimals', 'latestRoundData'] as const).map((functionName) => ({ address: feed, abi: CHAINLINK_FEED_ABI, functionName }));

/** Value a priced side's raw balance in USD. */
const usdOf = (raw: bigint, decimals: number, price: number) => (Number(raw) / 10 ** decimals) * price;

export async function priceDay(readers: Map<number, ChainReader>, cfg: ChainScan, scan: ChainDayScan, opts: PriceOpts = {}): Promise<PriceBook> {
  const o = { ...PRICE_DEFAULTS, ...opts };
  const chainId = cfg.chain_id;
  const where = `chain ${chainId} ${scan.day}`;
  const reader = readers.get(chainId);
  if (!reader || reader.chainId !== chainId || scan.chainId !== chainId) throw new OrionError('pool_scan_config', `${where}: no reader for the scan's chain`);
  const need = <T>(v: T | null | undefined, what: string): T => {
    if (v === null || v === undefined) throw new OrionError('pool_scan_read_failed', `${where}: ${what} failed`);
    return v;
  };
  const at = scan.blocks.e - 1n;

  const anchors = cfg.anchors.map((a) => ({ ...a, token: lc(a.token), feed: lc(a.feed) }));
  const seen = new Set<string>();
  for (const a of anchors) {
    if (seen.has(a.token)) throw new OrionError('pool_scan_config', `${where}: token ${a.token} has two anchors`);
    seen.add(a.token);
  }
  const kindOf = new Map<string, ScanFactory['kind']>(cfg.factories.map((f) => [lc(f.address), f.kind]));
  const pools = scan.pools.map((p) => {
    const kind = kindOf.get(lc(p.factory));
    if (!kind) throw new OrionError('pool_scan_config', `${where}: pool ${p.pool} is from unconfigured factory ${p.factory}`);
    return { pool: lc(p.pool), token0: lc(p.token0), token1: lc(p.token1), kind };
  });
  const tokens = [...new Set(pools.flatMap((p) => [p.token0, p.token1]))];
  const local = anchors.filter((a) => (a.feed_chain_id ?? chainId) === chainId);
  const foreign = new Map<number, typeof anchors>();
  for (const a of anchors) if ((a.feed_chain_id ?? chainId) !== chainId) foreign.set(a.feed_chain_id!, [...(foreign.get(a.feed_chain_id!) ?? []), a]);

  // One batch at e−1 on the scan's chain: block timestamp, local feeds, token decimals, pool state.
  const calls: TypedCall[] = [{ address: MULTICALL3_ADDRESS, abi: MULTICALL3_ABI, functionName: 'getCurrentBlockTimestamp' }];
  for (const a of local) calls.push(...feedCalls(a.feed));
  for (const t of tokens) calls.push({ address: t, abi: ERC20_ABI, functionName: 'decimals' });
  for (const p of pools) {
    if (p.kind === 'cl') {
      calls.push({ address: p.pool, abi: CL_POOL_PRICE_ABI, functionName: 'slot0' });
      calls.push({ address: p.pool, abi: CL_POOL_PRICE_ABI, functionName: 'observe', args: [[o.twapSec, 0]] });
    } else {
      calls.push({ address: p.pool, abi: V2_POOL_PRICE_ABI, functionName: 'getReserves' });
    }
    calls.push({ address: p.token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [p.pool] });
    calls.push({ address: p.token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [p.pool] });
  }
  const r = await reader.call(calls, at);
  let i = 0;
  const ts = Number(need(r[i++] as bigint | null, `Multicall3.getCurrentBlockTimestamp() at e−1 (${at})`));
  const feeds: FeedRead[] = local.map((anchor) => ({ anchor, block: at, reads: [r[i++], r[i++], r[i++]] }));
  const decimals = new Map<string, number>();
  for (const t of tokens) {
    const d = r[i++] as number | null;
    if (d !== null && d !== undefined) decimals.set(t, Number(d));
  }
  const edges = new Map<string, Edge>();
  for (const p of pools) {
    let price: number | null = null;
    let spot = false;
    const d0 = decimals.get(p.token0);
    const d1 = decimals.get(p.token1);
    if (p.kind === 'cl') {
      const slot0 = need(r[i++] as readonly [bigint, ...unknown[]] | null, `${p.pool}.slot0() at e−1`);
      const obs = r[i++] as readonly [readonly bigint[], readonly bigint[]] | null;
      if (d0 !== undefined && d1 !== undefined) {
        if (obs && obs[0].length === 2) {
          const tick = Number(obs[0][1] - obs[0][0]) / o.twapSec;
          price = 1.0001 ** tick * 10 ** (d0 - d1);
        } else {
          spot = true;
          const sqrt = Number(slot0[0]) / 2 ** 96;
          price = sqrt > 0 ? sqrt * sqrt * 10 ** (d0 - d1) : null;
        }
      }
    } else {
      const res = need(r[i++] as readonly [bigint, bigint, bigint] | null, `${p.pool}.getReserves() at e−1`);
      if (d0 !== undefined && d1 !== undefined && res[0] > 0n && res[1] > 0n) {
        const x = Number(res[0]) / 10 ** d0;
        const y = Number(res[1]) / 10 ** d1;
        price = p.kind === 'v2_stable' ? (3 * x * x * y + y ** 3) / (x ** 3 + 3 * x * y * y) : y / x;
      }
    }
    const bal: [bigint, bigint] = [(r[i++] as bigint | null) ?? 0n, (r[i++] as bigint | null) ?? 0n];
    if (price !== null && !(price > 0 && Number.isFinite(price))) price = null;
    edges.set(p.pool, { pool: p.pool, token0: p.token0, token1: p.token1, price, spot, bal });
  }

  // Cross-chain feeds: on the feed's chain at the first block at or after this chain's e−1 timestamp.
  for (const [fid, list] of foreign) {
    const fr = readers.get(fid);
    if (!fr || fr.chainId !== fid) throw new OrionError('pool_scan_config', `${where}: anchors read feeds on chain ${fid}, which has no reader`);
    const block = (await fr.blockAt(ts)).number;
    const fres = await fr.call(list.flatMap((a) => feedCalls(a.feed)), block);
    list.forEach((anchor, k) => feeds.push({ anchor, block, reads: [fres[3 * k], fres[3 * k + 1], fres[3 * k + 2]] }));
  }

  const anchorUsd = new Map<string, number>();
  const anchorsDropped: string[] = [];
  for (const { anchor: a, block, reads } of feeds) {
    const on = `feed ${a.feed}${a.feed_chain_id && a.feed_chain_id !== chainId ? ` (chain ${a.feed_chain_id})` : ''}`;
    const desc = need(reads[0] as string | null, `${on}.description() at ${block}`);
    if (desc !== a.description) {
      const got = JSON.stringify(desc);
      throw new OrionError('anchor_feed_mismatch', `${where}: ${on} description() is ${got}, configured ${JSON.stringify(a.description)} for ${a.token}`);
    }
    const fdec = Number(need(reads[1] as number | null, `${on}.decimals() at ${block}`));
    const round = need(reads[2] as readonly bigint[] | null, `${on}.latestRoundData() at ${block}`);
    const answer = round[1];
    if (answer <= 0n) throw new OrionError('pool_scan_read_failed', `${where}: ${on}.latestRoundData() at ${block} answered ${answer}`);
    if (ts - Number(round[3]) > o.feedMaxAgeSec) {
      anchorsDropped.push(a.token);
      continue;
    }
    anchorUsd.set(a.token, Number(answer) / 10 ** fdec);
  }

  const main = runGraph([...edges.values()], anchorUsd, decimals, o.floorUsd, o.maxHops);
  const estimate = runGraph([...edges.values()], anchorUsd, decimals, COVERAGE_GRAPH.floorUsd, COVERAGE_GRAPH.maxHops).usd;
  return {
    chainId,
    usd: main.usd,
    how: main.how,
    sources: main.sources,
    anchorsDropped,
    estimate,
    decimals,
    fallback(pool, token) {
      const e = edges.get(lc(pool));
      const t = lc(token);
      if (!e || e.price === null || main.usd.has(t)) return null;
      if (t === e.token0 && main.usd.has(e.token1)) return e.price * main.usd.get(e.token1)!;
      if (t === e.token1 && main.usd.has(e.token0)) return main.usd.get(e.token0)! / e.price;
      return null;
    },
  };
}

/** pricing.py `price_graph`: per hop, each unpriced token takes its deepest qualifying edge to a token priced before. */
function runGraph(edges: Edge[], anchors: Map<string, number>, decimals: Map<string, number>, floorUsd: number, maxHops: number) {
  const usd = new Map(anchors);
  const how = new Map<string, PriceHow>([...anchors.keys()].map((t) => [t, 'anchor']));
  const sources = new Map<string, PriceSource>();
  for (let hop = 1; hop <= maxHops; hop++) {
    const cand = new Map<string, { price: number; depthUsd: number; pool: string; how: PriceHow }>();
    for (const e of edges) {
      if (e.price === null) continue;
      for (const [k, known, unk] of [[1, e.token1, e.token0], [0, e.token0, e.token1]] as const) {
        const pk = usd.get(known);
        if (pk === undefined || usd.has(unk) || e.bal[k] === 0n) continue;
        const depthUsd = usdOf(e.bal[k], decimals.get(known)!, pk);
        if (depthUsd < floorUsd) continue;
        const price = unk === e.token0 ? e.price * pk : pk / e.price;
        const prev = cand.get(unk);
        if (!prev || depthUsd > prev.depthUsd) {
          cand.set(unk, { price, depthUsd, pool: e.pool, how: e.spot || how.get(known) === 'graph_spot_fallback' ? 'graph_spot_fallback' : 'graph' });
        }
      }
    }
    if (cand.size === 0) break;
    for (const [t, c] of cand) {
      usd.set(t, c.price);
      how.set(t, c.how);
      sources.set(t, { pool: c.pool, hop, depthUsd: c.depthUsd });
    }
  }
  return { usd, how, sources };
}

export interface UnpricedFee {
  token: string;
  /** Raw token units. */
  amount: bigint;
  pool: string;
  /** The coverage graph's USD for it (never a value); null when no floorless path reaches the token. */
  estimateUsd: number | null;
}

export interface ScanValue {
  grossUsd: number;
  allocatorUsd: number;
  /** gross − allocator. */
  lpUsd: number;
  /** The allocator USD of gauged pools unregistered at e−1 (their gross is that accrual, so their LP is 0). */
  unregisteredAllocatorUsd: number;
  /** 100 × gross priced / (gross priced + coverageEstimateUsd); 100 when nothing is left unpriced or estimable. */
  pricedPct: number;
  /** The unpriced gross fees at the coverage graph's prices (coverage only). */
  coverageEstimateUsd: number;
  unpriced: UnpricedFee[];
}

/** USD of one chain-day's fees: anchors, the graph, then each pool's own fallback; the rest is listed unpriced. */
export function valueScan(scan: ChainDayScan, book: PriceBook): ScanValue {
  const priceIn = (pool: string, token: string): number | null => book.usd.get(lc(token)) ?? book.fallback(pool, token);
  const whole = (token: string, amount: bigint): number | null => {
    const d = book.decimals.get(lc(token));
    return d === undefined ? null : Number(amount) / 10 ** d;
  };
  let grossUsd = 0;
  let coverageEstimateUsd = 0;
  const unpriced: UnpricedFee[] = [];
  for (const p of scan.pools) {
    for (const [token, amount] of [[p.token0, p.fee0], [p.token1, p.fee1]] as const) {
      if (amount <= 0n) continue;
      const amt = whole(token, amount);
      const px = amt === null ? null : priceIn(p.pool, token);
      if (amt !== null && px !== null) {
        grossUsd += amt * px;
        continue;
      }
      const est = amt === null ? undefined : book.estimate.get(lc(token));
      const estimateUsd = est === undefined || amt === null ? null : amt * est;
      coverageEstimateUsd += estimateUsd ?? 0;
      unpriced.push({ token: lc(token), amount, pool: p.pool, estimateUsd });
    }
  }
  const unregistered = new Set(scan.pools.filter((p) => !p.registered && p.gauge !== null).map((p) => p.pool));
  let allocatorUsd = 0;
  let unregisteredAllocatorUsd = 0;
  for (const [pool, amounts] of scan.allocatorByPool) {
    for (const [token, amount] of amounts) {
      if (amount <= 0n) continue;
      const amt = whole(token, amount);
      const px = amt === null ? null : priceIn(pool, token);
      if (amt === null || px === null) continue;
      allocatorUsd += amt * px;
      if (unregistered.has(pool)) unregisteredAllocatorUsd += amt * px;
    }
  }
  const denom = grossUsd + coverageEstimateUsd;
  return { grossUsd, allocatorUsd, lpUsd: grossUsd - allocatorUsd, unregisteredAllocatorUsd, pricedPct: denom > 0 ? (100 * grossUsd) / denom : 100, coverageEstimateUsd, unpriced };
}
