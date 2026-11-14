import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbHourBlocks } from '../../src/db/hourBlocks.js';
import { upsertPrices, upsertToken } from '../../src/db/prices.js';
import type { BlockRef, RpcTransport } from '../../src/ingest/transport/rpc.js';
import { loadPrices, type PriceEntry } from '../../src/prices/config.js';
import { withCheck } from '../../src/prices/evmMethods.js';
import type { PriceDeps } from '../../src/prices/types.js';
import { findHourBlock, makePriceDeps, PRICE_CHAIN_METHODS, writeChainPrices, type PriceChainMethod } from '../../src/prices/writer.js';
import { useTestDb } from '../helpers/db.js';
import { callKey, fakeRpc, type FakeRpc } from '../helpers/fakeRpc.js';

// Phase 3 R2 Task 3: the resumable chain price writer. Base's block-time switch (base-bnb.md, measured): the last 2 s
// block is 53,556,127 (2026-11-05T18:00:01Z), ts = 1,686,789,347 + 2n before it; from 53,556,128 blocks are 0.2 s
// apart sharing integer-second timestamps, ts = 1,793,901,601 + floor((n - 53,556,128) / 5). Prices: VVV 19.4017-ish
// (base-bnb.md), cvxCRV 0.41377 CRV (wrappers.md), LIT 3.3573 (hype-lit-pump.md); ETH 3,000 and stables 1 as round quotes.

const testDb = useTestDb();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRICES = loadPrices(ROOT);
const bySymbol = (s: string): PriceEntry => {
  const e = [...PRICES.values()].find((x) => x.symbol === s);
  if (!e) throw new Error(`no ${s} in prices.yaml`);
  return e;
};
const addrOf = (e: PriceEntry) => e.ref.split('/')[1]!;
const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const E18 = 10n ** 18n;

type Calls = Record<string, bigint | Error>;
const k = (address: string, fn: string, args: readonly unknown[] = [], pick?: number) => callKey(address, fn, args) + (pick === undefined ? '' : `[${pick}]`);
const feed = (address: string, usd: number, updatedAt: number): Calls => ({
  [k(address, 'latestRoundData', [], 1)]: BigInt(Math.round(usd * 1e8)),
  [k(address, 'latestRoundData', [], 3)]: BigInt(updatedAt),
});

const unwired = new Proxy({}, { get: () => () => Promise.reject(new Error('not wired in this test')) });
function deps(rpcs: Record<string, RpcTransport>, now: string): PriceDeps {
  return {
    rpcFor: (chain) => {
      const r = rpcs[chain];
      if (!r) throw new Error(`no fake rpc for ${chain}`);
      return r;
    },
    solana: unwired as PriceDeps['solana'],
    http: unwired as PriceDeps['http'],
    now: new Date(now),
    prices: PRICES,
  };
}

// ---- Base around the 0.2 s switch -----------------------------------------------------------------------------------

const SWITCH = 53_556_128n;
const baseTs = (n: bigint): number => (n < SWITCH ? 1_686_789_347 + 2 * Number(n) : 1_793_901_601 + Math.floor(Number(n - SWITCH) / 5));
/** The first Base block at or after `t` (unix seconds), closed form on either side of the switch. */
const baseBlockAt = (t: number): bigint => (t <= 1_793_901_601 ? BigInt(Math.ceil((t - 1_686_789_347) / 2)) : SWITCH + BigInt(5 * (t - 1_793_901_601)));
const B = (isoHour: string) => baseBlockAt(at(isoHour) / 1000);

const VVV = bySymbol('VVV');
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ETH_USD_BASE = '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70';
const USDC_USD_BASE = '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b';
const VVV_POOL = (VVV.primary as { pool: string }).pool.toLowerCase();
const VVV_CHECK_POOL = (VVV.check as { pool: string }).pool.toLowerCase();
// VVV/WETH reserves 1,000,000 : 6,467 (both 18 decimals) x ETH 3,000 = 19.401 USD; the v3 check at the tick for 19.40 USDC.
const R0 = 1_000_000n * E18;
const R1 = 6_467n * E18;
const VVV_USD = (6_467 / 1_000_000) * 3_000;
const TICK = BigInt(Math.round(Math.log(1e12 / 19.4) / Math.log(1.0001)));

function vvvCallsAt(n: bigint): Calls {
  const t = baseTs(n);
  const T = BigInt(t);
  return {
    [k(VVV_POOL, 'token0')]: BigInt(addrOf(VVV)),
    [k(VVV_POOL, 'token1')]: BigInt(WETH_BASE),
    [k(VVV_POOL, 'currentCumulativePrices', [], 0)]: R0 * T,
    [k(VVV_POOL, 'currentCumulativePrices', [], 1)]: R1 * T,
    [k(VVV_POOL, 'currentCumulativePrices', [], 2)]: T,
    [k(VVV_CHECK_POOL, 'token0')]: BigInt(USDC_BASE),
    [k(VVV_CHECK_POOL, 'token1')]: BigInt(addrOf(VVV)),
    [k(VVV_CHECK_POOL, 'observe', [[3600, 0]], 3)]: TICK * (T - 3600n),
    [k(VVV_CHECK_POOL, 'observe', [[3600, 0]], 4)]: TICK * T,
    ...feed(ETH_USD_BASE, 3_000, t - 60),
    ...feed(USDC_USD_BASE, 1, t - 60),
  };
}

