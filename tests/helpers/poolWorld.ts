import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, type Abi, type AbiFunction, type Hex } from 'viem';
import type { AssetConfig } from '../../src/config/schema.js';
import {
  CHAINLINK_FEED_ABI, CL_POOL_PRICE_ABI, ERC20_ABI, FACTORY_ABI, FACTORY_REGISTRY_ABI, GAUGE_ABI, LEAF_VOTER_ABI, MULTICALL3_ABI, POOL_ABI, POOL_TAPE_ABI,
  ROOT_VOTER_ABI, V2_POOL_PRICE_ABI, VRM_ABI,
} from '../../src/ingest/poolscan/abi.js';
import type { SourceContext } from '../../src/ingest/types.js';
import { fakeRpc, type FakeRpc } from './fakeRpc.js';
import { ingestAsset } from './ingestAsset.js';
import { sourceCtx } from './sourceCtx.js';

/**
 * A SYNTHETIC pool-scan world (Phase 3 R4 Task 7): one V2 volatile factory per chain, three pools, one gauge and one VRM
 * with two incentive programs, a USDC anchor; served raw through `fakeRpc.dataCalls` (viem encode/decode), so the
 * adapters run the real engine (scan, pricing, incentives) through `ctx.rpcFor` with no network.
 *
 * - P1 USDC/Z: the day's priced gross fee (USDC) and the gauge's allocator (Δ pendingFees). Balances 0: never a graph edge.
 * - P2 X/Y: the day's unpriced fee (X). P3 Y/USDC holds $100 of USDC (< the $10K floor): X and Y stay unpriced, and the
 *   floor-0 coverage graph prices both at $1, so `unpriced` X counts $1 per token in coverage.
 * - Programs: id 1 (third party) streams `vote` USDC/day, id 2 (the subsidy creator) `subsidy` USDC/day; supply > 0.
 * - Blocks: one per 60 s from 2026-06-01 00:00Z, so each day has exact boundary blocks; accumulators and pending are
 *   cumulative sums of the per-day figures through the block's day.
 */

const a = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
export const W = {
  factory: a(0xf1), tape: a(0x7a), router: a(0x70), registry: a(0xe9), leafVoter: a(0x1e), gaugeFactory: a(0x9f), gauge: a(0x9a), vrm: a(0x7e),
  usdc: a(0xc1), x: a(0xa1), y: a(0xb1), z: a(0xd1), feed: a(0xfd), p1: a(0x101), p2: a(0x102), p3: a(0x103), rootVoter: a(0x400),
  voteCreator: a(0x501), subsidyCreator: a(0x502), otherFactory: a(0xf2), otherTape: a(0x7b),
} as const;

export const GENESIS = Date.parse('2026-06-01T00:00:00Z') / 1000;
const BLOCK_SEC = 60;
const E18 = 10n ** 18n;

export interface DayFees {
  /** Priced gross fee (USDC, whole). */
  gross: number;
  /** Allocator share of P1 (USDC, whole). */
  alloc: number;
  /** Unpriced fee (X, whole; $1 each in coverage). */
  unpriced: number;
  /** Raw accumulator drop on P1 this day (negative_gross). */
  negativeGross?: boolean;
}

export interface WorldChain {
  chainId: number;
  fees?: (day: string) => Partial<DayFees>;
  /** USDC per day streamed by the third-party program (1) and the subsidy program (2). */
  vote?: number;
  subsidy?: number;
  /** A read that reverts (null data): `fn` at the block's day. */
  revert?: (fn: string, day: string) => boolean;
  /** A transport failure (the eth_call throws). */
  fail?: (fn: string, day: string) => boolean;
  /** The anchor's feed is read on this chain instead (Elysium → Base); this chain then reverts feed reads. */
  feedChain?: number;
  /** Feed updatedAt this many seconds before the block (stale anchor). */
  feedAgeSec?: number;
  /** The factory's live tape getter answers another tape (tape drift). */
  liveTape?: string;
  /** Root Voter chains() (Base only); default the configured ids. */
  rootChains?: number[];
  /** The day whose VRM supply reaches 0 inside an interval (ambiguous point at the day's end). */
  ambiguousDay?: string;
  /** Observe-less pools: none here (V2 only). Extra pools are not modelled. */
}

