import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BlockRef } from '../../src/ingest/transport/rpc.js';
import { loadPrices, type PriceEntry } from '../../src/prices/config.js';
import { callsFor, decode, priceHourEvm, quoteTokenFor, withCheck, type BlockReadCache } from '../../src/prices/evmMethods.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

// Phase 3 R2 Task 2: the EVM price methods, read in one multicall per chain-hour. Prices from the scoping files' measured
// rows (base-bnb.md NOW row: CAKE 1.74948, VVV 19.4017; wrappers.md: cvxCRV 0.41377 CRV; eth-tokens.md: SKY 0.0584;
// hype-lit-pump.md: LIT 3.3573), quote prices (ETH 3,000, USD stables 1) round where the test needs only the arithmetic.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRICES = loadPrices(ROOT);
const bySymbol = (s: string): PriceEntry => {
  const e = [...PRICES.values()].find((x) => x.symbol === s);
  if (!e) throw new Error(`no ${s} in prices.yaml`);
  return e;
};
const ref = (s: string) => bySymbol(s).ref;
const addr = (s: string) => ref(s).split('/')[1];

type Calls = Record<string, bigint | Error>;
const E18 = 10n ** 18n;
const H = Date.parse('2026-11-13T12:00:00Z') / 1000; // the hour H; the bucket is [H, H+1h), read at B(H+1h)

/** A regular chain whose block START is at H and END at H+1h, with reads per block. */
function hourChain(blockTime: number, reads: { start?: Calls; end: Calls; other?: Record<string, Calls> }) {
  const START = 100_000n;
  const END = START + BigInt(3600 / blockTime);
  const rpc = fakeRpc({
    genesisTs: H - Number(START) * blockTime,
    latest: END + 10n,
    blockTimeSec: blockTime,
    callsAt: (n) => (n === START ? reads.start : n === END ? reads.end : reads.other?.[String(n)]),
  });
  const at = { start: { number: START, timestamp: H } as BlockRef, end: { number: END, timestamp: H + 3600 } as BlockRef };
  return { rpc, at };
}

const k = (address: string, fn: string, args: readonly unknown[] = [], pick?: number) => callKey(address, fn, args) + (pick === undefined ? '' : `[${pick}]`);
/** A Chainlink feed's latestRoundData (8 decimals): answer at pick 1, updatedAt at pick 3. */
const feed = (address: string, usd: number, updatedAt = H + 3600 - 60): Calls => ({
  [k(address, 'latestRoundData', [], 1)]: BigInt(Math.round(usd * 1e8)),
  [k(address, 'latestRoundData', [], 3)]: BigInt(updatedAt),
});
const tokens = (pool: string, t0: string, t1: string): Calls => ({ [k(pool, 'token0')]: BigInt(t0), [k(pool, 'token1')]: BigInt(t1) });
/** A signed int56 as the uint256 word it is ABI-encoded as (sign-extended, two's complement). */
const word = (x: bigint): bigint => (x < 0n ? (1n << 256n) + x : x);
/** observe([3600, 0]) read as its raw return words: tickCumulatives[0] is word 3, tickCumulatives[1] word 4. */
const observe = (pool: string, tc0: bigint, tc1: bigint): Calls => ({ [k(pool, 'observe', [[3600, 0]], 3)]: word(tc0), [k(pool, 'observe', [[3600, 0]], 4)]: word(tc1) });
const meanTickPrice = (tc0: bigint, tc1: bigint) => 1.0001 ** (Number(tc1 - tc0) / 3600);

const FEEDS = {
  ethUsdEth: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
  usdcUsdEth: '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6',
  usdtUsdEth: '0x3e7d1eab13ad0104d2750b8863b489d65364e32d',
  daiUsd: '0xaed0c38402a5d19df6e4c03f4e2dced6e29c1ee9',
  crvUsd: '0xcd627aa160a6fa45eb793d19ef54f5062f20f33f',
  crvusdUsd: '0xeef0c605546958c1f899b6fb336c20671f9cd49f',
  usdsUsd: '0xff30586cd0f29ed462364c7e81375fc0c71219b1',
  skyUsd: '0xee10fe5e7aa92dd7b136597449c3d5813cfc5f18',
  linkUsd: '0x2c1d072e956affc0d435cb7ac38ef18d24d9127c',
  cakeUsd: '0xb6064ed41d4f67e353768aa239ca86f4f73665a1',
  usdtUsdBnb: '0xb97ad0e74fa7d920791e90258a6e2085088b4320',
  ethUsdBase: '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70',
  usdcUsdBase: '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b',
};
const WETH_ETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDT_BNB = '0x55d398326f99059ff775485246999027b3197955';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

