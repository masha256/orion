import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { solanaPriceTransport, SOLANA_SLOT_SEC } from '../../src/ingest/transport/solana.js';
import { loadPrices, type PriceEntry } from '../../src/prices/config.js';
import type { MethodRead } from '../../src/prices/evmMethods.js';
import {
  HYPERLIQUID_INFO_URL,
  LIGHTER_API,
  livePriceOffchain,
  MAX_SWAP_AGE_S,
  priceHourOffchain,
  priceRangeOffchain,
  USDC_MINT,
} from '../../src/prices/offchainMethods.js';
import type { PriceDeps } from '../../src/prices/types.js';
import { makePriceDeps, PRICE_CHAIN_METHODS } from '../../src/prices/writer.js';
import { fakeHttp, type FakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

// Phase 3 R2 Task 4: the first-party (Hyperliquid, Lighter) and Solana (PumpSwap, Meteora DLMM) price methods. Numbers are
// hype-lit-pump.md's measured rows: USDC/USD 0.99978 (Ethereum feed, 14:42Z); HYPE @107 vs perp at 2026-10-30 01:00Z
// 89.035 / 89.372 and allMids @107 73.8355 / HYPE 73.795; Lighter spot last 3.354, book 3.3547 / 3.3577, v4 3.3573;
// PumpSwap 0.0035042 (33 s lag) vs Meteora DLMM exec 0.0035093 on a $317 swap (2026-11-10T14), and the live PumpSwap
// reserves 3.0147B PUMP + 10.53M USDC vs DLMM 0.0034953. Request shapes as measured: candleSnapshot {coin, interval 1h},
// Lighter /api/v1/candles (500 a call; /candlesticks is 403), getSignaturesForAddress `before`, getTransaction with
// maxSupportedTransactionVersion 1, slots 0.215 s.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRICES = loadPrices(ROOT);
const bySymbol = (s: string): PriceEntry => {
  const e = [...PRICES.values()].find((x) => x.symbol === s);
  if (!e) throw new Error(`no ${s} in prices.yaml`);
  return e;
};
const HYPE = bySymbol('HYPE');
const LIT = bySymbol('LIT');
const PUMP = bySymbol('PUMP');
const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const USDC_USD = 0.99978;
const USDC_FEED = '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6';
const FEEDS = new Map([[USDC_FEED, USDC_USD]]);
const SOL_URL = 'https://solana-mainnet.g.alchemy.com/v2/sol_SECRETKEY';
const PUMP_MINT = PUMP.ref.split('/')[1]!;
const BASE_VAULT = '8TqK4PL3x7zWR2dNinr1LMi8Uf4vTRSFE2Ev1yYW9bhC';
const QUOTE_VAULT = '68Vdm7mQJ7RBxWioLVEUXbeTTpTtyiR1CL9vLRxmdr8t';
const POOL = '2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd';
const PAIR = '9SMp4yLKGtW9TnLimfVPkDARsyNSfJw43WMke4r7KoZj';

/** Every fake HTTP transport made in this file: R8 is checked over all of them at the end. */
const transports: FakeHttp[] = [];
function http(routes: Parameters<typeof fakeHttp>[0]): FakeHttp {
  const h = fakeHttp(routes);
  transports.push(h);
  return h;
}
afterAll(() => {
  const urls = transports.flatMap((t) => t.calls.map((c) => c.url));
  expect(urls.length).toBeGreaterThan(0);
  // Ruling R8 / M8: PUMP is read only through our own Solana RPC, never a pump.fun host.
  expect(urls.filter((u) => /(^|\.)pump\.fun$/i.test(new URL(u).hostname))).toEqual([]);
});

const unwired = new Proxy({}, { get: () => () => Promise.reject(new Error('not wired in this test')) });
function deps(o: { http?: FakeHttp; solana?: PriceDeps['solana']; rpc?: ReturnType<typeof fakeRpc>; now?: string }): PriceDeps {
  return {
    rpcFor: (chain) => {
      if (chain !== 'eip155:1' || !o.rpc) throw new Error(`no fake rpc for ${chain}`);
      return o.rpc;
    },
    solana: o.solana ?? (unwired as PriceDeps['solana']),
    http: o.http ?? (unwired as PriceDeps['http']),
    now: new Date(o.now ?? '2026-11-14T00:00:00Z'),
    prices: PRICES,
  };
}

// ---- Hyperliquid ------------------------------------------------------------------------------------------------------

/** candleSnapshot rows as the info API answers them: strings for prices, ms for times. */
const hlCandle = (coin: string, t: number, close: number) => ({ t, T: t + HOUR - 1, s: coin, i: '1h', o: String(close), c: String(close), h: String(close), l: String(close), v: '1000.0', n: 500 });
interface HlBody { type: string; req?: { coin: string; interval: string; startTime: number; endTime: number } }
function hyperliquid(closeOf: (coin: string, t: number) => number | null, mids: Record<string, string> = {}) {
  return http({
    [HYPERLIQUID_INFO_URL]: (_u: string, body?: unknown) => {
      const b = body as HlBody;
      if (b.type === 'allMids') return mids;
      if (b.type !== 'candleSnapshot' || !b.req) throw new Error(`unexpected info request ${JSON.stringify(body)}`);
      const out = [];
      // The API serves only the newest 5,000 candles of a coin.
      for (let t = Math.ceil(b.req.startTime / HOUR) * HOUR; t <= b.req.endTime; t += HOUR) {
        const c = closeOf(b.req.coin, t);
        if (c !== null) out.push(hlCandle(b.req.coin, t, c));
      }
      return out.slice(-5000);
    },
  });
}

describe('HYPE: Hyperliquid spot @107 candle close x USDC/USD, checked against the perp (same venue)', () => {
  const H = at('2026-10-30T01:00:00Z');

  it('prices an hour from the @107 close and gaps it against the perp HYPE close (89.035 vs 89.372)', async () => {
    const h = hyperliquid((coin, t) => (t === H ? (coin === '@107' ? 89.035 : 89.372) : null));
    const r = await priceHourOffchain(deps({ http: h }), [HYPE], H, FEEDS);
    expect(r.missing).toEqual([]);
    const p = r.prices.get(HYPE.ref)!;
    expect(p.usd).toBeCloseTo(89.035 * USDC_USD, 10);
    expect(p.source).toBe('first_party:hyperliquid');
    expect(p.check).toBe('first_party:hyperliquid:same_venue');
    expect(p.checkGapPct).toBeCloseTo(((89.372 - 89.035) / 89.035) * 100, 8); // +0.3785%
    expect(p.detail).toMatchObject({ coin: '@107', close: '89.035', usdc_usd: USDC_USD, check: { coin: 'HYPE', close: '89.372' } });
    // One candleSnapshot per coin, hourly, on the info API.
    expect(h.calls.map((c) => [c.method, c.url, (c.body as HlBody).req?.coin, (c.body as HlBody).req?.interval])).toEqual([
      ['POST', HYPERLIQUID_INFO_URL, '@107', '1h'],
      ['POST', HYPERLIQUID_INFO_URL, 'HYPE', '1h'],
    ]);
    expect(r.calls).toBe(2);
  });

  it('a range of 4,431 hours is one candleSnapshot per coin; a missing spot candle is a gap, a missing perp candle an unread check', async () => {
    const from = at('2026-05-13T00:00:00Z');
    const to = from + 4431 * HOUR;
    const GAP = from + 1000 * HOUR;
    const NO_PERP = from + 2000 * HOUR;
    const h = hyperliquid((coin, t) => (coin === '@107' ? (t === GAP ? null : 40) : t === NO_PERP ? null : 40.02));
    const r = await priceRangeOffchain(deps({ http: h }), HYPE, from, to, () => USDC_USD);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((c) => (c.body as HlBody).req)).toEqual([
      { coin: '@107', interval: '1h', startTime: from, endTime: to - 1 },
      { coin: 'HYPE', interval: '1h', startTime: from, endTime: to - 1 },
    ]);
    expect(r.prices.size).toBe(4430);
    expect(r.missing).toEqual([{ hourMs: GAP, reason: 'no_candle' }]);
    expect(r.prices.get(from)!.checkGapPct).toBeCloseTo(0.05, 8);
    expect(r.prices.get(NO_PERP)).toMatchObject({ checkGapPct: null, detail: { check: { skipped: 'no_candle' } } });
    expect(r.calls).toBe(2);
  });

  it('an hour without the USDC/USD feed value is quote_missing, and nothing is fetched for it', async () => {
    const h = hyperliquid(() => 40);
    const r = await priceHourOffchain(deps({ http: h }), [HYPE], H, null);
    expect(r.prices.size).toBe(0);
    expect(r.missing).toEqual([{ ref: HYPE.ref, reason: 'quote_missing' }]);
    expect(h.calls).toHaveLength(0);
    const r2 = await priceHourOffchain(deps({ http: h }), [HYPE], H, new Map());
    expect(r2.missing).toEqual([{ ref: HYPE.ref, reason: 'quote_missing' }]);
  });

  it('live: allMids["@107"] x the USDC/USD feed at the Ethereum head, checked against allMids.HYPE', async () => {
    const h = hyperliquid(() => null, { '@107': '73.8355', HYPE: '73.795', BTC: '1' });
    const rpc = ethHead({ ...feed(USDC_FEED, USDC_USD) });
    const p = await livePriceOffchain(deps({ http: h, rpc }), HYPE);
    expect(p.usd).toBeCloseTo(73.8355 * USDC_USD, 10);
    expect(p.checkGapPct).toBeCloseTo(((73.795 - 73.8355) / 73.8355) * 100, 8);
    expect(p.detail).toMatchObject({ level: 'allMids', coin: '@107', mid: '73.8355', usdc_usd: USDC_USD });
    expect(h.calls.map((c) => c.body)).toEqual([{ type: 'allMids' }]);
  });
});

