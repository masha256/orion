import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { ADAPTER_SOURCE_TYPES } from '../../src/report/sourceTypes.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

// Generic EVM state adapters (spec 2026-11-09-orion-aero-supply-design.md §3.2, §3.4). Figures are AERO's, read live on
// Base on 2026-11-09 (block ~55.34M), scaled to round numbers where the test only needs the arithmetic.
const TOKEN = '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee';
const VE = '0xbf7977e1521e9a3032bf7243ee4712f311f13915';
const MINTER = '0x59268a34ba897e82368fee39839ffc661d4f9c97';
const MIG = '0x22a2f7340a3fb4c7c389d91ee954766b12476721';
const VMIG = '0x6dae95fe833f190640db1176f8c8a2e50c6a66c0';
const POOL = '0xf634058dc94e6bf8e828e27621320c423bc8b18e';
const CLPOOL = '0xd0acf293547457fb4fe9ee32ca93e89497626816';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FEED = '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b';
const NAMES: Record<string, string> = { token: TOKEN, ve: VE, minter: MINTER, aero_migration: MIG, velo_migration: VMIG, price_pool: POOL, price_check_pool: CLPOOL, usdc: USDC, usdc_usd_feed: FEED };
const contract = (name: string) => NAMES[name] ?? (() => { throw new Error(`no contract ${name}`); })();

const E18 = 10n ** 18n;
const GENESIS = 1_792_000_000;
const LATEST = 1_000_000n; // 2 s blocks: the run block is at 1_794_000_000 (2026-11-07T21:20Z)
const NOW_TS = GENESIS + 2 * Number(LATEST);
const WEEK_AGO_BLOCK = BigInt((NOW_TS - 7 * 86_400 - GENESIS) / 2);

async function ctxWith(calls: Record<string, bigint | Error>, earlier: Record<string, bigint | Error> = {}) {
  const rpc = fakeRpc({ genesisTs: GENESIS, latest: LATEST, calls, callsAt: (n) => (n < LATEST ? earlier : undefined) });
  return { ctx: sourceCtx({ rpc, block: await rpc.latestBlock(), contract }), rpc };
}
const run = async (name: string, params: Record<string, unknown>, calls: Record<string, bigint | Error>, earlier: Record<string, bigint | Error> = {}) => {
  const { ctx } = await ctxWith(calls, earlier);
  const v = await getAdapter(name).run(ctx, params);
  if (v.kind !== 'level') throw new Error(`expected a level, got ${v.kind}`);
  return v;
};

describe('generic EVM adapters', () => {
  it('are registered, need the chain, and sit on the contract-state rung', () => {
    const names = ['chain.counter_rate', 'chain.view_sum', 'chain.v2_pool_twap_price', 'chain.cl_pool_spot_price'];
    expect(adapterNames()).toEqual(expect.arrayContaining(names));
    for (const n of names) {
      expect(getAdapter(n).needsRpc, n).toBe(true);
      expect(ADAPTER_SOURCE_TYPES[n], n).toBe('contract_state');
      expect(getAdapter(n).paramsDoc, n).toBeTruthy();
    }
  });
});