describe('Chainlink (8 decimals) and a v3 observe check on BNB', () => {
  const CAKE = bySymbol('CAKE');
  const POOL = '0x7f51c8aaa6b0599abd16674e2b17fec7a9f674a1'; // PCS v3 CAKE/USDT: CAKE (0x0e09..) is token0, both 18 decimals
  const tc0 = -10_000_000n; // crosses zero within the hour: each int56 is read as its two's-complement word
  const tc1 = tc0 + 5_595n * 3600n;
  const end: Calls = { ...feed(FEEDS.cakeUsd, 1.74948), ...feed(FEEDS.usdtUsdBnb, 1), ...tokens(POOL, addr('CAKE'), USDT_BNB), ...observe(POOL, tc0, tc1) };

  it('prices CAKE from its feed at B(H+1h) and checks it against the pool TWAP x USDT/USD, in one multicall', async () => {
    const { rpc, at } = hourChain(3, { end });
    const { prices, feedUsd } = await priceHourEvm(rpc, [CAKE], at);
    const p = prices.get(CAKE.ref)!;
    expect(p.usd).toBeCloseTo(1.74948, 10);
    expect(p.source).toBe('chain:chainlink');
    expect(p.check).toBe('chain:v3_twap');
    const check = meanTickPrice(tc0, tc1) * 1;
    expect(p.checkGapPct).toBeCloseTo(((check - 1.74948) / 1.74948) * 100, 8);
    expect(p.detail.feed_age_s).toBe(60);
    expect(p.detail.block).toBe(String(at.end.number));
    expect(feedUsd.get(FEEDS.cakeUsd)).toBeCloseTo(1.74948, 10);
    expect(feedUsd.get(FEEDS.usdtUsdBnb)).toBe(1);
    expect(rpc.stats.multicall).toBe(1);
  });

  it('reads token1 side and decimals the other way round (VVV is token1 of VVV/USDC, 18 vs 6)', async () => {
    const VVV = bySymbol('VVV');
    const check = VVV.check;
    if (check.kind !== 'v3_twap') throw new Error('VVV check is not v3_twap');
    const pool = check.pool.toLowerCase();
    // VVV in USDC 19.40: raw price token1/token0 = VVV raw per USDC raw = 1e12 / 19.40.
    const t = Math.round((Math.log(1e12 / 19.4) / Math.log(1.0001)) * 3600);
    const ctx = { chainId: 8453, token: addr('VVV'), decimals: 18, quoteDecimals: () => null };
    const calls = callsFor(check, at0(), ctx);
    expect(calls.map((c) => `${c.functionName}${c.pick ?? ''}@${c.at}`)).toEqual(['token0@end', 'token1@end', 'observe3@end', 'observe4@end']);
    const raw = [BigInt(USDC_BASE), BigInt(addr('VVV')), 7n, 7n + BigInt(t)];
    const v = decode(check, raw, at0(), ctx, () => null, new Map([[FEEDS.usdcUsdBase, 0.9999]]));
    if (v.usd === null) throw new Error(v.reason);
    expect(v.usd).toBeCloseTo(1.0001 ** (-t / 3600) * 1e12 * 0.9999, 8);
    expect(v.usd).toBeCloseTo(19.4 * 0.9999, 3);
    expect(pool).toBe('0x67a11022b7b6ed66f81233f6c8ed6e48f7826530');
  });
});

function at0() {
  return { start: { number: 1n, timestamp: H }, end: { number: 2n, timestamp: H + 3600 } };
}

