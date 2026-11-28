import { holderFlowMetrics } from '../../src/config/incomeStatement.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
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

/** The five pool-scan metrics (Phase 3 R4): every one reads the 8 Aero chains through ctx.rpcFor. */
const POOL_METRICS = ['flow_usd.voter_fees', 'flow_usd.lp_fees', 'flow_usd.pool_fees_gross', 'flow_usd.vote_incentives', 'flow_usd.protocol_subsidy'];
/** The 8 Aero chains in the root Voter's chains() order (spec section 3). */
const AERO_CHAINS = [8453, 10, 1, 42161, 57073, 4663, 5042, 99901];
/** Fake RPC URLs for the six chains with no keyless default (never dialled: rpcFactory is a fake). */
const CHAIN_ENV = {
  ORION_ETH_RPC_URL: 'http://fake/eth', ORION_OP_RPC_URL: 'http://fake/op', ORION_ARB_RPC_URL: 'http://fake/arb', ORION_INK_RPC_URL: 'http://fake/ink',
  ORION_ROBINHOOD_RPC_URL: 'http://fake/robinhood', ORION_ARC_RPC_URL: 'http://fake/arc', ORION_ELYSIUM_RPC_URL: 'http://fake/elysium',
};

function world() {
  // No HTTP read at all: no CoinGecko, no DefiLlama (Mike, 2026-11-09; Phase 3 R4 retired the last, flow_usd.fees).
  const http = fakeHttp({});
  const hourBlocks = 3600n / 2n + 5n;
  const rpc = fakeRpc({ genesisTs: GENESIS_TS, latest: LATEST, calls: LIVE, callsAt: (n) => (n === LATEST ? undefined : n >= LATEST - hourBlocks ? HOUR_AGO : AT_LAUNCH) });
  /** Chains whose transport the run asked for, in order (Base's own reads included). */
  const asked: number[] = [];
  const deps: FetchDeps = { http, rpcFactory: (_url, chainId) => (asked.push(Number(chainId)), rpc), env: CHAIN_ENV, sleep: async () => undefined, now: () => NOW };
  return { db: testDb(), deps, http, rpc, asked };
}

