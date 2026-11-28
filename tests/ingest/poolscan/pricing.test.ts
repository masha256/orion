import { describe, expect, it } from 'vitest';
import { MULTICALL3_ADDRESS } from '../../../src/ingest/poolscan/abi.js';
import { priceDay, valueScan } from '../../../src/ingest/poolscan/pricing.js';
import type { ChainReader } from '../../../src/ingest/poolscan/reader.js';
import { fakeChainReader } from '../../helpers/fakeChainReader.js';
import {
  addr, feedAnswer, loadPricingFixture, pricingConfig, pricingReader, pricingScan, synthAnchor, synthPool, synthPricing, SYN_TS,
  type PricingFixture,
} from '../../helpers/pricingFixture.js';

const readers = (...rs: ChainReader[]) => new Map(rs.map((r) => [r.chainId, r]));
const rel = (a: number, b: number) => Math.abs(a / b - 1);

async function book(fx: PricingFixture, opts?: Parameters<typeof priceDay>[3], override?: Parameters<typeof pricingReader>[1]) {
  const reader = pricingReader(fx, override);
  const scan = pricingScan(fx);
  const b = await priceDay(readers(reader), pricingConfig(fx), scan, opts);
  return { b, scan, reader };
}

// Synthetic tokens: USDC (6), WETH (18), and X/Y/T* (18).
const USDC = addr(0xa1);
const WETH = addr(0xa2);
const X = addr(0xb1);
const Y = addr(0xb2);
const USDC_FEED = addr(0xfa1);
const WETH_FEED = addr(0xfa2);
const t18 = (a: string) => ({ address: a, decimals: 18 });
function usdcChain(extra: string[] = []): PricingFixture {
  return synthPricing({
    tokens: [{ address: USDC, decimals: 6 }, t18(WETH), t18(X), t18(Y), ...extra.map(t18)],
    anchors: [synthAnchor(USDC, USDC_FEED, 1, 600, 'USDC / USD')],
  });
}