describe('Curve price_oracle x CRV (Ethereum)', () => {
  const entries = [bySymbol('crvUSD'), bySymbol('CRV'), bySymbol('cvxCRV')];
  const TRICRV = '0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14';
  const CRVUSD_USDT = '0x390f3595bca2df7d23783dfd126427cceb997bf4';
  const CVXCRV_POOL = '0x971add32ea87f10bd192671630be3be8a11b8623';
  const CVXCRV_OLD = '0x9d0464996170c6b9e75eed71c68b99ddedf279e8';
  const FEE = 15_000_000n; // 0.15% in 1e10
  // get_dy(1, 0, 100 cvxCRV) / (1 - fee) = 42 CRV: 0.42 CRV per cvxCRV.
  const DY = (42n * E18 * (10n ** 10n - FEE)) / 10n ** 10n;
  const end: Calls = {
    ...feed(FEEDS.crvusdUsd, 1),
    ...feed(FEEDS.usdtUsdEth, 1),
    ...feed(FEEDS.crvUsd, 0.2336),
    [k(CRVUSD_USDT, 'price_oracle')]: E18,
    [k(TRICRV, 'price_oracle', [1n])]: 2335n * 10n ** 14n, // CRV 0.2335 crvUSD
    [k(CVXCRV_POOL, 'price_oracle')]: 41377n * 10n ** 13n, // cvxCRV 0.41377 CRV
    [k(CVXCRV_OLD, 'get_dy', [1n, 0n, 100n * E18])]: DY,
    [k(CVXCRV_OLD, 'fee')]: FEE,
  };

  it('chains crvUSD -> CRV -> cvxCRV in dependency order from one read: 0.41377 x 0.2335 = 0.09662', async () => {
    const { rpc, at } = hourChain(12, { end });
    const { prices } = await priceHourEvm(rpc, [...entries].reverse(), at);
    expect(prices.get(ref('CRV'))!.usd).toBeCloseTo(0.2335, 10);
    expect(prices.get(ref('CRV'))!.checkGapPct).toBeCloseTo(((0.2336 - 0.2335) / 0.2335) * 100, 8);
    const cvx = prices.get(ref('cvxCRV'))!;
    expect(cvx.usd).toBeCloseTo(0.41377 * 0.2335, 12);
    expect(cvx.usd).toBeCloseTo(0.09662, 4);
    expect(cvx.source).toBe('chain:curve_oracle');
    expect(cvx.check).toBe('chain:curve_get_dy');
    expect(cvx.checkGapPct).toBeCloseTo(((0.42 - 0.41377) / 0.41377) * 100, 6);
    expect(rpc.stats.multicall).toBe(1);
  });

  it('a ref whose quote ref has no price this hour gets no row (Review Focus 2: cvxCRV before CRV)', async () => {
    const { rpc, at } = hourChain(12, { end: { ...end, [k(TRICRV, 'price_oracle', [1n])]: new Error('execution reverted') } });
    const { prices, missing } = await priceHourEvm(rpc, entries, at);
    expect(prices.has(ref('crvUSD'))).toBe(true);
    expect(prices.has(ref('CRV'))).toBe(false);
    expect(prices.has(ref('cvxCRV'))).toBe(false);
    expect(missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: ref('CRV'), reason: 'call_failed' }),
        expect.objectContaining({ ref: ref('cvxCRV'), reason: 'quote_missing' }),
      ]),
    );
  });
});

