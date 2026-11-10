import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { insertObservation } from '../../src/db/observations.js';
import { compareUsd, evmTokenRef, HOURLY_SERIES_DAYS, listFlowUsd, listPrices, pricedHourlyAtIngest, upsertPrices, upsertToken, USD_TOKEN } from '../../src/db/prices.js';
import { parseMarketChart } from '../../src/ingest/flow.js';
import { COINGECKO_PRICE_SOURCE, fetchHourlyRange, hourlyPriceRows } from '../../src/prices/coingeckoHourly.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

const testDb = useTestDb();
const REF = evmTokenRef(1, '0xD533a949740bb3306d119CC777fa900bA034cd52');
const TOKEN = { tokenRef: REF, symbol: 'CRV', decimals: 18, coingeckoId: 'curve-dao-token' };
const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

/** A flow row for `day` (UTC), with optional token columns. */
async function flowRow(day: string, value: number, tokens?: { amount: number; hourly: number[] | null; ref?: string }, over: { metricKey?: string; fetchedAt?: string } = {}) {
  return await insertObservation(testDb(), {
    assetId: 'crv', metricKey: over.metricKey ?? 'flow_usd.fees', observedAt: new Date(at(`${day}T00:00:00Z`) + 86_400_000).toISOString(), periodDays: 1, value,
    fetchedAt: over.fetchedAt ?? '2026-11-05T06:00:00Z', provenance: testProvenance('onchain'),
    ...(tokens ? { tokens: { tokenRef: tokens.ref ?? REF, amount: tokens.amount, hourlyAmounts: tokens.hourly } } : {}),
  });
}

const view = async (id: number) =>
  await testDb().one<{ usd: number; usd_basis: string; legacy_usd: number; usd_hourly: number | null; hours_priced: number; hours_needed: number }>(
    'SELECT usd, usd_basis, legacy_usd, usd_hourly, hours_priced, hours_needed FROM flow_usd_v WHERE id = $1', [id],
  );

/** Hourly prices for every hour of `day` at `price(hour)`. */
const dayPrices = (day: string, price: (h: number) => number) =>
  Array.from({ length: 24 }, (_, h) => ({ ts: new Date(at(`${day}T00:00:00Z`) + h * H).toISOString(), priceUsd: price(h) }));

