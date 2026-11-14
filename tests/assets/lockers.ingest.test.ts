import { holderFlowMetrics } from '../../src/config/incomeStatement.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { evmTokenRef } from '../../src/db/prices.js';
import { fakePriceWriter } from '../helpers/chainPrices.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { liveEvmCalls, priceRef } from '../helpers/livePrices.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { useTestDb } from '../helpers/db.js';
import { statementShape } from '../helpers/assets.js';

const testDb = useTestDb();

/**
 * The two multi-stream CRV liquid lockers (cvxCRV, sdCRV): each pays its stakers in three tokens, each a holder flow
 * scanned at the staking contract (or the bribe stash), summed into one run rate. Canned feeds at about live levels.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-09T07:30:00.000Z'); // a Friday
const BLOCK_SEC = 12;
const GENESIS_TS = NOW.getTime() / 1000 - 110 * 86_400 + 1;
const E18 = 10n ** 18n;
const LATEST = BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC));
const LATEST_TS = GENESIS_TS + Number(LATEST) * BLOCK_SEC;
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));

/** Every `everyDays` days from 2026-07-04 to 2026-10-03 at 12:00Z. */
function payoutDays(everyDays: number): string[] {
  const out: string[] = [];
  for (let d = Date.parse('2026-07-04T12:00:00Z'); d <= Date.parse('2026-10-03T12:00:00Z'); d += everyDays * 86_400_000) out.push(new Date(d).toISOString());
  return out;
}

/** Transfers by token and sink: the fake RPC's own log list is one stream, so route by query instead. */
function multiLogRpc(base: ReturnType<typeof fakeRpc>, logs: Record<string, Omit<TransferLog, 'timestamp'>[]>): RpcTransport {
  return {
    ...base,
    async getTransferLogs(q) {
      const all = logs[`${q.token.toLowerCase()}>${q.to.toLowerCase()}`] ?? [];
      return all
        .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
        .map((l) => ({ ...l, timestamp: base.timestampOf(l.blockNumber) }));
    },
  };
}

interface Case {
  id: 'cvxcrv' | 'sdcrv';
  hash: string;
  coingecko: string;
  price: number;
  supply: bigint;
  staked: bigint;
  stakedContract: string;
  /** flow id -> [token, sink, sender, cadence days, tokens per payout, coingecko id, price] */
  streams: Record<string, [string, string, string, number, bigint, string, number]>;
}

const cvx = loadAsset(ROOT, 'cvxcrv').config.contracts;
const sd = loadAsset(ROOT, 'sdcrv').config.contracts;

const CASES: Case[] = [
  {
    id: 'cvxcrv',
    // Re-pinned (Phase 3 R2 Task 6a): price_coingecko_id retired from the transfer_flow members.
    // Re-pinned (Phase 3 R2 Task 6b): price_usd reads price.token with its prices.yaml check; entriesFor reads refs (R11).
    // Re-pinned (Phase 3 R2 Task 6 fix wave, F/R22): no fetch-time price cross-check (its check runs hourly in the writer).
    hash: '5df3f84495c0bb20c955d7eef7deb38431094f160ff08027dd72cc164f754a4d',
    coingecko: 'convex-crv',
    price: 0.1392,
    supply: 423_825_801n,
    staked: 342_184_638n,
    stakedContract: cvx.wrapper,
    streams: {
      // About live: crvUSD 684,621 / 91 days in daily checkpoints, CRV 1.64M, CVX 106K.
      fees: [cvx.crvusd, cvx.wrapper, cvx.crvusd_pool, 1, 7_500n, 'crvusd', 0.9991],
      crv: [cvx.crv, cvx.wrapper, cvx.base_reward_pool, 1, 18_000n, 'curve-dao-token', 0.3534],
      cvx: [cvx.cvx, cvx.wrapper, cvx.cvx_distribution, 1, 1_160n, 'convex-finance', 2.05],
    },
  },
  {
    id: 'sdcrv',
    // Re-pinned (Phase 3 R2 Task 6a): price_coingecko_id retired from the transfer_flow members.
    // Re-pinned (Phase 3 R2 Task 6b): price_usd reads price.token with its prices.yaml check; entriesFor reads refs (R11).
    // Re-pinned (Phase 3 R2 Task 6 fix wave, F/R22): no fetch-time price cross-check (its check runs hourly in the writer).
    hash: '09a7ff1a81fdcaea3dcda853821d095a7706ae3d4c8369c7d785631cbd08a981',
    coingecko: 'stake-dao-crv',
    price: 0.1884,
    supply: 119_049_969n,
    staked: 106_861_447n,
    stakedContract: sd.gauge,
    streams: {
      // About live: weekly, crvUSD 164,457 / 13, CRV 189,832 / 13, bribes 2,452,748 sdCRV / 13.
      fees: [sd.crvusd, sd.gauge, sd.accumulator, 7, 12_650n, 'crvusd', 0.9991],
      crv: [sd.crv, sd.gauge, sd.accumulator, 7, 14_600n, 'curve-dao-token', 0.3534],
      bribes: [sd.token, sd.merkle_stash, sd.botmarket, 7, 188_700n, 'stake-dao-crv', 0.1884],
    },
  },
];