describe('Uniswap v2 cumulative TWAP (SKY/USDS)', () => {
  const PAIR = '0x2621cc0b3f3c079c1db0e80794aa24976f0b9e3c'; // token0 SKY (0x5607..), token1 USDS (0xdc03..), both 18
  const Q112 = 2n ** 112n;
  const enc = (num: bigint, den: bigint) => (num * Q112) / den;
  // p1 = 0.06 USDS/SKY until a swap at H+1800, then p2 = 0.05. The pair was last touched at H-100 before the start block.
  const [a0, a1] = [1_000_000n * E18, 60_000n * E18];
  const [b0, b1] = [1_200_000n * E18, 60_000n * E18];
  const C0 = 5n * 2n ** 130n;
  const C1 = 7n * 2n ** 120n;
  const reserves = (pair: string, r0: bigint, r1: bigint, ts: number): Calls => ({
    [k(pair, 'getReserves', [], 0)]: r0,
    [k(pair, 'getReserves', [], 1)]: r1,
    [k(pair, 'getReserves', [], 2)]: BigInt(ts),
  });
  const start: Calls = { [k(PAIR, 'price0CumulativeLast')]: C0, [k(PAIR, 'price1CumulativeLast')]: C1, ...reserves(PAIR, a0, a1, H - 100) };
  const end: Calls = {
    ...feed(FEEDS.usdsUsd, 1),
    ...feed(FEEDS.daiUsd, 1),
    ...feed(FEEDS.skyUsd, 0.055),
    ...tokens(PAIR, addr('SKY'), addr('USDS')),
    [k(PAIR, 'price0CumulativeLast')]: C0 + enc(a1, a0) * 1900n,
    [k(PAIR, 'price1CumulativeLast')]: C1 + enc(a0, a1) * 1900n,
    ...reserves(PAIR, b0, b1, H + 1800),
  };

  it('folds each block forward from blockTimestampLast (getReserves): (0.06 x 1800 + 0.05 x 1800) / 3600 = 0.055', async () => {
    const { rpc, at } = hourChain(12, { start, end });
    const { prices } = await priceHourEvm(rpc, [bySymbol('USDS'), bySymbol('SKY')], at);
    const sky = prices.get(ref('SKY'))!;
    expect(sky.usd).toBeCloseTo(0.055, 12); // without the fold it would be (0.06 x 1900) / 3600 = 0.0317
    expect(sky.source).toBe('chain:v2_twap');
    expect(sky.checkGapPct).toBeCloseTo(0, 8);
    expect(sky.detail.twap_s).toBe(3600);
    expect(rpc.stats.multicall).toBe(2); // B(H+1h) and B(H)
  });

  it('prices the token1 side from price1CumulativeLast', () => {
    const sky = bySymbol('SKY');
    const m = sky.primary;
    // Price USDS (token1) in SKY instead: (1/0.06 x 1800 + 1/0.05 x 1800) / 3600.
    const ctx = { chainId: 1, token: addr('USDS'), decimals: 18, quoteDecimals: () => 18 };
    const calls = callsFor(m, at0(), ctx);
    const pick = (c: (typeof calls)[number]) => {
      const src = c.at === 'start' ? start : end;
      return src[k(c.address, c.functionName, c.args ?? [], c.pick)] as bigint;
    };
    expect(calls.filter((c) => c.at === 'start').map((c) => `${c.functionName}${c.pick ?? ''}`)).toEqual(['price0CumulativeLast', 'price1CumulativeLast', 'getReserves0', 'getReserves1', 'getReserves2']);
    const raw = calls.map(pick);
    // the pool holds USDS as token1 and the quote (SKY) as token0
    const v = decode({ ...m, quote_ref: ref('SKY') } as typeof m, raw, at0(), ctx, () => 1, new Map());
    if (v.usd === null) throw new Error(v.reason);
    expect(v.usd).toBeCloseTo((1 / 0.06 + 1 / 0.05) / 2, 10);
  });
});