// ---- Lighter ----------------------------------------------------------------------------------------------------------

/** A /api/v1/candles reply: `c` rows of t (ms, the candle's start), o/h/l/c, base and quote volume. */
function lighter(closeOf: (t: number) => number | null, book?: { bids: string[]; asks: string[] }) {
  return http({
    [`${LIGHTER_API}/candles`]: (url: string) => {
      const q = new URL(url).searchParams;
      expect(q.get('market_id')).toBe('2049');
      expect(q.get('resolution')).toBe('1h');
      const start = Number(q.get('start_timestamp'));
      const end = Number(q.get('end_timestamp'));
      const back = Number(q.get('count_back'));
      expect(back).toBeLessThanOrEqual(500);
      const c = [];
      for (let t = Math.ceil(start / HOUR) * HOUR; t < end; t += HOUR) {
        const v = closeOf(t);
        if (v !== null) c.push({ t, o: v, h: v, l: v, c: v, v: 46_000, V: 157_000, i: 1 });
      }
      return { code: 200, r: '1h', c: c.slice(-500) };
    },
    [`${LIGHTER_API}/candlesticks`]: new Error('HTTP 403'),
    [`${LIGHTER_API}/orderBookOrders`]: (url: string) => {
      expect(new URL(url).searchParams.get('market_id')).toBe('2049');
      return { code: 200, total_asks: 1, asks: (book?.asks ?? []).map((price) => ({ price, remaining_base_amount: '100' })), total_bids: 1, bids: (book?.bids ?? []).map((price) => ({ price, remaining_base_amount: '100' })) };
    },
  });
}