describe('assets/aero.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'aero', symbol: 'AERO', name: 'Aero' });
    expect(holderFlowMetrics(config.income_statement)).toEqual(['flow_usd.voter_fees', 'flow_usd.vote_incentives']);
    expect('holder_flows' in config || 'reporting' in config).toBe(false); // retired (Task 11)
    // Every metric has a source.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    for (const key of ['dominance_share', 'dominance_share_1y', 'revenue_run_rate_usd']) expect(config.metrics[key], key).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // No CoinGecko or DefiLlama source anywhere (Mike, 2026-11-09: licensing; Phase 3 R4 moved the revenue on chain).
    const sources = Object.entries(config.metrics).flatMap(([k, d]) => [d.source, ...(d.cross_checks ?? []).map((c) => c.source)].map((s) => [k, s?.type, JSON.stringify(s)] as const));
    expect(sources.filter(([, t, s]) => t === 'coingecko' || t === 'defillama' || t === 'defillama_share' || /llama|coingecko/.test(s ?? '')).map(([k]) => k)).toEqual([]);
    expect(config.metrics['flow_usd.fees']).toBeUndefined(); // retired (Phase 3 R4)
    expect(config.external_ids).toEqual({ coingecko: 'aero', defillama: 'aerodrome' }); // identifiers only, until R8
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check (wrappers: + circulating_supply). A deliberate edit of assets/aero.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    // Re-pinned 2026-10-26: window 90 -> 91 days on every asset (Mike), backfill_days 90 -> 100.
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    // Re-pinned 2026-11-09: the Aero contracts (spec 2026-11-09-orion-aero-supply-design.md): on-chain price, circulating,
    // realised emissions, the upgrade reserves as dilution, no CoinGecko/DefiLlama outside revenue, revenue relabelled.
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    // Re-pinned (Phase 3 R2 Task 1): the production hash (loadAsset) now includes the asset's prices.yaml entries.
    // Re-pinned (Phase 3 R2 Task 6b): AERO names no ref (R11: entriesFor reads price.* params and scanned tokens; its price adapters are its own, R21).
    // Re-pinned (Phase 3 R2 Task 6 fix wave, E): entriesFor includes the asset's own token's prices.yaml entry (AERO's again).
    // Re-pinned (Phase 3 R2 Task 10 fix wave, A/R36): AERO's prices.yaml entry valid_from 2026-09-23 -> 2026-10-22.
    // Re-pinned (Phase 3 R3 Task 5, Ruling R6): circulating_supply rebuild_from 2026-11-10.
    // Re-pinned (Phase 3 R4 Task 8, RET-203): revenue on chain via pool_scan (five pool.* metrics, one scan block on 8
    // chains), flow_usd.fees retired, income statement scope complete (voter_rev/lp_rev, lp_fees cost, incentives below).
    expect(loadAsset(ROOT, 'aero').hash).toBe('8b0352283ee83d1d904bf56975dad00ab7c39b8a3b13af91b90ece456879a7b1');
  });

  it('v2 block shape: an income_statement with the plan line ids', () => {
    expect(statementShape(config.income_statement)).toEqual({
      category: 'dex',
      scope: 'complete',
      window_days: 91,
      revenue: ['voter_rev', 'lp_rev'],
      cost_of_revenue: ['lp_fees'],
      holders: ['voter_fees'],
      below_line: ['vote_incentives', 'protocol_subsidy'],
      of: { lp_fees: 'lp_rev', voter_fees: 'voter_rev' },
    });
    const is = config.income_statement!;
    expect(is.history_start).toBe('2026-10-22');
    expect(is.revenue.map((r) => [r.id, r.metric, r.started])).toEqual([
      ['voter_rev', 'flow_usd.voter_fees', '2026-10-22'],
      ['lp_rev', 'flow_usd.lp_fees', '2026-10-22'],
    ]);
    expect(is.cost_of_revenue).toEqual([{ id: 'lp_fees', to: 'lps', of: 'lp_rev' }]);
    expect(is.holders).toEqual([{ id: 'voter_fees', of: 'voter_rev', bucket: 'cash', haircut: 0.02, recipient_base: 'locked', capture_rule: 'contractual' }]);
    expect(is.below_line).toEqual([
      { id: 'vote_incentives', metric: 'flow_usd.vote_incentives', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked', capture_rule: 'programmatic', started: '2026-10-22' },
      { id: 'protocol_subsidy', metric: 'flow_usd.protocol_subsidy', to: 'holders', in_holder_flow: false, note: "Aero Foundation TGE wallet and governance multisig programs: Aero's own money recycled", started: '2026-10-22' },
    ]);
    expect(is.checks).toBeUndefined(); // bound, coverage and drift live in the adapter
    expect(config.income_statement?.dilution?.map((d) => [d.id, d.metric, d.cap_metric])).toEqual([
      ['aero_upgrade', 'upgrade_release_aero', 'upgrade_reserve_aero'],
      ['velo_upgrade', 'upgrade_release_velo', 'upgrade_reserve_velo'],
    ]);
  });

  it('the five pool-scan metrics: one scan block on the 8 chains, since the launch, every registry factory listed', () => {
    const defs = POOL_METRICS.map((k) => [k, config.metrics[k]!] as const);
    expect(defs.map(([k, d]) => [k, d.type, d.unit, d.cadence, d.staleness_days, d.critical, d.monitor_only])).toEqual([
      ['flow_usd.voter_fees', 'flow', 'usd', 'daily', 3, true, undefined],
      ['flow_usd.lp_fees', 'flow', 'usd', 'daily', 3, false, undefined],
      ['flow_usd.pool_fees_gross', 'flow', 'usd', 'daily', 3, false, true],
      ['flow_usd.vote_incentives', 'flow', 'usd', 'daily', 3, false, undefined],
      ['flow_usd.protocol_subsidy', 'flow', 'usd', 'daily', 3, false, undefined],
    ]);
    const params = defs.map(([, d]) => (d.source as { name: string; params: Record<string, unknown> }));
    expect(params.map((s) => [s.name, s.params.field ?? s.params.class, s.params.since, s.params.max_scan_days])).toEqual([
      ['pool.tape_fees_daily', 'allocator', '2026-10-22', undefined],
      ['pool.tape_fees_daily', 'lp', '2026-10-22', undefined],
      ['pool.tape_fees_daily', 'gross', '2026-10-22', undefined],
      ['pool.vrm_incentives_daily', 'vote_incentives', '2026-10-22', undefined],
      ['pool.vrm_incentives_daily', 'protocol_subsidy', '2026-10-22', undefined],
    ]);
    // One scan block (the YAML anchor): every metric's is the same.
    const scan = params[0]!.params.scan as { chains: { chain_id: number; factories: { address: string; kind: string; tape: string; hook?: string }[]; log_range?: number; anchors: { feed_chain_id?: number }[] }[]; subsidy_creators: string[]; root_voter?: { chain_id: number; address: string } };
    for (const p of params) expect(p.params.scan).toEqual(scan);
    expect([...scan.chains.map((c) => c.chain_id)].sort((x, y) => x - y)).toEqual([...AERO_CHAINS].sort((x, y) => x - y));
    expect(scan.chains.map((c) => [c.chain_id, c.log_range])).toEqual(scan.chains.map((c) => [c.chain_id, c.chain_id === 57073 ? 10_000 : 1_000_000]));
    expect(scan.root_voter).toEqual({ chain_id: 8453, address: '0x49d7d4f17Ec56Ef8fA04E464AF5D1A4942CC31e6' });
    expect(scan.subsidy_creators).toEqual(['0x7269de76188E6597444D0859C4e5c336D3c39dDb', '0x42255e3c2d0b71a0b006243148fdf1a71d054ce0']);
    // Every chain: the two shared V2 factories on PoolTape and its own CLFactory on CLPoolTape with the DynamicSwapFeeHook.
    const lc = (x: string) => x.toLowerCase();
    for (const c of scan.chains) {
      const main = c.factories.filter((f) => lc(f.tape) === '0x34bdd64b19d8631f936c2d07f19aaa6b83515992' || lc(f.tape) === '0x27d5eb73e7406675f6b0cbd037490ec3dba935a4');
      expect(main.map((f) => [lc(f.address), f.kind]).slice(0, 2), String(c.chain_id)).toEqual([['0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d', 'v2_stable'], ['0x8e6a9fcd1d638cc760ffba397605fe3355de76d2', 'v2_volatile']]);
      expect(main.filter((f) => f.kind === 'cl').map((f) => lc(f.hook!)), String(c.chain_id)).toEqual(['0xc0ed888afe87ed1acf01d9f19bb850159e3ce434']);
      expect(c.factories.length, String(c.chain_id)).toBe(c.chain_id === 5042 ? 6 : 3);
    }
    // Arc also lists the three Aero Lite factories its FactoryRegistry returns, on their own tapes (ruling 3).
    const arc = scan.chains.find((c) => c.chain_id === 5042)!;
    expect(arc.factories.slice(3).map((f) => [lc(f.address), f.kind, lc(f.tape), f.hook && lc(f.hook)])).toEqual([
      ['0xaed253f1ad84d99f2165256d701b2b481dd4cc16', 'v2_stable', '0x8da07efabcf124b61671df449bc73292d4b56c25', undefined],
      ['0x9bc8b3f60d349d687fb44a018967025e3741f9a5', 'v2_volatile', '0x8da07efabcf124b61671df449bc73292d4b56c25', undefined],
      ['0xb89df768af2cfe637ceb352c587fe8edaf491d03', 'cl', '0x967f5352a6448e22d7361e149103350c49345ee9', '0xaaf164008441f112eb2858d9f7a2db1b84b1e415'],
    ]);
    // Elysium's three anchors read Base's feeds; no other anchor names a feed chain.
    expect(scan.chains.flatMap((c) => c.anchors.filter((x) => x.feed_chain_id !== undefined).map((x) => [c.chain_id, x.feed_chain_id]))).toEqual([[99901, 8453], [99901, 8453], [99901, 8453]]);
  });

  it('plans the source map of the spec: chain reads and generic adapters, the pool scan for every flow', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['adapter:chain.v2_pool_twap_price', ['primary:price_usd']],
      ['adapter:chain.cl_pool_spot_price', ['cross_check:price_usd']],
      ['chain_levels', ['primary:total_supply', 'primary:staked_supply', 'primary:locked_supply', 'primary:upgrade_reserve_aero', 'primary:upgrade_reserve_velo']],
      ['adapter:chain.view_sum', ['primary:circulating_supply', 'primary:emission_ceiling_annual']],
      ['constant', ['primary:staker_emission_share']],
      ['adapter:chain.counter_rate', ['primary:emission_rate_annual', 'primary:upgrade_release_aero', 'primary:upgrade_release_velo']],
      ['adapter:pool.tape_fees_daily', ['primary:flow_usd.voter_fees', 'primary:flow_usd.lp_fees', 'primary:flow_usd.pool_fees_gross']],
      ['adapter:pool.vrm_incentives_daily', ['primary:flow_usd.vote_incentives', 'primary:flow_usd.protocol_subsidy']],
    ]);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.derived).toEqual([]);
    expect(plan.needsRpc).toBe(true);
  });

  it('fetches every non-pool metric from canned live reads, the price check in tolerance, no HTTP call', async () => {
    const w = world();
    const metrics = Object.keys(config.metrics).filter((k) => !POOL_METRICS.includes(k));
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { metrics });
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
    expect(w.http.calls).toEqual([]);
    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked.map((c) => [c.metricKey, c.ok])).toEqual([['price_usd', true]]); // the Slipstream pool, 2 percent (0.35 percent apart)
  });

  it('the pool-scan metrics read their chains through ctx.rpcFor and fail closed when a chain cannot answer: nothing written, no HTTP', async () => {
    // The canned Base world has no pool contracts, so the first chain-day read fails: the run must store no partial sum.
    // (The engine and adapters are exercised on a synthetic world in tests/ingest/adapters.pool.test.ts.)
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { metrics: POOL_METRICS });
    const why = 'chain 8453 2026-10-22: 0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d.allPoolsLength() at e−1 failed';
    expect(r.sources.map((s) => [s.sourceId, s.status])).toEqual([['adapter:pool.tape_fees_daily', 'failed'], ['adapter:pool.vrm_incentives_daily', 'failed']]);
    // The first day scanned is the launch (`since`): nothing before 2026-10-22 is ever read.
    expect(r.sources.map((s) => s.error)).toEqual([
      ['flow_usd.voter_fees', 'flow_usd.lp_fees', 'flow_usd.pool_fees_gross'].map((m) => `${m}: adapter pool.tape_fees_daily: ${why}`).join('; '),
      ['flow_usd.vote_incentives', 'flow_usd.protocol_subsidy'].map((m) => `${m}: adapter pool.vrm_incentives_daily: ${why}`).join('; '),
    ]);
    expect(r.outcome).toBe('failed');
    // Every one of the 8 chains got a transport from its env var (ctx.rpcFor), none from the network.
    expect([...new Set(w.asked)].sort((x, y) => x - y)).toEqual([...AERO_CHAINS].sort((x, y) => x - y));
    for (const m of POOL_METRICS) expect(await listActiveObservations(w.db, 'aero', m), m).toEqual([]);
    expect(w.http.calls).toEqual([]);
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