const DEFAULT_FEES: DayFees = { gross: 1000, alloc: 900, unpriced: 0 };

const SELECTORS = (() => {
  const out = new Map<string, AbiFunction>();
  for (const abi of [POOL_TAPE_ABI, FACTORY_ABI, POOL_ABI, FACTORY_REGISTRY_ABI, GAUGE_ABI, LEAF_VOTER_ABI, VRM_ABI, ROOT_VOTER_ABI, CL_POOL_PRICE_ABI, V2_POOL_PRICE_ABI, ERC20_ABI, CHAINLINK_FEED_ABI, MULTICALL3_ABI] as Abi[]) {
    for (const item of abi) {
      if (item.type !== 'function') continue;
      const sel = toFunctionSelector(item);
      if (!out.has(sel)) out.set(sel, item); // first wins: V2 tape accumulators (the world has no CL factory)
    }
  }
  return out;
})();

const dayOfTs = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 1000;
const usdc = (n: number): bigint => BigInt(Math.round(n * 1e6));
const tok = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

export interface PoolWorld {
  rpcs: Map<number, FakeRpc>;
  /** Inner calls by chain, `functionName` → count. */
  calls: Map<number, Map<string, number>>;
  /** `functionName@day` → count, per chain. */
  callsByDay: Map<number, Map<string, number>>;
  scan: Record<string, unknown>;
  /** `stored`: the days each metric's series holds (default: all up to yesterday; `{}` = none). */
  ctx(over?: Partial<SourceContext> & { stored?: Record<string, string[]>; backfillDays?: number }): SourceContext;
  /** The metric keys the world's asset declares: one per field/class. */
  metrics: Record<string, { name: string; params: Record<string, unknown> }>;
}

export const POOL_METRICS = {
  gross: 'flow_usd.pool_fees_gross',
  allocator: 'flow_usd.voter_fees',
  lp: 'flow_usd.lp_fees',
  vote_incentives: 'flow_usd.vote_incentives',
  protocol_subsidy: 'flow_usd.protocol_subsidy',
} as const;