function baseChain(headIso: string): FakeRpc {
  return fakeRpc({ genesisTs: 1_686_789_347, latest: B(headIso), blockTimeSec: 0.2, timestampOf: baseTs, callsAt: vvvCallsAt });
}

async function rows(ref?: string) {
  const got = await testDb().all<{ token_ref: string; ts: string; price_usd: number; source: string; check_gap_pct: number | null; check: string | null; detail: Record<string, unknown> | null }>(
    `SELECT token_ref, ts, price_usd, source, check_gap_pct, "check", detail FROM prices ${ref ? 'WHERE token_ref = $1' : ''} ORDER BY token_ref, ts, source`,
    ref ? [ref] : [],
  );
  return got.map((r) => ({ ...r, ts: iso(new Date(r.ts).getTime()) }));
}

describe('hour blocks (Review Focus 1): Base on both sides of the 0.2 s switch', () => {
  const HOURS = ['2026-11-05T16:00:00Z', '2026-11-05T17:00:00Z', '2026-11-05T18:00:00Z', '2026-11-05T19:00:00Z', '2026-11-05T20:00:00Z', '2026-11-05T21:00:00Z'];

  it('the closed form is the measured switch: B(18:00Z) is the last 2 s block, 53,556,127', () => {
    expect(B('2026-11-05T18:00:00Z')).toBe(53_556_127n);
    expect(baseTs(53_556_126n)).toBe(1_793_901_599);
    expect(baseTs(53_556_128n)).toBe(1_793_901_601);
    expect(B('2026-11-05T19:00:00Z')).toBe(53_574_123n);
  });

  it('findHourBlock walks back from the previous hour\'s block: the first block at or after each hour, <= 4 getBlock each', async () => {
    const rpc = baseChain('2026-11-06T02:00:00Z');
    const known = new Map<string, BlockRef>();
    const b21 = B(HOURS[5]!);
    known.set(HOURS[5]!, { number: b21, timestamp: baseTs(b21) });
    for (let i = 4; i >= 0; i--) {
      const newer = known.get(HOURS[i + 1]!)!;
      const newer2 = known.get(HOURS[i + 2] ?? '');
      const rate = newer2 ? (newer2.timestamp - newer.timestamp) / Number(newer2.number - newer.number) : 0.2;
      const before = rpc.stats.getBlock;
      const got = await findHourBlock(rpc, at(HOURS[i]!) / 1000, newer, rate, newer);
      expect(got.number, HOURS[i]).toBe(B(HOURS[i]!));
      expect(got.timestamp).toBe(baseTs(got.number));
      expect(rpc.stats.getBlock - before, HOURS[i]).toBeLessThanOrEqual(4);
      known.set(HOURS[i]!, got);
    }
  });

  it('findHourBlock finds the first block after a chain halt (hours inside the halt share it)', async () => {
    // Ethereum-like 12 s blocks with a 3 h 10 min halt after block 1,000 (ts T0 + 12,000).
    const T0 = at('2026-11-10T00:00:00Z') / 1000 - 12_000;
    const ts = (n: bigint) => (n <= 1_000n ? T0 + 12 * Number(n) : T0 + 12 * Number(n) + 11_400);
    const rpc = fakeRpc({ genesisTs: T0, latest: 5_000n, blockTimeSec: 12, timestampOf: ts });
    const truth = (t: number) => {
      let lo = 0n;
      let hi = 5_000n;
      while (lo < hi) {
        const m = (lo + hi) / 2n;
        if (ts(m) >= t) hi = m;
        else lo = m + 1n;
      }
      return hi;
    };
    let newer: BlockRef = { number: truth(at('2026-11-10T05:00:00Z') / 1000), timestamp: 0 };
    newer = { ...newer, timestamp: ts(newer.number) };
    for (const h of ['04', '03', '02', '01', '00']) {
      const t = at(`2026-11-10T${h}:00:00Z`) / 1000;
      const got = await findHourBlock(rpc, t, newer, 12, newer);
      expect(got.number, h).toBe(truth(t));
      newer = got;
    }
    expect(truth(at('2026-11-10T01:00:00Z') / 1000)).toBe(truth(at('2026-11-10T03:00:00Z') / 1000)); // inside the halt
  });

  it('the writer prices 16:00Z..20:00Z at B(H+1h) with the TWAP from B(H): exact blocks, <= 4 getBlock per hour, N+1 multicalls', async () => {
    const rpc = baseChain('2026-11-06T02:00:00Z');
    await dbHourBlocks(testDb(), 8453).put(at(HOURS[5]!), { number: B(HOURS[5]!), timestamp: baseTs(B(HOURS[5]!)) });
    const r = await writeChainPrices(testDb(), deps({ 'eip155:8453': rpc }, '2026-11-06T02:00:00Z'), [VVV.ref], at(HOURS[0]!), at(HOURS[5]!));
    expect(r.written).toEqual({ [VVV.ref]: 5 });
    expect(r.missing).toEqual([]);
    expect(r.stoppedByBudget).toBe(false);
    expect(r.reachedMs).toBe(at(HOURS[0]!));
    // B(21:00) came from hour_blocks; the five searches walk back from the previous hour's block.
    expect(rpc.stats.getBlock).toBeLessThanOrEqual(4 * 5);
    // One multicall at each hour's end block, plus B(16:00) for the oldest TWAP start: 5 hours -> 6, not 10.
    expect(rpc.stats.multicall).toBe(6);
    expect(r.calls['eip155:8453']).toBe(rpc.stats.multicall + rpc.stats.getBlock + 1); // + the one latestBlock
    const got = await rows(VVV.ref);
    expect(got.map((x) => x.ts)).toEqual(HOURS.slice(0, 5).map((h) => iso(at(h))));
    got.forEach((x, i) => {
      expect(x.source).toBe('chain:v2_twap');
      expect(x.price_usd).toBeCloseTo(VVV_USD, 9);
      expect(x.detail!.block, x.ts).toBe(String(B(HOURS[i + 1]!)));
      expect(x.detail!.start_block, x.ts).toBe(String(B(HOURS[i]!)));
      expect(x.check).toBe('chain:v3_twap');
      expect(Math.abs(x.check_gap_pct!)).toBeLessThan(0.05);
    });
    // Every searched hour is cached for the next run (all are > 1 h below the head).
    const cached = await testDb().all<{ hour: string; block: number }>('SELECT hour, block FROM hour_blocks WHERE chain_id = 8453 ORDER BY hour');
    expect(cached.map((c) => [iso(new Date(c.hour).getTime()), BigInt(c.block)])).toEqual(HOURS.map((h) => [iso(at(h)), B(h)]));
  });

  it('an hour whose H+1h is after the head writes nothing (no_block_yet); a block within an hour of the head is not cached', async () => {
    const rpc = baseChain('2026-11-05T20:30:00Z');
    const r = await writeChainPrices(testDb(), deps({ 'eip155:8453': rpc }, '2026-11-05T21:30:00Z'), [VVV.ref], at(HOURS[3]!), at(HOURS[5]!));
    expect(r.missing).toEqual([{ ref: VVV.ref, hourMs: at(HOURS[4]!), reason: 'no_block_yet' }]);
    expect(r.written).toEqual({ [VVV.ref]: 1 });
    expect((await rows(VVV.ref)).map((x) => x.ts)).toEqual([iso(at(HOURS[3]!))]);
    const cached = await testDb().all<{ hour: string }>('SELECT hour FROM hour_blocks ORDER BY hour');
    expect(cached.map((c) => iso(new Date(c.hour).getTime()))).toEqual([iso(at(HOURS[3]!))]); // 20:00Z is 30 min below the head
  });

  it('idempotent: a second run writes 0 rows and makes no RPC call; a CoinGecko row at the hour is not the chain source', async () => {
    await upsertToken(testDb(), { tokenRef: VVV.ref, symbol: 'VVV', decimals: 18, coingeckoId: 'venice-token' });
    await upsertPrices(testDb(), VVV.ref, 'coingecko', [{ ts: iso(at(HOURS[0]!)), priceUsd: 19 }], '2026-11-05T17:00:00Z');
    const rpc = baseChain('2026-11-06T02:00:00Z');
    const d = deps({ 'eip155:8453': rpc }, '2026-11-06T02:00:00Z');
    const first = await writeChainPrices(testDb(), d, [VVV.ref], at(HOURS[0]!), at(HOURS[5]!));
    expect(first).toMatchObject({ written: { [VVV.ref]: 5 }, skippedExisting: 0 });
    const calls = { ...rpc.stats };
    const second = await writeChainPrices(testDb(), d, [VVV.ref], at(HOURS[0]!), at(HOURS[5]!));
    expect(second).toMatchObject({ written: { [VVV.ref]: 0 }, skippedExisting: 5, missing: [], breaches: [], stoppedByBudget: false, reachedMs: at(HOURS[0]!) });
    expect(rpc.stats.multicall).toBe(calls.multicall);
    expect(rpc.stats.getBlock).toBe(calls.getBlock);
    expect((await rows(VVV.ref)).filter((x) => x.ts === iso(at(HOURS[0]!))).map((x) => x.source)).toEqual(['chain:v2_twap', 'coingecko']);
  });

  it('budget: budgetMs 0 stops after the first chain-day (newest first); a re-run resumes with the older day', async () => {
    const rpc = baseChain('2026-11-06T02:00:00Z');
    const d = deps({ 'eip155:8453': rpc }, '2026-11-06T02:00:00Z');
    const from = at('2026-11-04T00:00:00Z');
    const to = at('2026-11-06T00:00:00Z');
    const r = await writeChainPrices(testDb(), d, [VVV.ref], from, to, { budgetMs: 0 });
    expect(r).toMatchObject({ stoppedByBudget: true, written: { [VVV.ref]: 24 }, reachedMs: at('2026-11-05T00:00:00Z') });
    const days = await testDb().all<{ day: string; n: number }>("SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n FROM prices GROUP BY 1 ORDER BY 1");
    expect(days).toEqual([{ day: '2026-11-05', n: 24 }]);
    // 24 hours of one chain-day in one pass: 25 multicalls (the cache carries B(H) into the older hour).
    expect(rpc.stats.multicall).toBe(25);
    const again = await writeChainPrices(testDb(), d, [VVV.ref], from, to, { budgetMs: 60_000 });
    expect(again).toMatchObject({ stoppedByBudget: false, written: { [VVV.ref]: 24 }, skippedExisting: 24, reachedMs: from });
    expect((await rows(VVV.ref)).length).toBe(48);
  });

  it('an aborted signal stops before the next chain-day', async () => {
    const rpc = baseChain('2026-11-06T02:00:00Z');
    const ac = new AbortController();
    ac.abort();
    const r = await writeChainPrices(testDb(), deps({ 'eip155:8453': rpc }, '2026-11-06T02:00:00Z'), [VVV.ref], at('2026-11-05T00:00:00Z'), at('2026-11-06T00:00:00Z'), { signal: ac.signal });
    expect(r).toMatchObject({ written: { [VVV.ref]: 0 }, reachedMs: null, stoppedByBudget: false, stoppedBySignal: true });
    expect(rpc.stats.multicall).toBe(0);
  });

  it('a signal aborted inside a multicall stops at the next hour: nothing of that chain-day is committed, no further read', async () => {
    const rpc = baseChain('2026-11-06T02:00:00Z');
    const ac = new AbortController();
    const inner = rpc.multicall.bind(rpc);
    let after: { multicall: number; getBlock: number } | null = null;
    rpc.multicall = async (calls, block) => {
      const out = await inner(calls, block);
      // The 3rd multicall is the second hour's only read (the first hour reads B(H+1h) and B(H)).
      if (rpc.stats.multicall === 3) {
        ac.abort();
        after = { multicall: rpc.stats.multicall, getBlock: rpc.stats.getBlock };
      }
      return out;
    };
    const r = await writeChainPrices(testDb(), deps({ 'eip155:8453': rpc }, '2026-11-06T02:00:00Z'), [VVV.ref], at('2026-11-04T00:00:00Z'), at('2026-11-06T00:00:00Z'), { signal: ac.signal });
    expect(r).toMatchObject({ written: { [VVV.ref]: 0 }, reachedMs: null, stoppedByBudget: false, stoppedBySignal: true, breaches: [] });
    expect(after).not.toBeNull();
    expect({ multicall: rpc.stats.multicall, getBlock: rpc.stats.getBlock }).toEqual(after);
    expect(await rows()).toEqual([]);
    expect(await testDb().all('SELECT hour FROM hour_blocks')).toEqual([]);
  });

  it('no row and no read before the ref\'s valid_from', async () => {
    const rpc = baseChain('2026-11-06T02:00:00Z');
    const r = await writeChainPrices(testDb(), deps({ 'eip155:8453': rpc }, '2026-11-06T02:00:00Z'), [VVV.ref], at('2025-10-12T22:00:00Z'), at('2025-10-13T00:00:00Z'));
    expect(r).toMatchObject({ written: { [VVV.ref]: 0 }, missing: [], skippedExisting: 0 });
    expect(rpc.stats.multicall + rpc.stats.getBlock).toBe(0);
  });
});

