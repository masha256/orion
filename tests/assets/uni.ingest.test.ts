import { readFileSync } from 'node:fs';
import { holderFlowMetrics } from '../../src/config/incomeStatement.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { loadPersona } from '../../src/config/personas.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { addDays } from '../../src/ingest/time.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { useTestDb } from '../helpers/db.js';
import { statementShape } from '../helpers/assets.js';

const testDb = useTestDb();

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-11T10:30:00.000Z');
const BLOCK_SEC = 12;
const GENESIS_TS = NOW.getTime() / 1000 - 110 * 86_400 + 1;
const E18 = 10n ** 18n;

const { config } = loadAsset(ROOT, 'uni');
const C = config.contracts;
const BRIDGE = '0x3154cf16ccdb4c6d922629664174b904d80f2c35'; // OP Mainnet's L1 bridge (L1ChugSplashProxy): L2 burns bridged back
const SEARCHER = '0xc6208ce00b3f88c6555833ab9bbc943717dfd941'; // a mainnet Firepit searcher contract
const PRICE = 7.5;

/** UNI market chart: flat at 7.5 every hour (every day past 90) over the window asked for. */
function uniChart(url: string): { prices: [number, number][] } {
  const days = Number(new URL(url).searchParams.get('days'));
  const end = NOW.getTime();
  const step = days > 90 ? 86_400_000 : 3_600_000;
  const prices: [number, number][] = [];
  for (let t = end - days * 86_400_000; t <= end; t += step) prices.push([t, PRICE]);
  return { prices };
}

/** 100 days of gross swap fees to 2026-10-10, 4.6M USD a day (DefiLlama's real 91-day sum was 426M on 2026-10-11). */
function feesChart(): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 100; i >= 1; i--) points.push([Date.parse(`${addDays('2026-10-10', 1 - i)}T00:00:00Z`) / 1000, 4_600_000]);
  return { totalDataChart: points };
}

/**
 * Burns for each of the 100 days to 2026-10-10: 48,000 UNI a day from the bridge, 16,000 from a searcher (75/25 as live),
 * plus the Timelock's one 100M burn on one day, which must be left out. 64,000 UNI a day = 23.36M a year, the live rate.
 */
function burnLogs() {
  const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));
  const logs = [];
  for (let i = 0; i < 100; i++) {
    const day = addDays('2026-10-10', -i);
    logs.push({ blockNumber: blockAt(`${day}T06:00:00Z`), logIndex: 0, txHash: `0xb${i}`, from: BRIDGE, value: 48_000n * E18 });
    logs.push({ blockNumber: blockAt(`${day}T18:00:00Z`), logIndex: 0, txHash: `0xs${i}`, from: SEARCHER, value: 16_000n * E18 });
  }
  logs.push({ blockNumber: blockAt('2026-09-01T12:00:00Z'), logIndex: 1, txHash: '0xtl', from: C.timelock.toLowerCase(), value: 100_000_000n * E18 });
  return logs;
}

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'uniswap', symbol: 'uni', current_price: PRICE, market_cap: 4.7e9, circulating_supply: 624_978_422, total_supply: 887_216_418 }],
    'https://api.coingecko.com/api/v3/coins/uniswap/market_chart': uniChart,
    'https://api.llama.fi/summary/fees/uniswap': feesChart(),
  });
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    blockTimeSec: BLOCK_SEC,
    maxLogRange: 10_000n,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC)),
    calls: {
      // Read live on 2026-10-11.
      [callKey(C.token, 'totalSupply')]: 1_000_000_000n * E18,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.token, 'balanceOf', [C.dead])]: 112_783_581n * E18,
      [callKey(C.token, 'balanceOf', [C.timelock])]: 262_247_996n * E18,
      [callKey(C.token, 'allowance', [C.timelock, C.vesting])]: 20_000_000n * E18,
      [callKey(C.vesting, 'quarterlyVestingAmount')]: 5_000_000n * E18,
      [callKey(C.chainlink_uni_usd, 'latestAnswer')]: 757_500_416n,
    },
    logs: burnLogs(),
  });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: testDb(), deps, http, rpc };
}