describe('prices', () => {
  it('prices: CoinGecko points are floored to the hour; a re-fetch is idempotent (PK)', async () => {
    const chart = { prices: [[at('2026-11-01T10:03:12Z'), 2], [at('2026-11-01T11:02:59Z'), 3], [at('2026-11-01T11:47:00Z'), 3.5], [at('2026-11-01T12:00:00Z'), 4]] };
    const rows = hourlyPriceRows(parseMarketChart(chart, 'x'));
    // Floored to the top of the hour; of two points in one hour, the earlier (the hourly point, not the live one).
    expect(rows).toEqual([
      { ts: '2026-11-01T10:00:00.000Z', priceUsd: 2 }, { ts: '2026-11-01T11:00:00.000Z', priceUsd: 3 }, { ts: '2026-11-01T12:00:00.000Z', priceUsd: 4 },
    ]);
    await upsertToken(testDb(), TOKEN);
    expect(await upsertPrices(testDb(), REF, COINGECKO_PRICE_SOURCE, rows, '2026-11-01T13:00:00Z')).toBe(3);
    // The same hours again (a revised price): no new row, the newer fetch wins.
    expect(await upsertPrices(testDb(), REF, COINGECKO_PRICE_SOURCE, [{ ts: '2026-11-01T11:00:00.000Z', priceUsd: 3.1 }, ...rows.slice(2)], '2026-11-02T13:00:00Z')).toBe(2);
    const stored = await listPrices(testDb(), REF);
    expect(stored.map((p) => [p.ts, p.priceUsd, p.fetchedAt])).toEqual([
      ['2026-11-01T10:00:00.000Z', 2, '2026-11-01T13:00:00.000Z'], ['2026-11-01T11:00:00.000Z', 3.1, '2026-11-02T13:00:00.000Z'], ['2026-11-01T12:00:00.000Z', 4, '2026-11-02T13:00:00.000Z'],
    ]);
    // Off the hour, non-positive, or twice in one call: refused before anything is written.
    await expect(upsertPrices(testDb(), REF, 'coingecko', [{ ts: '2026-11-01T10:30:00.000Z', priceUsd: 1 }], '2026-11-01T13:00:00Z')).rejects.toMatchObject({ code: 'invalid_price' });
    await expect(upsertPrices(testDb(), REF, 'coingecko', [{ ts: '2026-11-01T10:00:00.000Z', priceUsd: 0 }], '2026-11-01T13:00:00Z')).rejects.toMatchObject({ code: 'invalid_price' });
    await expect(upsertPrices(testDb(), REF, 'coingecko', [rows[0]!, rows[0]!], '2026-11-01T13:00:00Z')).rejects.toMatchObject({ code: 'invalid_price' });
    // A token is recorded once; a later write fills a missing coingecko id but never replaces one.
    await upsertToken(testDb(), { ...TOKEN, coingeckoId: 'other' });
    expect(await testDb().one('SELECT symbol, decimals, coingecko_id FROM tokens WHERE token_ref = $1', [REF])).toEqual({ symbol: 'CRV', decimals: 18, coingecko_id: 'curve-dao-token' });
  });

  it('fetchHourlyRange walks back in windows of at most 89 days and stops at the first failing one (the reach of the key)', async () => {
    const now = at('2026-11-05T00:00:00Z');
    const from = now - 200 * 86_400_000;
    let n = 0;
    const http = fakeHttp({
      'https://api.coingecko.com/api/v3/coins/curve-dao-token/market_chart/range': (url: string) => {
        n++;
        if (n === 3) throw new Error('HTTP 401');
        const u = new URL(url);
        const a = Number(u.searchParams.get('from')) * 1000;
        const b = Number(u.searchParams.get('to')) * 1000;
        expect(b - a).toBeLessThanOrEqual(89 * 86_400_000);
        return { prices: [[a, 1], [b, 2]] };
      },
    });
    const r = await fetchHourlyRange(http, {}, 'curve-dao-token', from, now);
    expect(r.requests).toBe(3);
    expect(r.reachedMs).toBe(now - 178 * 86_400_000);
    expect(r.failures).toEqual([expect.stringMatching(/2026-04-19 to 2026-05-11: HTTP 401/)]);
    expect(r.points.map((p) => p.ts)).toEqual([...r.points.map((p) => p.ts)].sort((a, b) => a - b));
  });
});