describe('chain.counter_rate', () => {
  const minted = { contract: 'minter', function: 'emissionsMinted', direction: 'rise', days: 7 };

  it('annualizes the rise of a cumulative counter between the run block and the block `days` earlier', async () => {
    const v = await run('chain.counter_rate', minted, { [callKey(MINTER, 'emissionsMinted')]: 10_000_000n * E18 }, { [callKey(MINTER, 'emissionsMinted')]: 3_000_000n * E18 });
    expect(v.value).toBeCloseTo((7_000_000 / 7) * 365, 3);
    expect(v.source).toBe('onchain');
    expect(v.observedAt).toBe(new Date(NOW_TS * 1000).toISOString());
    expect(v.detail).toContain(`block ${WEEK_AGO_BLOCK}`);
    expect(v.detail).toContain(`block ${LATEST}`);
  });

  it('adds a share read live (the Minter team rate, pips of 1e6) on top', async () => {
    const v = await run(
      'chain.counter_rate',
      { ...minted, plus_share: { contract: 'minter', function: 'teamRate', denominator: 1_000_000 } },
      { [callKey(MINTER, 'emissionsMinted')]: 10_000_000n * E18, [callKey(MINTER, 'teamRate')]: 50_000n },
      { [callKey(MINTER, 'emissionsMinted')]: 3_000_000n * E18 },
    );
    expect(v.value).toBeCloseTo(365_000_000 * 1.05, 2);
  });

  it('clamps the window to not_before and annualizes over the days actually elapsed', async () => {
    const notBefore = NOW_TS - 500_000; // 5.787 days before the run block
    const v = await run(
      'chain.counter_rate',
      { ...minted, days: 91, not_before: new Date(notBefore * 1000).toISOString() },
      { [callKey(MINTER, 'emissionsMinted')]: 10_000_000n * E18 },
      { [callKey(MINTER, 'emissionsMinted')]: 0n },
    );
    expect(v.value).toBeCloseTo((10_000_000 / (500_000 / 86_400)) * 365, 2);
    expect(v.detail).toContain(`block ${(notBefore - GENESIS) / 2}`);
  });

  it('measures a draining balance with direction fall (an upgrade reserve), with args resolved as contract names', async () => {
    const p = { contract: 'token', function: 'balanceOf', args: ['aero_migration'], direction: 'fall', days: 7, refuse_if_supply_falls: 'token' };
    const now = { [callKey(TOKEN, 'balanceOf', [MIG])]: 385_000_000n * E18, [callKey(TOKEN, 'totalSupply')]: 2_137_000_000n * E18 };
    const then = { [callKey(TOKEN, 'balanceOf', [MIG])]: 900_000_000n * E18, [callKey(TOKEN, 'totalSupply')]: 2_132_000_000n * E18 };
    const v = await run('chain.counter_rate', p, now, then);
    expect(v.value).toBeCloseTo((515_000_000 / 7) * 365, 2);
  });

  it('refuses a fall in the token supply when guarded (a burn of the reserve is not a release)', async () => {
    const p = { contract: 'token', function: 'balanceOf', args: ['aero_migration'], direction: 'fall', days: 7, refuse_if_supply_falls: 'token' };
    const now = { [callKey(TOKEN, 'balanceOf', [MIG])]: 0n, [callKey(TOKEN, 'totalSupply')]: 1_752_000_000n * E18 };
    const then = { [callKey(TOKEN, 'balanceOf', [MIG])]: 385_000_000n * E18, [callKey(TOKEN, 'totalSupply')]: 2_137_000_000n * E18 };
    await expect(run('chain.counter_rate', p, now, then)).rejects.toThrow(/supply fell/);
  });

  it('refuses a move against its direction, and a window under one day', async () => {
    await expect(run('chain.counter_rate', minted, { [callKey(MINTER, 'emissionsMinted')]: 1n * E18 }, { [callKey(MINTER, 'emissionsMinted')]: 2n * E18 })).rejects.toThrow(/fell/);
    const p = { ...minted, days: 91, not_before: new Date((NOW_TS - 3_600) * 1000).toISOString() };
    await expect(run('chain.counter_rate', p, { [callKey(MINTER, 'emissionsMinted')]: 1n * E18 }, { [callKey(MINTER, 'emissionsMinted')]: 0n })).rejects.toThrow(/less than one day/);
  });

  it('validates its params, refusing unknown keys', () => {
    const v = getAdapter('chain.counter_rate').validateParams!;
    expect(v(minted)).toEqual([]);
    expect(v({ ...minted, direction: 'up' })).not.toEqual([]);
    expect(v({ ...minted, days: 0 })).not.toEqual([]);
    expect(v({ ...minted, not_before: 'yesterday' })).not.toEqual([]);
    expect(v({ ...minted, plus_share: { contract: 'minter', function: 'teamRate' } })).not.toEqual([]);
    expect(v({ ...minted, dayz: 7 })).toEqual(['unknown param "dayz"']);
    expect(v({ function: 'x', direction: 'rise', days: 1 })).not.toEqual([]);
  });
});