export function poolWorld(chains: WorldChain[], o: { nowIso: string; maxScanDays?: number; since?: string; withRoot?: boolean } ): PoolWorld {
  const latestTs = Date.parse(o.nowIso) / 1000;
  const latest = BigInt(Math.floor((latestTs - GENESIS) / BLOCK_SEC));
  const ids = chains.map((c) => c.chainId);
  const calls = new Map<number, Map<string, number>>();
  const callsByDay = new Map<number, Map<string, number>>();
  const rpcs = new Map<number, FakeRpc>();

  for (const c of chains) {
    const counts = new Map<string, number>();
    const byDay = new Map<string, number>();
    calls.set(c.chainId, counts);
    callsByDay.set(c.chainId, byDay);
    const fees = (day: string): DayFees => ({ ...DEFAULT_FEES, ...(c.fees?.(day) ?? {}) });
    /** Σ of a per-day figure from GENESIS's day through `day`. */
    const cum = (day: string, pick: (f: DayFees) => number, unit: (n: number) => bigint): bigint => {
      let total = 0n;
      for (let t = GENESIS; dayOfTs(t) <= day; t += 86_400) total += unit(pick(fees(dayOfTs(t))));
      return total;
    };
    const ts = (block: bigint) => GENESIS + Number(block) * BLOCK_SEC;
    const rate = (perDay: number) => (usdc(perDay) * E18) / 86_400n;

    const answer = (address: string, fn: string, args: readonly unknown[], block: bigint): unknown => {
      const t = ts(block);
      const day = dayOfTs(t);
      const isFeed = address === W.feed;
      switch (fn) {
        case 'allPoolsLength': return 3n;
        case 'allPools': return [W.p1, W.p2, W.p3][Number(args[0])];
        case 'poolTape': return c.liveTape ?? W.tape;
        case 'targetFactories': return [W.factory];
        case 'gaugeFactories': return [W.gaugeFactory];
        case 'factoryToGauges': return [W.gauge];
        case 'gaugeToTarget': return W.p1;
        case 'votingRewardsManager': return W.vrm;
        case 'FACTORY_REGISTRY': return W.registry;
        case 'token0': return { [W.p1]: W.usdc, [W.p2]: W.x, [W.p3]: W.y }[address];
        case 'token1': return { [W.p1]: W.z, [W.p2]: W.y, [W.p3]: W.usdc }[address];
        case 'allowedCaller': return W.router;
        case 'accumulators': {
          // V2 PoolTape.accumulators: fee0, fee1, 6 volume/MEV words, lastSwapTimestamp, swapCount.
          const v = (f0: bigint) => [f0, 0n, 0n, 0n, 0n, 0n, 0n, 0n, BigInt(t), 1n];
          if (args[0] === W.p1) {
            let g = cum(day, (f) => f.gross, usdc);
            if (fees(day).negativeGross) g -= usdc(fees(day).gross) * 2n;
            return v(g < 0n ? 0n : g);
          }
          if (args[0] === W.p2) return v(cum(day, (f) => f.unpriced, tok));
          return v(0n);
        }
        case 'pendingFees': return [cum(day, (f) => f.alloc, usdc), 0n];
        case 'getCurrentBlockTimestamp': return BigInt(t);
        case 'description':
          return c.feedChain !== undefined ? null : 'USDC / USD';
        case 'decimals':
          if (isFeed) return c.feedChain !== undefined ? null : 8;
          return address === W.usdc ? 6 : 18;
        case 'latestRoundData':
          if (c.feedChain !== undefined) return null;
          return [1n, 100_000_000n, BigInt(t), BigInt(t - (c.feedAgeSec ?? 0)), 1n];
        case 'getReserves':
          return { [W.p1]: [usdc(1000), tok(1000), 0n], [W.p2]: [tok(100), tok(100), 0n], [W.p3]: [tok(100), usdc(100), 0n] }[address];
        case 'balanceOf': {
          const pool = String(args[0]).toLowerCase();
          if (pool === W.p1) return 0n;
          if (pool === W.p2) return tok(100);
          if (pool === W.p3) return address === W.usdc ? usdc(100) : tok(100);
          return 0n;
        }
        case 'incentiveCount': return 2n;
        case 'incentive': {
          const id = Number(args[0]);
          const r = id === 1 ? rate(c.vote ?? 0) : rate(c.subsidy ?? 0);
          return { token: W.usdc, amount: r * 1000n, rate: r, start: GENESIS, end: GENESIS + 400 * 86_400, creator: id === 1 ? W.voteCreator : W.subsidyCreator };
        }
        case 'getPriorSupplyIndex': {
          const q = Number(args[0]);
          return c.ambiguousDay !== undefined && q >= dayStart(c.ambiguousDay) - 3600 ? 2n : 1n;
        }
        case 'supplyAt': {
          const q = Number(args[0]);
          return c.ambiguousDay !== undefined && q === dayStart(c.ambiguousDay) + 86_400 - 1 ? 0n : E18;
        }
        case 'globalRewardPointHistory':
          return Number(args[0]) === 2
            ? { bias: E18, slope: 0n, ts: dayStart(c.ambiguousDay!) - 3600, permanentStakeBalance: 0n, zeroSupplySeconds: 0 }
            : { bias: E18, slope: 0n, ts: GENESIS, permanentStakeBalance: 0n, zeroSupplySeconds: 0 };
        case 'chains': return (c.rootChains ?? ids).map(BigInt);
        default: return undefined;
      }
    };

    const rpc = fakeRpc({
      genesisTs: GENESIS,
      blockTimeSec: BLOCK_SEC,
      latest,
      dataCalls: (address, data, block) => {
        const item = SELECTORS.get(data.slice(0, 10));
        if (!item) throw new Error(`world: unknown selector ${data.slice(0, 10)}`);
        const { args } = decodeFunctionData({ abi: [item], data: data as Hex });
        const fn = item.name;
        const day = dayOfTs(ts(block));
        counts.set(fn, (counts.get(fn) ?? 0) + 1);
        byDay.set(`${fn}@${day}`, (byDay.get(`${fn}@${day}`) ?? 0) + 1);
        if (c.fail?.(fn, day)) throw new Error(`RPC Request failed (world ${c.chainId} ${fn})`);
        if (c.revert?.(fn, day)) return null;
        const r = answer(address.toLowerCase(), fn, (args ?? []).map((x) => (typeof x === 'string' ? x.toLowerCase() : x)), block);
        if (r === undefined || r === null) return null;
        return encodeFunctionResult({ abi: [item], functionName: fn, result: r } as Parameters<typeof encodeFunctionResult>[0]);
      },
    });
    rpcs.set(c.chainId, rpc);
  }

  const scan: Record<string, unknown> = {
    chains: chains.map((c) => ({
      chain_id: c.chainId,
      factories: [{ address: W.factory, kind: 'v2_volatile', tape: W.tape }],
      factory_registry: W.registry,
      leaf_voter: W.leafVoter,
      anchors: [{ token: W.usdc, feed: W.feed, description: 'USDC / USD', ...(c.feedChain !== undefined ? { feed_chain_id: c.feedChain } : {}) }],
    })),
    subsidy_creators: [W.subsidyCreator],
    ...(o.withRoot !== false && ids.includes(8453) ? { root_voter: { chain_id: 8453, address: W.rootVoter } } : {}),
  };
  const extra = { ...(o.maxScanDays !== undefined ? { max_scan_days: o.maxScanDays } : {}), ...(o.since !== undefined ? { since: o.since } : {}) };
  const metrics: PoolWorld['metrics'] = {
    [POOL_METRICS.gross]: { name: 'pool.tape_fees_daily', params: { scan, field: 'gross', ...extra } },
    [POOL_METRICS.allocator]: { name: 'pool.tape_fees_daily', params: { scan, field: 'allocator', ...extra } },
    [POOL_METRICS.lp]: { name: 'pool.tape_fees_daily', params: { scan, field: 'lp', ...extra } },
    [POOL_METRICS.vote_incentives]: { name: 'pool.vrm_incentives_daily', params: { scan, class: 'vote_incentives', ...extra } },
    [POOL_METRICS.protocol_subsidy]: { name: 'pool.vrm_incentives_daily', params: { scan, class: 'protocol_subsidy', ...extra } },
  };
  const base = ingestAsset().config;
  const asset = {
    ...base,
    ingest: { ...base.ingest!, backfill_days: 100 },
    metrics: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, { type: 'flow', unit: 'usd', source: { type: 'adapter', name: m.name, params: m.params } }])),
  } as unknown as AssetConfig;

  return {
    rpcs,
    calls,
    callsByDay,
    scan,
    metrics,
    ctx(over = {}) {
      // Default: every metric's series is up to date (every day from GENESIS to yesterday stored), a routine run.
      const { stored, ...rest } = over;
      const upToDate: string[] = [];
      for (let t = GENESIS; dayOfTs(t) < o.nowIso.slice(0, 10); t += 86_400) upToDate.push(dayOfTs(t));
      return sourceCtx({
        asset,
        nowIso: o.nowIso,
        rpcFor: (id) => {
          const r = rpcs.get(id);
          if (!r) throw new Error(`world has no chain ${id}`);
          return r;
        },
        storedFlowDays: async (m) => new Set(stored === undefined ? upToDate : (stored[m] ?? [])),
        ...rest,
      });
    },
  };
}

/** The params object a metric of the world's asset carries (identity matters: the adapter finds its metric by it). */
export function paramsOf(world: PoolWorld, ctx: SourceContext, metric: string): Record<string, unknown> {
  const s = (ctx.asset.metrics as Record<string, { source?: { params?: Record<string, unknown> } }>)[metric]?.source?.params;
  if (!s) throw new Error(`no metric ${metric}`);
  return s;
}