describe('LIT: Lighter spot 2049 candle close x USDC/USD, checked against the Uniswap v4 pool read on chain 1', () => {
  const H = at('2026-11-13T13:00:00Z');
  const v4 = (usd: number): MethodRead => ({ usd, detail: { method: 'v4_spot', in_quote: usd / USDC_USD } });

  it('prices an hour from the 2049 close (3.354) and gaps it against the v4 check the writer read on chain 1 (3.3573)', async () => {
    const h = lighter((t) => (t === H ? 3.354 : 3.35));
    const r = await priceHourOffchain(deps({ http: h }), [LIT], H, FEEDS, new Map([[LIT.ref, v4(3.3573 * USDC_USD)]]));
    const p = r.prices.get(LIT.ref)!;
    expect(p.usd).toBeCloseTo(3.354 * USDC_USD, 10);
    expect(p.source).toBe('first_party:lighter');
    expect(p.check).toBe('chain:v4_spot');
    expect(p.checkGapPct).toBeCloseTo(((3.3573 - 3.354) / 3.354) * 100, 8);
    expect(p.detail).toMatchObject({ market_id: 2049, close: 3.354, usdc_usd: USDC_USD });
    expect(h.calls.every((c) => new URL(c.url).pathname === '/api/v1/candles')).toBe(true);
  });

  it('a zero-liquidity v4 hour leaves the check unread (skipped, never a gap); no check read at all is not_read', async () => {
    const h = lighter(() => 0.89);
    const zero: MethodRead = { usd: null, reason: 'zero_liquidity', detail: { method: 'v4_spot', liquidity: '0' } };
    const r = await priceHourOffchain(deps({ http: h }), [LIT], H, FEEDS, new Map([[LIT.ref, zero]]));
    expect(r.prices.get(LIT.ref)).toMatchObject({ checkGapPct: null, detail: { check: { skipped: 'zero_liquidity' } } });
    const r2 = await priceHourOffchain(deps({ http: h }), [LIT], H, FEEDS);
    expect(r2.prices.get(LIT.ref)).toMatchObject({ checkGapPct: null, detail: { check: { skipped: 'not_read' } } });
  });

  it('183 days of hours are 9 calls of at most 500 candles, never /candlesticks', async () => {
    const to = at('2026-11-13T00:00:00Z');
    const from = to - 183 * 24 * HOUR;
    const h = lighter(() => 3.35);
    const r = await priceRangeOffchain(deps({ http: h }), LIT, from, to, () => USDC_USD, () => v4(3.36 * USDC_USD));
    expect(h.calls).toHaveLength(9);
    expect(h.calls.every((c) => c.url.startsWith(`${LIGHTER_API}/candles?`))).toBe(true);
    expect(r.prices.size).toBe(183 * 24);
    expect(r.missing).toEqual([]);
    expect(r.prices.get(from)!.checkGapPct).toBeCloseTo(((3.36 - 3.35) / 3.35) * 100, 8);
    expect(r.calls).toBe(9);
  });

  it('live: the order-book mid (3.3547 / 3.3577) x USDC/USD at the Ethereum head, checked against the v4 pool there', async () => {
    const h = lighter(() => null, { bids: ['3.3547'], asks: ['3.3577'] });
    const SV = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
    const ID = '0x8366b1dde4de12c8806985fbb599d408d92d01a6faf2e478cc6bb76189cc00f1';
    // LIT (0x232c..) is currency0 of the v4 pool: sqrtPriceX96 is sqrt(USDC raw per LIT raw) x 2^96.
    const sqrt = BigInt(Math.round(Math.sqrt(3.3573e-12) * 2 ** 96));
    const rpc = ethHead({ ...feed(USDC_FEED, USDC_USD), [k(SV, 'getSlot0', [ID], 0)]: sqrt, [k(SV, 'getLiquidity', [ID])]: 10n ** 20n });
    const p = await livePriceOffchain(deps({ http: h, rpc }), LIT);
    expect(p.usd).toBeCloseTo(3.3562 * USDC_USD, 10);
    expect(p.check).toBe('chain:v4_spot');
    expect(p.checkGapPct).toBeCloseTo(((3.3573 - 3.3562) / 3.3562) * 100, 3);
    expect(p.detail).toMatchObject({ level: 'order_book_mid', bid: '3.3547', ask: '3.3577' });
    expect(rpc.stats.multicall).toBe(1);
  });
});

