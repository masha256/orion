import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { insertObservation } from '../../src/db/observations.js';
import { evmTokenRef, upsertPrices, upsertToken, USD_TOKEN } from '../../src/db/prices.js';
import type { Db } from '../../src/db/connection.js';
import { addDays } from '../../src/ingest/time.js';
import type { HolderYieldReport, ReportInput } from '../../src/report/holderYield.js';
import { loadHolderYieldReport, yieldReport } from '../../src/report/load.js';
import { MINI_REPORT_YAML } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE } from '../helpers/provenance.js';

/**
 * Task 8 (after G2): income statement v2 reads tokens x prices (flow_usd_v) where a row's hourly coverage is full, else
 * the stored USD; each line says which (`priceBasis`). The legacy (v1) keys keep reading `value`, byte for byte.
 */
const testDb = useTestDb();
const asset = parseAssetYaml(MINI_REPORT_YAML).config; // window 10, revenue = holders = flow_usd.fees
const REF = evmTokenRef(1, '0x00000000000000000000000000000000000000aa');
const DAY = '2026-10-10';
const YEAR = 365;

type Kind = 'hourly' | 'partial' | 'usd' | 'none';

/**
 * flow_usd.fees for the `days` days to `last`: value 100; tokens per `kind(i)` (i = 0 is `last`). `fetched(i)` is the row's
 * fetched_at (default: the day after `last`, so every day is inside the hourly series at ingest).
 */
async function seed(db: Db, last: string, kind: (i: number) => Kind, days = 25, fetched?: (i: number) => string): Promise<void> {
  await upsertToken(db, { tokenRef: REF, symbol: 'MINI', decimals: 18, coingeckoId: 'mini' });
  await upsertToken(db, USD_TOKEN);
  const end = `${addDays(last, 1)}T00:00:00.000Z`;
  for (let i = 0; i < days; i++) {
    const day = addDays(last, -i);
    const k = kind(i);
    // 10 tokens in hour 12 (priced 10.5: 105 USD by the hour); `partial` also has 1 token in hour 3, never priced.
    const hourly = Array.from({ length: 24 }, (_, h) => (h === 12 ? 10 : k === 'partial' && h === 3 ? 1 : 0));
    if (k === 'hourly' || k === 'partial') await upsertPrices(db, REF, 'coingecko', [{ ts: `${day}T12:00:00.000Z`, priceUsd: 10.5 }], end);
    await insertObservation(db, {
      provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value: 100,
      source: k === 'none' ? 'api' : 'onchain', fetchedAt: fetched?.(i) ?? end,
      ...(k === 'hourly' || k === 'partial' ? { tokens: { tokenRef: REF, amount: k === 'partial' ? 11 : 10, hourlyAmounts: hourly } } : {}),
      ...(k === 'usd' ? { tokens: { tokenRef: 'usd', amount: 100, hourlyAmounts: null } } : {}),
    });
  }
  await insertObservation(db, { provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: 'price_usd', observedAt: end, value: 2, source: 'api', fetchedAt: end });
  await insertObservation(db, { provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: 'total_supply', observedAt: end, value: 1_000_000, source: 'onchain', fetchedAt: end });
}

const legacyOf = async (db: Db, day = DAY) => (await loadHolderYieldReport(db, asset, day, { legacy: true })) as HolderYieldReport;
const withoutStatement = (r: HolderYieldReport): Record<string, unknown> => {
  const { incomeStatement: _is, incomeStatementError: _e, ...rest } = r as unknown as Record<string, unknown>;
  return rest;
};