describe('flow_usd_v', () => {
  it('flow_usd_v falls back to legacy_usd and labels it when hours lack prices', async () => {
    await upsertToken(testDb(), TOKEN);
    const hourly = Array.from({ length: 24 }, (_, h) => (h === 3 ? 2 : h === 20 ? 1.5 : 0));
    // Day 1: every hour priced (price = 10 + hour). 3.5 tokens: 2 x 13 + 1.5 x 30 = 71.
    await upsertPrices(testDb(), REF, 'coingecko', dayPrices('2026-10-01', (h) => 10 + h), '2026-10-02T00:00:00Z');
    const priced = await flowRow('2026-10-01', 70.9, { amount: 3.5, hourly });
    expect(await view(priced.id)).toEqual({ usd: 71, usd_basis: 'hourly', legacy_usd: 70.9, usd_hourly: 71, hours_priced: 24, hours_needed: 2 });

    // Day 2: prices stop at 12:00, so hour 20 (with an amount) has none: the row keeps its legacy USD, labelled.
    await upsertPrices(testDb(), REF, 'coingecko', dayPrices('2026-10-02', () => 5).slice(0, 13), '2026-10-03T00:00:00Z');
    const gap = await flowRow('2026-10-02', 17.4, { amount: 3.5, hourly });
    expect(await view(gap.id)).toEqual({ usd: 17.4, usd_basis: 'legacy_unpriced', legacy_usd: 17.4, usd_hourly: null, hours_priced: 19, hours_needed: 2 });

    // A price more than 6 hours old is a gap, not a price: hour 20 would otherwise take 12:00's. Hours 13 to 18 take
    // 12:00's (at most 6 hours old), so 19 hours are priced above.

    // Hours with no amount need no price: a day whose only amount is in a priced hour is hourly.
    const early = await flowRow('2026-10-02', 10, { amount: 2, hourly: hourly.map((x, h) => (h === 3 ? x : 0)) }, { metricKey: 'flow_usd.other' });
    expect(await view(early.id)).toMatchObject({ usd: 10, usd_basis: 'hourly', hours_needed: 1 });

    // Tokens without hourly buckets (Solana's supply drop), no tokens at all, and a dollar series.
    const noHourly = await flowRow('2026-10-01', 9, { amount: 3, hourly: null }, { metricKey: 'flow_usd.supply_drop' });
    const noTokens = await flowRow('2026-10-01', 8, undefined, { metricKey: 'flow_usd.llama' });
    await upsertToken(testDb(), USD_TOKEN);
    const usd = await flowRow('2026-10-01', 7.25, { amount: 7.25, hourly: null, ref: 'usd' }, { metricKey: 'flow_usd.lighter' });
    expect(await view(noHourly.id)).toMatchObject({ usd: 9, usd_basis: 'legacy_no_hourly', usd_hourly: null, hours_priced: 0 });
    expect(await view(noTokens.id)).toMatchObject({ usd: 8, usd_basis: 'legacy_no_tokens', usd_hourly: null });
    expect(await view(usd.id)).toMatchObject({ usd: 7.25, usd_basis: 'usd_native' });

    // Only active flow rows: a superseded row and a level are not in the view.
    const again = await flowRow('2026-10-01', 70.95, { amount: 3.5, hourly });
    expect(await view(priced.id)).toBeUndefined();
    expect(await view(again.id)).toMatchObject({ usd: 71 });
    const lvl = await insertObservation(testDb(), {
      assetId: 'crv', metricKey: 'total_supply', observedAt: '2026-10-01T12:00:00Z', value: 1, fetchedAt: '2026-10-01T12:00:00Z', provenance: testProvenance('onchain'),
    });
    expect(await view(lvl.id)).toBeUndefined();
    // A token flow is not in the view: its value is tokens, and legacy_usd must be dollars.
    const tokensRow = await flowRow('2026-10-01', 3.5, { amount: 3.5, hourly }, { metricKey: 'flow_tokens.fees' });
    expect(await view(tokensRow.id)).toBeUndefined();
  });

  it('flow_usd_v hour starts do not depend on the session TimeZone (DST change day 2026-11-01)', async () => {
    await upsertToken(testDb(), TOKEN);
    // Every hour of 2026-11-01 at 10 + hour, and 99 in the last hour of the day before: an hour bucket priced one hour
    // early (calendar-day arithmetic in America/Los_Angeles, where 2026-11-01 has 25 hours) would take a different price.
    await upsertPrices(testDb(), REF, 'coingecko', [...dayPrices('2026-10-31', () => 99), ...dayPrices('2026-11-01', (h) => 10 + h)], '2026-11-02T00:00:00Z');
    const hourly = Array.from({ length: 24 }, (_, h) => (h === 0 ? 1 : h === 1 ? 2 : h === 23 ? 3 : 0));
    const row = await flowRow('2026-11-01', 120, { amount: 6, hourly });
    const expected = { usd: 1 * 10 + 2 * 11 + 3 * 33, usd_basis: 'hourly', hours_priced: 24, hours_needed: 3 };
    expect(await view(row.id)).toMatchObject(expected);
    const underLa = await testDb().tx(async (t) => {
      await t.run("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      return await t.one<{ usd: number; usd_basis: string; hours_priced: number; hours_needed: number }>(
        'SELECT usd, usd_basis, hours_priced, hours_needed FROM flow_usd_v WHERE id = $1', [row.id],
      );
    });
    expect(underLa).toMatchObject(expected);
  });
});

