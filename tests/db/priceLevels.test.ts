import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import type { Db, OrionDb } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { rebuildPriceLevels } from '../../src/db/priceLevels.js';
import { upsertPrices, upsertToken } from '../../src/db/prices.js';
import type { PriceEntry } from '../../src/prices/config.js';
import { purgeMetrics } from '../../src/db/purge.js';
import { latestLevel } from '../../src/observations/select.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const NOW = new Date('2026-11-14T12:00:00.000Z');
const H = 3_600_000;

const TOKEN_REF = 'eip155:8453/0x00000000000000000000000000000000000000a1';
const DIEM_REF = 'eip155:8453/0x00000000000000000000000000000000000000d1';
const HYPE_REF = 'hyperliquid:spot/@107';

/** price_usd on a price.token ref, diem_price_usd on another (VVV's shape). */
const LVL_YAML = `
id: lvl
symbol: LVL
name: Level Test
chain: base
contracts:
  token: "0x00000000000000000000000000000000000000a1"
ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 100 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true, source: { type: adapter, name: price.token, params: { ref: "${TOKEN_REF}" } } }
  diem_price_usd: { type: level, unit: usd, staleness_days: 7, source: { type: adapter, name: price.token, params: { ref: "${DIEM_REF}" } } }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
`;

/** AERO's shape: price_usd on its own pool adapter; the ref is the asset's `token` contract. */
const AERO_YAML = `
id: aer
symbol: AER
name: Aero Test
chain: base
contracts:
  token: "0x00000000000000000000000000000000000000A1"
  price_pool: "0x00000000000000000000000000000000000000c1"
  usdc_usd_feed: "0x00000000000000000000000000000000000000f1"
ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 100 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true, source: { type: adapter, name: chain.v2_pool_twap_price, params: { pool: price_pool, token: token, quote_decimals: 6, seconds: 3600, usd_feed: usdc_usd_feed } } }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
`;

/** HYPE's shape: a first-party candle ref. */
const HYP_YAML = `
id: hyp
symbol: HYP
name: Hype Test
contracts:
  zero: "0x0000000000000000000000000000000000000000"
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true, source: { type: adapter, name: price.token, params: { ref: "${HYPE_REF}" } } }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
`;

const load = (yaml: string, validFrom?: Record<string, string>): LoadedAsset => {
  const { config, hash } = parseAssetYaml(yaml);
  if (validFrom === undefined) return { config, hash };
  // Only validFrom is read by the rebuild and the purge (Ruling R38).
  return { config, hash, prices: new Map(Object.entries(validFrom).map(([ref, v]) => [ref, { ref, validFrom: v } as PriceEntry])) };
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'orion-levels-'));
  dirs.push(d);
  return d;
}

/** A CoinGecko-era level row (`market_data`), as the nightly wrote it. */
async function seedMarket(d: Db, assetId: string, metricKey: string, observedAt: string, value: number): Promise<number> {
  return (await insertObservation(d, {
    assetId, metricKey, observedAt, value, periodDays: null, fetchedAt: observedAt,
    provenance: { method: 'measured', sourceType: 'market_data', chain: null, locator: { provider: 'coingecko', endpoint: '/coins/markets' }, codeVersion: 'test', configHash: 'h' },
  })).id;
}

async function seedHourly(d: Db, ref: string, fromIso: string, hours: number, source: string, price: (i: number) => number, skip: number[] = []): Promise<void> {
  await upsertToken(d, { tokenRef: ref, symbol: 'T', decimals: 18, coingeckoId: null });
  const from = Date.parse(fromIso);
  const rows = [];
  for (let i = 0; i < hours; i++) if (!skip.includes(i)) rows.push({ ts: new Date(from + i * H).toISOString(), priceUsd: price(i) });
  await upsertPrices(d, ref, source, rows, '2026-11-14T00:00:00.000Z');
}

const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return 'no error';
};

const obsCount = async (): Promise<number> => Number((await db().one<{ n: number }>('SELECT count(*)::bigint AS n FROM observations'))!.n);