/** The plan's income statement v2 line ids per locker (Phase 2 Task 2; `_rev`: ruling R8). */
const V2: Record<Case['id'], unknown> = {
  cvxcrv: {
    category: 'liquid_locker',
    scope: 'complete',
    window_days: 91,
    revenue: ['vecrv_fees_rev', 'platform_cvxcrv', 'platform_cvx', 'platform_treasury', 'callers_fee'],
    holders: ['vecrv_fees', 'crv'],
    protocol: ['cvx_stakers', 'treasury'],
    operating_costs: ['callers'],
    below_line: ['cvx_rewards'],
    of: { vecrv_fees: 'vecrv_fees_rev', crv: 'platform_cvxcrv', cvx_stakers: 'platform_cvx', treasury: 'platform_treasury', callers: 'callers_fee' },
  },
  sdcrv: {
    category: 'liquid_locker',
    scope: 'complete',
    window_days: 91,
    revenue: ['vecrv_fees_rev', 'crv_fee_share_rev', 'vesdt_rev', 'treasury_crv_rev', 'liquidity_fee_rev', 'treasury_fees_rev', 'boost_delegators_rev'],
    holders: ['vecrv_fees', 'crv_fee_share'],
    protocol: ['vesdt', 'treasury_crv', 'liquidity_fee', 'treasury_fees'],
    operating_costs: ['boost_delegators'],
    below_line: ['bribes'],
    checks: ['crv_fee'],
    of: { vecrv_fees: 'vecrv_fees_rev', crv_fee_share: 'crv_fee_share_rev', vesdt: 'vesdt_rev', treasury_crv: 'treasury_crv_rev', liquidity_fee: 'liquidity_fee_rev', treasury_fees: 'treasury_fees_rev', boost_delegators: 'boost_delegators_rev' },
  },
};

function world(c: Case) {
  // No coins.llama.fi route: the DefiLlama price cross-check is gone (Phase 3 R1); 'fetches every stream' asserts no call.
  const routes: Record<string, unknown> = {
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: c.coingecko, current_price: c.price, circulating_supply: Number(c.supply), total_supply: Number(c.supply) }],
  };
  const calls: Record<string, bigint> = {
    [callKey(loadAsset(ROOT, c.id).config.contracts.token, 'totalSupply')]: c.supply * E18,
    [callKey(loadAsset(ROOT, c.id).config.contracts.token, 'decimals')]: 18n,
    [callKey(c.stakedContract, 'totalSupply')]: c.staked * E18,
    // price_usd (Phase 3 R2 Task 6b): the locker's Curve EMA in CRV x CRV (the TriCRV EMA x crvUSD) at the run block, at
    // the price CoinGecko gave this test (and the streams' CRV and crvUSD prices); its check reads the same.
    ...(liveEvmCalls({ [priceRef('crvUSD')]: { usd: 0.9991 }, [priceRef('CRV')]: { usd: 0.3534 }, [priceRef(c.id === 'cvxcrv' ? 'cvxCRV' : 'sdCRV')]: { usd: c.price } }, { endTs: LATEST_TS, startTs: LATEST_TS - 3600 }).end as Record<string, bigint>),
  };
  const logs: Record<string, Omit<TransferLog, 'timestamp'>[]> = {};
  let tx = 0;
  // Chain prices by token ref, flat per stream (the CoinGecko charts this test served before Phase 3 R2).
  const priceOf = new Map<string, number>();
  for (const [token, sink, sender, every, amount, , price] of Object.values(c.streams)) {
    priceOf.set(evmTokenRef(1, token), price);
    calls[callKey(token, 'decimals')] = 18n;
    logs[`${token.toLowerCase()}>${sink.toLowerCase()}`] = payoutDays(every).map((iso) => ({ blockNumber: blockAt(iso), logIndex: 0, txHash: `0x${(tx++).toString(16)}`, from: sender, value: amount * E18 }));
  }
  const base = fakeRpc({ genesisTs: GENESIS_TS, blockTimeSec: BLOCK_SEC, maxLogRange: 10_000n, latest: LATEST, calls });
  const rpc = multiLogRpc(base, logs);
  const http = fakeHttp(routes as Parameters<typeof fakeHttp>[0]);
  const deps: FetchDeps = {
    http, rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW,
    priceWriter: fakePriceWriter((ref) => priceOf.get(ref) ?? null),
  };
  return { db: testDb(), deps, http };
}