describe('the flow_usd_v naming rule', () => {
  it('every USD flow metric of every asset is named flow_usd.* and every flow_usd.* metric is USD (the view selects by name)', async () => {
    const { listAssetIds, loadAsset } = await import('../../src/config/load.js');
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const flows = listAssetIds(root).flatMap((id) => Object.entries(loadAsset(root, id).config.metrics).filter(([, d]) => d.type === 'flow').map(([k, d]) => ({ id, k, unit: d.unit })));
    expect(flows.length).toBeGreaterThan(50);
    expect(flows.filter((f) => f.k.startsWith('flow_usd.') !== (f.unit === 'usd'))).toEqual([]);
  });
});

describe('pricedHourlyAtIngest (correction 13: one rule for compareUsd and the report)', () => {
  it('a day starting within HOURLY_SERIES_DAYS of its fetch was priced hourly at ingest; earlier, daily', () => {
    expect(HOURLY_SERIES_DAYS).toBe(90);
    const fetched = '2026-11-05T06:00:00Z';
    // observed_at = day end; the day starts 24 h earlier. Boundary: start == fetched - 90 d is within.
    expect(pricedHourlyAtIngest('2026-08-08T06:00:00Z', fetched)).toBe(true);
    expect(pricedHourlyAtIngest('2026-08-08T05:59:59.999Z', fetched)).toBe(false);
    expect(pricedHourlyAtIngest('2026-11-05T00:00:00Z', fetched)).toBe(true);
    expect(pricedHourlyAtIngest('2026-07-02T00:00:00Z', fetched)).toBe(false);
  });

  it('listFlowUsd: a fully priced row fetched > 90 days after its day reads its stored USD, labelled legacy', async () => {
    await upsertToken(testDb(), TOKEN);
    const hourly = Array.from({ length: 24 }, (_, h) => (h === 12 ? 10 : 0));
    await upsertPrices(testDb(), REF, 'coingecko', dayPrices('2026-07-01', () => 2), '2026-11-05T06:00:00Z');
    await upsertPrices(testDb(), REF, 'coingecko', dayPrices('2026-10-20', () => 2), '2026-11-05T06:00:00Z');
    const beyond = await flowRow('2026-07-01', 30, { amount: 10, hourly }, { fetchedAt: '2026-11-05T06:00:00Z' });
    const within = await flowRow('2026-10-20', 30, { amount: 10, hourly }, { fetchedAt: '2026-11-05T06:00:00Z' });
    expect((await view(beyond.id))!.usd_basis).toBe('hourly'); // the view alone cannot tell
    const got = await listFlowUsd(testDb(), 'crv');
    expect(got.get(beyond.id)).toEqual({ usd: 30, basis: 'legacy' });
    expect(got.get(within.id)).toEqual({ usd: 20, basis: 'hourly' });
  });
});

