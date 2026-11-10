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
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { useTestDb } from '../helpers/db.js';
import { statementShape } from '../helpers/assets.js';

const testDb = useTestDb();

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-16T10:30:00.000Z');
const BLOCK_SEC = 12;
const GENESIS_TS = NOW.getTime() / 1000 - 400 * 86_400 + 1;
const E18 = 10n ** 18n;
const PRICE = 12.5;

const { config } = loadAsset(ROOT, 'link');
const C = config.contracts;
const lc = (a: string) => a.toLowerCase();
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));
const RELEASE_SAFE = '0xa42d0a18b834f52e41beddeaa2940165db3da9a3'; // one of Chainlink's non-circulating Safes
const STRANGER = '0x7630c870da0f44308a2676898010bed93bd89c19';

/** LINK market chart: flat at 12.5 every hour (every day past 90) over the window asked for. */
function linkChart(url: string): { prices: [number, number][] } {
  const days = Number(new URL(url).searchParams.get('days'));
  const end = NOW.getTime();
  const step = days > 90 ? 86_400_000 : 3_600_000;
  const prices: [number, number][] = [];
  for (let t = end - days * 86_400_000; t <= end; t += step) prices.push([t, PRICE]);
  return { prices };
}

/**
 * Into the Reserve: 100,000 LINK every Thursday from the fee converter (2026-10-15 back 15 weeks), a 5-LINK test send
 * from another wallet (under the 10-LINK dust floor, as the August 2025 tests were), and one 2,000-LINK send from a
 * stranger, which must be flagged, not counted.
 */
const TESTER = '0x46de11332d1e25ca6e9ff95997ae97386e584aea'; // sent test amounts to the Reserve in August 2025
const thursdays = Array.from({ length: 15 }, (_, i) => addDays('2026-10-15', -7 * i));
const reserveLogs: Omit<TransferLog, 'timestamp'>[] = [
  ...thursdays.map((d, i) => ({ blockNumber: blockAt(`${d}T15:36:00Z`), logIndex: 0, txHash: `0xr${i}`, from: lc(C.fee_converter), value: 100_000n * E18 })),
  { blockNumber: blockAt('2026-09-02T10:00:00Z'), logIndex: 1, txHash: '0xdust', from: TESTER, value: 5n * E18 },
  { blockNumber: blockAt('2026-09-09T10:00:00Z'), logIndex: 0, txHash: '0xstranger', from: STRANGER, value: 2_000n * E18 },
];
/** Releases: four quarters of 15M to the hub and 2.5M to the rewards Safe, plus address-poisoning dust, and one older than a year. */
const quarters = ['2025-12-19', '2026-04-03', '2026-06-19', '2026-10-09'];
const releaseLogs = (to: string, tokens: bigint): Omit<TransferLog, 'timestamp'>[] => [
  ...quarters.map((d, i) => ({ blockNumber: blockAt(`${d}T14:00:00Z`), logIndex: 0, txHash: `0x${to.slice(2, 6)}${i}`, from: RELEASE_SAFE, value: tokens * E18 })),
  { blockNumber: blockAt('2026-10-09T15:00:00Z'), logIndex: 2, txHash: `0x${to.slice(2, 6)}dust`, from: STRANGER, value: 1n * E18 },
  { blockNumber: blockAt('2025-10-10T14:00:00Z'), logIndex: 0, txHash: `0x${to.slice(2, 6)}old`, from: RELEASE_SAFE, value: tokens * E18 },
];
const logsTo: Record<string, Omit<TransferLog, 'timestamp'>[]> = {
  [lc(C.reserve)]: reserveLogs,
  [lc(C.release_hub)]: releaseLogs(C.release_hub, 15_000_000n),
  [lc(C.release_rewards)]: releaseLogs(C.release_rewards, 2_500_000n),
};

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'chainlink', symbol: 'link', current_price: PRICE, market_cap: 9.6e9, circulating_supply: 766_849_970, total_supply: 1_000_000_000 }],
    'https://api.coingecko.com/api/v3/coins/chainlink/market_chart': linkChart,
  });
  const base = fakeRpc({
    genesisTs: GENESIS_TS,
    blockTimeSec: BLOCK_SEC,
    maxLogRange: 10_000n,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC)),
    calls: {
      // Read live on 2026-10-16.
      [callKey(C.token, 'totalSupply')]: 1_000_000_000n * E18,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.token, 'balanceOf', [C.reserve])]: 6_293_843n * E18,
      [callKey(C.chainlink_link_usd, 'latestAnswer')]: 1_244_185_063n,
    },
  });
  const rpc = {
    ...base,
    async getTransferLogs(q: { token: string; to: string; fromBlock: bigint; toBlock: bigint }) {
      await base.getTransferLogs(q); // keeps the range cap and stats
      if (lc(q.token) !== lc(C.token)) return [];
      return (logsTo[lc(q.to)] ?? []).filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock).map((l) => ({ ...l, timestamp: base.timestampOf(l.blockNumber) }));
    },
  };
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: testDb(), deps, http, rpc };
}