describe('v2 reads tokens x prices where hourly coverage is full (Task 8)', () => {
  it('full coverage: v2 reads the hourly USD and every line says hourly; v1 keeps the stored value', async () => {
    const db = testDb();
    await seed(db, DAY, () => 'hourly');
    const r = await legacyOf(db);
    const is = r.incomeStatement!;
    expect(r.incomeStatementError).toBeUndefined();
    expect(is.revenue.annualized).toBe((10 * 105 * YEAR) / 10);
    expect(is.revenue.lines[0]).toMatchObject({ id: 'fees', priceBasis: 'hourly' });
    expect(is.holders.lines[0]).toMatchObject({ id: 'fees_paid', priceBasis: 'hourly' });
    expect(is.holderFlow.lines[0]).toMatchObject({ id: 'fees_paid', priceBasis: 'hourly', gross: (10 * 105 * YEAR) / 10 });
    expect(is.protocol.lines[0]).toMatchObject({ id: 'remainder', priceBasis: 'hourly' });
    // v2's yields are its own basis: the copied v1 figures come from the same daily series as the statement.
    expect(is.yields.cash).toBe(is.holderFlow.lines[0]!.yield);
    expect(is.priceBasis.flows).toMatch(/hourly/);
    // v1 (legacy keys) reads `value`.
    expect(r.income!.revenue.annualized).toBe((10 * 100 * YEAR) / 10);
    expect(r.yields.cash).toBe((10 * 100 * YEAR) / 10 / (1_000_000 * 2));
  });

  it('the legacy keys are byte-identical with and without prices (v1 never reads flow_usd_v)', async () => {
    const db = testDb();
    await seed(db, DAY, () => 'hourly');
    const priced = JSON.stringify(withoutStatement(await legacyOf(db)));
    await db.run('DELETE FROM prices');
    const unpriced = await legacyOf(db);
    expect(JSON.stringify(withoutStatement(unpriced))).toBe(priced);
    // Without prices every row falls back to its stored USD, and says so.
    expect(unpriced.incomeStatement!.revenue).toMatchObject({ annualized: (10 * 100 * YEAR) / 10 });
    expect(unpriced.incomeStatement!.revenue.lines[0]!.priceBasis).toBe('legacy');
  });

  it('partial coverage: the row keeps its stored USD (legacy); a window of both bases is mixed', async () => {
    const db = testDb();
    await seed(db, DAY, () => 'partial');
    const all = (await legacyOf(db)).incomeStatement!;
    expect(all.revenue.annualized).toBe((10 * 100 * YEAR) / 10);
    expect(all.revenue.lines[0]!.priceBasis).toBe('legacy');
    await db.run('DELETE FROM observations');
    await db.run('DELETE FROM prices');
    await seed(db, DAY, (i) => (i < 3 ? 'hourly' : 'partial'));
    const mixed = (await legacyOf(db)).incomeStatement!;
    expect(mixed.revenue.annualized).toBe(((3 * 105 + 7 * 100) * YEAR) / 10);
    expect(mixed.revenue.lines[0]!.priceBasis).toBe('mixed');
  });

  it('a row backfilled with daily prices (its day starts > HOURLY_SERIES_DAYS before fetched_at) reads its stored USD even with full hourly prices', async () => {
    const db = testDb();
    // Every row has full hourly coverage; the prior window's rows (i >= 10, window 10) were fetched long after their day,
    // so their stored USD came from daily prices at ingest (correction 13, compareUsd's `beyond`): G2 never signed them off.
    await seed(db, DAY, () => 'hourly', 25, (i) => (i >= 10 ? '2027-02-01T00:00:00.000Z' : `${addDays(DAY, -i + 1)}T00:00:00.000Z`));
    const r = await legacyOf(db);
    const line = r.incomeStatement!.revenue.lines[0]!;
    expect(line.growth.current).toBe(10 * 105);
    expect(line.growth.prior).toBe(10 * 100);
    expect(r.income!.revenue.growth.prior).toBe(10 * 100);
    // The label covers every day the line's figures read: hourly now, legacy in growth's prior window.
    expect(line.priceBasis).toBe('mixed');
  });

  it('priceBasis covers growth\'s prior window too: hourly now, legacy before is mixed', async () => {
    const db = testDb();
    await seed(db, DAY, (i) => (i < 10 ? 'hourly' : 'partial'));
    const is = (await legacyOf(db)).incomeStatement!;
    expect(is.revenue.annualized).toBe((10 * 105 * YEAR) / 10);
    expect(is.revenue.lines[0]!.growth).toMatchObject({ current: 10 * 105, prior: 10 * 100 });
    expect(is.revenue.lines[0]!.priceBasis).toBe('mixed');
    expect(is.holders.lines[0]!.priceBasis).toBe('mixed');
    expect(is.holderFlow.lines[0]!.priceBasis).toBe('mixed');
    expect(is.protocol.lines[0]!.priceBasis).toBe('mixed');
  });

  it('usd-native rows (a first-party API in dollars): usd_native, the amount', async () => {
    const db = testDb();
    await seed(db, DAY, () => 'usd');
    const is = (await legacyOf(db)).incomeStatement!;
    expect(is.revenue.annualized).toBe((10 * 100 * YEAR) / 10);
    expect(is.revenue.lines[0]!.priceBasis).toBe('usd_native');
  });

  it('DefiLlama / derived rows (no tokens): the stored USD, priceBasis legacy', async () => {
    const db = testDb();
    await seed(db, DAY, () => 'none');
    const r = await legacyOf(db);
    expect(r.incomeStatement!.revenue.annualized).toBe((10 * 100 * YEAR) / 10);
    expect(r.incomeStatement!.revenue.lines[0]!.priceBasis).toBe('legacy');
    expect(r.incomeStatement!.holderFlow.lines[0]!.priceBasis).toBe('legacy');
  });

  it('a DST day (2026-11-01, 25 hours in Los Angeles): the hourly USD and the day key do not depend on the session TimeZone', async () => {
    const db = testDb();
    const last = '2026-11-01';
    await seed(db, last, (i) => (i === 0 ? 'hourly' : 'none'));
    // A price 99 at 11:00 UTC: an hour bucket shifted one hour early (calendar-day arithmetic) would take it.
    await upsertPrices(db, REF, 'coingecko', [{ ts: '2026-11-01T11:00:00.000Z', priceUsd: 99 }], '2026-11-02T00:00:00Z');
    const want = ((9 * 100 + 105) * YEAR) / 10;
    const utc = (await legacyOf(db, last)).incomeStatement!;
    expect(utc.revenue.annualized).toBe(want);
    expect(utc.revenue.lines[0]!.priceBasis).toBe('mixed');
    const la = await db.tx(async (t) => {
      await t.run("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      return await legacyOf(t, last);
    });
    expect(la.day).toBe(last);
    expect(la.incomeStatement!.revenue.annualized).toBe(want);
    expect(JSON.stringify(la)).toBe(JSON.stringify(await legacyOf(db, last)));
  });

  it('the default (D9) shape carries the same statement as --legacy', async () => {
    const db = testDb();
    await seed(db, DAY, () => 'hourly');
    const slim = (await loadHolderYieldReport(db, asset, DAY)) as { incomeStatement: unknown };
    expect(slim.incomeStatement).toEqual((await legacyOf(db)).incomeStatement);
  });
});

describe('yieldReport with a statement basis (pure)', () => {
  const daily = (v: number) => new Map(Array.from({ length: 20 }, (_, i) => [addDays(DAY, -i), v] as const));
  const input: ReportInput = {
    asset, day: DAY, daily: new Map([['flow_usd.fees', daily(100)]]),
    levels: { price: 2, totalSupply: 1_000_000, circulatingSupply: null, stakedSupply: null, lockedSupply: null, emissionRateAnnual: null, extra: {}, disclosed: [] },
  };

  it('v1 reads `daily`, v2 reads `statementDaily`, and v2 lines label their days from `priceBasis`', () => {
    const r = yieldReport({ ...input, statementDaily: new Map([['flow_usd.fees', daily(105)]]), priceBasis: new Map([['flow_usd.fees', new Map([...daily(0).keys()].map((d) => [d, 'hourly'] as const))]]) }, { legacy: true });
    expect(r.income!.revenue.annualized).toBe((10 * 100 * YEAR) / 10);
    expect(r.incomeStatement!.revenue.annualized).toBe((10 * 105 * YEAR) / 10);
    expect(r.incomeStatement!.revenue.lines[0]!.priceBasis).toBe('hourly');
    const plain = yieldReport(input, { legacy: true });
    expect(JSON.stringify(withoutStatement(r))).toBe(JSON.stringify(withoutStatement(plain)));
  });

  it('without a statement basis (a pure input) v2 reads `daily` and labels every USD line legacy', () => {
    const r = yieldReport(input, { legacy: true });
    expect(r.incomeStatement!.revenue.annualized).toBe((10 * 100 * YEAR) / 10);
    expect(r.incomeStatement!.revenue.lines[0]!.priceBasis).toBe('legacy');
    expect(r.incomeStatement!.priceBasis.flows).toBe("each flow day's USD at that day's price (the stored value)");
  });
});
