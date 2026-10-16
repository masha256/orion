import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

// Shapes read live on 2026-10-16 from Lighter's API (trades: newest first, 100 a page, next_cursor) and DefiLlama's
// emissions dataset (documentedData.data[].data[]: cumulative `unlocked` per day).
const NOW = '2026-10-16T12:00:00.000Z';
const API = 'https://mainnet.zklighter.elliot.ai/api/v1';
const DAY = 86_400_000;
const today = Date.parse('2026-10-16T00:00:00Z');

interface Trade { timestamp: number; price: string; size: string; bid_account_id: number; ask_account_id: number; market_id: number }

/** `perDay` trades a day for `days` days back from today (plus some of today), every one bought by account 0 at 3.0. */
function history(days: number, perDay: number, over: (t: Trade, i: number) => Trade = (t) => t): Trade[] {
  const out: Trade[] = [];
  let i = 0;
  // Today's trades are newest, then each earlier day, newest first within the day.
  for (let k = 0; k < 3; k++) out.push(over({ timestamp: today + 3_600_000 * (3 - k), price: '3.0', size: '100', bid_account_id: 0, ask_account_id: 77, market_id: 2049 }, i++));
  for (let d = 1; d <= days; d++) {
    for (let k = 0; k < perDay; k++) {
      out.push(over({ timestamp: today - (d - 1) * DAY - 1 - k * 60_000, price: '3.0', size: '10', bid_account_id: 0, ask_account_id: 77, market_id: 2049 }, i++));
    }
  }
  return out;
}

/** The trades endpoint over `trades`: 100 a page, the cursor being the next offset. */
function tradesRoute(trades: Trade[]) {
  return (url: string) => {
    const u = new URL(url);
    expect(u.searchParams.get('account_index')).toBe('0');
    expect(u.searchParams.get('market_id')).toBe('2049');
    const from = Number(u.searchParams.get('cursor') ?? '0');
    const page = trades.slice(from, from + 100);
    return { code: 200, trades: page, next_cursor: from + 100 < trades.length ? String(from + 100) : undefined };
  };
}

const run = (trades: Trade[], params: Record<string, unknown> = {}, backfillDays?: number) => {
  const http = fakeHttp({ [`${API}/trades`]: tradesRoute(trades) });
  const ctx = sourceCtx({ nowIso: NOW, http, ...(backfillDays !== undefined ? { backfillDays } : {}) });
  return { http, result: getAdapter('lit.treasury_buys_daily').run(ctx, { account: 0, market: 2049, ...params }) };
};

