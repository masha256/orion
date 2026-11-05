import { describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/ingest/adapters/registry.js';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import type { ReadingResult, SourceValue } from '../../src/ingest/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { req, sourceCtx } from '../helpers/sourceCtx.js';

/**
 * response_digest (spec §3) is the sha256 of the raw response slice a value was read from: each API source hands that
 * slice (the JSON sub-tree for the day or the metric, untouched) to the writer next to the value.
 */

const valueOf = (r: ReadingResult): SourceValue => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const DAY = 86_400_000;

describe('API sources expose the raw response slice of each value', () => {
  it('defillama: a day is its totalDataChart entry', async () => {
    const chart = [[1758067200, 130.5], [1758153600, 140]];
    const http = fakeHttp({ 'https://api.llama.fi/summary/fees/mini': { totalDataChart: chart, other: 'ignored' } });
    const [r] = await getSourceHandler('defillama').fetch([req('flow_usd.fees', { type: 'defillama', slug: 'mini', data_type: 'dailyFees', compare: 'monthly_sum' })], sourceCtx({ http }));
    const v = valueOf(r!);
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    expect(v.points).toEqual([
      { day: '2025-09-17', value: 130.5, slice: [1758067200, 130.5] },
      { day: '2025-09-18', value: 140, slice: [1758153600, 140] },
    ]);
  });

  it("coingecko: a level is the market row's id and the field read", async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'mini-token', current_price: 10, market_cap: 600, last_updated: 'x' }] });
    const [r] = await getSourceHandler('coingecko').fetch([req('price_usd', { type: 'coingecko', id: 'mini-token', field: 'price' })], sourceCtx({ http }));
    expect(valueOf(r!)).toMatchObject({ kind: 'level', value: 10, slice: { id: 'mini-token', current_price: 10 } });
  });

  it('http_json: a level is the value at its path, as the API wrote it', async () => {
    const http = fakeHttp({ 'https://api.example.test/stats': { data: { total: '12.5', other: 1 } } });
    const [r] = await getSourceHandler('http_json').fetch([req('m', { type: 'http_json', url: 'https://api.example.test/stats', path: 'data.total', scale: 2, decimals: 0 })], sourceCtx({ http }));
    expect(valueOf(r!)).toMatchObject({ kind: 'level', value: 25, slice: '12.5' });
  });

  it("defillama_share: a level is the category's rows, with the fields read", async () => {
    const body = {
      protocols: [
        { slug: 'a', parentProtocol: 'parent#x', category: 'Dexs', total30d: 30, total1y: 1, name: 'A' },
        { slug: 'b', category: 'Dexs', total30d: 70, name: 'B' },
        { slug: 'c', category: 'Lending', total30d: 1000 },
      ],
    };
    const http = fakeHttp({ 'https://api.llama.fi/overview/': body });
    const [r] = await getSourceHandler('defillama_share').fetch(
      [req('share', { type: 'defillama_share', parent: 'parent#x', category: 'Dexs', overview: 'fees', window: '30d' })], sourceCtx({ http }),
    );
    expect(valueOf(r!)).toMatchObject({
      kind: 'level', value: 0.3,
      slice: [{ slug: 'a', parentProtocol: 'parent#x', category: 'Dexs', total30d: 30 }, { slug: 'b', category: 'Dexs', total30d: 70 }],
    });
  });

  it("lit.exchange_fees_daily: a day is each kind's exchangeMetrics row for it", async () => {
    const today = Date.parse('2026-10-23T00:00:00Z');
    const rows = (f: (ago: number) => number) => ({ code: 200, metrics: [2, 1, 0].map((ago) => ({ timestamp: (today - ago * DAY) / 1000, data: f(ago) })) });
    const byKind: Record<string, unknown> = { maker_fee: rows((a) => 100 * a), taker_fee: rows((a) => a) };
    const http = fakeHttp({ 'https://mainnet.zklighter.elliot.ai/api/v1/exchangeMetrics': (url: string) => structuredClone(byKind[new URL(url).searchParams.get('kind')!]) });
    const v = await getAdapter('lit.exchange_fees_daily').run(sourceCtx({ nowIso: '2026-10-23T12:00:00.000Z', http }), { kinds: ['maker_fee', 'taker_fee'], days: 2 });
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    expect(v.points).toEqual([2, 1].map((ago) => ({
      day: new Date(today - ago * DAY).toISOString().slice(0, 10), value: 101 * ago,
      slice: { maker_fee: { timestamp: (today - ago * DAY) / 1000, data: 100 * ago }, taker_fee: { timestamp: (today - ago * DAY) / 1000, data: ago } },
    })));
  });

  it("lit.treasury_buys_daily: a day is the account's buys that day (an empty day: no trade)", async () => {
    const today = Date.parse('2026-10-16T00:00:00Z');
    const t = (ms: number, size: string) => ({ timestamp: ms, price: '3.0', size, bid_account_id: 0, ask_account_id: 77, market_id: 2049 });
    // Newest first: one trade today (dropped), two the day before, none two days back, one three days back.
    const trades = [t(today + 1000, '1'), t(today - 1000, '10'), t(today - 2000, '20'), t(today - 3 * DAY + 5000, '5'), t(today - 4 * DAY - 1000, '9')];
    const http = fakeHttp({ 'https://mainnet.zklighter.elliot.ai/api/v1/trades': () => ({ code: 200, trades }) });
    const v = await getAdapter('lit.treasury_buys_daily').run(sourceCtx({ nowIso: '2026-10-16T12:00:00.000Z', http, backfillDays: 3 }), { account: 0, market: 2049 });
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    expect(v.points.map((p) => [p.day, p.value, p.slice])).toEqual([
      ['2026-10-13', 15, [trades[3]]],
      ['2026-10-14', 0, []],
      ['2026-10-15', 90, [trades[1], trades[2]]],
    ]);
  });

  const FUND = '0xfefefefefefefefefefefefefefefefefefefefe';
  const INTEREST = '0x5000000000000000000000000000000000000000';
  const hypeCtx = (nowIso: string, route: (url: string, body?: unknown) => unknown) => {
    const contracts: Record<string, string> = { assistance_fund: FUND, system_interest: INTEREST, aqa_treasury: '0x1111111111111111111111111111111111111111' };
    return sourceCtx({ nowIso, http: fakeHttp({ 'https://api.hyperliquid.xyz/info': route }), contract: (n) => contracts[n]! });
  };

  it("hype.fund_buys_daily: a day is the fund's buy fills on the pair that day", async () => {
    const today = Date.parse('2026-09-19T00:00:00Z');
    const f = (ms: number, coin: string, side: string, px: string, sz: string) => ({ time: ms, coin, side, px, sz, hash: `0x${ms}` });
    const fills = [f(today - DAY + 1000, '@107', 'B', '40', '2'), f(today - DAY + 2000, '@107', 'A', '40', '1'), f(today - DAY + 3000, '@1', 'B', '1', '1'), f(today - 2 * DAY + 5, '@107', 'B', '10', '1')];
    const ctx = hypeCtx('2026-09-19T12:00:00.000Z', (_url, body) => {
      const b = body as { startTime: number; endTime: number };
      return fills.filter((x) => x.time >= b.startTime && x.time <= b.endTime);
    });
    const v = await getAdapter('hype.fund_buys_daily').run(ctx, { pair: '@107', days: 3 });
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    expect(v.points.map((p) => [p.day, p.value, p.slice])).toEqual([
      ['2026-09-17', 10, [fills[3]]],
      ['2026-09-18', 80, [fills[0]]],
    ]);
  });

  it('hype.reserve_yield_payments: a payment is the ledger sends it sums', async () => {
    const at = (iso: string) => Date.parse(iso);
    const send = (iso: string, amount: string, token = 'USDC') => ({ time: at(iso), hash: `0x${at(iso)}`, delta: { type: 'send', token, user: INTEREST, destination: FUND, amount } });
    const ledger = [send('2026-09-08T10:00:00Z', '2'), send('2026-09-09T10:00:00Z', '100'), send('2026-09-09T11:00:00Z', '7', 'HYPE'), send('2026-10-08T10:00:00Z', '50')];
    const ctx = hypeCtx('2026-10-20T12:00:00.000Z', () => ledger);
    const v = await getAdapter('hype.reserve_yield_payments').run(ctx, { interest: 'system_interest', fund: 'assistance_fund', treasury: ['aqa_treasury'], token: 'USDC', started: '2026-08-01', interval_days: 30, lag_days: 8 });
    if (v.kind !== 'periodic_payments') throw new Error(v.kind);
    expect(v.payments.map((p) => [p.from, p.value, p.slice])).toEqual([
      ['2026-08-01', 102, [ledger[0], ledger[1]]],
      ['2026-08-31', 50, [ledger[3]]],
    ]);
  });
});
