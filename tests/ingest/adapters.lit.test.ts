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

  it('without tranches the value is unchanged (golden: the existing fixture result, byte for byte)', async () => {
    // Captured from the adapter before tranches existed (HEAD 6cd6caf).
    expect(await read(['Team', 'Investors'])).toEqual({
      kind: 'level', value: 132779142.85714285, observedAt: NOW, source: 'api',
      detail: 'https://defillama-datasets.llama.fi/emissions/lighter unlocks over the next 365 days: Team 69.05M, Investors 63.73M',
    });
  });
});

describe("LIT unlocks over the next year, on the issuer's own tranche schedule", () => {
  const URL_ = 'https://defillama-datasets.llama.fi/emissions/lighter';
  const sec = (iso: string) => Date.parse(iso) / 1000;
  const t0 = sec('2026-12-29T00:00:00Z');
  /** DefiLlama's curve: linear weekly from 2026-12-29 over three years to `total`, daily points, flat after. */
  const linearTo = (total: number) => Array.from({ length: 1300 }, (_, i) => ({ timestamp: t0 + (i - 80) * 86_400, unlocked: Math.min(total, Math.max(0, ((i - 80) * total) / 1095)) }));
  const linearBody = { documentedData: { data: [{ label: 'Team', data: linearTo(300_000_000) }, { label: 'Investors', data: linearTo(198_000_000) }] } };
  const read = (nowIso: string, params: Record<string, unknown>, body: unknown = linearBody) =>
    getAdapter('lit.unlocks_next_year').run(sourceCtx({ nowIso, http: fakeHttp({ [URL_]: body }) }), params);
  const level = async (p: Promise<unknown>) => {
    const v = (await p) as { kind: string; value: number; detail: string };
    if (v.kind !== 'level') throw new Error('expected a level');
    return v;
  };

  it('tranches: 36 monthly from 2027-01-29 counts 9 tranches at 2026-10-23', async () => {
    const v = await level(read('2026-10-23T12:00:00.000Z', { allocations: ['Team', 'Investors'], tranches: { first: '2027-01-29', every_months: 1, count: 36 } }));
    // The schedule starts 2026-12-29 (nothing unlocked yet), so A is the final cumulative: 300M and 198M, over 36 tranches;
    // 2027-01-29 .. 2027-09-29 fall in (now, now + 365d].
    expect(v.value).toBeCloseTo((9 / 36) * 498_000_000, 0);
    expect(v.value).toBeCloseTo(124_500_000, 0);
    expect(v.detail).toBe(`${URL_} unlocks over the next 365 days: Team 75.00M, Investors 49.50M; tranches 36 x 1mo from 2027-01-29`);
  });

  it('A is the final cumulative minus the cumulative at the schedule start (first minus every_months)', async () => {
    const params = { allocations: ['Team'], tranches: { first: '2028-03-27', every_months: 3, count: 3 } };
    // Start 2027-12-27, 363 days into the curve: 300M x 363/1095 is already out, the rest is split over 2028-03-27, -06-27, -09-27.
    const a = 300_000_000 - (300_000_000 * 363) / 1095;
    expect((await level(read('2027-12-01T00:00:00.000Z', params))).value).toBeCloseTo(a, 0);
    // A year that ends before the first tranche counts none of it.
    expect((await level(read('2027-01-01T00:00:00.000Z', params))).value).toBe(0);
  });

  it('clamps the day to month end (first 2027-01-31 -> 2027-02-28)', async () => {
    const step = { documentedData: { data: [{ label: 'Team', data: [
      { timestamp: sec('2026-12-31T00:00:00Z'), unlocked: 100 },
      { timestamp: sec('2027-01-02T00:00:00Z'), unlocked: 150 },
      { timestamp: sec('2027-02-28T00:00:00Z'), unlocked: 200 },
      { timestamp: sec('2027-03-03T00:00:00Z'), unlocked: 300 },
      { timestamp: sec('2030-01-01T00:00:00Z'), unlocked: 1300 },
    ] }] } };
    const tr = (first: string, count: number) => ({ allocations: ['Team'], tranches: { first, every_months: 1, count } });
    // Tranche 1 of 2027-01-31 falls on 2027-02-28: at exactly that instant it is not in (now, now + 365d], one ms earlier it is.
    // Start 2026-12-31 (cumulative 100): A = 1200, two tranches of 600.
    expect((await level(read('2027-02-28T00:00:00.000Z', tr('2027-01-31', 2), step))).value).toBe(0);
    expect((await level(read('2027-02-27T23:59:59.999Z', tr('2027-01-31', 2), step))).value).toBe(600);
    // The start clamps too: first 2027-03-31 starts 2027-02-28 (cumulative 200), not 2027-03-03: A = 1100, four of 275.
    const v = await level(read('2027-03-01T00:00:00.000Z', tr('2027-03-31', 4), step));
    expect(v.value).toBe(1100);
    expect(v.detail).toMatch(/; tranches 4 x 1mo from 2027-03-31$/);
  });

  it('counts a tranche at now + 365d and not one at now', async () => {
    const params = { allocations: ['Team', 'Investors'], tranches: { first: '2028-01-29', every_months: 1, count: 1 } };
    // The schedule starts 2027-12-29, a year into the curve: A = 498M less the year already out.
    const a = 498_000_000 - (498_000_000 * 365) / 1095;
    expect((await level(read('2028-01-29T00:00:00.000Z', params))).value).toBe(0);
    expect((await level(read('2027-01-29T00:00:00.000Z', params))).value).toBeCloseTo(a, 0);
    expect((await level(read('2027-01-28T23:59:59.999Z', params))).value).toBe(0);
  });

  it('validateParams refuses a bad date, every_months 0 or 13, count 0 or 121, non-integers, unknown keys in tranches', () => {
    const def = getAdapter('lit.unlocks_next_year');
    const v = (params: Record<string, unknown>) => def.validateParams!(params);
    const ok = { first: '2027-01-29', every_months: 1, count: 36 };
    const t = (over: Record<string, unknown>) => v({ allocations: ['Team'], tranches: { ...ok, ...over } });
    expect(v({ allocations: ['Team', 'Investors'] })).toEqual([]);
    expect(v({ allocations: ['Team'], tranches: ok })).toEqual([]);
    expect(t({ every_months: 12, count: 120, first: '2028-02-29' })).toEqual([]);
    for (const first of ['2027-02-30', '2027-1-29', '29/01/2027', '2027-01-29T00:00:00Z', 20270129, null]) expect(t({ first }), String(first)).toEqual([expect.stringMatching(/^tranches\.first/)]);
    for (const every_months of [0, 13, 1.5, '1']) expect(t({ every_months }), String(every_months)).toEqual([expect.stringMatching(/^tranches\.every_months/)]);
    for (const count of [0, 121, 2.5, '36']) expect(t({ count }), String(count)).toEqual([expect.stringMatching(/^tranches\.count/)]);
    expect(t({ cadence: 'monthly' })).toEqual(['tranches: unknown key "cadence" (first, every_months, count)']);
    expect(v({ allocations: ['Team'], tranches: { first: '2027-01-29' } })).toEqual([
      expect.stringMatching(/^tranches\.every_months/), expect.stringMatching(/^tranches\.count/),
    ]);
    for (const tranches of [null, [], 'monthly']) expect(v({ allocations: ['Team'], tranches }), String(tranches)).toEqual([expect.stringMatching(/^tranches: /)]);
    for (const allocations of [undefined, [], 'Team', ['Team', 3]]) expect(v({ allocations }), String(allocations)).toEqual([expect.stringMatching(/^allocations: /)]);
    expect(v({ allocations: ['Team'], tranche: ok })).toEqual(['unknown key "tranche" (url, allocations, tranches)']);
    expect(v({ allocations: ['Team'], url: 5 })).toEqual(['url: a string']);
  });

  it('documents its params; the treasury buys adapter does not', () => {
    expect(getAdapter('lit.unlocks_next_year').paramsDoc).toBe(
      "allocations: string[] (DefiLlama allocation labels, required); tranches?: { first: YYYY-MM-DD, every_months: 1..12, count: 1..120 }: the issuer's own tranche schedule; each allocation's remaining amount from the schedule start is split evenly over the tranches",
    );
    expect(getAdapter('lit.treasury_buys_daily').paramsDoc).toBeUndefined();
    expect(getAdapter('lit.treasury_buys_daily').validateParams).toBeUndefined();
  });

  it('refuses malformed tranches at run time too', async () => {
    await expect(read('2026-10-23T12:00:00.000Z', { allocations: ['Team'], tranches: { first: '2027-01-29', every_months: 0, count: 36 } })).rejects.toThrow(/tranches\.every_months/);
  });
});

