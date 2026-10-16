import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys, validateAssetModules } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-09-24T12:00:00.000Z');
const INFO = 'https://api.hyperliquid.xyz/info';
const LLAMA_PRICE = 'https://coins.llama.fi/prices/current/hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec';
const recorded = (name: string): unknown => JSON.parse(readFileSync(`${ROOT}/tests/fixtures/hype/${name}.json`, 'utf8')) as unknown;

const { config } = loadAsset(ROOT, 'hype');

const SYS = '0x5000000000000000000000000000000000000000';
const AF = '0xfefefefefefefefefefefefefefefefefefefefe';
const TREASURY = '0x8536a52900b5e7b23b08d6dcc50fd5689b5e270c';
const send = (iso: string, user: string, destination: string, amount: string, token = 'USDC') => ({ time: Date.parse(iso), hash: '0x', delta: { type: 'send', user, destination, token, amount, usdcValue: amount, fee: '0.0', nativeTokenFee: '0.0', nonce: null, feeToken: '' } });
const INTEREST_LEDGER = [
  send('2026-08-27T18:34:04.307Z', TREASURY, SYS, '1.0'),
  send('2026-10-02T17:05:38.677Z', TREASURY, SYS, '1.0'),
  send('2026-10-03T00:00:00.106Z', SYS, AF, '2.0'),
  send('2026-10-03T02:43:10.017Z', TREASURY, SYS, '14580777.2100000009'),
  send('2026-10-03T11:46:32.531Z', '0x20e6648f8c6c4c62b32be4ac373b79cae190b601', SYS, '1.0', 'LIQD'),
  send('2026-10-04T00:00:00.002Z', SYS, AF, '14580774.6853202805'),
];

/** 100 days of holders revenue ending on the last complete day, about 1.55M USD a day (139.5M over any 90 days; DefiLlama's real 90-day sum was 140.5M on 2026-09-24). */
function chart(): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 100; i >= 1; i--) {
    const day = addDays('2026-09-23', 1 - i);
    points.push([Date.parse(`${day}T00:00:00Z`) / 1000, 1_500_000 + (i % 5) * 25_000]);
  }
  return { totalDataChart: points };
}

function world(now: Date = NOW) {
  const fixtures: Record<string, unknown> = { spotMetaAndAssetCtxs: recorded('spotMetaAndAssetCtxs'), validatorSummaries: recorded('validatorSummaries') };
  for (const name of ['assistance_fund', 'zero', 'dead']) fixtures[`spotClearinghouseState:${config.contracts[name]}`] = recorded(`spotClearinghouseState-${config.contracts[name]}`);
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'hyperliquid', symbol: 'hype', current_price: 92.36, market_cap: 20545976252, circulating_supply: 222445714.07414138, total_supply: 955307079.4341414 }],
    [LLAMA_PRICE]: { coins: { 'hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec': { decimals: 8, symbol: 'HYPE', price: 92.35934496087437, timestamp: 1790215180, confidence: 0.99 } } },
    'https://api.llama.fi/summary/fees/hyperliquid': chart(),
    // The info API answers by request type (and, for a clearinghouse state, by address); recorded 2026-09-24 and 2026-10-02.
    [INFO]: (_url: string, body?: unknown) => {
      const { type, user, startTime } = body as { type: string; user?: string; startTime?: number };
      // The fund's fills: two buys a day on @107 (10 and 20 HYPE at 50), plus a sell and another pair, which do not count.
      // The API keeps about two weeks, so days before 2026-09-14 have none.
      if (type === 'userFillsByTime') {
        if (startTime! < Date.parse('2026-09-14T00:00:00Z')) return [];
        return [
          { coin: '@107', side: 'B', px: '50', sz: '10', time: startTime! + 1000 },
          { coin: '@107', side: 'B', px: '50', sz: '20', time: startTime! + 2000 },
          { coin: '@107', side: 'A', px: '50', sz: '99', time: startTime! + 3000 },
          { coin: '@1', side: 'B', px: '1', sz: '99', time: startTime! + 4000 },
        ];
      }
      // The system interest address's ledger, as read on 2026-10-12: the treasury's 1 USDC tests, the first period's due
      // day (2026-10-03, 2 USDC on hand), the treasury's funding that afternoon, and the payment to the fund on 10-04.
      if (type === 'userNonFundingLedgerUpdates') return structuredClone(INTEREST_LEDGER).filter((e) => e.time >= startTime!);
      const reply = fixtures[user === undefined ? type : `${type}:${user}`];
      if (reply === undefined) throw new Error(`no fixture for ${type} ${user ?? ''}`);
      return structuredClone(reply);
    },
  });
  const deps: FetchDeps = { http, rpcFactory: () => { throw new Error('HYPE reads no chain'); }, env: {}, sleep: async () => undefined, now: () => now };
  return { db: openDb(':memory:'), deps, http };
}

