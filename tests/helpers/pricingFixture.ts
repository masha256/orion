import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MULTICALL3_ADDRESS } from '../../src/ingest/poolscan/abi.js';
import type { TypedCall } from '../../src/ingest/poolscan/reader.js';
import { ChainScanSchema, type ChainDayScan, type ChainScan, type PoolFees, type TokenAmounts } from '../../src/ingest/poolscan/types.js';
import { fakeChainReader, type FakeChainReader } from './fakeChainReader.js';

/**
 * The poolscan pricing fixtures (tests/fixtures/poolscan/pricing-<chain>-2026-11-26.json, trimmed from the R4 scoping
 * raw day files by trim_pricing.py there), and in-test synthetic ones of the same shape (`synthPricing`), served as a
 * ChainDayScan plus a fake ChainReader. The scan's e is the scoping's recorded block + 1, so pricing's e−1 reads land
 * on the state the scoping recorded.
 */

export interface PxAnchor { token: string; feed: string; description: string; feed_decimals: number; answer_raw: string; updated_at: number }
export interface PxPool {
  kind: 'cl' | 'v2_stable' | 'v2_volatile';
  tokens: [string, string];
  fee: [string, string];
  alloc?: [string, string];
  bal: [string, string];
  sqrt_price_x96?: string;
  /** observe([twap, 0]) tickCumulatives; null = observe reverts (too few observations). */
  tick_cumulatives?: [string, string] | null;
  reserves?: [string, string];
}
export interface PricingFixture {
  chain: string;
  chain_id: number;
  day: string;
  blocks: { s: number; e: number };
  read_block_timestamp: number;
  factories: { v2_stable: string; v2_volatile: string; cl: string };
  decimals: Record<string, number>;
  anchors: PxAnchor[];
  pools: Record<string, PxPool>;
  expect?: { gross_usd: number; alloc_usd: number; p_onchain: Record<string, number> };
}

export function loadPricingFixture(chain: string, day = '2026-11-26'): PricingFixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'poolscan', `pricing-${chain}-${day}.json`), 'utf8')) as PricingFixture;
}

/** The day scan pricing values: every fixture pool with its gross fees, and the allocator share of pools with `alloc`. */
export function pricingScan(fx: PricingFixture): ChainDayScan {
  const pools: PoolFees[] = [];
  const allocatorByPool = new Map<string, TokenAmounts>();
  for (const [pool, p] of Object.entries(fx.pools)) {
    pools.push({
      pool, factory: fx.factories[p.kind], token0: p.tokens[0], token1: p.tokens[1], fee0: BigInt(p.fee[0]), fee1: BigInt(p.fee[1]),
      registered: true, newInDay: false, gauge: p.alloc ? pool : null,
    });
    if (p.alloc) allocatorByPool.set(pool, new Map([[p.tokens[0], BigInt(p.alloc[0])], [p.tokens[1], BigInt(p.alloc[1])]]));
  }
  return {
    chainId: fx.chain_id, day: fx.day, blocks: { s: BigInt(fx.blocks.s + 1), e: BigInt(fx.blocks.e + 1) }, pools,
    counts: { pools: pools.length, registered: pools.length, gauged: allocatorByPool.size, newInDay: 0 }, allocatorByPool, drift: [],
    rpc: { calls: 0, requests: 0, logs: 0 },
  };
}

const TAPE = '0x34bdd64b19d8631f936c2d07f19aaa6b83515992';
const CL_TAPE = '0x27d5eb73e7406675f6b0cbd037490ec3dba935a4';

/** A scan config for the fixture's chain: its three factories and `anchors` (default: the fixture's). */
export function pricingConfig(fx: PricingFixture, anchors: { token: string; feed: string; description: string; feed_chain_id?: number }[] = fx.anchors): ChainScan {
  return ChainScanSchema.parse({
    chain_id: fx.chain_id,
    factories: [
      { address: fx.factories.v2_stable, kind: 'v2_stable', tape: TAPE },
      { address: fx.factories.v2_volatile, kind: 'v2_volatile', tape: TAPE },
      { address: fx.factories.cl, kind: 'cl', tape: CL_TAPE },
    ],
    factory_registry: '0x7b2a2c12dc5ea2a31455952a05031c3e4bb28f3e',
    leaf_voter: '0x382409fad8503fbcdbb27a4211551fa03e884078',
    anchors: anchors.map((a) => ({ token: a.token, feed: a.feed, description: a.description, ...(a.feed_chain_id ? { feed_chain_id: a.feed_chain_id } : {}) })),
  });
}

/** One feed's three reads, as viem decodes them. */
export function feedAnswer(a: PxAnchor, fn: string): unknown {
  switch (fn) {
    case 'description': return a.description;
    case 'decimals': return a.feed_decimals;
    case 'latestRoundData': return [1n, BigInt(a.answer_raw), BigInt(a.updated_at), BigInt(a.updated_at), 1n];
  }
  return undefined;
}

export interface PricingReaderOptions {
  /** Answer this call first (return undefined to fall through to the fixture; null = the call reverts). */
  override?(call: TypedCall): unknown;
}