describe('Aerodrome currentCumulativePrices (Base): VVV, then DIEM quoted in VVV', () => {
  const VVV_POOL = '0x01784ef301d79e4b2df3a21ad9a536d4cf09a5ce'; // token0 WETH, token1 VVV
  const DIEM_POOL = '0xbb345d35450bf9ee76f3d2ce214e8e7ac5e1071d'; // token0 VVV (0xacfe..), token1 DIEM (0xf4d9..)
  const VVV_CHECK = '0x67a11022b7b6ed66f81233f6c8ed6e48f7826530';
  const DIEM_CHECK = '0xbc3231036ee1eca03e5f67fecedc640d21610823';
  const cum = (pool: string, c0: bigint, c1: bigint, ts: number): Calls => ({
    [k(pool, 'currentCumulativePrices', [], 0)]: c0,
    [k(pool, 'currentCumulativePrices', [], 1)]: c1,
    [k(pool, 'currentCumulativePrices', [], 2)]: BigInt(ts),
  });
  // VVV/WETH: reserves 19,401.7 WETH : 3,000,000 VVV over the hour -> 0.0064672 WETH x 3,000 = 19.4017.
  const rW = 194_017n * 10n ** 17n;
  const rV = 3_000_000n * E18;
  // DIEM/VVV: 81.30 VVV per DIEM (1,577.44 / 19.4017 = 81.304).
  const rVd = 8_130_400n * E18;
  const rD = 100_000n * E18;
  const tVvv = Math.round((Math.log(1e12 / 19.4017) / Math.log(1.0001)) * 3600);
  const tDiem = Math.round((Math.log(1e12 / 1577.44) / Math.log(1.0001)) * 3600); // DIEM is token1 of DIEM/USDC too
  const start: Calls = { ...cum(VVV_POOL, 10n, 20n, H), ...cum(DIEM_POOL, 30n, 40n, H) };
  const end: Calls = {
    ...feed(FEEDS.ethUsdBase, 3000),
    ...feed(FEEDS.usdcUsdBase, 1),
    ...tokens(VVV_POOL, WETH_BASE, addr('VVV')),
    ...tokens(DIEM_POOL, addr('VVV'), addr('DIEM')),
    ...tokens(VVV_CHECK, USDC_BASE, addr('VVV')),
    ...tokens(DIEM_CHECK, USDC_BASE, addr('DIEM')),
    ...cum(VVV_POOL, 10n + rW * 3600n, 20n + rV * 3600n, H + 3600),
    ...cum(DIEM_POOL, 30n + rVd * 3600n, 40n + rD * 3600n, H + 3600),
    ...observe(VVV_CHECK, 0n, BigInt(tVvv)),
    ...observe(DIEM_CHECK, 0n, BigInt(tDiem)),
  };
  const entries = () => [bySymbol('DIEM'), bySymbol('VVV')];

  it('prices VVV 19.4017 (TWAP x ETH/USD) and DIEM through VVV, checks on the v3/Slipstream TWAPs', async () => {
    const { rpc, at } = hourChain(2, { start, end });
    const { prices } = await priceHourEvm(rpc, entries(), at);
    const vvv = prices.get(ref('VVV'))!;
    expect(vvv.usd).toBeCloseTo(19.4017, 9);
    expect(vvv.checkGapPct).toBeCloseTo(((1.0001 ** (-tVvv / 3600) * 1e12 - 19.4017) / 19.4017) * 100, 6);
    expect(Math.abs(vvv.checkGapPct!)).toBeLessThan(0.01);
    const diem = prices.get(ref('DIEM'))!;
    expect(diem.usd).toBeCloseTo(81.304 * 19.4017, 6);
    expect(diem.detail.quote).toEqual({ ref: ref('VVV'), usd: vvv.usd });
    expect(Math.abs(diem.checkGapPct!)).toBeLessThan(0.05);
  });

  it("DIEM with VVV's primary call failing: neither is in the map (Review Focus 2)", async () => {
    const { rpc, at } = hourChain(2, { start, end: { ...end, [k(VVV_POOL, 'currentCumulativePrices', [], 0)]: new Error('execution reverted') } });
    const { prices, missing } = await priceHourEvm(rpc, entries(), at);
    expect(prices.has(ref('VVV'))).toBe(false);
    expect(prices.has(ref('DIEM'))).toBe(false);
    expect(missing.find((m) => m.ref === ref('DIEM'))?.reason).toBe('quote_missing');
  });

  it('reuses a cached block read: walking hours newest first costs one multicall per chain-hour', async () => {
    // Hour H-1h reads at B(H) (its end) and B(H-1h) (its start); B(H) was already read as hour H's start.
    const PREV = 100_000n - 1800n;
    const prevStart = { ...cum(VVV_POOL, 0n, 0n, H - 3600), ...cum(DIEM_POOL, 0n, 0n, H - 3600) };
    const { rpc, at } = hourChain(2, { start: { ...end, ...start }, end, other: { [String(PREV)]: { ...end, ...prevStart } } });
    const cache: BlockReadCache = new Map();
    await priceHourEvm(rpc, entries(), at, { cache });
    expect(rpc.stats.multicall).toBe(2);
    const prev = { start: { number: PREV, timestamp: H - 3600 }, end: at.start };
    const { prices } = await priceHourEvm(rpc, entries(), prev, { cache });
    expect(rpc.stats.multicall).toBe(3);
    expect(prices.has(ref('VVV'))).toBe(true);
  });
});

