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
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { useTestDb } from '../helpers/db.js';
import { statementShape } from '../helpers/assets.js';

const testDb = useTestDb();

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-12T12:30:00.000Z');
const BLOCK_SEC = 0.45;
const GENESIS_TS = NOW.getTime() / 1000 - 110 * 86_400;
const E18 = 10n ** 18n;
const PRICE = 2.3;

const { config } = loadAsset(ROOT, 'cake');
const C = config.contracts;
const lc = (a: string) => a.toLowerCase();
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));

/** CAKE market chart: flat at 2.3 every hour (every day past 90) over the window asked for. */
function cakeChart(url: string): { prices: [number, number][] } {
  const days = Number(new URL(url).searchParams.get('days'));
  const end = NOW.getTime();
  const step = days > 90 ? 86_400_000 : 3_600_000;
  const prices: [number, number][] = [];
  for (let t = end - days * 86_400_000; t <= end; t += step) prices.push([t, PRICE]);
  return { prices };
}

/**
 * The weekly Monday burn as live: on each Monday, the converters send 550k CAKE to the burner (and 200k to the treasury),
 * the chef returns ~60M minted CAKE to the burner and the dev share is minted straight to it, neither of which may count. Plus the 2026-09-09 address-poisoning dust.
 */
function logsBySink(): Record<string, Omit<TransferLog, 'timestamp'>[]> {
  const burner: Omit<TransferLog, 'timestamp'>[] = [];
  const treasury: Omit<TransferLog, 'timestamp'>[] = [];
  let i = 0;
  for (let d = '2026-07-06'; d <= '2026-10-05'; d = addDays(d, 7)) {
    const b = blockAt(`${d}T07:00:00Z`);
    burner.push({ blockNumber: b, logIndex: 0, txHash: `0xa${i}`, from: lc(C.converter_a), value: 300_000n * E18 });
    burner.push({ blockNumber: b, logIndex: 1, txHash: `0xb${i}`, from: lc(C.converter_b), value: 250_000n * E18 });
    burner.push({ blockNumber: b, logIndex: 2, txHash: `0xc${i}`, from: lc(C.masterchef_v2), value: 60_000_000n * E18 });
    burner.push({ blockNumber: b, logIndex: 4, txHash: `0xm${i}`, from: '0x0000000000000000000000000000000000000000', value: 6_000_000n * E18 });
    treasury.push({ blockNumber: b, logIndex: 3, txHash: `0xt${i}`, from: lc(C.converter_a), value: 200_000n * E18 });
    i++;
  }
  burner.push({ blockNumber: blockAt('2026-09-09T12:00:00Z'), logIndex: 0, txHash: '0xpoison', from: '0x0000c35b2ca02a14a01af31b070e88d8bc10dead', value: 6_010_000_000_000n });
  return { [`${lc(C.token)}>${lc(C.burner)}`]: burner, [`${lc(C.token)}>${lc(C.treasury)}`]: treasury };
}

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'pancakeswap-token', symbol: 'cake', current_price: PRICE, market_cap: 7.3e8, circulating_supply: 317_949_435, total_supply: 329_536_890 }],
    'https://api.coingecko.com/api/v3/coins/pancakeswap-token/market_chart': cakeChart,
  });
  const base = fakeRpc({
    genesisTs: GENESIS_TS,
    blockTimeSec: BLOCK_SEC,
    maxLogRange: 50_000n,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC)),
    calls: {
      // Read live on 2026-10-12.
      [callKey(C.token, 'totalSupply')]: 5_563_795_275n * E18,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.token, 'balanceOf', [C.dead])]: 5_228_326_976n * E18,
      // Pending-burn balances, read live on 2026-10-18 (same totalSupply and dead balance as above): MasterChef v2's float
      // of 347,302 CAKE and the burner's 0.69 CAKE (rounded to 0 here).
      [callKey(C.token, 'balanceOf', [C.masterchef_v2])]: 347_302n * E18,
      [callKey(C.token, 'balanceOf', [C.burner])]: 0n,
      [callKey(C.masterchef_v2, 'cakePerBlock', [true])]: 40_000_000n,
      [callKey(C.masterchef_v2, 'cakePerBlock', [false])]: 113_292_343_840_000_000n,
      [callKey(C.chainlink_cake_usd, 'latestAnswer')]: 229_459_054n,
    },
  });
  const logs = logsBySink();
  const rpc: RpcTransport = {
    ...base,
    async getTransferLogs(q) {
      return (logs[`${lc(q.token)}>${lc(q.to)}`] ?? [])
        .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
        .map((l) => ({ ...l, timestamp: base.timestampOf(l.blockNumber) }));
    },
  };
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: { ORION_BNB_RPC_URL: 'http://bnb.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: testDb(), deps, http };
}