// ---- Ethereum: checks and breaches --------------------------------------------------------------------------------

/** A regular 12 s chain whose blocks fall on every hour: block n at T0 + 12 n. */
const T0 = at('2026-11-01T00:00:00Z') / 1000 - 12 * 100_000;
const ethBlockAt = (isoHour: string): bigint => BigInt((at(isoHour) / 1000 - T0) / 12);
function ethChain(headIso: string, callsAt: (n: bigint, t: number) => Calls): FakeRpc {
  return fakeRpc({ genesisTs: T0, latest: ethBlockAt(headIso), blockTimeSec: 12, callsAt: (n) => callsAt(n, T0 + 12 * Number(n)) });
}

const CRVUSD = bySymbol('crvUSD');
const CRV = bySymbol('CRV');
const CVXCRV = bySymbol('cvxCRV');
const SDCRV = bySymbol('sdCRV');
const lc = (s: string) => s.toLowerCase();
const crvCalls = (t: number): Calls => ({
  ...feed(lc((CRVUSD.primary as { feed: string }).feed), 1, t - 60),
  [k(lc((CRV.primary as { pool: string }).pool), 'price_oracle', [1n])]: 2_335n * 10n ** 14n, // CRV 0.2335 crvUSD
  [k(lc((CVXCRV.primary as { pool: string }).pool), 'price_oracle')]: 41_377n * 10n ** 13n, // cvxCRV 0.41377 CRV
});
/** cvxCRV's get_dy check (fee 0) at `gapPct` from its primary: get_dy(1, 0, 100) = 100 x 0.41377 x (1 + gap). */
const cvxCheck = (gapPct: number | null): Calls => {
  const pool = lc((CVXCRV.check as { pool: string }).pool);
  return {
    [k(pool, 'get_dy', [1n, 0n, 100n * E18])]: gapPct === null ? new Error('execution reverted') : BigInt(Math.round(41.377 * (1 + gapPct / 100) * 1e9)) * 10n ** 9n,
    [k(pool, 'fee')]: 0n,
  };
};

