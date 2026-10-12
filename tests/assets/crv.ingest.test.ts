import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { loadPersona } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys, requiredExtraMetrics } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-08T10:30:00.000Z'); // a Thursday
const BLOCK_SEC = 12;
const GENESIS_TS = NOW.getTime() / 1000 - 110 * 86_400 + 1;
const LLAMA = 'https://coins.llama.fi/prices/current/ethereum:0xD533a949740bb3306d119CC777fa900bA034cd52';
const BRIBES = 'https://llama.box/curvedex/api/bribes/stats.json';
const E18 = 10n ** 18n;

const { config } = loadAsset(ROOT, 'crv');
const C = config.contracts;
/** The real feed of 2026-10-08, the per-day claims series trimmed. */
const bribes = JSON.parse(readFileSync(`${ROOT}/tests/fixtures/crv/llama_box_bribes_stats.json`, 'utf8')) as unknown;

/** crvUSD market chart: flat at 0.9993 every hour over the window. */
function crvusdChart(url: string): { prices: [number, number][] } {
  const days = Number(new URL(url).searchParams.get('days'));
  const end = NOW.getTime();
  const step = days > 90 ? 86_400_000 : 3_600_000;
  const prices: [number, number][] = [];
  for (let t = end - days * 86_400_000; t <= end; t += step) prices.push([t, 0.9993]);
  return { prices };
}

/** The Wednesdays from 2026-07-01 to 2026-10-07, at 18:00Z: 98,566 crvUSD each, about the 13-week mean of the live series. */
function wednesdays(): string[] {
  const out: string[] = [];
  for (let d = Date.parse('2026-07-01T18:00:00Z'); d <= Date.parse('2026-10-07T18:00:00Z'); d += 7 * 86_400_000) out.push(new Date(d).toISOString());
  return out;
}
const PAYOUT = 98_566n;

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'curve-dao-token', symbol: 'crv', current_price: 0.3933, market_cap: 619e6, circulating_supply: 1_574_000_000, total_supply: 2_424_321_556 }],
    'https://api.coingecko.com/api/v3/coins/crvusd/market_chart': crvusdChart,
    [LLAMA]: { coins: { 'ethereum:0xD533a949740bb3306d119CC777fa900bA034cd52': { decimals: 18, symbol: 'CRV', price: 0.3897, timestamp: 1791440000, confidence: 0.99 } } },
    [BRIBES]: bribes,
  });
  const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    blockTimeSec: BLOCK_SEC,
    maxLogRange: 10_000n,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC)),
    calls: {
      // Read live on 2026-10-08 at block 26,146,581.
      [callKey(C.token, 'totalSupply')]: 2_424_321_556n * E18,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.crvusd, 'decimals')]: 18n,
      [callKey(C.ve, 'supply')]: 840_614_647n * E18,
      // The liquid lockers (monitor-only), read live 2026-10-09 at block 26153692.
      [callKey(C.ve, 'totalSupply')]: 773_693_863n * E18,
      [callKey(C.ve, 'balanceOf', [C.locker_convex])]: 418_311_184n * E18,
      [callKey(C.ve, 'balanceOf', [C.locker_stakedao])]: 117_574_827n * E18,
      [callKey(C.ve, 'balanceOf', [C.locker_yearn])]: 83_094_985n * E18,
      [`${callKey(C.ve, 'locked', [C.locker_convex])}[0]`]: 423_932_072n * E18,
      [`${callKey(C.ve, 'locked', [C.locker_stakedao])}[0]`]: 119_154_691n * E18,
      [`${callKey(C.ve, 'locked', [C.locker_yearn])}[0]`]: 83_401_058n * E18,
      [callKey(C.token, 'rate')]: 3080982847903985532n,
      [callKey(C.token, 'start_epoch_time')]: 1786573048n,
    },
    logs: wednesdays().map((iso, i) => ({ blockNumber: blockAt(iso), logIndex: 0, txHash: `0x${i.toString(16)}`, from: C.fee_allocator, value: PAYOUT * E18 })),
  });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http, rpc };
}

/** A flat, plausible set for the wiring test; the real one comes from the user's calibration. */
function assumptions(): AssumptionValues {
  const one = {
    rev_growth_y1: 0.1, growth_fade_years: 4, terminal_growth: 0.02, 'capture_rate_terminal.fees': 1, 'capture_ramp_years.fees': 0,
    discount_rate_base: 0.2, discount_premium_programmatic: 0.03, 'multiple.fm_holder_flow': 10, regime_multiplier: 1, staked_ratio_horizon: 0.35,
    incentive_efficiency_drift: 0, incentive_discount_rate: 0.2,
  };
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}