describe('chain.view_sum', () => {
  const liquid = {
    terms: [
      { contract: 'token', function: 'totalSupply' },
      { contract: 've', function: 'supply', sign: -1 },
      { contract: 'token', function: 'balanceOf', args: ['aero_migration'], sign: -1 },
      { contract: 'token', function: 'balanceOf', args: ['velo_migration'], sign: -1 },
    ],
  };
  const live = {
    [callKey(TOKEN, 'totalSupply')]: 2_137_656_188_139_846_600_000_000_000n,
    [callKey(VE, 'supply')]: 1_061_419_067_554_911_400_000_000_000n,
    [callKey(TOKEN, 'balanceOf', [MIG])]: 357_376_144_656_026_700_000_000_000n,
    [callKey(TOKEN, 'balanceOf', [VMIG])]: 27_713_949_955_370_836_000_000_000n,
  };

  it('sums signed views in one multicall (liquid AERO = total - sAERO - the two upgrade reserves)', async () => {
    const { ctx, rpc } = await ctxWith(live);
    const v = await getAdapter('chain.view_sum').run(ctx, liquid);
    expect(v.kind === 'level' && v.value).toBeCloseTo(691_147_025.97, 1);
    expect(rpc.stats.multicall).toBe(1);
  });

  it('scales and adds a share (the Minter ceiling: baseRate a second x a year x (1 + team))', async () => {
    const v = await run(
      'chain.view_sum',
      { terms: [{ contract: 'minter', function: 'baseRate' }], scale: 31_536_000, plus_share: { contract: 'minter', function: 'teamRate', denominator: 1_000_000 } },
      { [callKey(MINTER, 'baseRate')]: 13_489_345_000_000_000_000n, [callKey(MINTER, 'teamRate')]: 50_000n },
    );
    expect(v.value).toBeCloseTo(13.489345 * 31_536_000 * 1.05, 2);
  });

  it('refuses a negative sum and bad params', async () => {
    await expect(run('chain.view_sum', liquid, { ...live, [callKey(VE, 'supply')]: 3_000_000_000n * E18 })).rejects.toThrow(/negative/);
    const v = getAdapter('chain.view_sum').validateParams!;
    expect(v(liquid)).toEqual([]);
    expect(v({ terms: [] })).not.toEqual([]);
    expect(v({ terms: [{ contract: 'token', function: 'totalSupply', sign: 2 }] })).not.toEqual([]);
    expect(v({ terms: [{ contract: 'token', function: 'totalSupply', extra: 1 }] })).not.toEqual([]);
    expect(v({ ...liquid, scale: -1 })).not.toEqual([]);
  });
});

