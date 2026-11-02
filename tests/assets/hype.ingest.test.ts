import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
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

describe('assets/hype.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'hype', symbol: 'HYPE' });
    expect(config.chain).toBeUndefined();
    expect(config.ingest).toBeUndefined();
    expect(config.holder_flows).toEqual([{ id: 'af_buyback', kind: 'burn', capture_rule: 'programmatic', recipient_base: 'all', metric: 'flow_usd.af_buyback', window_days: 91 }]);
    // One manual metric: the staker share, 1.0 by construction, which the bootstrap researches and the user confirms.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual(['staker_emission_share']);
    for (const key of ['dominance_share', 'dominance_share_1y', 'revenue_run_rate_usd']) expect(config.metrics[key], key).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check (wrappers: + circulating_supply); then revenue streams (trading + the USDC reserve yield). A deliberate edit of assets/hype.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    // Re-pinned 2026-10-26: window 90 -> 91 days on every asset (Mike).
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/hype.yaml`, 'utf8')).hash).toBe('91a3d4fe5abf7c01b81d562b3096e6d18e86fc910dde7459e126decdb2940133');
  });

  it('plans the source map of the spec: no chain, three adapters, one API-series flow, no derived level', () => {
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
    expect(plan.derived).toEqual([]);
    expect(plan.needsRpc).toBe(false);
  });

  it('fetches every sourced metric from canned responses with the price cross-check in tolerance', async () => {
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
    // No derived run rate any more (it fed only the valuation).
    expect(listActiveObservations(w.db, 'hype', 'revenue_run_rate_usd')).toEqual([]);
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
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'consumer-launchpad-analyst', 'onchain-dex-analyst', 'oracle-network-analyst', 'perp-exchange-analyst', 'stablecoin-protocol-analyst']);
    const persona = loadPersona(ROOT, 'perp-exchange-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['perp-dex', 'exchange-buyback'] });
    expect(persona.body).toContain('The fund is the mechanism and the risk');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
    expect(skillsFor(ROOT, 'disclosure').map((s) => s.name)).toEqual(['disclosure-research', 'disclosure-review']);
  });
});