describe('Uniswap v4 getSlot0: the LIT check, read for an entry whose primary is off-chain', () => {
  const LIT = bySymbol('LIT');
  const SV = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
  const ID = '0x8366b1dde4de12c8806985fbb599d408d92d01a6faf2e478cc6bb76189cc00f1';
  // LIT (0x232c..) sorts below USDC (0xa0b8..): LIT is currency0, the price is USDC raw per LIT raw.
  const sqrt = BigInt(Math.round(Math.sqrt(3.3573e-12) * 2 ** 96));
  const slot = (liquidity: bigint): Calls => ({ ...feed(FEEDS.usdcUsdEth, 1), [k(SV, 'getSlot0', [ID], 0)]: sqrt, [k(SV, 'getLiquidity', [ID])]: liquidity });

  it('reads the check value, and the writer combines it with the Lighter primary', async () => {
    const { rpc, at } = hourChain(12, { end: slot(5n * 10n ** 20n) });
    const { prices, checks, feedUsd } = await priceHourEvm(rpc, [LIT], at, { feeds: [FEEDS.usdcUsdEth] });
    expect(prices.size).toBe(0);
    expect(feedUsd.get(FEEDS.usdcUsdEth)).toBe(1);
    const c = checks.get(LIT.ref)!;
    if (c.usd === null) throw new Error(c.reason);
    expect(c.usd).toBeCloseTo(3.3573, 6);
    const p = withCheck(LIT, { usd: 3.3562, source: 'first_party:lighter', detail: { close: 3.3562 } }, c);
    expect(p.checkGapPct).toBeCloseTo(((c.usd - 3.3562) / 3.3562) * 100, 8);
    expect(p.check).toBe('chain:v4_spot');
    expect(p.usd).toBe(3.3562);
  });

  it('zero in-range liquidity -> check skipped (checkGapPct null, skipped: zero_liquidity)', async () => {
    const { rpc, at } = hourChain(12, { end: slot(0n) });
    const { checks } = await priceHourEvm(rpc, [LIT], at);
    const c = checks.get(LIT.ref)!;
    expect(c.usd).toBeNull();
    const p = withCheck(LIT, { usd: 0.89, source: 'first_party:lighter', detail: {} }, c);
    expect(p.checkGapPct).toBeNull();
    expect(p.detail.check).toMatchObject({ skipped: 'zero_liquidity' });
  });
});

describe('bound check (sdCRV in CRV, band 0.3-1.0)', () => {
  const SD_POOL = '0xca0253a98d16e9c1e3614cafda19318ee69772d0';
  const TRICRV = '0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14';
  const run = async (sdInCrv: bigint) => {
    const end: Calls = {
      ...feed(FEEDS.crvusdUsd, 1),
      ...feed(FEEDS.usdtUsdEth, 1),
      ...feed(FEEDS.crvUsd, 0.25),
      [k('0x390f3595bca2df7d23783dfd126427cceb997bf4', 'price_oracle')]: E18,
      [k(TRICRV, 'price_oracle', [1n])]: E18 / 4n,
      [k(SD_POOL, 'price_oracle')]: sdInCrv,
    };
    const { rpc, at } = hourChain(12, { end });
    const { prices } = await priceHourEvm(rpc, [bySymbol('crvUSD'), bySymbol('CRV'), bySymbol('sdCRV')], at);
    return prices.get(ref('sdCRV'))!;
  };

  it('outside the band: the gap is the distance to the bound, in % of the bound', async () => {
    const above = await run((105n * E18) / 100n);
    expect(above.usd).toBeCloseTo(1.05 * 0.25, 12);
    expect(above.checkGapPct).toBeCloseTo(5, 8);
    expect(above.check).toBe('chain:bound:no_independent_check');
    expect((await run(E18 / 4n)).checkGapPct).toBeCloseTo(((0.25 - 0.3) / 0.3) * 100, 8);
  });

  it('inside the band: 0', async () => {
    expect((await run((6n * E18) / 10n)).checkGapPct).toBe(0);
  });
});