describe('chain.v2_pool_twap_price', () => {
  // An Aero basic pool's cumulative reserves (currentCumulativePrices) at the run block and an hour earlier: the time-weighted
  // reserves are 27.23M AERO (token0, 18 decimals) and 15.57M USDC (token1, 6 decimals). USDC/USD from Chainlink, 8 decimals.
  const R0 = 27_230_000n * E18;
  const R1 = 15_570_000n * 10n ** 6n;
  const twap = { pool: 'price_pool', token: 'token', quote_decimals: 6, seconds: 3600, usd_feed: 'usdc_usd_feed' };
  const cum = (ts: number, k: bigint) => ({
    [`${callKey(POOL, 'currentCumulativePrices')}[0]`]: 5n * E18 + R0 * k,
    [`${callKey(POOL, 'currentCumulativePrices')}[1]`]: 7n + R1 * k,
    [`${callKey(POOL, 'currentCumulativePrices')}[2]`]: BigInt(ts),
  });
  const now = { ...cum(NOW_TS, 3600n), [callKey(POOL, 'token0')]: BigInt(TOKEN), [callKey(POOL, 'token1')]: BigInt(USDC), [callKey(FEED, 'latestAnswer')]: 99_975_857n };

  it('prices the token from the time-weighted reserves, in USD through the feed', async () => {
    const v = await run('chain.v2_pool_twap_price', twap, now, cum(NOW_TS - 3600, 0n));
    expect(v.value).toBeCloseTo((15_570_000 / 27_230_000) * 0.99975857, 10);
    expect(v.detail).toMatch(/twap 3600 s/);
  });

  it('inverts when the token is token1, and refuses a pool without the token', async () => {
    const swapped = { ...now, [callKey(POOL, 'token0')]: BigInt(USDC), [callKey(POOL, 'token1')]: BigInt(TOKEN) };
    const v = await run('chain.v2_pool_twap_price', { ...twap, token_decimals: 6, quote_decimals: 18 }, swapped, cum(NOW_TS - 3600, 0n));
    // token0 is now the quote (18 decimals per the params) and token1 the priced token (6): quote reserve / token reserve
    expect(v.value).toBeCloseTo((27_230_000 / 15_570_000) * 0.99975857, 8);
    const other = { ...now, [callKey(POOL, 'token0')]: 1n, [callKey(POOL, 'token1')]: BigInt(USDC) };
    await expect(run('chain.v2_pool_twap_price', twap, other, cum(NOW_TS - 3600, 0n))).rejects.toThrow(/does not hold/);
  });

  it('refuses a non-positive feed answer and a window with no elapsed time', async () => {
    await expect(run('chain.v2_pool_twap_price', twap, { ...now, [callKey(FEED, 'latestAnswer')]: 0n }, cum(NOW_TS - 3600, 0n))).rejects.toThrow(/feed/);
    await expect(run('chain.v2_pool_twap_price', twap, now, cum(NOW_TS, 3600n))).rejects.toThrow(/elapsed/);
    const v = getAdapter('chain.v2_pool_twap_price').validateParams!;
    expect(v(twap)).toEqual([]);
    expect(v({ ...twap, seconds: 10 })).not.toEqual([]);
    expect(v({ ...twap, quote_decimals: undefined })).not.toEqual([]);
  });
});

describe('chain.cl_pool_spot_price', () => {
  const spot = { pool: 'price_check_pool', token: 'token', quote_decimals: 6, usd_feed: 'usdc_usd_feed' };
  // sqrtPriceX96 for 0.5699 USDC (6 decimals) per AERO (18 decimals): raw price = 0.5699e6 / 1e18.
  const sqrt = BigInt(Math.round(Math.sqrt(0.5699e-12) * 2 ** 96));
  const live = { [`${callKey(CLPOOL, 'slot0')}[0]`]: sqrt, [callKey(CLPOOL, 'token0')]: BigInt(TOKEN), [callKey(CLPOOL, 'token1')]: BigInt(USDC), [callKey(FEED, 'latestAnswer')]: 99_975_857n };

  it('prices the token from slot0 at the run block, in USD through the feed', async () => {
    const v = await run('chain.cl_pool_spot_price', spot, live);
    expect(v.value).toBeCloseTo(0.5699 * 0.99975857, 8);
  });

  it('inverts for token1 and refuses a pool without the token', async () => {
    const v = await run('chain.cl_pool_spot_price', { ...spot, token_decimals: 6, quote_decimals: 18 }, { ...live, [callKey(CLPOOL, 'token0')]: BigInt(USDC), [callKey(CLPOOL, 'token1')]: BigInt(TOKEN) });
    expect(v.value).toBeCloseTo((1 / 0.5699) * 0.99975857, 6);
    await expect(run('chain.cl_pool_spot_price', spot, { ...live, [callKey(CLPOOL, 'token0')]: 1n })).rejects.toThrow(/does not hold/);
  });
});