// ---- Solana: a fake chain and its JSON-RPC ----------------------------------------------------------------------------

const T0 = at('2026-11-09T00:00:00Z') / 1000;
const S0 = 400_000_000;
/** The chain's true slot time differs from the 0.215 s the search assumes, and every 53rd slot is skipped. */
const TRUE_SLOT_SEC = 0.2148;
const skipped = (s: number) => s % 53 === 0;
const timeOfSlot = (s: number) => T0 + Math.floor((s - S0) * TRUE_SLOT_SEC);
const HEAD = S0 + Math.floor((at('2026-11-13T23:59:00Z') / 1000 - T0) / TRUE_SLOT_SEC);
/** The first produced slot whose block time is at or after ts (brute force, for the test's expectations). */
function firstSlotAt(ts: number): number {
  let s = S0 + Math.floor((ts - T0) / TRUE_SLOT_SEC) - 10;
  while (skipped(s) || timeOfSlot(s) < ts) s++;
  return s;
}

interface TokenBal { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string; decimals: number; uiAmountString: string } }
interface FakeTx { signature: string; slot: number; err: unknown; keys: string[]; loaded?: string[]; pre: TokenBal[]; post: TokenBal[] }
const bal = (accountIndex: number, mint: string, owner: string, raw: bigint): TokenBal => ({ accountIndex, mint, owner, uiTokenAmount: { amount: raw.toString(), decimals: 6, uiAmountString: (Number(raw) / 1e6).toString() } });
const RAW = (tokens: number) => BigInt(Math.round(tokens * 1e6));

/** A PumpSwap swap (vaults in the v0 lookup table: loadedAddresses) leaving reserves `pump` PUMP and `usdc` USDC. */
function pumpSwap(signature: string, slot: number, pump: number, usdc: number, err: unknown = null): FakeTx {
  const keys = ['Trader1111111111111111111111111111111111111', POOL];
  const loaded = [BASE_VAULT, QUOTE_VAULT];
  return {
    signature, slot, err, keys, loaded,
    pre: [bal(2, PUMP_MINT, POOL, RAW(pump) + 1_000_000n), bal(3, USDC_MINT, POOL, RAW(usdc) - 3_500n)],
    post: [bal(2, PUMP_MINT, POOL, RAW(pump)), bal(3, USDC_MINT, POOL, RAW(usdc))],
  };
}
/** A Meteora DLMM swap: the pair's PUMP reserve moves by dPump and its USDC reserve by dUsdc (raw, 6 decimals). */
function dlmmTx(signature: string, slot: number, dPump: bigint, dUsdc: bigint, err: unknown = null): FakeTx {
  const PX = 'DLMMreservePUMP1111111111111111111111111111';
  const PY = 'DLMMreserveUSDC1111111111111111111111111111';
  const p0 = 343_300_000n * 1_000_000n;
  const u0 = 189_800n * 1_000_000n;
  return {
    signature, slot, err, keys: ['Trader1111111111111111111111111111111111111', PAIR, PX, PY],
    pre: [bal(2, PUMP_MINT, PAIR, p0), bal(3, USDC_MINT, PAIR, u0)],
    post: [bal(2, PUMP_MINT, PAIR, p0 + dPump), bal(3, USDC_MINT, PAIR, u0 + dUsdc)],
  };
}