describe('feeds', () => {
  it('a feed answer 6.6 h old at B(H+1h) is priced, with its age in the detail (Review Focus 3)', async () => {
    const LINK = bySymbol('LINK');
    const POOL = '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8'; // LINK (0x5149..) token0, WETH (0xc02a..) token1
    const t = Math.round((Math.log(14.2 / 3000) / Math.log(1.0001)) * 3600);
    const { rpc, at } = hourChain(12, {
      end: { ...feed(FEEDS.linkUsd, 14.2, H + 3600 - 23_760), ...feed(FEEDS.ethUsdEth, 3000), ...tokens(POOL, addr('LINK'), WETH_ETH), ...observe(POOL, 0n, BigInt(t)) },
    });
    const { prices, feedUsd } = await priceHourEvm(rpc, [LINK], at, { feeds: [FEEDS.usdcUsdEth] });
    const p = prices.get(LINK.ref)!;
    expect(p.usd).toBeCloseTo(14.2, 10);
    expect(p.detail.feed_age_s).toBe(23_760);
    expect(Math.abs(p.checkGapPct!)).toBeLessThan(0.01);
    // every feed read, keyed lowercased; an extra feed that failed is simply absent
    expect([...feedUsd.keys()].sort()).toEqual([FEEDS.ethUsdEth, FEEDS.linkUsd].sort());
  });

  it('every pool method quoted through a usd_feed in prices.yaml has a known quote token', () => {
    for (const e of PRICES.values()) {
      for (const m of [e.primary, e.check]) {
        if (!['v2_twap', 'v3_twap', 'v3_spot', 'v4_spot'].includes(m.kind) || !('usd_feed' in m) || m.usd_feed === undefined) continue;
        const chainId = Number(e.ref.split('/')[0].split(':')[1]);
        expect(quoteTokenFor(chainId, m.usd_feed), `${e.symbol} ${m.kind}`).not.toBeNull();
      }
    }
  });
});

describe('Slipstream slot0 spot (the AERO check)', () => {
  it('prices AERO from the v2 TWAP and checks it against slot0 x USDC/USD', async () => {
    const AERO = bySymbol('AERO');
    const POOL = '0xf634058dc94e6bf8e828e27621320c423bc8b18e'; // AERO (0x3f5b..) token0, USDC (0x8335..) token1
    const CL = '0xd0acf293547457fb4fe9ee32ca93e89497626816';
    const cum = (c0: bigint, c1: bigint, ts: number): Calls => ({
      [k(POOL, 'currentCumulativePrices', [], 0)]: c0,
      [k(POOL, 'currentCumulativePrices', [], 1)]: c1,
      [k(POOL, 'currentCumulativePrices', [], 2)]: BigInt(ts),
    });
    // 27.2M AERO : 15.6M USDC (aero.yaml's pool, 11-09): 0.573529 USDC per AERO.
    const rA = 27_200_000n * E18;
    const rU = 15_600_000n * 10n ** 6n;
    const sqrt = BigInt(Math.round(Math.sqrt(0.5765e-12) * 2 ** 96));
    const { rpc, at } = hourChain(2, {
      start: cum(0n, 0n, H),
      end: { ...feed(FEEDS.usdcUsdBase, 1), ...tokens(POOL, addr('AERO'), USDC_BASE), ...tokens(CL, addr('AERO'), USDC_BASE), ...cum(rA * 3600n, rU * 3600n, H + 3600), [k(CL, 'slot0', [], 0)]: sqrt },
    });
    const p = (await priceHourEvm(rpc, [AERO], at)).prices.get(AERO.ref)!;
    expect(p.usd).toBeCloseTo(15.6 / 27.2, 10);
    expect(p.check).toBe('chain:v3_spot');
    expect(p.checkGapPct).toBeCloseTo(((0.5765 - 15.6 / 27.2) / (15.6 / 27.2)) * 100, 4);
  });
});