/** A fake ChainReader answering the pricing reads from one fixture, at the scoping's recorded end block only. */
export function pricingReader(fx: PricingFixture, opts: PricingReaderOptions = {}): FakeChainReader {
  const feeds = new Map(fx.anchors.map((a) => [a.feed.toLowerCase(), a]));
  return fakeChainReader({
    chainId: fx.chain_id,
    blockAt(ts) {
      throw new Error(`pricing fixture has no block for ${ts}`);
    },
    answer(c, block) {
      if (block !== BigInt(fx.blocks.e)) throw new Error(`pricing read at block ${block}: only ${fx.blocks.e} was recorded`);
      const o = opts.override?.(c);
      if (o !== undefined) return o;
      const addr = c.address.toLowerCase();
      if (addr === MULTICALL3_ADDRESS.toLowerCase() && c.functionName === 'getCurrentBlockTimestamp') return BigInt(fx.read_block_timestamp);
      const feed = feeds.get(addr);
      if (feed) return feedAnswer(feed, c.functionName);
      if (c.functionName === 'decimals' && fx.decimals[addr] !== undefined) return fx.decimals[addr];
      if (c.functionName === 'balanceOf') {
        const p = fx.pools[(c.args?.[0] as string).toLowerCase()];
        const i = p ? p.tokens.indexOf(addr) : -1;
        return i < 0 ? 0n : BigInt(p.bal[i]);
      }
      const p = fx.pools[addr];
      if (p) {
        switch (c.functionName) {
          case 'slot0': return p.sqrt_price_x96 === undefined ? undefined : [BigInt(p.sqrt_price_x96), 0, 0, 1, 1, true];
          case 'observe': return p.tick_cumulatives ? [p.tick_cumulatives.map(BigInt), [0n, 0n]] : p.tick_cumulatives === null ? null : undefined;
          case 'getReserves': return p.reserves ? [BigInt(p.reserves[0]), BigInt(p.reserves[1]), 0n] : undefined;
        }
      }
      return undefined;
    },
  });
}

// ---- synthetic fixtures ----

export const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
export const SYN_DAY = '2026-11-26';
/** 2026-11-27T00:00:00Z: the synthetic read block's timestamp. */
export const SYN_TS = 1795737600;

/** A synthetic chain: anchors and pools in human units, turned into the fixture shape. */
export interface SynToken { address: string; decimals: number }
export function synthPricing(o: { chainId?: number; tokens: SynToken[]; anchors?: PxAnchor[] }): PricingFixture {
  return {
    chain: 'synthetic', chain_id: o.chainId ?? 8453, day: SYN_DAY, blocks: { s: 1000, e: 2000 }, read_block_timestamp: SYN_TS,
    factories: { v2_stable: addr(0xf1), v2_volatile: addr(0xf2), cl: addr(0xf3) },
    decimals: Object.fromEntries(o.tokens.map((t) => [t.address, t.decimals])), anchors: o.anchors ?? [], pools: {},
  };
}

const raw = (x: number, decimals: number): string => ((BigInt(Math.round(x * 1e6)) * 10n ** BigInt(decimals)) / 1_000_000n).toString();

/** A USD feed answering `usd` (8 decimals), updated `ageSec` before the read block. */
export function synthAnchor(token: string, feed: string, usd: number, ageSec = 600, description = 'X / USD'): PxAnchor {
  return { token, feed, description, feed_decimals: 8, answer_raw: BigInt(Math.round(usd * 1e8)).toString(), updated_at: SYN_TS - ageSec };
}

/**
 * Add a pool to a synthetic fixture. `price` = token1 per token0 (human units). CL pools: `twap` (default = price)
 * gives the observe() mean tick, `twap: null` makes observe revert. `bal` = each side's balance in human units (default:
 * 1M of each side). Fees in human units.
 */
export function synthPool(
  fx: PricingFixture,
  pool: string,
  p: { kind: PxPool['kind']; t0: string; t1: string; price: number; twap?: number | null; bal?: [number, number]; fee?: [number, number]; alloc?: [number, number] },
): void {
  const d0 = fx.decimals[p.t0];
  const d1 = fx.decimals[p.t1];
  const bal = p.bal ?? [1_000_000, 1_000_000];
  const entry: PxPool = {
    kind: p.kind, tokens: [p.t0, p.t1], fee: [raw(p.fee?.[0] ?? 0, d0), raw(p.fee?.[1] ?? 0, d1)], bal: [raw(bal[0], d0), raw(bal[1], d1)],
    ...(p.alloc ? { alloc: [raw(p.alloc[0], d0), raw(p.alloc[1], d1)] as [string, string] } : {}),
  };
  if (p.kind === 'cl') {
    const sqrt = Math.sqrt(p.price * 10 ** (d1 - d0)) * 2 ** 96;
    entry.sqrt_price_x96 = BigInt(Math.round(sqrt)).toString();
    const tw = p.twap === undefined ? p.price : p.twap;
    entry.tick_cumulatives = tw === null ? null : ['0', String(Math.round((Math.log(tw * 10 ** (d1 - d0)) / Math.log(1.0001)) * 1800))];
  } else {
    // A volatile pool's reserves are its price; a stable pool here just mirrors balances (tests set stable reserves directly).
    entry.reserves = p.kind === 'v2_volatile' ? [raw(1_000_000, d0), raw(1_000_000 * p.price, d1)] : [entry.bal[0], entry.bal[1]];
  }
  fx.pools[pool] = entry;
}