interface SolFake { txs: Record<string, FakeTx[]>; accounts?: Record<string, unknown>; head?: number }
/** Solana JSON-RPC over the fake HTTP: one route, answering by method. */
function solanaHttp(f: SolFake): FakeHttp {
  const head = f.head ?? HEAD;
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: 1, error: { code, message } });
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: 1, result });
  return http({
    [SOL_URL]: (_u: string, body?: unknown) => {
      const { method, params } = body as { method: string; params: unknown[] };
      switch (method) {
        case 'getSlot':
          return ok(head);
        case 'getBlockTime': {
          const s = params[0] as number;
          if (s > head) return err(-32004, `Block not available for slot ${s}`);
          if (skipped(s)) return err(-32007, `Slot ${s} was skipped, or missing due to ledger jump to recent snapshot`);
          return ok(timeOfSlot(s));
        }
        case 'getBlock': {
          const s = params[0] as number;
          expect(params[1]).toMatchObject({ transactionDetails: 'signatures', maxSupportedTransactionVersion: 1, rewards: false });
          if (skipped(s)) return err(-32007, `Slot ${s} was skipped, or missing due to ledger jump to recent snapshot`);
          return ok({ blockTime: timeOfSlot(s), blockHeight: s - 20_000_000, signatures: [`blk${s}a`, `blk${s}b`] });
        }
        case 'getSignaturesForAddress': {
          const [address, opts] = params as [string, { before?: string; limit: number }];
          const list = [...(f.txs[address] ?? [])].sort((a, b) => b.slot - a.slot);
          let rest = list;
          if (opts.before?.startsWith('blk')) {
            const seek = Number(opts.before.slice(3, -1));
            rest = list.filter((t) => t.slot < seek);
          } else if (opts.before) {
            rest = list.slice(list.findIndex((t) => t.signature === opts.before) + 1);
          }
          return ok(rest.slice(0, opts.limit).map((t) => ({ signature: t.signature, slot: t.slot, err: t.err, memo: null, blockTime: timeOfSlot(t.slot), confirmationStatus: 'finalized' })));
        }
        case 'getTransaction': {
          const [sig, opts] = params as [string, { maxSupportedTransactionVersion?: number }];
          // Version-1 transactions exist: without maxSupportedTransactionVersion 1 the node answers -32015.
          if (opts?.maxSupportedTransactionVersion !== 1) return err(-32015, 'Transaction version (1) is not supported by the requesting client');
          const t = Object.values(f.txs).flat().find((x) => x.signature === sig);
          if (!t) return ok(null);
          return ok({
            slot: t.slot, blockTime: timeOfSlot(t.slot), version: 0,
            meta: { err: t.err, preTokenBalances: t.pre, postTokenBalances: t.post, loadedAddresses: { writable: t.loaded ?? [], readonly: [] } },
            transaction: { signatures: [sig], message: { accountKeys: t.keys } },
          });
        }
        case 'getMultipleAccounts': {
          const [keys] = params as [string[]];
          return ok({ context: { slot: head }, value: keys.map((key) => f.accounts?.[key] ?? null) });
        }
        default:
          throw new Error(`fake solana: no method ${method}`);
      }
    },
  });
}
const rpcCalls = (h: FakeHttp, method: string) => h.calls.filter((c) => (c.body as { method: string }).method === method);

describe('Solana transport: slotAt and the price reads (ORION_SOL_RPC_URL only)', () => {
  it('slotAt finds the first produced slot at or after a time, across skipped slots, in a dozen requests', async () => {
    const h = solanaHttp({ txs: {} });
    const sol = solanaPriceTransport(h, SOL_URL);
    expect(SOLANA_SLOT_SEC).toBe(0.215);
    for (const iso of ['2026-11-10T14:00:00Z', '2026-11-10T13:00:00Z', '2026-11-12T03:00:00Z']) {
      const before = h.calls.length;
      const ts = at(iso) / 1000;
      expect(await sol.slotAt(ts)).toBe(firstSlotAt(ts));
      expect(h.calls.length - before).toBeLessThanOrEqual(14);
    }
    // A time past the finalized head has no slot yet.
    expect(await sol.slotAt(at('2026-11-14T00:00:00Z') / 1000)).toBeNull();
    expect(sol.stats.requests).toBe(h.calls.length);
  });

  it('refuses a pump.fun host as its RPC (R8)', () => {
    expect(() => solanaPriceTransport(fakeHttp({}), 'https://frontend-api-v3.pump.fun/coins')).toThrow(expect.objectContaining({ code: 'forbidden_price_host' }));
  });
});