/** A flat, plausible set for the wiring test; the real one comes from the user's calibration. */
function assumptions(): AssumptionValues {
  const one = {
    rev_growth_y1: 0.2, growth_fade_years: 5, terminal_growth: 0.02, 'capture_rate_terminal.af_buyback': 1, 'capture_ramp_years.af_buyback': 0,
    discount_rate_base: 0.2, discount_premium_programmatic: 0.02, 'multiple.fm_holder_flow': 30, regime_multiplier: 1, staked_ratio_horizon: 0.46,
  };
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}

describe('assets/hype.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'hype', symbol: 'HYPE', supply_basis: 'effective_total' });
    expect(config.chain).toBeUndefined();
    expect(config.ingest).toBeUndefined();
    expect(config.holder_flows).toEqual([{ id: 'af_buyback', kind: 'burn', capture_rule: 'programmatic', recipient_base: 'all', metric: 'flow_usd.af_buyback', window_days: 90 }]);
    expect(config.modules.map((m) => [m.id, m.weight])).toEqual([['hc', 0.6], ['fm_holder_flow', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.af_buyback', 'capture_rate_terminal.af_buyback', 'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years', 'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    // One manual metric: the staker share, 1.0 by construction, which the bootstrap researches and the user confirms.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual(['staker_emission_share']);
    expect(validateAssetModules(config)).toEqual([]);
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check (wrappers: + circulating_supply); then revenue streams (trading + the USDC reserve yield). A deliberate edit of assets/hype.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/hype.yaml`, 'utf8')).hash).toBe('b64e5b54cdc8c08ad660d2176a90fe94c8cd4c407a4ef22ef101511b6ba472f2');
  });

  it('plans the source map of the spec: no chain, three adapters, one API-series flow, one derived level', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'cross_check:total_supply', 'primary:circulating_supply']],
      [`http_json:${LLAMA_PRICE}`, ['cross_check:price_usd']],
      ['adapter:hype.total_supply', ['primary:total_supply']],
      ['adapter:hype.staked_supply', ['primary:staked_supply']],
      ['adapter:hype.emission_rate_annual', ['primary:emission_rate_annual']],
      ['defillama:hyperliquid:dailyHoldersRevenue', ['primary:flow_usd.af_buyback']],
      ['adapter:hype.fund_buys_daily', ['primary:flow_usd.af_buys_direct']],
      ['defillama:hyperliquid:dailyRevenue', ['primary:flow_usd.revenue_proxy']],
      ['adapter:hype.reserve_yield_payments', ['primary:flow_usd.reserve_yield']],
    ]);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
    expect(plan.needsRpc).toBe(false);
  });

  it('fetches every sourced metric from canned responses with the price cross-check in tolerance, then values the asset once the staker share is entered', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const value = (metric: string) => listActiveObservations(w.db, 'hype', metric).at(-1)!.value;
    expect(value('price_usd')).toBe(92.36);
    expect(value('circulating_supply')).toBeCloseTo(222445714.07414138, 3);
    expect(value('total_supply')).toBeGreaterThan(950e6);
    expect(value('total_supply')).toBeLessThan(953e6);
    expect(value('staked_supply')).toBeGreaterThan(430e6);
    expect(value('staked_supply')).toBeLessThan(450e6);
    expect(value('emission_rate_annual')).toBeGreaterThan(9.8e6);
    expect(value('emission_rate_annual')).toBeLessThan(10.1e6);
    expect(listActiveObservations(w.db, 'hype', 'staker_emission_share')).toEqual([]);
    // The writer keeps only the backfill window (backfill_days 100 on a first run, no cursor): all 100 of the 100 days.
    expect(listActiveObservations(w.db, 'hype', 'flow_usd.af_buyback')).toHaveLength(100);
    // The run rate: the last 90 complete days summed and scaled to a year, written for every day with a full window: days 90 to 100 in the backfill.
    const revenue = listActiveObservations(w.db, 'hype', 'revenue_run_rate_usd');
    expect(revenue).toHaveLength(11);
    expect(revenue.at(-1)!.value).toBeGreaterThan(560e6);
    expect(revenue.at(-1)!.value).toBeLessThan(580e6);
    expect(revenue.at(-1)).toMatchObject({ source: 'api', sourceDetail: 'derived flow_annualized(flow_usd.af_buyback, 90d)' });
    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked.map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true]]); // total: CoinGecko's, 2 percent
    // Five posts: the spot meta, one clearinghouse state per subtracted address, and the validators once (the stake and emission
    // adapters share the cached reply); plus the report-only fills, one per day of the 14.
    const posts = w.http.calls.filter((c) => c.url === INFO).map((c) => (c.body as { type: string }).type);
    expect(posts.filter((t) => t !== 'userFillsByTime').sort()).toEqual(['spotClearinghouseState', 'spotClearinghouseState', 'spotClearinghouseState', 'spotMetaAndAssetCtxs', 'userNonFundingLedgerUpdates', 'validatorSummaries']);
    // The reserve yield's first period (2026-08-26 .. 09-24) is not over on 09-24: nothing stored, nothing due.
    expect(listActiveObservations(w.db, 'hype', 'flow_usd.reserve_yield')).toEqual([]);
    expect(posts.filter((t) => t === 'userFillsByTime')).toHaveLength(14);
    // The direct series: 1,500 USD of buys a day (30 HYPE at 50) from 2026-09-14, the first day the fills reach, to the last
    // complete day; the sell and the other pair are left out, and the days before the API's memory are not written as zero.
    const direct = listActiveObservations(w.db, 'hype', 'flow_usd.af_buys_direct');
    expect(direct.map((o) => o.value)).toEqual(Array(10).fill(1500));
    expect(direct[0].observedAt).toBe('2026-09-15T00:00:00.000Z');
    expect(direct[0].source).toBe('api');

    createAssumptionSet(w.db, { assetId: 'hype', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const withoutShare = runValuation(w.db, loadAsset(ROOT, 'hype'), NOW);
    expect(withoutShare.signal.status).toBe('blocked');
    expect(withoutShare.signal.status_reasons.join(' ')).toMatch(/staker_emission_share/);
    expect(withoutShare.signal.status_reasons).toHaveLength(1);
    // The user's confirmation of the bootstrap's row: 1.0 by construction.
    insertObservation(w.db, { assetId: 'hype', metricKey: 'staker_emission_share', observedAt: NOW.toISOString(), value: 1, source: 'manual', fetchedAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'hype'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('B'); // a manual row in force (the staker share) caps the grade, as VVV's revenue does
    expect(signal.spot!.price).toBe(92.36);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    // A burn flow on the effective-total basis: the horizon supply is today's total supply plus a year of emissions less the
    // tokens the buyback dollars buy along the price path. With this wiring set that is about 16M tokens (the flat set solves to a
    // target near 12 USD, so each dollar buys more tokens than at spot); the band fails if the burn is missing or an order out.
    const noBurn = value('total_supply') + value('emission_rate_annual');
    const hc = signal.horizons!['12m'].modules.hc.breakdown as { supply_at_horizon: number };
    expect(hc.supply_at_horizon).toBeLessThan(noBurn - 12e6);
    expect(hc.supply_at_horizon).toBeGreaterThan(noBurn - 20e6);
  });
});

describe('assets/hype.yaml: the USDC reserve yield (AQAv2), read from the ledger (Mike, 2026-10-12)', () => {
  const ry = (db: ReturnType<typeof world>['db']) => listActiveObservations(db, 'hype', 'flow_usd.reserve_yield');
  const fetchAt = async (now: Date) => {
    const w = world(now);
    const r = await fetchAsset(w.db, { config, hash: 'test' }, now, w.deps, { metrics: ['flow_usd.reserve_yield'] });
    return { w, r };
  };

  it('stores the first payment as one row covering its 30 days, from the treasury, on time, and only once', async () => {
    const { w, r } = await fetchAt(new Date('2026-10-12T12:00:00.000Z'));
    expect(r.sources.map((s) => [s.sourceId, s.status])).toEqual([['adapter:hype.reserve_yield_payments', 'ok']]);
    expect(r.anomalies).toEqual([]); // paid on 10-04, a day after the 10-03 due day; funded by the configured treasury
    // The 2-USDC sweep on the due day and the 14.58M payment the next day are one period's payment.
    expect(ry(w.db).map((o) => [o.observedAt, o.periodDays, o.value, o.source])).toEqual([['2026-09-25T00:00:00.000Z', 30, 14580776.6853202805, 'api']]);
    expect(ry(w.db)[0].sourceDetail).toMatch(/covers 2026-08-26 to 2026-09-24, paid 2026-10-04T00:00:00.002Z/);
    const again = await fetchAsset(w.db, { config, hash: 'test' }, new Date('2026-10-12T12:00:00.000Z'), w.deps, { metrics: ['flow_usd.reserve_yield'] });
    expect(again.written).toEqual([]);
    expect(ry(w.db)).toHaveLength(1);
  });

  it('raises a late alert when a period is unpaid more than 10 days after it is due, and a payer alert for a new treasury', async () => {
    // The second period (09-25 .. 10-24) is due 11-02; on 11-13 it is 11 days late and unpaid.
    const { r } = await fetchAt(new Date('2026-11-13T12:00:00.000Z'));
    expect(r.anomalies.map((a) => [a.kind, a.dedupeKey, a.severity])).toEqual([['revenue_payment', 'late:2026-09-25', 'advisory']]);
    expect(r.anomalies[0].detail).toMatchObject({ due_day: '2026-11-02', days_late: 11, paid: false });
    const before = await fetchAt(new Date('2026-11-12T12:00:00.000Z'));
    expect(before.r.anomalies).toEqual([]); // 10 days late: not yet
  });
});

describe('the HYPE persona', () => {
  it('ships beside the other two, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst', 'oracle-network-analyst', 'perp-exchange-analyst']);
    const persona = loadPersona(ROOT, 'perp-exchange-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['perp-dex', 'exchange-buyback'] });
    expect(persona.body).toContain('The fund is the mechanism and the risk');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
  });
});