describe('poolscan priceDay (on-chain price graph)', () => {
  it('only configured anchor addresses are anchors: the five other Base USDCs and the spoof LINK are graph-priced', async () => {
    const fx = loadPricingFixture('base');
    const OTHER_USDC = ['0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', '0x584fbca587e2bbea9bec6cac60370f6ed20a49c4', '0x9cb79dfbb336c487a77a79d040f34bd44d91a846',
      '0xc4c6b55196e495d7efe3273326b7b650e586ed87', '0x0ac9c1d2db7b6b03100e1c675ff44b729dd9fb07'];
    const SPOOF_LINK = '0x26afac38d9991b0ec8990281d85e3566af16d994';
    const REAL_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const WETH_BASE = '0x4200000000000000000000000000000000000006';
    // On the real day none of them has a >= $10K edge, so the graph leaves them unpriced (never at the USDC/LINK feed).
    const { b } = await book(fx);
    const anchored = [...b.how].filter(([, h]) => h === 'anchor').map(([t]) => t).sort();
    expect(anchored).toEqual(fx.anchors.map((a) => a.token).sort());
    expect(b.how.get(REAL_USDC)).toBe('anchor');
    for (const t of [...OTHER_USDC, SPOOF_LINK]) expect(b.how.get(t), t).toBeUndefined();
    // Synthetic deep WETH pools for each: each is graph-priced at its pool's price, never the feed's.
    const fx2: PricingFixture = structuredClone(fx);
    [...OTHER_USDC, SPOOF_LINK].forEach((t, i) => {
      fx2.decimals[t] ??= 18;
      synthPool(fx2, addr(0x5000 + i), { kind: 'cl', t0: WETH_BASE, t1: t, price: 1000 * (i + 2), bal: [100, 0] });
    });
    const { b: b2 } = await book(fx2);
    const weth = b2.usd.get(WETH_BASE)!;
    [...OTHER_USDC, SPOOF_LINK].forEach((t, i) => {
      expect(b2.how.get(t), t).toBe('graph');
      expect(rel(b2.usd.get(t)!, weth / (1000 * (i + 2))), t).toBeLessThan(1e-4);
    });
  });

  it('a CL edge uses the 30-min TWAP; spot only when observations are short, flagged spot_fallback', async () => {
    const fx = usdcChain();
    synthPool(fx, addr(0x101), { kind: 'cl', t0: X, t1: USDC, price: 3, twap: 2 });
    synthPool(fx, addr(0x102), { kind: 'v2_volatile', t0: Y, t1: X, price: 0.5 });
    const { b, reader } = await book(fx);
    expect(rel(b.usd.get(X)!, 2)).toBeLessThan(1e-3);
    expect(b.how.get(X)).toBe('graph');
    expect(rel(b.usd.get(Y)!, 1)).toBeLessThan(1e-3);
    const obs = reader.stats.calls.filter((c) => c.functionName === 'observe');
    expect(obs).toEqual([{ address: addr(0x101), functionName: 'observe', args: [[1800, 0]], block: BigInt(fx.blocks.e) }]);
    // observe reverts (cardinality too short for 30 min): slot0 spot, flagged, and the flag carries to tokens priced off it.
    fx.pools[addr(0x101)].tick_cumulatives = null;
    const { b: b2 } = await book(fx);
    expect(rel(b2.usd.get(X)!, 3)).toBeLessThan(1e-6);
    expect(b2.how.get(X)).toBe('graph_spot_fallback');
    expect(b2.how.get(Y)).toBe('graph_spot_fallback');
    expect(rel(b2.usd.get(Y)!, 1.5)).toBeLessThan(1e-6);
  });

  it('a V2 stable pool uses the stable curve from its factory', async () => {
    const fx = loadPricingFixture('optimism');
    const MSUSD = '0x9dabae7274d28a45f0b65bf8ed201a5731492ca0';
    const want = fx.expect!.p_onchain[MSUSD];
    const { b, reader } = await book(fx);
    expect(rel(b.usd.get(MSUSD)!, want)).toBeLessThan(0.005);
    // The curve comes from the factory: no stable() read.
    expect(reader.stats.calls.some((c) => c.functionName === 'stable')).toBe(false);
    // Read as a volatile pool, the same reserves are 50%+ off.
    const fxv: PricingFixture = structuredClone(fx);
    for (const p of Object.values(fxv.pools)) p.kind = 'v2_volatile';
    const bv = await priceDay(readers(pricingReader(fxv)), pricingConfig(fxv), pricingScan(fxv));
    expect(rel(bv.usd.get(MSUSD)!, want)).toBeGreaterThan(0.5);
  });

  it('an edge whose priced side holds under $10K is not used', async () => {
    const fx = usdcChain();
    synthPool(fx, addr(0x201), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2, bal: [1e6, 9_999] });
    expect((await book(fx)).b.usd.has(X)).toBe(false);
    synthPool(fx, addr(0x201), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2, bal: [1e6, 10_000] });
    expect(rel((await book(fx)).b.usd.get(X)!, 2)).toBeLessThan(1e-9);
    // The deepest qualifying pool wins.
    synthPool(fx, addr(0x202), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2.2, bal: [1e6, 50_000] });
    expect(rel((await book(fx)).b.usd.get(X)!, 2.2)).toBeLessThan(1e-9);
    // The floor is the option's.
    expect((await book(fx, { floorUsd: 60_000 })).b.usd.has(X)).toBe(false);
  });

  it('a 4-hop token is unpriced', async () => {
    const T = [1, 2, 3, 4].map((i) => addr(0xc0 + i));
    const Z = addr(0xc9);
    const fx = usdcChain([...T, Z]);
    let prev = USDC;
    T.forEach((t, i) => {
      synthPool(fx, addr(0x300 + i), { kind: 'v2_volatile', t0: t, t1: prev, price: 2 });
      prev = t;
    });
    // T4's fees sit in a pool against a token nothing prices, so the own-pool fallback cannot value them either.
    synthPool(fx, addr(0x309), { kind: 'v2_volatile', t0: T[3], t1: Z, price: 1, fee: [10, 0] });
    const { b, scan } = await book(fx);
    expect(b.usd.get(T[0])).toBeCloseTo(2, 9);
    expect(b.usd.get(T[1])).toBeCloseTo(4, 9);
    expect(b.usd.get(T[2])).toBeCloseTo(8, 9);
    expect(b.usd.has(T[3])).toBe(false);
    expect(b.how.has(T[3])).toBe(false);
    expect(b.fallback(addr(0x309), T[3])).toBeNull();
    expect((await book(fx, { maxHops: 4 })).b.usd.get(T[3])).toBeCloseTo(16, 9);
    // Its fees: unpriced, listed, and valued for coverage only by the floorless 6-hop graph.
    const v = valueScan(scan, b);
    expect(v.grossUsd).toBe(0);
    expect(v.unpriced).toEqual([{ token: T[3], amount: 10n * 10n ** 18n, pool: addr(0x309), estimateUsd: expect.closeTo(160, 6) }]);
    expect(v.coverageEstimateUsd).toBeCloseTo(160, 6);
    expect(v.pricedPct).toBe(0);
  });

  it('own-pool fallback prices only that pool', async () => {
    const fx = usdcChain();
    synthPool(fx, addr(0x401), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2, bal: [1e6, 5_000], fee: [10, 1], alloc: [9, 1] });
    synthPool(fx, addr(0x402), { kind: 'v2_volatile', t0: X, t1: Y, price: 4, bal: [1e6, 1e6], fee: [3, 0] });
    const { b, scan } = await book(fx);
    expect(b.usd.has(X)).toBe(false);
    expect(b.fallback(addr(0x401), X)).toBeCloseTo(2, 9);
    expect(b.fallback(addr(0x402), X)).toBeNull();
    expect(b.fallback(addr(0x401), USDC)).toBeNull();
    const v = valueScan(scan, b);
    expect(v.grossUsd).toBeCloseTo(10 * 2 + 1, 6);
    expect(v.allocatorUsd).toBeCloseTo(9 * 2 + 1, 6);
    expect(v.lpUsd).toBeCloseTo(v.grossUsd - v.allocatorUsd, 9);
    // X's fees in the X/Y pool stay unpriced (the floorless graph prices X at the thin pool: $2 -> $6 of coverage).
    expect(v.unpriced).toEqual([{ token: X, amount: 3n * 10n ** 18n, pool: addr(0x402), estimateUsd: expect.closeTo(6, 6) }]);
    expect(v.pricedPct).toBeCloseTo((100 * 21) / 27, 6);
  });

  it('a fee no floorless path reaches counts 0 in coverage and is listed with its amount', async () => {
    const fx = usdcChain([addr(0xee)]);
    synthPool(fx, addr(0x451), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2, fee: [1, 0] });
    synthPool(fx, addr(0x452), { kind: 'v2_volatile', t0: Y, t1: addr(0xee), price: 1, fee: [5, 0] });
    const { b, scan } = await book(fx);
    const v = valueScan(scan, b);
    expect(v.grossUsd).toBeCloseTo(2, 9);
    expect(v.unpriced).toEqual([{ token: Y, amount: 5n * 10n ** 18n, pool: addr(0x452), estimateUsd: null }]);
    expect(v.coverageEstimateUsd).toBe(0);
    expect(v.pricedPct).toBe(100);
  });

  it('a feed older than 26 h drops its anchor', async () => {
    const fx = usdcChain();
    fx.anchors.push(synthAnchor(WETH, WETH_FEED, 2000, 93_601, 'ETH / USD'));
    synthPool(fx, addr(0x501), { kind: 'cl', t0: WETH, t1: USDC, price: 1990, bal: [1000, 2e6] });
    const { b } = await book(fx);
    expect(b.anchorsDropped).toEqual([WETH]);
    expect(b.how.get(WETH)).toBe('graph');
    expect(rel(b.usd.get(WETH)!, 1990)).toBeLessThan(1e-3);
    // At exactly 26 h it is still an anchor.
    fx.anchors[1] = synthAnchor(WETH, WETH_FEED, 2000, 93_600, 'ETH / USD');
    const { b: b2 } = await book(fx);
    expect(b2.anchorsDropped).toEqual([]);
    expect(b2.how.get(WETH)).toBe('anchor');
    expect(b2.usd.get(WETH)).toBe(2000);
    // The staleness limit is the option's.
    expect((await book(fx, { feedMaxAgeSec: 3600 })).b.anchorsDropped).toEqual([WETH]);
  });

  it('a feed whose description() differs from the configured one fails the run', async () => {
    const fx = usdcChain();
    synthPool(fx, addr(0x601), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2 });
    const cfg = pricingConfig(fx, [{ token: USDC, feed: USDC_FEED, description: 'USDT / USD' }]);
    await expect(priceDay(readers(pricingReader(fx)), cfg, pricingScan(fx))).rejects.toMatchObject({ code: 'anchor_feed_mismatch' });
  });

  it('a failed feed, reserve, slot0 or block-timestamp read fails the run (never a missing price)', async () => {
    const fx = usdcChain();
    synthPool(fx, addr(0x701), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2 });
    synthPool(fx, addr(0x702), { kind: 'cl', t0: Y, t1: USDC, price: 2 });
    const cases: [string, string, string][] = [
      [USDC_FEED, 'latestRoundData', 'latestRoundData'], [USDC_FEED, 'description', 'description'], [USDC_FEED, 'decimals', 'decimals'],
      [addr(0x701), 'getReserves', 'getReserves'], [addr(0x702), 'slot0', 'slot0'], [MULTICALL3_ADDRESS.toLowerCase(), 'getCurrentBlockTimestamp', 'getCurrentBlockTimestamp'],
    ];
    for (const [target, fn, msg] of cases) {
      const r = pricingReader(fx, { override: (c) => (c.address.toLowerCase() === target && c.functionName === fn ? null : undefined) });
      const err = await priceDay(readers(r), pricingConfig(fx), pricingScan(fx)).catch((e: unknown) => e);
      expect(err, fn).toMatchObject({ code: 'pool_scan_read_failed' });
      expect((err as Error).message, fn).toContain(msg);
    }
    // A non-positive answer is a broken feed, not a price.
    const z = pricingReader(fx, { override: (c) => (c.functionName === 'latestRoundData' ? [1n, 0n, 1n, BigInt(SYN_TS), 1n] : undefined) });
    await expect(priceDay(readers(z), pricingConfig(fx), pricingScan(fx))).rejects.toMatchObject({ code: 'pool_scan_read_failed' });
  });

  it('Elysium anchors read Base feeds at the Base block for Elysium e-1', async () => {
    const WHYPE = addr(0xd1);
    const BASE_HYPE_FEED = '0xedb56c5de751ed3182dda337f7d9ab33cf091dca';
    const BASE_USDC_FEED = '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b';
    const ELY_TS = SYN_TS - 1; // Elysium e−1's timestamp (synthetic)
    const fx = synthPricing({ chainId: 99901, tokens: [{ address: USDC, decimals: 6 }, t18(WHYPE), t18(X)] });
    fx.read_block_timestamp = ELY_TS;
    synthPool(fx, addr(0x801), { kind: 'cl', t0: X, t1: WHYPE, price: 0.1 });
    const baseFeeds = [synthAnchor(USDC, BASE_USDC_FEED, 0.9999, 1000, 'USDC / USD'), synthAnchor(WHYPE, BASE_HYPE_FEED, 62.1, 1000, 'HYPE / USD')];
    const BASE_BLOCK = 62_736_000n;
    const base = fakeChainReader({
      chainId: 8453,
      blockAt: (ts) => ({ number: BASE_BLOCK, timestamp: ts }),
      answer(c, block) {
        if (block !== BASE_BLOCK) throw new Error(`base feed read at ${block}`);
        const a = baseFeeds.find((f) => f.feed === c.address.toLowerCase());
        return a ? feedAnswer(a, c.functionName) : undefined;
      },
    });
    const ely = pricingReader(fx);
    const cfg = pricingConfig(fx, baseFeeds.map((a) => ({ token: a.token, feed: a.feed, description: a.description, feed_chain_id: 8453 })));
    const b = await priceDay(readers(ely, base), cfg, pricingScan(fx));
    expect(base.stats.blockAt).toEqual([ELY_TS]);
    expect(new Set(base.stats.calls.map((c) => c.block))).toEqual(new Set([BASE_BLOCK]));
    expect(ely.stats.calls.some((c) => c.address === BASE_HYPE_FEED || c.address === BASE_USDC_FEED)).toBe(false);
    expect(b.usd.get(USDC)).toBe(0.9999);
    expect(b.usd.get(WHYPE)).toBe(62.1);
    expect(rel(b.usd.get(X)!, 6.21)).toBeLessThan(1e-3);
    // Staleness is measured at Elysium's e−1.
    baseFeeds[1] = synthAnchor(WHYPE, BASE_HYPE_FEED, 62.1, 93_602, 'HYPE / USD'); // updated ELY_TS − 93,601
    expect((await priceDay(readers(ely, base), cfg, pricingScan(fx))).anchorsDropped).toEqual([WHYPE]);
    // No Base reader: a config error, not a silent unpriced anchor.
    await expect(priceDay(readers(ely), cfg, pricingScan(fx))).rejects.toMatchObject({ code: 'pool_scan_config' });
  });

  it('2026-11-26 Base fixture: grossUsd within 0.1% of the scoping 241,793', async () => {
    const fx = loadPricingFixture('base');
    expect(fx.expect!.gross_usd).toBeCloseTo(241_793.3, 1);
    const { b, scan } = await book(fx);
    const v = valueScan(scan, b);
    expect(rel(v.grossUsd, fx.expect!.gross_usd)).toBeLessThan(0.001);
    expect(rel(v.allocatorUsd, fx.expect!.alloc_usd)).toBeLessThan(0.001);
    expect(v.lpUsd).toBeCloseTo(v.grossUsd - v.allocatorUsd, 6);
    expect(v.pricedPct).toBeGreaterThan(99.9);
    // Per-token agreement with the scoping's on-chain prices (tokens.*.p_onchain: graph_AB_floor50k, spot edges), over
    // the top 30 tokens by fee value: fee-weighted under 0.1%, every one under 0.5%; AERO under 0.5%.
    const feeUsd = new Map<string, number>();
    for (const p of scan.pools) {
      for (const [t, a] of [[p.token0, p.fee0], [p.token1, p.fee1]] as const) {
        const px = b.usd.get(t);
        if (px !== undefined && a > 0n) feeUsd.set(t, (feeUsd.get(t) ?? 0) + (Number(a) / 10 ** b.decimals.get(t)!) * px);
      }
    }
    const top = [...feeUsd].filter(([t]) => fx.expect!.p_onchain[t] !== undefined).sort((x, y) => y[1] - x[1]).slice(0, 30);
    expect(top).toHaveLength(30);
    const errs = top.map(([t, usd]) => [rel(b.usd.get(t)!, fx.expect!.p_onchain[t]), usd] as const);
    expect(errs.reduce((s, [e, w]) => s + e * w, 0) / errs.reduce((s, [, w]) => s + w, 0)).toBeLessThan(0.001);
    expect(Math.max(...errs.map(([e]) => e))).toBeLessThan(0.005);
    const AERO = '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee';
    expect(b.how.get(AERO)).toBe('graph');
    expect(rel(b.usd.get(AERO)!, fx.expect!.p_onchain[AERO])).toBeLessThan(0.005);
    expect(b.anchorsDropped).toEqual([]);
  });
});