for (const c of CASES) describe(`assets/${c.id}.yaml`, () => {
  const { config, prices } = loadAsset(ROOT, c.id);
  const flowIds = Object.keys(c.streams);

  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: c.id, chain: 'ethereum', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(holderFlowMetrics(config.income_statement)).toEqual(flowIds.map((id) => `flow_usd.${id}`));
    // Every holder-flow line: cash, to stakers, valued per staked token.
    const lines = [...(config.income_statement!.holders ?? []), ...(config.income_statement!.below_line ?? []).filter((b) => b.to === 'holders')];
    expect(lines.map((l) => [l.bucket, l.recipient_base, l.valued_per])).toEqual(flowIds.map(() => ['cash', 'staked', 'recipients']));
    expect('holder_flows' in config || 'reporting' in config).toBe(false); // retired (Task 11)
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    expect(config.metrics.revenue_run_rate_usd).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    // Re-pinned (Phase 3 R2 Task 1): the production hash (loadAsset) now includes the asset's prices.yaml entries.
    expect(loadAsset(ROOT, c.id).hash).toBe(c.hash);
    // Supply definitions (Mike, 2026-10-12): CoinGecko has no circulating supply for the wrappers, so it is the on-chain total;
    // No total_supply cross-check on either (Phase 3 R1 removed CoinGecko's total and DefiLlama's price). The price is its
    // prices.yaml method (Task 6b); its check (cvxCRV's get_dy on the old pool, sdCRV's 0.3-1.0 CRV band) runs hourly in
    // the writer, never at fetch (Ruling R22).
    expect(config.metrics.circulating_supply?.source).toEqual(config.metrics.total_supply.source);
    expect(config.metrics.total_supply.cross_checks).toBeUndefined();
    const ref = priceRef(c.id === 'cvxcrv' ? 'cvxCRV' : 'sdCRV');
    expect(config.metrics.price_usd.source).toEqual({ type: 'adapter', name: 'price.token', params: { ref } });
    expect(config.metrics.price_usd.cross_checks).toBeUndefined();
  });

  it('v2 block shape: an income_statement with the plan line ids', () => {
    // Income statement v2 (Phase 2 Task 2), beside reporting for one release: the plan's line ids, which the v2 report and
    // the parity map key on. A revenue line a use line passes on with the same name is `<name>_rev` (ruling R8).
    expect(statementShape(config.income_statement)).toEqual(V2[c.id]);
  });

  it('plans one transfer scan per stream and no derived level', () => {
    const plan = buildPlan(config);
    // One scan per holder-flow stream, then the report-only revenue and gross scans (never a holder flow).
    const reportFlows = Object.entries(config.metrics).filter(([, d]) => d.type === 'flow' && d.monitor_only === true).map(([k]) => k);
    const is = config.income_statement!;
    // Every revenue and volume line is a report-only flow; a report-only flow may also be a record only (e.g. the whole
    // fee, of which only the protocol's part is revenue).
    const incomeMetrics = [...is.revenue, ...(is.cost_of_revenue ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])].flatMap((l) => (l.metric ? [l.metric] : []));
    expect(reportFlows).toEqual(expect.arrayContaining([...incomeMetrics.filter((m) => config.metrics[m]?.monitor_only), ...((is.volume ?? []) as string[])]));
    expect(plan.flowGroups.map((g) => g.members.map((m) => m.metricKey))).toEqual([...flowIds.map((id) => [`flow_usd.${id}`]), ...reportFlows.map((m) => [m])]);
    expect(plan.derived).toEqual([]);
  });

  it('fetches every stream', async () => {
    const w = world(c);
    const r = await fetchAsset(w.db, { config, hash: 'test', prices }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    const rows = async (metric: string) => await listActiveObservations(w.db, c.id, metric);
    expect((await rows('price_usd')).at(-1)!.value).toBeCloseTo(c.price, 12); // EMA in CRV x CRV in crvUSD x crvUSD
    expect(r.sources.flatMap((s) => s.crossChecks).map((x) => [x.metricKey, x.ok])).toEqual([]); // no price cross-check (R22)
      expect(w.http.calls.filter((x) => new URL(x.url).host === 'coins.llama.fi').map((x) => x.url)).toEqual([]); // Phase 3 R1
    expect((await rows('total_supply')).at(-1)!.value).toBe(Number(c.supply));
    expect((await rows('staked_supply')).at(-1)!.value).toBe(Number(c.staked));

    // Every stream is stored daily at the payout's value; no derived run rate any more (it fed only the valuation).
    for (const [id, [, , , , amount, , price]] of Object.entries(c.streams)) {
      const stream = await rows(`flow_usd.${id}`);
      expect(stream.length).toBeGreaterThanOrEqual(91);
      expect(stream.find((o) => o.value > 0)!.value).toBeCloseTo(Number(amount) * price, 6);
    }
    expect(await rows('revenue_run_rate_usd')).toEqual([]);
  });
});