describe('breaches: |gap| > tolerance for `consecutive` hours in a row; a skipped check neither breaches nor resets', () => {
  const HOURS = ['2026-11-10T00:00:00Z', '2026-11-10T01:00:00Z', '2026-11-10T02:00:00Z'];
  /** Gaps by hour (the hour's end block is B(H+1h)). */
  const chainWithGaps = (gaps: (number | null)[]) =>
    ethChain('2026-11-11T00:00:00Z', (n, t) => {
      const i = HOURS.findIndex((h) => ethBlockAt(h) + 300n === n);
      return { ...crvCalls(t), ...cvxCheck(i >= 0 ? gaps[i]! : 0) };
    });

  it('cvxCRV (3%, consecutive 2): 3.4% then 3.5% is one breach, at the second hour; the gap and check are stored', async () => {
    const rpc = chainWithGaps([3.4, 3.5]);
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': rpc }, '2026-11-11T00:00:00Z'), [CVXCRV.ref], at(HOURS[0]!), at(HOURS[2]!));
    expect(r.written).toEqual({ [CVXCRV.ref]: 2 });
    expect(r.breaches).toHaveLength(1);
    expect(r.breaches[0]).toMatchObject({ ref: CVXCRV.ref, hourMs: at(HOURS[1]!), check: 'chain:curve_get_dy' });
    expect(r.breaches[0]!.gapPct).toBeCloseTo(3.5, 6);
    const got = await rows(CVXCRV.ref);
    expect(got.map((x) => [x.source, x.check])).toEqual([['chain:curve_oracle', 'chain:curve_get_dy'], ['chain:curve_oracle', 'chain:curve_get_dy']]);
    expect(got[0]!.check_gap_pct).toBeCloseTo(3.4, 6);
    expect(got[1]!.price_usd).toBeCloseTo(0.41377 * 0.2335, 12);
    expect(got[1]!.detail).toMatchObject({ method: 'curve_oracle', quote: { ref: CRV.ref }, check: { method: 'curve_get_dy' } });
    // Only the requested ref is written; its quotes (CRV, crvUSD) were read in the same multicall.
    expect((await rows()).every((x) => x.token_ref === CVXCRV.ref)).toBe(true);
    expect(rpc.stats.multicall).toBe(2);
  });

  it('3.4% then 0.1% is no breach', async () => {
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': chainWithGaps([3.4, 0.1]) }, '2026-11-11T00:00:00Z'), [CVXCRV.ref], at(HOURS[0]!), at(HOURS[2]!));
    expect(r.written).toEqual({ [CVXCRV.ref]: 2 });
    expect(r.breaches).toEqual([]);
  });

  it('3.4%, a skipped check (null gap), 3.5%: one breach at the third hour', async () => {
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': chainWithGaps([3.4, null, 3.5]) }, '2026-11-11T00:00:00Z'), [CVXCRV.ref], at(HOURS[0]!), at('2026-11-10T03:00:00Z'));
    expect(r.written).toEqual({ [CVXCRV.ref]: 3 });
    expect((await rows(CVXCRV.ref))[1]).toMatchObject({ check_gap_pct: null, detail: { check: { skipped: 'call_failed' } } });
    expect(r.breaches.map((b) => b.hourMs)).toEqual([at(HOURS[2]!)]);
  });

  it('a run across midnight is one breach: 3.5% at 23:00, 00:00 and 01:00 in one writer run -> one breach, at 00:00', async () => {
    const bad = ['2026-11-09T23:00:00Z', '2026-11-10T00:00:00Z', '2026-11-10T01:00:00Z'];
    const rpc = ethChain('2026-11-11T00:00:00Z', (n, t) => ({ ...crvCalls(t), ...cvxCheck(bad.some((h) => ethBlockAt(h) + 300n === n) ? 3.5 : 0) }));
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': rpc }, '2026-11-11T00:00:00Z'), [CVXCRV.ref], at('2026-11-09T22:00:00Z'), at('2026-11-10T03:00:00Z'));
    expect(r.written).toEqual({ [CVXCRV.ref]: 5 });
    expect(r.breaches.map((b) => [b.ref, iso(b.hourMs)])).toEqual([[CVXCRV.ref, iso(at('2026-11-10T00:00:00Z'))]]);
  });

  it('an hour with no row resets the run: 3.4% stored at 00:00, no row at 01:00, 3.5% written at 02:00 -> no breach', async () => {
    await upsertToken(testDb(), { tokenRef: CVXCRV.ref, symbol: 'cvxCRV', decimals: 18, coingeckoId: null });
    await upsertPrices(testDb(), CVXCRV.ref, 'chain:curve_oracle', [{ ts: iso(at(HOURS[0]!)), priceUsd: 0.0966, checkGapPct: 3.4, check: 'chain:curve_get_dy', detail: {} }], '2026-11-10T01:00:00Z');
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': chainWithGaps([3.4, 3.5, 3.5]) }, '2026-11-11T00:00:00Z'), [CVXCRV.ref], at(HOURS[2]!), at('2026-11-10T03:00:00Z'));
    expect(r.written).toEqual({ [CVXCRV.ref]: 1 });
    expect((await rows(CVXCRV.ref)).map((x) => x.ts)).toEqual([iso(at(HOURS[0]!)), iso(at(HOURS[2]!))]);
    expect(r.breaches).toEqual([]);
  });

  it('the run spans writer runs: 3.4% stored by one run, 3.5% by the next -> the breach is the second run\'s', async () => {
    const d = deps({ 'eip155:1': chainWithGaps([3.4, 3.5]) }, '2026-11-11T00:00:00Z');
    expect((await writeChainPrices(testDb(), d, [CVXCRV.ref], at(HOURS[0]!), at(HOURS[1]!))).breaches).toEqual([]);
    const r = await writeChainPrices(testDb(), d, [CVXCRV.ref], at(HOURS[0]!), at(HOURS[2]!));
    expect(r.written).toEqual({ [CVXCRV.ref]: 1 });
    expect(r.breaches.map((b) => [b.ref, b.hourMs])).toEqual([[CVXCRV.ref, at(HOURS[1]!)]]);
  });

  it('a bound check (sdCRV, no_independent_check) breaches when its gap is not 0, once per run of breaching hours', async () => {
    const pool = lc((SDCRV.primary as { pool: string }).pool);
    const inCrv = [1.2, 1.3, 0.5];
    const rpc = ethChain('2026-11-11T00:00:00Z', (n, t) => {
      const i = HOURS.findIndex((h) => ethBlockAt(h) + 300n === n);
      return { ...crvCalls(t), [k(pool, 'price_oracle')]: BigInt(Math.round((inCrv[i] ?? 0.5) * 1e6)) * 10n ** 12n };
    });
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': rpc }, '2026-11-11T00:00:00Z'), [SDCRV.ref], at(HOURS[0]!), at('2026-11-10T03:00:00Z'));
    expect(r.written).toEqual({ [SDCRV.ref]: 3 });
    expect(r.breaches).toHaveLength(1);
    expect(r.breaches[0]).toMatchObject({ ref: SDCRV.ref, hourMs: at(HOURS[0]!), check: 'chain:bound:no_independent_check' });
    expect(r.breaches[0]!.gapPct).toBeCloseTo(20, 6);
    expect((await rows(SDCRV.ref)).map((x) => x.check_gap_pct)).toEqual([expect.closeTo(20, 6), expect.closeTo(30, 6), 0]);
  });
});

