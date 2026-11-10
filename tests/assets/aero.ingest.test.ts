import { readFileSync } from 'node:fs';
import { holderFlowMetrics } from '../../src/config/incomeStatement.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { useTestDb } from '../helpers/db.js';
import { statementShape } from '../helpers/assets.js';

const testDb = useTestDb();

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Base block 55,335,954 (2026-11-09T20:52:46Z), read live: spec 2026-11-09-orion-aero-supply-design.md §2 and §3.4.
const NOW = new Date('2026-11-09T20:52:46.000Z');
const NOW_TS = NOW.getTime() / 1000;
const GENESIS_TS = NOW_TS - 100 * 86_400;
const LATEST = BigInt((NOW_TS - GENESIS_TS) / 2);
const LAUNCH_TS = Date.parse('2026-10-22T00:00:00Z') / 1000;

const { config } = loadAsset(ROOT, 'aero');
const C = config.contracts;

/** 100 days of holders revenue ending on the last complete day. */
function chart(): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 100; i >= 1; i--) {
    const day = addDays('2026-11-08', 1 - i);
    points.push([Date.parse(`${day}T00:00:00Z`) / 1000, 220_000 + (i % 5) * 10_000]);
  }
  return { totalDataChart: points };
}

const CUM = (i: number) => `${callKey(C.price_pool, 'currentCumulativePrices')}[${i}]`;
const LIVE = {
  [callKey(C.token, 'totalSupply')]: 2137656188139846466214415011n,
  [callKey(C.token, 'decimals')]: 18n,
  [callKey(C.ve, 'supply')]: 1061419067554911371263262026n,
  [callKey(C.token, 'balanceOf', [C.aero_migration])]: 357376144656026729357021554n,
  [callKey(C.token, 'balanceOf', [C.velo_migration])]: 27713949955370837077599828n,
  [callKey(C.minter, 'emissionsMinted')]: 10537146641557925288673784n,
  [callKey(C.minter, 'teamRate')]: 50_000n,
  [callKey(C.minter, 'baseRate')]: 13_489_345_000_000_000_000n,
  [callKey(C.price_pool, 'token0')]: BigInt(C.token),
  [callKey(C.price_pool, 'token1')]: BigInt('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  [CUM(0)]: 36653890530695048068540695693699n,
  [CUM(1)]: 23580404475950167206n,
  [CUM(2)]: 1794257566n,
  [callKey(C.price_check_pool, 'token0')]: BigInt(C.token),
  [callKey(C.price_check_pool, 'token1')]: BigInt('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  [`${callKey(C.price_check_pool, 'slot0')}[0]`]: 59808894443440384192540n,
  [callKey(C.usdc_usd_feed, 'latestAnswer')]: 99_975_857n,
};
/** An hour earlier (the TWAP's start), read live at block 55,317,952. */
const HOUR_AGO = { [CUM(0)]: 36555874937482610906548483587347n, [CUM(1)]: 23524350188277923325n, [CUM(2)]: 1794253966n };
/** At the launch (2026-10-22T00:00Z, block 52,918,927): every window that reaches back past it starts here. */
const AT_LAUNCH = {
  [callKey(C.token, 'totalSupply')]: 2127000000000000000000000000n,
  [callKey(C.token, 'balanceOf', [C.aero_migration])]: 1978658436053327590841194275n,
  [callKey(C.token, 'balanceOf', [C.velo_migration])]: 116881283916892509368619169n,
  [callKey(C.minter, 'emissionsMinted')]: 0n,
};

function world() {
  // DefiLlama's fee series is the only HTTP read: no CoinGecko, no DefiLlama coins (Mike, 2026-11-09).
  const http = fakeHttp({ 'https://api.llama.fi/summary/fees/aerodrome': chart() });
  const hourBlocks = 3600n / 2n + 5n;
  const rpc = fakeRpc({ genesisTs: GENESIS_TS, latest: LATEST, calls: LIVE, callsAt: (n) => (n === LATEST ? undefined : n >= LATEST - hourBlocks ? HOUR_AGO : AT_LAUNCH) });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: {}, sleep: async () => undefined, now: () => NOW };
  return { db: testDb(), deps, http, rpc };
}

describe('assets/aero.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'aero', symbol: 'AERO', name: 'Aero' });
    expect(holderFlowMetrics(config.income_statement)).toEqual(['flow_usd.fees']);
    expect('holder_flows' in config || 'reporting' in config).toBe(false); // retired (Task 11)
    // Every metric has a source.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    for (const key of ['dominance_share', 'dominance_share_1y', 'revenue_run_rate_usd']) expect(config.metrics[key], key).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // No CoinGecko or DefiLlama source anywhere except the revenue series (Mike, 2026-11-09: licensing; Phase 3 replaces it).
    const sources = Object.entries(config.metrics).flatMap(([k, d]) => [d.source, ...(d.cross_checks ?? []).map((c) => c.source)].map((s) => [k, s?.type, JSON.stringify(s)] as const));
    expect(sources.filter(([, t, s]) => t === 'coingecko' || t === 'defillama' || t === 'defillama_share' || /llama|coingecko/.test(s ?? '')).map(([k]) => k)).toEqual(['flow_usd.fees']);
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check (wrappers: + circulating_supply). A deliberate edit of assets/aero.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    // Re-pinned 2026-10-26: window 90 -> 91 days on every asset (Mike), backfill_days 90 -> 100.
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    // Re-pinned 2026-11-09: the Aero contracts (spec 2026-11-09-orion-aero-supply-design.md): on-chain price, circulating,
    // realised emissions, the upgrade reserves as dilution, no CoinGecko/DefiLlama outside revenue, revenue relabelled.
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/aero.yaml`, 'utf8')).hash).toBe('3c413feb4fbdba98b9ab17c4802ea46cc4306e9e700fb8d1384fa984dde4d19b');
  });

  it('v2 block shape: an income_statement with the plan line ids', () => {
    expect(statementShape(config.income_statement)).toEqual({
      category: 'dex',
      scope: 'protocol_share_only',
      window_days: 91,
      revenue: ['fees'],
      cost_of_revenue: ['lp_fees'],
      holders: ['voter_fees'],
      below_line: ['bribes'],
      of: { voter_fees: 'fees' },
    });
    expect(config.income_statement?.dilution?.map((d) => [d.id, d.metric, d.cap_metric])).toEqual([
      ['aero_upgrade', 'upgrade_release_aero', 'upgrade_reserve_aero'],
      ['velo_upgrade', 'upgrade_release_velo', 'upgrade_reserve_velo'],
    ]);
    expect(config.income_statement?.revenue[0].label).toContain('all-chain Aero since 2026-10-22');
  });

  it('plans the source map of the spec: chain reads and generic adapters, one API-series flow', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['adapter:chain.v2_pool_twap_price', ['primary:price_usd']],
      ['adapter:chain.cl_pool_spot_price', ['cross_check:price_usd']],
      ['chain_levels', ['primary:total_supply', 'primary:staked_supply', 'primary:locked_supply', 'primary:upgrade_reserve_aero', 'primary:upgrade_reserve_velo']],
      ['adapter:chain.view_sum', ['primary:circulating_supply', 'primary:emission_ceiling_annual']],
      ['constant', ['primary:staker_emission_share']],
      ['adapter:chain.counter_rate', ['primary:emission_rate_annual', 'primary:upgrade_release_aero', 'primary:upgrade_release_velo']],
      ['defillama:aerodrome:dailyHoldersRevenue', ['primary:flow_usd.fees']],
    ]);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.derived).toEqual([]);
    expect(plan.needsRpc).toBe(true);
  });

  it('fetches every metric from canned live reads, the price check in tolerance, no CoinGecko call', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const value = async (metric: string) => (await listActiveObservations(w.db, 'aero', metric)).at(-1)!.value;
    const twap = ((23580404475950167206 - 23524350188277923325) / 1e6) / ((36653890530695048068540695693699 - 36555874937482610906548483587347) / 1e18);
    expect(await value('price_usd')).toBeCloseTo(twap * 0.99975857, 8);
    expect(await value('price_usd')).toBeCloseTo(0.57175, 4);
    expect(await value('total_supply')).toBeCloseTo(2137656188.139846, 3);
    expect(await value('circulating_supply')).toBeCloseTo(691147025.97, 1); // total - sAERO - the two reserves
    expect(await value('staked_supply')).toBeCloseTo(1061419067.5549, 3);
    expect(await value('locked_supply')).toBeCloseTo(1061419067.5549, 3);
    expect(await value('staker_emission_share')).toBe(0);
    // 10.537M minted in the 18.87 days since the launch (the 91-day window clamps there), x 365, x 1.05 team.
    const days = (NOW_TS - LAUNCH_TS) / 86_400;
    expect(await value('emission_rate_annual')).toBeCloseTo((10537146.641557925 / days) * 365 * 1.05, 0);
    expect(await value('emission_rate_annual')).toBeCloseTo(214.01e6, -5);
    expect(await value('emission_ceiling_annual')).toBeCloseTo(446669983.116, 2);
    expect(await value('upgrade_reserve_aero')).toBeCloseTo(357376144.656, 2);
    expect(await value('upgrade_reserve_velo')).toBeCloseTo(27713949.955, 2);
    expect(await value('upgrade_release_aero')).toBeCloseTo(((1978658436.0533276 - 357376144.6560267) / days) * 365, -1);
    expect(await value('upgrade_release_velo')).toBeCloseTo(((116881283.9168925 - 27713949.95537084) / days) * 365, -1);
    expect(await listActiveObservations(w.db, 'aero', 'flow_usd.fees')).toHaveLength(100);
    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked.map((c) => [c.metricKey, c.ok])).toEqual([['price_usd', true]]); // the Slipstream pool, 2 percent (0.35 percent apart)
  });
});

describe('the AERO persona', () => {
  it('ships beside the VVV one, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'consumer-launchpad-analyst', 'onchain-dex-analyst', 'oracle-network-analyst', 'perp-exchange-analyst', 'stablecoin-protocol-analyst']);
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['dex', 'onchain-fee-share'] });
    expect(persona.body).toContain('Locking is the thesis');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
    expect(skillsFor(ROOT, 'disclosure').map((s) => s.name)).toEqual(['disclosure-research', 'disclosure-review']);
  });
});