describe('poolscan valueScan', () => {
  it('values gross and allocator per pool; a token without decimals is unpriced', async () => {
    const fx = usdcChain();
    synthPool(fx, addr(0x901), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2, fee: [1, 4], alloc: [0.5, 3] });
    const NODEC = addr(0xbad);
    fx.decimals[NODEC] = 18;
    synthPool(fx, addr(0x902), { kind: 'v2_volatile', t0: NODEC, t1: USDC, price: 1, fee: [7, 0] });
    fx.pools[addr(0x902)].fee[0] = '7';
    const { b, scan } = await book(fx, undefined, { override: (c) => (c.address.toLowerCase() === NODEC && c.functionName === 'decimals' ? null : undefined) });
    const v = valueScan(scan, b);
    expect(v.grossUsd).toBeCloseTo(6, 9);
    expect(v.allocatorUsd).toBeCloseTo(4, 9);
    expect(v.unpriced).toEqual([{ token: NODEC, amount: 7n, pool: addr(0x902), estimateUsd: null }]);
    expect(v.unregisteredAllocatorUsd).toBe(0);
  });

  it('a gauged unregistered pool (gross = its allocator accrual, from the scan) adds 0 LP and is summed in unregisteredAllocatorUsd', async () => {
    const fx = usdcChain();
    synthPool(fx, addr(0x901), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2, fee: [1, 4], alloc: [0.5, 3] });
    synthPool(fx, addr(0x903), { kind: 'v2_volatile', t0: X, t1: USDC, price: 2, fee: [2, 10], alloc: [2, 10] });
    const { b, scan } = await book(fx);
    scan.pools.find((p) => p.pool === addr(0x903))!.registered = false;
    const v = valueScan(scan, b);
    expect(v.grossUsd).toBeCloseTo(6 + 14, 9);
    expect(v.allocatorUsd).toBeCloseTo(4 + 14, 9);
    expect(v.lpUsd).toBeCloseTo(2, 9);
    expect(v.unregisteredAllocatorUsd).toBeCloseTo(14, 9);
  });
});