describe('PUMP: PumpSwap vaults after the last swap before H+1h, checked against Meteora DLMM', () => {
  const H = at('2026-11-10T13:00:00Z'); // the bucket [13:00, 14:00), read at 14:00:00Z
  const END = at('2026-11-10T14:00:00Z') / 1000;
  const seekSlot = firstSlotAt(END);
  const slotAtT = (ts: number) => firstSlotAt(ts);
  // PumpSwap PUMP/USDC: 3,005,000,000 PUMP and 10,530,121 USDC -> 0.0035042 USDC per PUMP, 33 s before 14:00.
  const goodPump = pumpSwap('pumpOK', slotAtT(END - 33), 3_005_000_000, 3_005_000_000 * 0.0035042);
  const afterHour = pumpSwap('pumpAFTER', seekSlot + 3, 3_000_000_000, 3_000_000_000 * 0.0036);
  const failed = (i: number, ts: number) => pumpSwap(`pumpFAIL${i}`, slotAtT(ts), 1, 1, { InstructionError: [2, { Custom: 6004 }] });
  // Meteora DLMM: the newest pair tx is a liquidity add (both reserves up, not a swap); the swap before it sold 317 USDC
  // for 90,331.405 PUMP -> 0.0035093 USDC per PUMP, fee included.
  const dPump = -RAW(317 / 0.0035093);
  const addLiq = dlmmTx('dlmmADD', slotAtT(END - 10), RAW(1_000), RAW(3.5));
  const dlmmSwap = dlmmTx('dlmmSWAP', slotAtT(END - 120), dPump, RAW(317));
  const dlmmAfter = dlmmTx('dlmmAFTER', seekSlot + 1, -RAW(1000), RAW(5));
  const world = (extra: Partial<Record<string, FakeTx[]>> = {}): SolFake => ({
    txs: {
      [QUOTE_VAULT]: extra[QUOTE_VAULT] ?? [afterHour, failed(1, END - 2), failed(2, END - 20), goodPump, pumpSwap('pumpOLD', slotAtT(END - 400), 3_000_000_000, 10_000_000)],
      [PAIR]: extra[PAIR] ?? [dlmmAfter, addLiq, dlmmSwap],
    },
  });

  it('prices the hour from the first successful swap before H+1h: USDC vault / PUMP vault, x USDC/USD; Meteora exec as the check', async () => {
    const h = solanaHttp(world());
    const sol = solanaPriceTransport(h, SOL_URL);
    const r = await priceHourOffchain(deps({ solana: sol }), [PUMP], H, FEEDS);
    expect(r.missing).toEqual([]);
    const p = r.prices.get(PUMP.ref)!;
    expect(p.usd).toBeCloseTo(0.0035042 * USDC_USD, 12);
    expect(p.source).toBe('chain:solana_vaults');
    expect(p.check).toBe('chain:meteora_dlmm');
    expect(p.checkGapPct).toBeCloseTo(((0.0035093 - 0.0035042) / 0.0035042) * 100, 4); // +0.146%
    expect(p.detail).toMatchObject({
      slot: seekSlot, seek_signature: `blk${seekSlot}a`, signature: 'pumpOK', last_swap_age_s: END - timeOfSlot(goodPump.slot),
      base_raw: RAW(3_005_000_000).toString(), usdc_usd: USDC_USD,
      check: { signature: 'dlmmSWAP', usd: expect.closeTo(0.0035093 * USDC_USD, 12) },
    });
    // The seek block is the first at or after 14:00; the signature cursor starts there; v1 transactions are asked for.
    expect(rpcCalls(h, 'getBlock').map((c) => (c.body as { params: unknown[] }).params[0])).toEqual([seekSlot]);
    const sigReqs = rpcCalls(h, 'getSignaturesForAddress').map((c) => (c.body as { params: [string, { before: string }] }).params);
    expect(sigReqs.map(([a, o]) => [a, o.before])).toEqual([[QUOTE_VAULT, `blk${seekSlot}a`], [PAIR, `blk${seekSlot}a`]]);
    const txReqs = rpcCalls(h, 'getTransaction').map((c) => (c.body as { params: [string, { maxSupportedTransactionVersion: number }] }).params);
    expect(txReqs.map(([s]) => s)).toEqual(['pumpOK', 'dlmmADD', 'dlmmSWAP']); // failed signatures are never fetched
    expect(txReqs.every(([, o]) => o.maxSupportedTransactionVersion === 1)).toBe(true);
    expect(r.calls).toBe(h.calls.length);
  });

  it('no swap in the hour before H+1h: the reserves of the newest earlier swap, with its age; refused beyond 6 h', async () => {
    const twoHours = pumpSwap('pumpOLDER', slotAtT(END - 7200 - 5), 3_005_000_000, 3_005_000_000 * 0.0035);
    const h = solanaHttp(world({ [QUOTE_VAULT]: [afterHour, failed(1, END - 30), twoHours] }));
    const r = await priceHourOffchain(deps({ solana: solanaPriceTransport(h, SOL_URL) }), [PUMP], H, FEEDS);
    expect(r.prices.get(PUMP.ref)!.usd).toBeCloseTo(0.0035 * USDC_USD, 12);
    expect(r.prices.get(PUMP.ref)!.detail.last_swap_age_s).toBeGreaterThanOrEqual(7205);

    expect(MAX_SWAP_AGE_S).toBe(6 * 3600);
    const stale = pumpSwap('pumpSTALE', slotAtT(END - 6 * 3600 - 60), 3_005_000_000, 3_005_000_000 * 0.0035);
    const h2 = solanaHttp(world({ [QUOTE_VAULT]: [afterHour, failed(1, END - 30), stale] }));
    const r2 = await priceHourOffchain(deps({ solana: solanaPriceTransport(h2, SOL_URL) }), [PUMP], H, FEEDS);
    expect(r2.prices.size).toBe(0);
    expect(r2.missing).toEqual([{ ref: PUMP.ref, reason: 'stale_swap', detail: expect.objectContaining({ last_swap_age_s: expect.any(Number) }) }]);
    expect((r2.missing[0]!.detail as { last_swap_age_s: number }).last_swap_age_s).toBeGreaterThan(6 * 3600);
    expect(rpcCalls(h2, 'getTransaction')).toHaveLength(0); // the age is known from the signature list
  });

  it('pages back with `before` = the last signature of a page full of failed bot transactions', async () => {
    const bots = Array.from({ length: 130 }, (_, i) => failed(100 + i, END - 1 - Math.floor(i / 5)));
    const h = solanaHttp(world({ [QUOTE_VAULT]: [...bots, goodPump] }));
    const r = await priceHourOffchain(deps({ solana: solanaPriceTransport(h, SOL_URL) }), [PUMP], H, FEEDS);
    expect(r.prices.get(PUMP.ref)!.detail.signature).toBe('pumpOK');
    const befores = rpcCalls(h, 'getSignaturesForAddress')
      .map((c) => (c.body as { params: [string, { before: string; limit: number }] }).params)
      .filter(([a]) => a === QUOTE_VAULT)
      .map(([, o]) => o.before);
    const newestFirst = [...bots].sort((a, b) => b.slot - a.slot);
    expect(befores).toEqual([`blk${seekSlot}a`, newestFirst[99]!.signature]);
  });

  it('a Meteora pair without a swap in reach leaves the check unread; the primary still prices', async () => {
    const h = solanaHttp(world({ [PAIR]: [dlmmAfter, addLiq] }));
    const r = await priceHourOffchain(deps({ solana: solanaPriceTransport(h, SOL_URL) }), [PUMP], H, FEEDS);
    expect(r.prices.get(PUMP.ref)).toMatchObject({ checkGapPct: null, detail: { check: { skipped: 'no_swap' } } });
  });

  it('an hour past the finalized head has no row yet (no_block_yet); a missing USDC/USD value is quote_missing', async () => {
    const late = at('2026-11-13T23:00:00Z'); // H+1h = 2026-11-14T00:00Z, past the fake head
    const h = solanaHttp(world());
    const r = await priceHourOffchain(deps({ solana: solanaPriceTransport(h, SOL_URL) }), [PUMP], late, FEEDS);
    expect(r.missing).toEqual([{ ref: PUMP.ref, reason: 'no_block_yet' }]);
    const r2 = await priceHourOffchain(deps({ solana: solanaPriceTransport(h, SOL_URL) }), [PUMP], H, null);
    expect(r2.missing).toEqual([{ ref: PUMP.ref, reason: 'quote_missing' }]);
  });

  it('live: getMultipleAccounts on the two vaults and the pair; Meteora active bin (1 + 20/1e4)^active_id', async () => {
    const tokenAccount = (mint: string, raw: bigint) => ({ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2_039_280, data: { program: 'spl-token', parsed: { type: 'account', info: { mint, owner: POOL, tokenAmount: { amount: raw.toString(), decimals: 6 } } } } });
    const activeId = Math.round(Math.log(0.0034953) / Math.log(1.002));
    const pair = Buffer.alloc(904);
    pair.writeInt32LE(activeId, 76);
    pair.writeUInt16LE(20, 80);
    Buffer.from(b58decode(PUMP_MINT)).copy(pair, 88);
    Buffer.from(b58decode(USDC_MINT)).copy(pair, 120);
    const h = solanaHttp({
      txs: {},
      accounts: {
        [BASE_VAULT]: tokenAccount(PUMP_MINT, RAW(3_014_700_000)),
        [QUOTE_VAULT]: tokenAccount(USDC_MINT, RAW(10_530_000)),
        [PAIR]: { owner: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', lamports: 7_000_000, data: [pair.toString('base64'), 'base64'] },
      },
    });
    const rpc = ethHead({ ...feed(USDC_FEED, USDC_USD) });
    const p = await livePriceOffchain(deps({ solana: solanaPriceTransport(h, SOL_URL), rpc }), PUMP);
    const pumpswap = 10_530_000 / 3_014_700_000;
    expect(p.usd).toBeCloseTo(pumpswap * USDC_USD, 12);
    const bin = 1.002 ** activeId;
    expect(p.checkGapPct).toBeCloseTo(((bin - pumpswap) / pumpswap) * 100, 6);
    expect(p.detail).toMatchObject({ level: 'vault_reserves', check: { active_id: activeId, bin_step: 20 } });
    expect(rpcCalls(h, 'getMultipleAccounts')).toHaveLength(1);
    expect((rpcCalls(h, 'getMultipleAccounts')[0]!.body as { params: [string[]] }).params[0]).toEqual([BASE_VAULT, QUOTE_VAULT, PAIR]);
  });
});

// ---- the registry and the deps ----------------------------------------------------------------------------------------

describe('PRICE_CHAIN_METHODS: hyperliquid, lighter and solana are registered (R4, R15)', () => {
  const ctx = (feedUsd: Map<string, number> | null, checks = new Map<string, MethodRead>()) => ({ feedUsd, checks, feeds: [], cache: new Map() });

  it('each prices its entries from chain 1\'s USDC/USD and reports its requests; a range is fetched once per run', async () => {
    expect(Object.keys(PRICE_CHAIN_METHODS)).toEqual(expect.arrayContaining(['hyperliquid', 'lighter', 'solana']));
    const h = hyperliquid(() => 40);
    const d = deps({ http: h });
    const hours = [at('2026-11-12T05:00:00Z'), at('2026-11-12T04:00:00Z'), at('2026-11-12T03:00:00Z')];
    for (const hourMs of hours) {
      const r = await PRICE_CHAIN_METHODS.hyperliquid!(d, [HYPE], { hourMs, blocks: null }, ctx(FEEDS));
      expect(r.prices.get(HYPE.ref)!.usd).toBeCloseTo(40 * USDC_USD, 10);
    }
    // The newest hour fetched both coins back to valid_from; the older hours were answered from that range.
    expect(h.calls).toHaveLength(2);
    expect((h.calls[0]!.body as HlBody).req).toMatchObject({ startTime: at(`${HYPE.validFrom}T00:00:00Z`), endTime: hours[0]! + HOUR - 1 });

    const l = lighter(() => 3.354);
    const rl = await PRICE_CHAIN_METHODS.lighter!(deps({ http: l }), [LIT], { hourMs: hours[0]!, blocks: null }, ctx(FEEDS));
    expect(rl.prices.get(LIT.ref)!.usd).toBeCloseTo(3.354 * USDC_USD, 10);
    expect(rl.calls).toBe(l.calls.length);

    const missing = await PRICE_CHAIN_METHODS.solana!(deps({}), [PUMP], { hourMs: hours[0]!, blocks: null }, ctx(new Map()));
    expect(missing).toMatchObject({ prices: new Map(), missing: [{ ref: PUMP.ref, reason: 'quote_missing' }] });
  });

  it('makePriceDeps wires Solana to ORION_SOL_RPC_URL over the HTTP slot; without the URL a Solana read refuses', async () => {
    const h = solanaHttp({ txs: {} });
    const factory = () => fakeRpc({ genesisTs: 0, latest: 1n });
    const d = makePriceDeps({ ORION_SOL_RPC_URL: SOL_URL }, { rpcFactory: factory, prices: PRICES, http: h });
    expect(await d.solana.slotAt(at('2026-11-10T14:00:00Z') / 1000)).toBe(firstSlotAt(at('2026-11-10T14:00:00Z') / 1000));
    expect(h.calls.every((c) => c.url === SOL_URL)).toBe(true);
    const none = makePriceDeps({}, { rpcFactory: factory, prices: PRICES, http: h });
    await expect(none.solana.slotAt(1)).rejects.toMatchObject({ code: 'no_rpc_url', message: expect.stringContaining('ORION_SOL_RPC_URL') });
  });
});

// ---- helpers ----------------------------------------------------------------------------------------------------------

const k = (address: string, fn: string, args: readonly unknown[] = [], pick?: number) => callKey(address, fn, args) + (pick === undefined ? '' : `[${pick}]`);
function feed(address: string, usd: number): Record<string, bigint> {
  return { [k(address, 'latestRoundData', [], 1)]: BigInt(Math.round(usd * 1e8)), [k(address, 'latestRoundData', [], 3)]: BigInt(at('2026-11-13T23:59:00Z') / 1000 - 60) };
}
/** An Ethereum fake whose head is at 2026-11-13T23:59Z, answering `calls` there. */
function ethHead(calls: Record<string, bigint>) {
  const genesisTs = at('2026-11-13T23:59:00Z') / 1000 - 12 * 1_000_000;
  return fakeRpc({ genesisTs, latest: 1_000_000n, blockTimeSec: 12, calls });
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const out: number[] = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 0xffn));
  for (let i = 0; i < s.length && s[i] === '1'; i++) out.unshift(0);
  return Uint8Array.from(out);
}