// Shape read on 2026-10-23 from Lighter's exchangeMetrics: one row per UTC day from the kind's first day, `timestamp`
// the day's start in seconds, `data` the day's total.
describe("LIT exchange fees per UTC day, from Lighter's exchangeMetrics", () => {
  const NOW23 = '2026-10-23T12:00:00.000Z';
  const today23 = Date.parse('2026-10-23T00:00:00Z');
  const RH = 'https://api.rh.lighter.xyz/api/v1';
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  /** `days` completed days ending yesterday (plus today's partial row), value `f(daysAgo)`. */
  const metrics = (days: number, f: (ago: number) => unknown, skipAgo: number[] = []) => {
    const rows: { timestamp: number; data: unknown }[] = [];
    for (let ago = days; ago >= 0; ago--) if (!skipAgo.includes(ago)) rows.push({ timestamp: (today23 - ago * DAY) / 1000, data: ago === 0 ? 999_999 : f(ago) });
    return { code: 200, metrics: rows };
  };
  const route = (byKind: Record<string, unknown>) => (url: string) => {
    const u = new URL(url);
    expect(u.searchParams.get('period')).toBe('all');
    const kind = u.searchParams.get('kind')!;
    if (!(kind in byKind)) throw new Error(`test bug: no kind ${kind}`);
    return structuredClone(byKind[kind]);
  };
  const read = (byKind: Record<string, unknown>, params: Record<string, unknown>, backfillDays?: number, api = API) => {
    const http = fakeHttp({ [`${api}/exchangeMetrics`]: route(byKind) });
    const ctx = sourceCtx({ nowIso: NOW23, http, ...(backfillDays !== undefined ? { backfillDays } : {}) });
    return { http, result: getAdapter('lit.exchange_fees_daily').run(ctx, params) };
  };
  const series = async (p: Promise<unknown>) => {
    const v = (await p) as { kind: string; points: { day: string; value: number }[]; detail: string };
    if (v.kind !== 'daily_series') throw new Error('expected a series');
    return v;
  };

  it('sums the kinds per UTC day and drops today', async () => {
    const v = await series(read({ maker_fee: metrics(5, (a) => 100 * a), taker_fee: metrics(5, (a) => a) }, { kinds: ['maker_fee', 'taker_fee'], days: 5 }).result);
    expect(v.points).toEqual([5, 4, 3, 2, 1].map((a) => ({ day: dayOf(today23 - a * DAY), value: 101 * a })));
    expect(v.points.some((p) => p.day === '2026-10-23')).toBe(false);
    expect(v.detail).toBe('lighter exchangeMetrics mainnet.zklighter.elliot.ai maker_fee+taker_fee (5 days)');
  });

  it("a day before a kind's first day counts 0 for that kind", async () => {
    const v = await series(read({ maker_fee: metrics(5, () => 10), taker_fee: metrics(3, () => 1) }, { kinds: ['maker_fee', 'taker_fee'], days: 5 }).result);
    expect(v.points.map((p) => p.value)).toEqual([10, 10, 11, 11, 11]);
  });

  it("refuses a day missing inside a kind's range", async () => {
    const r = read({ maker_fee: metrics(5, () => 10), taker_fee: metrics(5, () => 1, [3]) }, { kinds: ['maker_fee', 'taker_fee'], days: 5 });
    await expect(r.result).rejects.toThrow(`exchangeMetrics taker_fee: ${dayOf(today23 - 3 * DAY)} missing`);
  });

  it('refuses a non-numeric data', async () => {
    const r = read({ maker_fee: metrics(5, (a) => (a === 2 ? 'x' : 1)) }, { kinds: ['maker_fee'], days: 5 });
    await expect(r.result).rejects.toThrow(/maker_fee/);
    await expect(read({ maker_fee: { code: 200 } }, { kinds: ['maker_fee'] }).result).rejects.toThrow(/no metrics list/);
  });

  it('refuses a window with no completed day', async () => {
    // Only today's partial row: nothing completed to report.
    await expect(read({ maker_fee: metrics(0, () => 1) }, { kinds: ['maker_fee'] }).result).rejects.toThrow(/no completed day/);
  });

  it('returns the last --backfill-days completed days', async () => {
    const long = metrics(400, () => 2);
    const deep = await series(read({ maker_fee: long }, { kinds: ['maker_fee'] }, 362).result);
    expect(deep.points.length).toBe(362);
    expect(deep.points[0].day).toBe(dayOf(today23 - 362 * DAY));
    expect(deep.points.at(-1)!.day).toBe('2026-10-22');
    const routine = await series(read({ maker_fee: long }, { kinds: ['maker_fee'] }).result);
    expect(routine.points.length).toBe(7);
  });

  it('uses params.api', async () => {
    const r = read({ maker_fee: metrics(9, () => 1) }, { api: RH, kinds: ['maker_fee'] }, undefined, RH);
    const v = await series(r.result);
    expect(r.http.calls.length).toBe(1);
    expect(r.http.calls.every((c) => c.url.startsWith(`${RH}/exchangeMetrics?period=all&kind=maker_fee`))).toBe(true);
    expect(v.detail).toContain('api.rh.lighter.xyz');
  });

  it('validateParams refuses empty, duplicate and unknown kinds, and days outside 1..30', () => {
    const v = (params: Record<string, unknown>) => getAdapter('lit.exchange_fees_daily').validateParams!(params);
    expect(v({ kinds: [] })).toHaveLength(1);
    expect(v({})).toHaveLength(1);
    expect(v({ kinds: ['maker_fee', 'maker_fee'] })).toEqual([expect.stringMatching(/duplicate.*maker_fee/)]);
    const unknown = v({ kinds: ['volume'] });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain('volume');
    expect(unknown[0]).toContain('maker_fee, taker_fee, transfer_fee, withdraw_fee, liquidation_fee, buyback, buyback_usdc');
    expect(v({ kinds: ['maker_fee'], days: 0 })).toEqual([expect.stringMatching(/^days/)]);
    expect(v({ kinds: ['maker_fee'], days: 31 })).toEqual([expect.stringMatching(/^days/)]);
    expect(v({ kinds: ['maker_fee'], days: 2.5 })).toEqual([expect.stringMatching(/^days/)]);
    expect(v({ kinds: ['maker_fee'], api: 5 })).toEqual(['api: a string']);
    expect(v({ kinds: ['maker_fee'], kind: 'x' })).toEqual(['unknown key "kind" (api, kinds, days)']);
    expect(v({ api: RH, kinds: ['maker_fee', 'taker_fee', 'transfer_fee', 'withdraw_fee'], days: 30 })).toEqual([]);
  });

  it('paramsDoc mentions api, kinds and days', () => {
    const doc = getAdapter('lit.exchange_fees_daily').paramsDoc!;
    for (const word of ['api', 'kinds', 'days']) expect(doc).toContain(word);
    expect(getAdapter('lit.exchange_fees_daily').needsRpc).toBe(false);
  });
});