describe('rebuildPriceLevels', () => {
  it('per market_data row: a new active row from the newest chain price at or before observed_at - 1 h; refused (listed) beyond 6 h', async () => {
    const d = db();
    // Hourly chain prices 10-01 00:00 .. 10-03 23:00, price i = 1 + i / 100; a CoinGecko row at 10-03 too (never read).
    await seedHourly(d, TOKEN_REF, '2026-10-01T00:00:00Z', 72, 'chain:v2_twap', (i) => 1 + i / 100);
    await upsertPrices(d, TOKEN_REF, 'coingecko', [{ ts: '2026-10-02T23:00:00.000Z', priceUsd: 99 }], NOW.toISOString());
    // Nightly rows at 00:47 of 10-02 and 10-03: ts <= 23:47 of the day before -> the 23:00 row (i = 23, 47).
    const a = await seedMarket(d, 'lvl', 'price_usd', '2026-10-02T00:47:00.000Z', 1.3);
    const b = await seedMarket(d, 'lvl', 'price_usd', '2026-10-03T00:47:00.000Z', 1.6);
    // 10-05 00:47: the newest chain row is 10-03 23:00, 24.8 h old: refused.
    const c = await seedMarket(d, 'lvl', 'price_usd', '2026-10-05T00:47:00.000Z', 1.9);
    // diem_price_usd on its own ref: 10-02 00:00 - 1 h = 10-01 23:00 missing, 10-01 20:00 present (within 6 h).
    await seedHourly(d, DIEM_REF, '2026-10-01T00:00:00Z', 24, 'chain:v2_twap', (i) => 50 + i, [21, 22, 23]);
    const e = await seedMarket(d, 'lvl', 'diem_price_usd', '2026-10-02T00:00:00.000Z', 70);
    const before = await obsCount();

    const dry = await rebuildPriceLevels(d, load(LVL_YAML), { yes: false, now: NOW });
    expect(dry.applied).toBe(false);
    expect(dry.perMetric).toEqual([
      { metric: 'diem_price_usd', tokenRef: DIEM_REF, rows: 1, rebuilt: 1, beforeValidFrom: [], refused: [] },
      {
        metric: 'price_usd', tokenRef: TOKEN_REF, rows: 3, rebuilt: 2, beforeValidFrom: [],
        refused: [{ id: c, observedAt: '2026-10-05T00:47:00.000Z', reason: `no chain/first-party price of ${TOKEN_REF} in the 6 h to 2026-10-04T23:47:00.000Z` }],
      },
    ]);
    expect(await obsCount()).toBe(before);

    const r = await rebuildPriceLevels(d, load(LVL_YAML), { yes: true, now: NOW, release: 'orion-2026.11.14.1' });
    expect(r.applied).toBe(true);
    expect(await obsCount()).toBe(before + 3);
    const rows = await d.all<{ id: number; metric_key: string; observed_at: string; value: number; method: string; source_type: string; chain: string; locator: Record<string, unknown>; superseded_by: number | null; code_version: string }>(
      "SELECT id, metric_key, observed_at, value, method, source_type, chain, locator, superseded_by, code_version FROM observations WHERE source_type <> 'market_data' ORDER BY metric_key, observed_at",
    );
    expect(rows.map((x) => [x.metric_key, new Date(x.observed_at).toISOString(), x.value])).toEqual([
      ['diem_price_usd', '2026-10-02T00:00:00.000Z', 70],
      ['price_usd', '2026-10-02T00:47:00.000Z', 1.23],
      ['price_usd', '2026-10-03T00:47:00.000Z', 1.47],
    ]);
    expect(rows[1]).toMatchObject({
      method: 'derived', source_type: 'contract_state', chain: 'eip155:8453', superseded_by: null, code_version: 'orion-2026.11.14.1',
      locator: { from: 'prices', token_ref: TOKEN_REF, ts: '2026-10-01T23:00:00.000Z', source: 'chain:v2_twap' },
    });
    expect(rows[0]!.locator.ts).toBe('2026-10-01T20:00:00.000Z');
    // The CoinGecko rows are superseded by the rebuilt ones (never deleted here); c is left active (refused).
    const sup = await d.all<{ id: number; superseded_by: number | null }>("SELECT id, superseded_by FROM observations WHERE source_type = 'market_data' ORDER BY id");
    expect(sup.find((x) => x.id === a)!.superseded_by).not.toBeNull();
    expect(sup.find((x) => x.id === b)!.superseded_by).not.toBeNull();
    expect(sup.find((x) => x.id === e)!.superseded_by).not.toBeNull();
    expect(sup.find((x) => x.id === c)!.superseded_by).toBeNull();

    // A second --yes finds only the refused row: nothing written.
    const again = await rebuildPriceLevels(d, load(LVL_YAML), { yes: true, now: NOW });
    expect(again.perMetric.map((m) => [m.metric, m.rows, m.rebuilt])).toEqual([['diem_price_usd', 0, 0], ['price_usd', 1, 0]]);
    expect(await obsCount()).toBe(before + 3);
  });

  it('then `data purge --source-type market_data` succeeds and every report day still has a price level', async () => {
    const d = db();
    await seedHourly(d, TOKEN_REF, '2026-09-30T00:00:00Z', 24 * 6, 'chain:v2_twap', (i) => 1 + i / 1000);
    await seedHourly(d, DIEM_REF, '2026-09-30T00:00:00Z', 24 * 6, 'chain:v2_twap', (i) => 40 + i / 1000);
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
    for (const day of days) {
      await seedMarket(d, 'lvl', 'price_usd', `${day}T00:47:00.000Z`, 1);
      await seedMarket(d, 'lvl', 'price_usd', `${day}T00:52:00.000Z`, 1.01); // a second read the same night: its own observed_at, so its own rebuilt row
      await seedMarket(d, 'lvl', 'diem_price_usd', `${day}T00:47:00.000Z`, 40);
    }
    const loaded = load(LVL_YAML);
    const r = await rebuildPriceLevels(d, loaded, { yes: true, now: NOW });
    expect(r.perMetric.map((m) => [m.metric, m.rebuilt, m.refused.length])).toEqual([['diem_price_usd', 5, 0], ['price_usd', 10, 0]]);
    const purged = await purgeMetrics(d, loaded, { metrics: ['price_usd', 'diem_price_usd'], sourceType: 'market_data', apply: true, exportDir: join(scratch(), 'purged'), now: NOW });
    expect(purged.perMetric.map((m) => [m.metric, m.observations])).toEqual([['price_usd', 10], ['diem_price_usd', 5]]);
    expect(await d.one("SELECT 1 FROM observations WHERE source_type = 'market_data'")).toBeUndefined();
    for (const metric of ['price_usd', 'diem_price_usd']) {
      const active = await listActiveObservations(d, 'lvl', metric);
      for (const day of days) {
        // The report reads the level in force at the end of the day.
        const lvl = latestLevel(active, `${day}T23:59:59.999Z`);
        expect(lvl, `${metric} ${day}`).toBeDefined();
        expect(lvl!.observedAt.slice(0, 10)).toBe(day);
      }
    }
  });

  it("AERO: the ref is its `token` contract; a first-party candle ref gets the first_party_api rung", async () => {
    const d = db();
    await seedHourly(d, TOKEN_REF, '2026-10-01T00:00:00Z', 24, 'chain:aerodrome_v2_twap', () => 0.5);
    await seedMarket(d, 'aer', 'price_usd', '2026-10-01T12:00:00.000Z', 0.55);
    const r = await rebuildPriceLevels(d, load(AERO_YAML), { yes: true, now: NOW });
    expect(r.perMetric).toEqual([{ metric: 'price_usd', tokenRef: TOKEN_REF, rows: 1, rebuilt: 1, beforeValidFrom: [], refused: [] }]);

    await seedHourly(d, HYPE_REF, '2026-10-01T00:00:00Z', 24, 'first_party:hyperliquid', () => 40);
    await seedMarket(d, 'hyp', 'price_usd', '2026-10-01T12:00:00.000Z', 41);
    await rebuildPriceLevels(d, load(HYP_YAML), { yes: true, now: NOW });
    const row = await d.one<{ value: number; source_type: string; chain: string | null; locator: Record<string, unknown> }>(
      "SELECT value, source_type, chain, locator FROM observations WHERE asset_id = 'hyp' AND source_type <> 'market_data'",
    );
    expect(row).toEqual({
      value: 40, source_type: 'first_party_api', chain: 'hyperliquid:core',
      locator: { from: 'prices', token_ref: HYPE_REF, ts: '2026-10-01T11:00:00.000Z', source: 'first_party:hyperliquid', input_origin: 'api' },
    });
  });

  it('run_in_progress while another holder has the asset lock; the dry run still counts', async () => {
    const d = db();
    await seedHourly(d, TOKEN_REF, '2026-10-01T00:00:00Z', 24, 'chain:v2_twap', () => 1);
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-01T12:00:00.000Z', 1.1);
    const before = await obsCount();
    const held = await d.tryAssetRunLock('lvl', 'tick pid 1');
    try {
      expect(await errCode(rebuildPriceLevels(d, load(LVL_YAML), { yes: true, now: NOW }))).toBe('run_in_progress');
      expect((await rebuildPriceLevels(d, load(LVL_YAML), { yes: false, now: NOW })).perMetric.find((m) => m.metric === 'price_usd')!.rebuilt).toBe(1);
    } finally {
      await held!.release();
    }
    expect(await obsCount()).toBe(before);
  });
});