describe("LIT's treasury buys, from Lighter's trades", () => {
  it('is registered and needs no chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['lit.treasury_buys_daily', 'lit.unlocks_next_year']));
    expect(getAdapter('lit.treasury_buys_daily').needsRpc).toBe(false);
  });

  it('sums the completed days the account bid on, in USD or LIT, leaving out today', async () => {
    const trades = history(10, 30);
    const usd = await run(trades).result;
    expect(usd.kind).toBe('daily_series');
    if (usd.kind !== 'daily_series') return;
    // The routine window: 7 completed days, 30 trades of 10 LIT at 3.0 each.
    expect(usd.points.map((p) => p.day)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
    expect(usd.points.every((p) => p.value === 900)).toBe(true);
    const tokens = await run(trades, { unit: 'tokens' }).result;
    if (tokens.kind !== 'daily_series') throw new Error('expected a series');
    expect(tokens.points.every((p) => p.value === 300)).toBe(true);
    expect(tokens.detail).toContain('LIT bought');
  });

  it('stops paging once it passes the first day wanted, and reads further back on --backfill-days', async () => {
    const trades = history(40, 30);
    const routine = run(trades);
    await routine.result;
    // 7 days x 30 + 3 of today = 213 trades: the 3rd page holds the first trade older than the window.
    expect(routine.http.calls.length).toBe(3);
    const deep = run(trades, {}, 30);
    const v = await deep.result;
    if (v.kind !== 'daily_series') throw new Error('expected a series');
    expect(v.points.length).toBe(30);
    expect(v.points[0].day).toBe('2026-09-16');
  });

  it("counts only the account's bids: a sell is flagged in the detail, never netted; other markets are ignored", async () => {
    const trades = history(8, 10, (t, i) => (i === 20 ? { ...t, bid_account_id: 9, ask_account_id: 0 } : i === 21 ? { ...t, market_id: 2050 } : t));
    const v = await run(trades).result;
    if (v.kind !== 'daily_series') throw new Error('expected a series');
    const day = v.points.find((p) => p.day === '2026-10-14')!;
    expect(day.value).toBe(8 * 30);
    expect(v.detail).toContain('SOLD 30 USD of LIT (not netted)');
  });

  it("starts the day after the oldest trade when the API's memory ends inside the window (a partial day is never stored)", async () => {
    const trades = history(5, 10);
    const v = await run(trades, {}, 30).result;
    if (v.kind !== 'daily_series') throw new Error('expected a series');
    expect(v.points[0].day).toBe('2026-10-12');
    expect(v.points.length).toBe(4);
    expect(v.detail).toContain('history ends 2026-10-11');
  });

  it('writes a real zero for a day with no buy inside the walk', async () => {
    const trades = history(9, 10).filter((t) => new Date(t.timestamp).toISOString().slice(0, 10) !== '2026-10-13');
    const v = await run(trades).result;
    if (v.kind !== 'daily_series') throw new Error('expected a series');
    expect(v.points.find((p) => p.day === '2026-10-13')!.value).toBe(0);
  });

  it('fails rather than guessing: no buys, a malformed reply, a missing market, a runaway walk', async () => {
    await expect(run(history(9, 10, (t) => ({ ...t, bid_account_id: 5 }))).result).rejects.toThrow(/no buy by account 0 on market 2049/);
    const http = fakeHttp({ [`${API}/trades`]: { code: 200 } });
    await expect(getAdapter('lit.treasury_buys_daily').run(sourceCtx({ nowIso: NOW, http }), { market: 2049 })).rejects.toThrow(/no trades list/);
    await expect(getAdapter('lit.treasury_buys_daily').run(sourceCtx({ nowIso: NOW, http }), {})).rejects.toThrow(/params.market/);
    // The cap: 20 pages plus max_pages_per_day per day wanted; 2,700 trades to reach the window's start need 28.
    await expect(run(history(9, 300), { max_pages_per_day: 0 }).result).rejects.toThrow(/refusing a partial series/);
  });
});

describe('LIT unlocks over the next year, from DefiLlama emissions', () => {
  const t0 = Date.parse('2026-12-29T00:00:00Z') / 1000;
  /** Linear from 2026-12-29 at `perWeek` tokens, daily points for four years; the airdrop a cliff in 2025. */
  const linear = (perWeek: number) => Array.from({ length: 1461 }, (_, i) => ({ timestamp: t0 + (i - 80) * 86_400, unlocked: Math.max(0, ((i - 80) * perWeek) / 7) }));
  const body = {
    documentedData: {
      data: [
        { label: 'Seasons 1 and 2 Airdrop', data: [{ timestamp: 1766966400, unlocked: 250_000_000 }] },
        { label: 'Team', data: linear(1_661_000) },
        { label: 'Investors', data: linear(1_533_000) },
      ],
    },
  };
  const read = (allocations: unknown) =>
    getAdapter('lit.unlocks_next_year').run(sourceCtx({ nowIso: NOW, http: fakeHttp({ 'https://defillama-datasets.llama.fi/emissions/lighter': body }) }), { allocations });

  it('sums the named allocations unlocking in the next 365 days: the cliff 74 days out leaves 291 days', async () => {
    const v = await read(['Team', 'Investors']);
    if (v.kind !== 'level') throw new Error('expected a level');
    const days = 365 - 74;
    expect(v.value).toBeCloseTo((days * (1_661_000 + 1_533_000)) / 7, -3);
    expect(v.detail).toContain('Team ');
    expect(v.source).toBe('api');
  });

  it('fails on an allocation the dataset does not have, or none named', async () => {
    await expect(read(['Advisors'])).rejects.toThrow(/no allocation "Advisors"/);
    await expect(read([])).rejects.toThrow(/params.allocations/);
  });
});