describe('assets/cake.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'cake', symbol: 'CAKE', chain: 'bnb', ingest: { chain_id: 56, rpc_url_env: 'ORION_BNB_RPC_URL', backfill_days: 100 } });
    expect(holderFlowMetrics(config.income_statement)).toEqual(['flow_usd.burn']);
    expect('holder_flows' in config || 'reporting' in config).toBe(false); // retired (Task 11)
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // No DefiLlama (Phase 3 R1): its gross fees and revenue display series are gone; volume is not_measured.
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama').map(([k]) => k)).toEqual([]);
    expect(config.income_statement!.volume).toEqual({ not_measured: 'gross swap fees: DefiLlama removed (Phase 3 R1); on-chain v2/v3 gross not read yet (Phase 3b)' });
    for (const key of ['dominance_share', 'dominance_share_1y', 'revenue_run_rate_usd']) expect(config.metrics[key], key).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // A deliberate edit of assets/cake.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    // Re-pinned 2026-11-10 (fix/cake-pending-burn 0ecc69e): total_supply nets the burner and MasterChef v2; CoinGecko total cross-check dropped.
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/cake.yaml`, 'utf8')).hash).toBe('5434fc561d3f70d20eb8e31be5cf41b03e691bf14a4fa1d14b845d072c4d5837');
  });

  it('v2 block shape: an income_statement with the plan line ids', () => {
    // Income statement v2 (Phase 2 Task 2), beside reporting for one release: the plan's line ids, which the v2 report and
    // the parity map key on. A revenue line a use line passes on with the same name is `<name>_rev` (ruling R8).
    expect(statementShape(config.income_statement)).toEqual({
      category: 'dex',
      scope: 'protocol_share_only',
      window_days: 91,
      revenue: ['burn_rev', 'treasury_rev'],
      cost_of_revenue: ['lp_fees'],
      holders: ['burn'],
      protocol: ['treasury'],
      checks: ['price_chainlink'],
      of: { burn: 'burn_rev', treasury: 'treasury_rev' },
    });
  });

  it('plans one allowlisted scan into the burner (chef ignored, dust floor) and one into the treasury', () => {
    const plan = buildPlan(config);
    expect(plan.flowGroups.map((g) => [g.sourceId, g.ignore, g.ignoreBelowTokens, g.members.map((m) => m.metricKey)])).toEqual([
      [expect.stringMatching(/^transfer_flow:token>burner/), [lc(C.zero), lc(C.masterchef_v2)], 1, ['flow_usd.burn', 'flow_tokens.burn']],
      [expect.stringMatching(/^transfer_flow:token>treasury/), [], 1, ['flow_usd.treasury']],
    ]);
    expect(plan.derived).toEqual([]);
  });

  it('fetches every metric and counts only the fee-funded burn', async () => {
    const w = world();
    const r = await fetchAsset(w.db, loadAsset(ROOT, 'cake'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const burnScan = r.sources.find((s) => s.sourceId.startsWith('transfer_flow:token>burner'))!;
    expect(burnScan.unlistedTransfers).toEqual([]);
    expect(burnScan.notes).toContain('not counted, as configured: 28 from from_ignore senders, 1 dust (below 1 tokens)');

    const rows = async (metric: string) => await listActiveObservations(w.db, 'cake', metric);
    const value = async (metric: string) => (await rows(metric)).at(-1)!.value;
    expect(await value('price_usd')).toBe(PRICE);
    expect(await value('total_supply')).toBe(335_120_997);
    expect(await value('emission_rate_annual') / 1e6).toBeCloseTo(7.9396, 3);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['price_usd', true]]);
    expect(w.http.calls.filter((c) => /llama\.fi/.test(new URL(c.url).host)).map((c) => c.url)).toEqual([]); // Phase 3 R1

    // 14 Mondays of 550k CAKE: 13 inside the 91 days to 2026-10-11 (07-13..10-05).
    const burns = (await rows('flow_tokens.burn')).filter((o) => o.value > 0);
    expect(burns.map((o) => o.value)).toEqual(Array(14).fill(550_000));
    expect(await rows('revenue_run_rate_usd')).toEqual([]); // no derived run rate any more (it fed only the valuation)
  });

  it('reports the burn against emissions in tokens, and the treasury share as protocol income', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    const report = await loadHolderYieldReport(w.db, config);
    const rep = report.incomeStatement!; // Task 11b: the v2 statement (v1 retired)
    expect(rep.day).toBe('2026-10-11');
    expect(rep.yields.buyback).toBeCloseTo((13 * 550_000 * PRICE * 365) / 91 / (335_120_997 * PRICE), 6);
    expect(rep.dilution.supply).toMatchObject({ burnedPerYear: expect.closeTo((13 * 550_000 * 365) / 91, 0) });
    expect(rep.dilution.supply!.netPerYear).toBeLessThan(0);
    expect(rep.revenue.annualized).toBeCloseTo((13 * 750_000 * PRICE * 365) / 91, 0);
    expect(rep.ratios.payoutRatio).toBeCloseTo(550 / 750, 6);
    expect(rep.volume).toMatchObject({ annualized: null, notMeasured: expect.stringContaining('DefiLlama removed') });
  });

  it('is covered by the DEX analyst, who knows to read the burn at the converters', () => {
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona.body).toContain('A buyback-and-burn with a mint-and-burn on top (CAKE)');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
  });

  it('refuses to run without the BNB Chain RPC URL', async () => {
    const w = world();
    await expect(fetchAsset(w.db, { config, hash: 'test' }, NOW, { ...w.deps, env: {} })).rejects.toMatchObject({ code: 'missing_rpc_url' });
  });
});