// ---- off-chain chains through the registry (Rulings R4, R5) -------------------------------------------------------

describe('off-chain chains: the registry, and chain 1\'s feeds handed on (R4, R5)', () => {
  const HYPE = bySymbol('HYPE');
  const LIT = bySymbol('LIT');
  const USDC_USD_ETH = '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6';
  const saved = { ...PRICE_CHAIN_METHODS };
  afterEach(() => {
    for (const key of Object.keys(PRICE_CHAIN_METHODS)) if (!(key in saved)) delete PRICE_CHAIN_METHODS[key];
    Object.assign(PRICE_CHAIN_METHODS, saved);
  });
  const HOURS = ['2026-11-10T00:00:00Z', '2026-11-10T01:00:00Z', '2026-11-10T02:00:00Z'];

  it('HYPE: priced by its chain\'s method with chain 1\'s USDC/USD of the same hour; a failed feed read gives quote_missing', async () => {
    const seen: { hourMs: number; usdc: number | undefined }[] = [];
    const fake: PriceChainMethod = vi.fn<PriceChainMethod>(async (_deps, entries, hour, ctx) => {
      expect(entries.map((e) => e.ref)).toEqual([HYPE.ref]);
      expect(hour.blocks).toBeNull();
      const usdc = ctx.feedUsd?.get(USDC_USD_ETH);
      seen.push({ hourMs: hour.hourMs, usdc });
      return { prices: new Map([[HYPE.ref, { usd: 40 * usdc!, source: 'first_party:hyperliquid', checkGapPct: 0.1, check: 'first_party:hyperliquid:same_venue', detail: { close: 40 } }]]), missing: [] };
    });
    PRICE_CHAIN_METHODS.hyperliquid = fake;
    const rpc = ethChain('2026-11-11T00:00:00Z', (n, t) => (n === ethBlockAt(HOURS[1]!) + 300n ? { [k(USDC_USD_ETH, 'latestRoundData', [], 1)]: new Error('execution reverted') } : feed(USDC_USD_ETH, 0.9998, t - 60)));
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': rpc }, '2026-11-11T00:00:00Z'), [HYPE.ref], at(HOURS[0]!), at('2026-11-10T03:00:00Z'));
    expect(r.written).toEqual({ [HYPE.ref]: 2 });
    expect(r.missing).toEqual([{ ref: HYPE.ref, hourMs: at(HOURS[1]!), reason: 'quote_missing' }]);
    expect(seen).toEqual([{ hourMs: at(HOURS[2]!), usdc: 0.9998 }, { hourMs: at(HOURS[0]!), usdc: 0.9998 }]);
    // Chain 1 read only the feed, once per hour (no TWAP: no B(H) read).
    expect(rpc.stats.multicall).toBe(3);
    const got = await rows(HYPE.ref);
    expect(got.map((x) => [x.ts, x.source, x.check, x.check_gap_pct])).toEqual([
      [iso(at(HOURS[0]!)), 'first_party:hyperliquid', 'first_party:hyperliquid:same_venue', 0.1],
      [iso(at(HOURS[2]!)), 'first_party:hyperliquid', 'first_party:hyperliquid:same_venue', 0.1],
    ]);
    expect(got[0]!.price_usd).toBeCloseTo(40 * 0.9998, 12);
    expect(await testDb().one('SELECT symbol, decimals FROM tokens WHERE token_ref = $1', [HYPE.ref])).toEqual({ symbol: 'HYPE', decimals: 8 });
  });

  it('a chain-1 hour without its block (or a failed chain-1 read) leaves the off-chain ref missing with quote_missing', async () => {
    PRICE_CHAIN_METHODS.hyperliquid = vi.fn(async () => {
      throw new Error('must not be called without chain 1');
    });
    const rpc = ethChain('2026-11-10T01:30:00Z', (_n, t) => feed(USDC_USD_ETH, 1, t - 60));
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': rpc }, '2026-11-10T03:00:00Z'), [HYPE.ref], at(HOURS[1]!), at(HOURS[2]!));
    expect(r.missing).toEqual([{ ref: HYPE.ref, hourMs: at(HOURS[1]!), reason: 'quote_missing' }]);
    expect(PRICE_CHAIN_METHODS.hyperliquid).not.toHaveBeenCalled();

    const broken = ethChain('2026-11-11T00:00:00Z', () => ({}));
    broken.multicall = async () => {
      throw new Error('connection reset');
    };
    const r2 = await writeChainPrices(testDb(), deps({ 'eip155:1': broken }, '2026-11-11T00:00:00Z'), [HYPE.ref], at(HOURS[1]!), at(HOURS[2]!));
    expect(r2.missing).toEqual([{ ref: HYPE.ref, hourMs: at(HOURS[1]!), reason: 'quote_missing' }]);
    expect(r2.errors).toEqual([{ chain: 'eip155:1', hourMs: at(HOURS[1]!), error: 'connection reset' }]);
  });

  it('a method\'s missing detail reaches WriteResult.missing (stale_swap with its last_swap_age_s)', async () => {
    PRICE_CHAIN_METHODS.hyperliquid = async (_deps, entries) => ({ prices: new Map(), missing: entries.map((e) => ({ ref: e.ref, reason: 'stale_swap', detail: { signature: 'sigOLD', last_swap_age_s: 30_000 } })) });
    const rpc = ethChain('2026-11-11T00:00:00Z', (_n, t) => feed(USDC_USD_ETH, 1, t - 60));
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': rpc }, '2026-11-11T00:00:00Z'), [HYPE.ref], at(HOURS[0]!), at(HOURS[1]!));
    expect(r.missing).toEqual([{ ref: HYPE.ref, hourMs: at(HOURS[0]!), reason: 'stale_swap', detail: { signature: 'sigOLD', last_swap_age_s: 30_000 } }]);
  });

  it('LIT: chain 1 reads its v4 check (an off-chain primary\'s EVM check) and hands it to the lighter method', async () => {
    const SV = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
    const ID = '0x8366b1dde4de12c8806985fbb599d408d92d01a6faf2e478cc6bb76189cc00f1';
    const sqrt = BigInt(Math.round(Math.sqrt(3.4e-12) * 2 ** 96)); // LIT (0x232c..) is currency0: USDC raw per LIT raw
    PRICE_CHAIN_METHODS.lighter = async (_deps, entries, _hour, ctx) => {
      const usdc = ctx.feedUsd!.get(USDC_USD_ETH)!;
      const e = entries[0]!;
      return { prices: new Map([[e.ref, withCheck(e, { usd: 3.3573 * usdc, source: 'first_party:lighter', detail: { close: 3.3573 } }, ctx.checks.get(e.ref) ?? null)]]), missing: [] };
    };
    const rpc = ethChain('2026-11-11T00:00:00Z', (_n, t) => ({ ...feed(USDC_USD_ETH, 1, t - 60), [k(SV, 'getSlot0', [ID], 0)]: sqrt, [k(SV, 'getLiquidity', [ID])]: 10n ** 20n }));
    const r = await writeChainPrices(testDb(), deps({ 'eip155:1': rpc }, '2026-11-11T00:00:00Z'), [LIT.ref], at(HOURS[0]!), at(HOURS[1]!));
    expect(r.written).toEqual({ [LIT.ref]: 1 });
    const [row] = await rows(LIT.ref);
    expect(row).toMatchObject({ source: 'first_party:lighter', check: 'chain:v4_spot' });
    expect(row!.price_usd).toBeCloseTo(3.3573, 12);
    expect(row!.check_gap_pct).toBeCloseTo(((3.4 - 3.3573) / 3.3573) * 100, 4);
  });

  it('refuses a ref not in prices.yaml, and a ref whose chain has no registered method', async () => {
    const d = deps({}, '2026-11-11T00:00:00Z');
    await expect(writeChainPrices(testDb(), d, ['eip155:1/0x0000000000000000000000000000000000000001'], at(HOURS[0]!), at(HOURS[1]!))).rejects.toMatchObject({ code: 'unknown_price_ref' });
    delete PRICE_CHAIN_METHODS.solana;
    await expect(writeChainPrices(testDb(), d, [bySymbol('PUMP').ref], at(HOURS[0]!), at(HOURS[1]!))).rejects.toMatchObject({ code: 'no_price_method' });
    await expect(writeChainPrices(testDb(), d, [VVV.ref], at(HOURS[0]!) + 1, at(HOURS[1]!))).rejects.toMatchObject({ code: 'invalid_price_range' });
  });

  it('registers the three EVM chains', () => {
    expect(Object.keys(saved).sort()).toEqual(expect.arrayContaining(['eip155:1', 'eip155:56', 'eip155:8453']));
  });
});