describe('assets/link.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'link', symbol: 'LINK', chain: 'ethereum', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(holderFlowMetrics(config.income_statement)).toEqual(['flow_usd.reserve']);
    expect('holder_flows' in config || 'reporting' in config).toBe(false); // retired (Task 11)
    // Every metric has a source (the one manual metric, the category share, left with the valuation layer).
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // No DefiLlama at all (Mike, 2026-10-11): the Reserve flow and the releases are read on chain.
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama' || d.cross_checks?.some((c) => c.source.type === 'defillama')).map(([k]) => k)).toEqual([]);
    // The hold bucket's overhang haircut (Mike, 2026-10-16: 5 percent).
    expect(config.income_statement!.holders!.map((h) => [h.id, h.bucket, h.haircut, h.capture_rule])).toEqual([['reserve', 'hold', 0.05, 'discretionary']]);
    for (const key of ['dominance_share', 'dominance_share_1y', 'revenue_run_rate_usd']) expect(config.metrics[key], key).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // A deliberate edit of assets/link.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share (monitor-only category share).
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/link.yaml`, 'utf8')).hash).toBe('6bc2033876e803860ab6aa949e6ab20a1db8f24d695e12a454ec7f7a77d0f8b1');
  });

  it('v2 block shape: an income_statement with the plan line ids', () => {
    // Income statement v2 (Phase 2 Task 2), beside reporting for one release: the plan's line ids, which the v2 report and
    // the parity map key on. A revenue line a use line passes on with the same name is `<name>_rev` (ruling R8).
    expect(statementShape(config.income_statement)).toEqual({
      category: 'oracle',
      scope: 'protocol_share_only',
      window_days: 91,
      revenue: ['onchain_fees'],
      cost_of_revenue: ['node_operators'],
      holders: ['reserve'],
      checks: ['price_chainlink', 'reserve_balance'],
      of: { reserve: 'onchain_fees' },
    });
  });

  it('plans the Reserve scan, the two release scans and the chain levels with the Chainlink cross-check', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'cross_check:total_supply', 'primary:circulating_supply']],
      ['chain_levels', ['cross_check:price_usd', 'primary:total_supply', 'primary:reserve_link']],
      ['constant', ['primary:staked_supply', 'primary:staker_emission_share', 'primary:emission_rate_annual']],
    ]);
    expect(plan.flowGroups.map((g) => [g.sourceId, g.members.map((m) => m.metricKey)])).toEqual([
      [expect.stringMatching(/^transfer_flow:token>reserve/), ['flow_usd.reserve', 'flow_tokens.reserve']],
      [expect.stringMatching(/^transfer_flow:token>release_hub/), ['flow_tokens.released_hub']],
      [expect.stringMatching(/^transfer_flow:token>release_rewards/), ['flow_tokens.released_rewards']],
    ]);
    expect(plan.derived.map((r) => r.metricKey).sort()).toEqual(['released_rate']);
  });

  it('fetches every metric, counts only the fee converter, and flags the stranger', async () => {
    const w = world();
    // The year of releases first (live does this as the onboarding backfill); then the routine tick reads 100 days.
    await fetchAsset(w.db, { config, hash: 'backfill' }, NOW, w.deps, { backfillDays: 370, metrics: ['flow_tokens.released_hub', 'flow_tokens.released_rewards', 'released_rate'] });
    const r = await fetchAsset(w.db, loadAsset(ROOT, 'link'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error])).toEqual([]);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true]]);

    const rows = async (metric: string) => await listActiveObservations(w.db, 'link', metric);
    const value = async (metric: string) => (await rows(metric)).at(-1)!.value;
    expect(await value('price_usd')).toBe(PRICE);
    expect(await value('total_supply')).toBe(1_000_000_000);
    expect(await value('reserve_link')).toBe(6_293_843);
    expect(await value('emission_rate_annual')).toBe(0);

    // The stranger's 2,000 LINK is an unlisted sender (an alert on the holder flow), never counted; the 5-LINK test is dust.
    const reserveScan = r.sources.find((s) => s.sourceId.startsWith('transfer_flow:token>reserve'))!;
    expect(reserveScan.unlistedTransfers.map((t) => [t.from, t.tokens])).toEqual([[STRANGER, 2_000]]);
    expect(r.anomalies.map((a) => [a.kind, a.metricKey])).toEqual([['unlisted_sender', 'flow_usd.reserve']]);
    const paid = (await rows('flow_tokens.reserve')).filter((o) => o.value > 0);
    expect(paid.map((o) => o.value).every((v) => v === 100_000)).toBe(true);
    expect(paid.length).toBe(15);
    expect(await rows('revenue_run_rate_usd')).toEqual([]); // no derived run rate any more (it fed only the valuation)

    // Releases: the four quarters inside the last 365 days, the dust and the year-old release left out.
    expect(await value('released_rate')).toBeCloseTo(4 * (15_000_000 + 2_500_000), 0);
  });

  it('reports the Reserve as a hold with the 5 percent haircut, and the releases as dilution', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { backfillDays: 370 });
    const report = await loadHolderYieldReport(w.db, config);
    const rep = report.incomeStatement!; // Task 11b: the v2 statement (v1 retired)
    expect(rep.day).toBe('2026-10-15');
    const gross = (13 * 100_000 * PRICE * 365) / 91;
    expect(rep.holderFlow.lines).toEqual([expect.objectContaining({ id: 'reserve', bucket: 'hold', haircut: 0.05, gross: expect.closeTo(gross, 0), net: expect.closeTo(gross * 0.95, 0) })]);
    expect(rep.holderFlow.byBucket.hold!.net).toBeCloseTo(gross * 0.95, 0);
    expect(rep.holderFlow.byBucket.burn).toBeNull();
    const fdv = 1_000_000_000 * PRICE;
    expect(report.fdv).toBeCloseTo(fdv, 0);
    expect(report.marketCap).toBeCloseTo(766_849_970 * PRICE, 0);
    expect(rep.yields.buyback).toBeCloseTo((gross * 0.95) / fdv, 6);
    expect(rep.yields.dilutionLines).toEqual([{ id: 'releases', tokensPerYear: 70_000_000, yield: expect.closeTo(0.07, 6) }]);
    expect(rep.yields.dilution).toBeCloseTo(0.07, 6);
  });

  it('refuses to run without the Ethereum RPC URL', async () => {
    const w = world();
    await expect(fetchAsset(w.db, { config, hash: 'test' }, NOW, { ...w.deps, env: {} })).rejects.toMatchObject({ code: 'missing_rpc_url' });
  });
});

describe('the LINK persona', () => {
  it('is the oracle-network analyst, which knows the Reserve and the releases', () => {
    const persona = loadPersona(ROOT, 'oracle-network-analyst');
    expect(persona.body).toContain('A reserve that buys and holds (LINK)');
    expect(persona.body).toContain('Releases are dilution, not emissions');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
  });
});