describe('assets/crv.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'crv', symbol: 'CRV', chain: 'ethereum', supply_basis: 'effective_total', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows).toEqual([{ id: 'fees', kind: 'fee_share', capture_rule: 'programmatic', recipient_base: 'locked', metric: 'flow_usd.fees', window_days: 91 }]);
    expect(config.modules.map((m) => [m.id, m.kind, m.weight ?? null])).toEqual([['hc', 'estimate', 0.6], ['fm_holder_flow', 'estimate', 0.4], ['vote_incentives', 'component', null]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.fees', 'capture_rate_terminal.fees', 'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years',
      'incentive_discount_rate', 'incentive_efficiency_drift', 'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual(['vote_incentive_run_rate_usd']);
    // Every metric has a source, and none is manual: a bootstrap run has nothing to research and the grade can be A.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check (wrappers: + circulating_supply). A deliberate edit of assets/crv.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/crv.yaml`, 'utf8')).hash).toBe('8365897910ed75922a5641e723b8373df363d425b74fa855d0f3b6c4a6bdc30f');
  });

  it('plans the source map of the spec: one transfer scan, a constant, an adapter, the bribes feed', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'cross_check:total_supply', 'primary:circulating_supply']],
      [`http_json:${LLAMA}`, ['cross_check:price_usd']],
      [
        'chain_levels',
        [
          'primary:total_supply', 'primary:staked_supply', 'primary:locked_supply', 'primary:ve_power_total',
          'primary:ve_power.convex', 'primary:ve_power.stakedao', 'primary:ve_power.yearn',
          'primary:ve_locked.convex', 'primary:ve_locked.stakedao', 'primary:ve_locked.yearn',
        ],
      ],
      ['constant', ['primary:staker_emission_share']],
      ['adapter:crv.emission_rate_annual', ['primary:emission_rate_annual']],
      [`http_json:${BRIBES}`, ['primary:vote_incentive_run_rate_usd', 'cross_check:vote_incentive_run_rate_usd']],
    ]);
    // The holder flow, then the report-only income lines: Curve's 10 percent (Treasury) and every fee into the FeeAllocator.
    expect(plan.flowGroups.map((g) => g.members.map((m) => [m.metricKey, m.unit]))).toEqual([[['flow_usd.fees', 'usd']], [['flow_usd.curve_treasury', 'usd']], [['flow_usd.protocol_revenue', 'usd']]]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
    expect(plan.needsRpc).toBe(true);
  });

  it('fetches every metric from canned sources with both cross-checks in tolerance, then values the asset at grade A', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const rows = (metric: string) => listActiveObservations(w.db, 'crv', metric);
    const value = (metric: string) => rows(metric).filter((o) => o.observedAt <= NOW.toISOString()).at(-1)!.value;
    expect(value('price_usd')).toBe(0.3933);
    expect(value('total_supply')).toBe(2_424_321_556);
    expect(value('staked_supply')).toBe(840_614_647);
    expect(value('locked_supply')).toBe(840_614_647);
    expect(value('staker_emission_share')).toBe(0);
    expect(rows('emission_rate_annual').map((o) => [o.observedAt > NOW.toISOString(), Math.round(o.value)])).toEqual([[false, 97_161_875], [true, 81_703_072]]);
    expect(rows('emission_rate_annual')[1].observedAt).toBe('2027-08-12T22:17:28.000Z');
    expect(value('vote_incentive_run_rate_usd')).toBeCloseTo(4_284_586.14 * 365 / 180, 0);
    // The lockers' veCRV, monitor-only: Yearn 10.74 percent of voting power, 9.92 percent of the CRV locked.
    expect(value('ve_power.yearn') / value('ve_power_total')).toBeCloseTo(0.1074, 4);
    expect(value('ve_locked.yearn') / value('locked_supply')).toBeCloseTo(0.0992, 4);
    expect(['convex', 'stakedao', 'yearn'].map((k) => Math.round(value(`ve_locked.${k}`)))).toEqual([423_932_072, 119_154_691, 83_401_058]);

    // The 100-day backfill: every day stored, weekly payouts and zero days between.
    const fees = rows('flow_usd.fees');
    expect(fees).toHaveLength(100);
    expect(fees.filter((o) => o.value > 0).length).toBe(15); // the Wednesdays 2026-07-01 to 2026-10-07, all inside the 100 days
    expect(fees.filter((o) => o.value > 0).every((o) => new Date(o.observedAt).getUTCDay() === 4)).toBe(true); // a day's row is stamped at its end
    // The run rate: 13 payouts of 98,566 crvUSD at 0.9993 in the 91 days to 2026-10-07, scaled to a year.
    const revenue = rows('revenue_run_rate_usd').at(-1)!;
    expect(revenue.value).toBeCloseTo((13 * 98_566 * 0.9993 * 365) / 91, 0);
    expect(revenue).toMatchObject({ source: 'onchain', sourceDetail: 'derived flow_annualized(flow_usd.fees, 91d)' }); // from an on-chain flow

    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked.map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true], ['vote_incentive_run_rate_usd', true]]);
    expect(w.rpc.stats.logRanges).toHaveLength(300); // three scans (fees, protocol revenue, treasury), 100 days each: the scanner commits a day at a time; a mainnet day (7,200 blocks) fits one call
    expect(w.rpc.stats.logRanges.every(([a, b]) => b - a + 1n <= 10_000n)).toBe(true);

    createAssumptionSet(w.db, { assetId: 'crv', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'crv'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
    expect(signal.spot!.price).toBe(0.3933);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    const component = signal.horizons!['12m'].modules.vote_incentives;
    expect(component).toMatchObject({ type: 'vote_incentives', kind: 'component', weight: null });
    // Valued at spot (price_basis spot): independent of the fee model's target, about 0.0078 USD a token
    // (19.8M USD of discounted incentives over supply at the horizon).
    expect(component.breakdown).toMatchObject({ metric: 'vote_incentive_run_rate_usd', years_valued: 10, price_basis: 'spot', price_ratio: 1, incentives_run_rate_usd: expect.closeTo(8_688_188.56, 1) });
    expect(component.value).toBeGreaterThan(0.004);
    expect(component.value).toBeLessThan(0.009);
    // Over supply at the horizon, which emissions have grown past today's 2.42B.
    expect(component.value).toBeLessThan((component.breakdown.aggregate_pv_usd as number) / 2_424_321_556);
  });

  it('keeps the monitor-only locker lines out of the valuation: a failed read leaves the signal ok at grade A', async () => {
    const w = world();
    const failing = { ...w.deps, rpcFactory: () => ({ ...w.rpc, multicall: async (calls: Parameters<typeof w.rpc.multicall>[0], b: bigint) => {
      const out = await w.rpc.multicall(calls, b);
      return out.map((r, i) => (calls[i].functionName === 'locked' || calls[i].functionName === 'balanceOf' ? { ok: false as const, error: 'execution reverted' } : r));
    } }) };
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, failing);
    const chain = r.sources.find((s) => s.sourceId === 'chain_levels')!;
    // A failed reading marks its source failed (the existing rule), but the source's other readings are still written.
    expect(chain.status).toBe('failed');
    expect(chain.error!.split('; ').map((e) => e.split(':')[0])).toEqual([
      've_power.convex', 've_power.stakedao', 've_power.yearn', 've_locked.convex', 've_locked.stakedao', 've_locked.yearn',
    ]);
    expect(listActiveObservations(w.db, 'crv', 've_power.yearn')).toEqual([]);
    expect(listActiveObservations(w.db, 'crv', 'staked_supply')).toHaveLength(1);
    createAssumptionSet(w.db, { assetId: 'crv', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'crv'), NOW);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
  });

  it('refuses to run without the Ethereum RPC URL', async () => {
    const w = world();
    await expect(fetchAsset(w.db, { config, hash: 'test' }, NOW, { ...w.deps, env: {} })).rejects.toMatchObject({ code: 'missing_rpc_url' });
  });
});

describe('calibration/crv-assumptions.yaml', () => {
  it('is complete and sits inside the agent bands of assets/crv.yaml', () => {
    const raw = parseYaml(readFileSync(`${ROOT}/calibration/crv-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;
    for (const s of ['bear', 'base', 'bull'] as const) {
      expect(Object.keys(raw[s]).sort()).toEqual(requiredAssumptionKeys(config));
      for (const [key, value] of Object.entries(raw[s])) {
        const b = config.assumptions[key];
        const band = b[s] ?? b;
        expect(value, `${s} ${key}`).toBeGreaterThanOrEqual(band.min);
        expect(value, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
    }
  });
});

describe('the CRV persona', () => {
  it('is the DEX analyst, which knows that vote incentives are not revenue', () => {
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona.body).toContain('Vote incentives are not revenue');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
  });
});