describe('makePriceDeps', () => {
  it('builds rpcFor from the env RPC URLs through the RpcFactory (one transport per chain); Base falls back to its public URL', () => {
    const made: [string, number][] = [];
    const factory = (url: string, chainId: number) => {
      made.push([url, chainId]);
      return fakeRpc({ genesisTs: 0, latest: 1n });
    };
    const env = { ORION_ETH_RPC_URL: 'https://eth.test/k', ORION_BNB_RPC_URL: 'https://bnb.test/k' };
    const d = makePriceDeps(env, { rpcFactory: factory, prices: PRICES, now: new Date('2026-11-11T00:00:00Z') });
    expect(d.rpcFor('eip155:1')).toBe(d.rpcFor('eip155:1'));
    d.rpcFor('eip155:56');
    d.rpcFor('eip155:8453');
    expect(made).toEqual([['https://eth.test/k', 1], ['https://bnb.test/k', 56], ['https://mainnet.base.org', 8453]]);
    expect(d.now.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(d.prices).toBe(PRICES);
    expect(makePriceDeps({ ORION_BASE_RPC_URL: 'https://base.test/k' }, { rpcFactory: factory, prices: PRICES }).rpcFor('eip155:8453')).toBeDefined();
    expect(made.at(-1)).toEqual(['https://base.test/k', 8453]);
  });

  it('refuses a chain without a URL or a non-EVM chain; unwired Solana/HTTP slots refuse when used', async () => {
    const d = makePriceDeps({}, { rpcFactory: () => fakeRpc({ genesisTs: 0, latest: 1n }), prices: PRICES });
    expect(() => d.rpcFor('eip155:1')).toThrow(expect.objectContaining({ code: 'no_rpc_url', message: expect.stringContaining('ORION_ETH_RPC_URL') }));
    expect(() => d.rpcFor('solana')).toThrow(expect.objectContaining({ code: 'no_rpc_url' }));
    await expect(d.solana.slotAt(1)).rejects.toMatchObject({ code: 'no_price_transport' });
    await expect(d.http.getJson('https://x.test')).rejects.toMatchObject({ code: 'no_price_transport' });
  });
});