describe('Ruling R38: no price level is purged without a replacement, except before its ref\'s valid_from', () => {
  const VF = { [TOKEN_REF]: '2026-10-03', [DIEM_REF]: '2025-10-13' };
  const purge = async (d: OrionDb, loaded: LoadedAsset, apply: boolean) =>
    await purgeMetrics(d, loaded, { metrics: ['price_usd'], sourceType: 'market_data', apply, exportDir: join(scratch(), 'purged'), now: NOW });

  it('rebuild lists rows observed before valid_from as beforeValidFrom (not refused); a row on valid_from with no price is refused', async () => {
    const d = db();
    // Chain prices from valid_from (10-03 00:00) for 48 h.
    await seedHourly(d, TOKEN_REF, '2026-10-03T00:00:00Z', 48, 'chain:v2_twap', () => 2);
    const old1 = await seedMarket(d, 'lvl', 'price_usd', '2026-10-01T00:47:00.000Z', 1.1);
    const old2 = await seedMarket(d, 'lvl', 'price_usd', '2026-10-02T23:59:00.000Z', 1.2);
    const onDay = await seedMarket(d, 'lvl', 'price_usd', '2026-10-03T00:30:00.000Z', 1.3); // needs ts <= 10-02 23:30: none
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-03T12:00:00.000Z', 1.4);
    const dry = await rebuildPriceLevels(d, load(LVL_YAML, VF), { yes: false, now: NOW });
    expect(dry.perMetric.find((m) => m.metric === 'price_usd')).toEqual({
      metric: 'price_usd', tokenRef: TOKEN_REF, rows: 4, rebuilt: 1,
      beforeValidFrom: [{ id: old1, observedAt: '2026-10-01T00:47:00.000Z' }, { id: old2, observedAt: '2026-10-02T23:59:00.000Z' }],
      refused: [{ id: onDay, observedAt: '2026-10-03T00:30:00.000Z', reason: `no chain/first-party price of ${TOKEN_REF} in the 6 h to 2026-10-02T23:30:00.000Z` }],
    });
    const yes = await rebuildPriceLevels(d, load(LVL_YAML, VF), { yes: true, now: NOW });
    expect(yes.perMetric.find((m) => m.metric === 'price_usd')!.beforeValidFrom).toHaveLength(2);
    // The beforeValidFrom rows stay active CoinGecko rows (nothing replaces them).
    const active = await d.all<{ id: number }>("SELECT id FROM observations WHERE source_type = 'market_data' AND superseded_by IS NULL ORDER BY id");
    expect(active.map((r) => Number(r.id))).toEqual([old1, old2, onDay]);
    // Without a prices map there is no valid_from: the old rows are refused, as before.
    const bare = await rebuildPriceLevels(d, load(LVL_YAML), { yes: false, now: NOW });
    expect(bare.perMetric.find((m) => m.metric === 'price_usd')!.refused.map((x) => x.id)).toEqual([old1, old2, onDay]);
  });

  it('purge --source-type market_data refuses (deletes nothing, dry run too) while a row on or after valid_from has no rebuilt row', async () => {
    const d = db();
    await seedHourly(d, TOKEN_REF, '2026-10-03T00:00:00Z', 48, 'chain:v2_twap', () => 2);
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-01T00:47:00.000Z', 1.1);
    const onDay = await seedMarket(d, 'lvl', 'price_usd', '2026-10-03T00:30:00.000Z', 1.3);
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-03T12:00:00.000Z', 1.4);
    await rebuildPriceLevels(d, load(LVL_YAML, VF), { yes: true, now: NOW });
    const before = await obsCount();
    for (const apply of [false, true]) {
      let err: { code?: string; message?: string } = {};
      try {
        await purge(d, load(LVL_YAML, VF), apply);
      } catch (e) {
        err = e as typeof err;
      }
      expect(err.code).toBe('purge_unreplaced_price_level');
      expect(err.message).toContain(`#${onDay} 2026-10-03T00:30:00.000Z`);
      expect(await obsCount()).toBe(before);
    }
    // A superseded CoinGecko row with no rebuilt row at its observed_at (a later CoinGecko read replaced it) refuses too.
    const d2 = await seedMarket(d, 'lvl', 'price_usd', '2026-10-04T05:00:00.000Z', 1.5);
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-04T05:00:00.000Z', 1.6); // supersedes d2, itself unreplaced
    await d.run('DELETE FROM observations WHERE id = $1', [onDay]);
    expect(await errCode(purge(d, load(LVL_YAML, VF), false))).toBe('purge_unreplaced_price_level');
    expect(d2).toBeGreaterThan(0);
  });

  it('rows before valid_from are deleted without replacement and listed (ids, days); every other row has its rebuilt twin', async () => {
    const d = db();
    await seedHourly(d, TOKEN_REF, '2026-10-03T00:00:00Z', 48, 'chain:v2_twap', () => 2);
    const old1 = await seedMarket(d, 'lvl', 'price_usd', '2026-10-01T00:47:00.000Z', 1.1);
    const old2 = await seedMarket(d, 'lvl', 'price_usd', '2026-10-02T23:59:00.000Z', 1.2);
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-03T12:00:00.000Z', 1.4);
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-04T12:00:00.000Z', 1.5);
    await rebuildPriceLevels(d, load(LVL_YAML, VF), { yes: true, now: NOW });
    const withoutReplacement = [{ id: old1, observedAt: '2026-10-01T00:47:00.000Z', day: '2026-10-01' }, { id: old2, observedAt: '2026-10-02T23:59:00.000Z', day: '2026-10-02' }];
    const dry = await purge(d, load(LVL_YAML, VF), false);
    expect(dry.perMetric).toMatchObject([{ metric: 'price_usd', observations: 4, superseded: 2, withoutReplacement }]);
    const yes = await purge(d, load(LVL_YAML, VF), true);
    expect(yes.perMetric).toMatchObject([{ metric: 'price_usd', observations: 4, withoutReplacement }]);
    expect(await d.one("SELECT 1 FROM observations WHERE source_type = 'market_data'")).toBeUndefined();
    expect((await listActiveObservations(d, 'lvl', 'price_usd')).map((o) => o.observedAt)).toEqual(['2026-10-03T12:00:00.000Z', '2026-10-04T12:00:00.000Z']);
  });

  it('without a prices map (no valid_from) a row with no replacement refuses; a fully rebuilt metric lists none; other source types are untouched', async () => {
    const d = db();
    await seedHourly(d, TOKEN_REF, '2026-10-03T00:00:00Z', 48, 'chain:v2_twap', () => 2);
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-01T00:47:00.000Z', 1.1);
    expect(await errCode(purge(d, load(LVL_YAML), false))).toBe('purge_unreplaced_price_level');
    await d.run("DELETE FROM observations WHERE observed_at < '2026-10-03'");
    await seedMarket(d, 'lvl', 'price_usd', '2026-10-03T12:00:00.000Z', 1.4);
    await rebuildPriceLevels(d, load(LVL_YAML), { yes: true, now: NOW });
    expect((await purge(d, load(LVL_YAML), false)).perMetric[0]!.withoutReplacement).toEqual([]);
    // A third_party purge of a price metric is not a price-level purge: no withoutReplacement, no refusal.
    const tp = await purgeMetrics(d, load(LVL_YAML), { metrics: ['price_usd'], sourceType: 'third_party', apply: false, exportDir: join(scratch(), 'purged'), now: NOW });
    expect(tp.perMetric[0]).not.toHaveProperty('withoutReplacement');
  });
});
