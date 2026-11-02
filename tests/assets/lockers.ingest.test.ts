import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

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
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));

/** A flat market chart for a CoinGecko id. */
const flatChart = (price: number) => (url: string) => {
  const days = Number(new URL(url).searchParams.get('days'));
  const end = NOW.getTime();
  const step = days > 90 ? 86_400_000 : 3_600_000;
  const prices: [number, number][] = [];
  for (let t = end - days * 86_400_000; t <= end; t += step) prices.push([t, price]);
  return { prices };
};

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
  llamaPrice: number;
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
    hash: 'c22393aed76d70ea7c030d4bc6dad5080f864170b23fef14a1cfeb17ffda1571',
    coingecko: 'convex-crv',
    price: 0.1392,
    llamaPrice: 0.1391,
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
    hash: '340919e9f6b2cb23605ea8e28fdcc30d7a77071062cb19651cc375ed0aae18c2',
    coingecko: 'stake-dao-crv',
    price: 0.1884,
    llamaPrice: 0.1832,
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

function world(c: Case) {
  const llama = `https://coins.llama.fi/prices/current/ethereum:${loadAsset(ROOT, c.id).config.contracts.token}`;
  const routes: Record<string, unknown> = {
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: c.coingecko, current_price: c.price, circulating_supply: Number(c.supply), total_supply: Number(c.supply) }],
    [llama]: { coins: { [`ethereum:${loadAsset(ROOT, c.id).config.contracts.token}`]: { decimals: 18, price: c.llamaPrice, timestamp: 1791521457, confidence: 0.99 } } },
  };
  const calls: Record<string, bigint> = {
    [callKey(loadAsset(ROOT, c.id).config.contracts.token, 'totalSupply')]: c.supply * E18,
    [callKey(loadAsset(ROOT, c.id).config.contracts.token, 'decimals')]: 18n,
    [callKey(c.stakedContract, 'totalSupply')]: c.staked * E18,
  };
  const logs: Record<string, Omit<TransferLog, 'timestamp'>[]> = {};
  let tx = 0;
  for (const [token, sink, sender, every, amount, cg, price] of Object.values(c.streams)) {
    routes[`https://api.coingecko.com/api/v3/coins/${cg}/market_chart`] = flatChart(price);
    calls[callKey(token, 'decimals')] = 18n;
    logs[`${token.toLowerCase()}>${sink.toLowerCase()}`] = payoutDays(every).map((iso) => ({ blockNumber: blockAt(iso), logIndex: 0, txHash: `0x${(tx++).toString(16)}`, from: sender, value: amount * E18 }));
  }
  const base = fakeRpc({ genesisTs: GENESIS_TS, blockTimeSec: BLOCK_SEC, maxLogRange: 10_000n, latest: LATEST, calls });
  const rpc = multiLogRpc(base, logs);
  const deps: FetchDeps = { http: fakeHttp(routes as Parameters<typeof fakeHttp>[0]), rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps };
}

for (const c of CASES) describe(`assets/${c.id}.yaml`, () => {
  const { config } = loadAsset(ROOT, c.id);
  const flowIds = Object.keys(c.streams);

  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: c.id, chain: 'ethereum', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows.map((f) => [f.id, f.kind, f.recipient_base, f.valued_per, f.window_days])).toEqual(flowIds.map((id) => [id, 'fee_share', 'staked', 'recipients', 91]));
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    expect(config.metrics.revenue_run_rate_usd).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/${c.id}.yaml`, 'utf8')).hash).toBe(c.hash);
    // Supply definitions (Mike, 2026-10-12): CoinGecko has no circulating supply for the wrappers, so it is the on-chain total;
    // CoinGecko's total_supply checks cvxCRV only (sdCRV's figure there is a stale 2022 snapshot).
    expect(config.metrics.circulating_supply?.source).toEqual(config.metrics.total_supply.source);
    expect(config.metrics.total_supply.cross_checks?.map((x) => x.source)).toEqual(
      c.id === 'cvxcrv' ? [{ type: 'coingecko', id: 'convex-crv', field: 'total_supply' }] : undefined,
    );
  });

  it('plans one transfer scan per stream and no derived level', () => {
    const plan = buildPlan(config);
    // One scan per holder-flow stream, then the report-only revenue and gross scans (never a holder flow).
    const reportFlows = Object.entries(config.metrics).filter(([, d]) => d.type === 'flow' && d.monitor_only === true).map(([k]) => k);
    const r = config.reporting!;
    // Every revenue and volume line is a report-only flow; a report-only flow may also be a record only (e.g. the whole
    // fee, of which only the protocol's part is revenue).
    const incomeMetrics = (r.income?.lines ?? []).flatMap((l) => (l.metric ? [l.metric] : []));
    expect(reportFlows).toEqual(expect.arrayContaining([...incomeMetrics.filter((m) => config.metrics[m]?.monitor_only), ...(r.volume ?? [])]));
    expect(plan.flowGroups.map((g) => g.members.map((m) => m.metricKey))).toEqual([...flowIds.map((id) => [`flow_usd.${id}`]), ...reportFlows.map((m) => [m])]);
    expect(plan.derived).toEqual([]);
  });

  it('fetches every stream', async () => {
    const w = world(c);
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    const rows = async (metric: string) => await listActiveObservations(w.db, c.id, metric);
    expect((await rows('price_usd')).at(-1)!.value).toBe(c.price);
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