describe('assets/uni.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'uni', symbol: 'UNI', chain: 'ethereum', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(holderFlowMetrics(config.income_statement)).toEqual(['flow_usd.burn']);
    expect('holder_flows' in config || 'reporting' in config).toBe(false); // retired (Task 11)
    // Every metric has a source, and none is manual: a bootstrap run has nothing to research and the grade can be A.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // DefiLlama only for the gross swap fees (Mike, 2026-10-11): the one series with no on-chain source.
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama' || d.cross_checks?.some((c) => c.source.type === 'defillama')).map(([k]) => k)).toEqual(['flow_usd.swap_fees']);
    for (const key of ['dominance_share', 'dominance_share_1y', 'revenue_run_rate_usd']) expect(config.metrics[key], key).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check; then the revenue label (protocol fees, v2 + selected v3). A deliberate edit of assets/uni.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/uni.yaml`, 'utf8')).hash).toBe('e63169375421ff156ebf8735ea21897828794118ac68ecff22f3f9f3b131c792');
  });

  it('v2 block shape: an income_statement with the plan line ids', () => {
    // Income statement v2 (Phase 2 Task 2), beside reporting for one release: the plan's line ids, which the v2 report and
    // the parity map key on. A revenue line a use line passes on with the same name is `<name>_rev` (ruling R8).
    expect(statementShape(config.income_statement)).toEqual({
      category: 'dex',
      scope: 'protocol_share_only',
      window_days: 91,
      revenue: ['protocol_fees'],
      cost_of_revenue: ['lps'],
      holders: ['burn'],
      checks: ['price_chainlink'],
      of: { burn: 'protocol_fees' },
    });
  });

  it('plans one any-sender scan of burns, the chain levels with the Chainlink cross-check, the constants and the fees feed', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'cross_check:total_supply', 'primary:circulating_supply']],
      ['chain_levels', ['cross_check:price_usd', 'primary:total_supply', 'primary:labs_vest_rate', 'primary:labs_vest_approved', 'primary:treasury_uni']],
      ['constant', ['primary:staked_supply', 'primary:staker_emission_share', 'primary:emission_rate_annual']],
      ['defillama:uniswap:dailyFees', ['primary:flow_usd.swap_fees']],
    ]);
    expect(plan.flowGroups).toHaveLength(1);
    expect(plan.flowGroups[0]).toMatchObject({ sourceId: 'transfer_flow:token>dead[*]', anySender: true, allowlist: [], ignore: [C.timelock.toLowerCase()] });
    expect(plan.flowGroups[0].members.map((m) => [m.metricKey, m.unit, m.countFrom])).toEqual([['flow_usd.burn', 'usd', null], ['flow_tokens.burn', 'tokens', null]]);
    expect(plan.derived).toEqual([]);
  });

  it('fetches every metric from canned sources and counts every burner but the Timelock', async () => {
    const w = world();
    const r = await fetchAsset(w.db, loadAsset(ROOT, 'uni'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const scan = r.sources.find((s) => s.sourceId === 'transfer_flow:token>dead[*]')!;
    expect(scan.unlistedTransfers).toEqual([]);
    expect(scan.notes).toContain('not counted, as configured: 1 from from_ignore senders');

    const rows = async (metric: string) => await listActiveObservations(w.db, 'uni', metric);
    const value = async (metric: string) => (await rows(metric)).at(-1)!.value;
    expect(await value('price_usd')).toBe(PRICE);
    expect(await value('total_supply')).toBe(887_216_419);
    expect(await value('staked_supply')).toBe(0);
    expect(await value('emission_rate_annual')).toBe(0);
    expect(await value('labs_vest_rate')).toBe(20_000_000);
    expect(await value('labs_vest_approved')).toBe(20_000_000);
    expect(await value('treasury_uni')).toBe(262_247_996);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true]]);

    // 100 days, 64,000 UNI each (the Timelock's 100M left out), at 7.5 USD.
    const burns = await rows('flow_tokens.burn');
    expect(burns).toHaveLength(100);
    expect(burns.every((o) => o.value === 64_000)).toBe(true);
    expect(JSON.parse((await rows('flow_usd.burn')).at(-1)!.sourceDetail!).senders).toEqual({ [BRIDGE]: { count: 1, tokens: 48_000 }, [SEARCHER]: { count: 1, tokens: 16_000 } });
    expect(await rows('revenue_run_rate_usd')).toEqual([]); // no derived run rate any more (it fed only the valuation)
  });

  it('reports the burn against the Labs vest as dilution, and the gross swap fees as volume', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    const report = await loadHolderYieldReport(w.db, config);
    const rep = report.incomeStatement!; // Task 11b: the v2 statement (v1 retired)
    expect(rep.day).toBe('2026-10-10');
    const mcap = 887_216_419 * PRICE;
    expect(rep.yields.buyback).toBeCloseTo((64_000 * 365 * PRICE) / mcap, 6);
    // 20M a year vesting (capped by the 20M approved) on 887.2M total supply: 2.25 percent.
    expect(rep.yields.dilution).toBeCloseTo(20_000_000 / 887_216_419, 6);
    expect(rep.yields.dilutionLines).toEqual([{ id: 'labs_vest', tokensPerYear: 20_000_000, yield: expect.closeTo(20_000_000 / 887_216_419, 6) }]);
    expect(rep.yields.netShareholder).toBeCloseTo((64_000 * 365 - 20_000_000) / 887_216_419, 6);
    expect(rep.volume!.annualized).toBeCloseTo(4_600_000 * 365, 0);
    // In tokens: 64,000 a day burned (23.36M a year) against 20M vested: supply shrinks 3.36M a year.
    expect(rep.dilution.supply).toMatchObject({ burnedPerYear: expect.closeTo(23_360_000, 0), addedPerYear: 20_000_000, netPerYear: expect.closeTo(-3_360_000, 0) });
    expect(rep.dilution.supply!.netPct).toBeCloseTo(-3_360_000 / 887_216_419, 6);
    expect(rep.ratios.payoutRatio).toBeCloseTo(1);
  });

  it('refuses to run without the Ethereum RPC URL', async () => {
    const w = world();
    await expect(fetchAsset(w.db, { config, hash: 'test' }, NOW, { ...w.deps, env: {} })).rejects.toMatchObject({ code: 'missing_rpc_url' });
  });
});

describe('the UNI persona', () => {
  it('is the DEX analyst, which knows the fee-switch burn', () => {
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona.body).toContain('A fee-switch burn (UNI)');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
  });
});