describe('compareUsd', () => {
  it('compare-usd separates days beyond the hourly series (correction 13)', async () => {
    await upsertToken(testDb(), TOKEN);
    const hourly = (tokens: number) => Array.from({ length: 24 }, (_, h) => (h === 12 ? tokens : 0));
    const fetchedAt = '2026-11-05T06:00:00Z'; // the nightly that wrote the rows: hourly CoinGecko reaches back 90 days from here
    // Within the hourly series (written within 90 days of their day): priced 10 now, legacy within a cent or so.
    for (const [day, legacy] of [['2026-10-20', 100.5], ['2026-10-21', 99], ['2026-10-22', 200]] as const) {
      await upsertPrices(testDb(), REF, 'coingecko', dayPrices(day, () => 10), fetchedAt);
      await flowRow(day, legacy, { amount: legacy === 200 ? 20 : 10, hourly: hourly(legacy === 200 ? 20 : 10) }, { fetchedAt });
    }
    // Beyond it: a day written more than 90 days after it ended (its legacy USD came from daily points). Hourly prices
    // exist now (the backfill fetched them), so it is re-priced, but reported apart.
    await upsertPrices(testDb(), REF, 'coingecko', dayPrices('2026-07-01', () => 2), fetchedAt);
    await flowRow('2026-07-01', 30, { amount: 10, hourly: hourly(10) }, { fetchedAt });
    // Beyond the key's reach: no hourly price at all, so it keeps value (counted, not in either sum).
    await flowRow('2026-06-01', 40, { amount: 10, hourly: hourly(10) }, { fetchedAt });
    // Not backfilled yet.
    await flowRow('2026-10-23', 50, undefined, { fetchedAt });
    // A tokens metric is not compared (its value is not USD).
    await flowRow('2026-10-20', 10, { amount: 10, hourly: hourly(10) }, { metricKey: 'flow_tokens.fees', fetchedAt });

    const [row, ...rest] = await compareUsd(testDb(), { id: 'crv', metrics: { 'flow_usd.fees': { type: 'flow', unit: 'usd' }, 'flow_tokens.fees': { type: 'flow', unit: 'tokens' } } }, 200, { now: new Date('2026-11-05T12:00:00Z') });
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      metric: 'flow_usd.fees', days: 6, hourlyCovered: 3, sumLegacy: 399.5, sumHourly: 400, gapPct: expect.closeTo((400 / 399.5 - 1) * 100, 9),
      beyondHourly: 1, unpriced: 1, noTokens: 1,
      beyond: { days: 1, sumLegacy: 30, sumHourly: 20, gapPct: expect.closeTo(-100 / 3, 9) },
    });
    // Day gaps (absolute): 100.5 vs 100 (0.4975%), 99 vs 100 (1.0101%), 200 vs 200 (0).
    expect(row!.p50DayGapPct).toBeCloseTo((0.5 / 100.5) * 100, 9);
    expect(row!.p90DayGapPct).toBeCloseTo((1 / 99) * 100, 9);
    // A shorter window leaves the old days out.
    const [recent] = await compareUsd(testDb(), { id: 'crv', metrics: { 'flow_usd.fees': { type: 'flow', unit: 'usd' } } }, 20, { now: new Date('2026-11-05T12:00:00Z') });
    expect(recent).toMatchObject({ days: 4, hourlyCovered: 3, beyondHourly: 0, unpriced: 0, noTokens: 1 });
  });

  it('compare-usd counts a day whose legacy USD is 0 in the day-gap percentiles (100% when hourly is not 0)', async () => {
    await upsertToken(testDb(), TOKEN);
    const hourly = (tokens: number) => Array.from({ length: 24 }, (_, h) => (h === 12 ? tokens : 0));
    const fetchedAt = '2026-11-05T06:00:00Z';
    for (const day of ['2026-10-20', '2026-10-21', '2026-10-22']) await upsertPrices(testDb(), REF, 'coingecko', dayPrices(day, () => 10), fetchedAt);
    await flowRow('2026-10-20', 100, { amount: 10, hourly: hourly(10) }, { fetchedAt }); // 0%
    await flowRow('2026-10-21', 0, { amount: 0, hourly: hourly(0) }, { fetchedAt }); // 0 vs 0: 0%
    await flowRow('2026-10-22', 0, { amount: 1, hourly: hourly(1) }, { fetchedAt }); // 0 vs 10: 100%
    const [row] = await compareUsd(testDb(), { id: 'crv', metrics: { 'flow_usd.fees': { type: 'flow', unit: 'usd' } } }, 30, { now: new Date('2026-11-05T12:00:00Z') });
    expect(row).toMatchObject({ hourlyCovered: 3, sumLegacy: 100, sumHourly: 110, p50DayGapPct: 0, p90DayGapPct: 100, legacyZeroDays: 1 });
  });
});
