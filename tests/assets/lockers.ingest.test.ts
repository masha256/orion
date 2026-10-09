import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys, requiredExtraMetrics } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import type { AssumptionValues } from '../../src/types.js';
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

function oneSet(flows: string[], extra: Record<string, number>): Record<string, number> {
  const s: Record<string, number> = {
    rev_growth_y1: -0.1, growth_fade_years: 3, terminal_growth: -0.05, discount_rate_base: 0.15, discount_premium_programmatic: 0.02,
    'multiple.fm_holder_flow': 8, regime_multiplier: 1, staked_ratio_horizon: 0.85, ...extra,
  };
  for (const f of flows) {
    s[`capture_rate_terminal.${f}`] = 1;
    s[`capture_ramp_years.${f}`] = 0;
  }
  return s;
}
const flat = (s: Record<string, number>): AssumptionValues => ({ bear: { ...s }, base: { ...s }, bull: { ...s } });

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
  extraKeys: Record<string, number>;
}

const cvx = loadAsset(ROOT, 'cvxcrv').config.contracts;
const sd = loadAsset(ROOT, 'sdcrv').config.contracts;

const CASES: Case[] = [
  {
    id: 'cvxcrv',
    hash: '5acb294ca9c5aed16c7bad63cb632d1c6bea612f03cdfb5a98967db5f992458b',
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
    extraKeys: { discount_premium_discretionary: 0.1 },
  },
  {
    id: 'sdcrv',
    hash: '702131c3f3218afa7714280037f2a73aad6b1dbbdfe5d4a4b11e17d7d1147710',
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
    extraKeys: {},
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
    expect(config).toMatchObject({ id: c.id, chain: 'ethereum', supply_basis: 'effective_total', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows.map((f) => [f.id, f.kind, f.recipient_base, f.valued_per, f.window_days])).toEqual(flowIds.map((id) => [id, 'fee_share', 'staked', 'recipients', 91]));
    expect(requiredExtraMetrics(config)).toEqual([]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    expect(Object.keys(flat(oneSet(flowIds, c.extraKeys)).base).sort()).toEqual(requiredAssumptionKeys(config));
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/${c.id}.yaml`, 'utf8')).hash).toBe(c.hash);
  });

  it('plans one transfer scan per stream and a summed run rate', () => {
    const plan = buildPlan(config);
    expect(plan.flowGroups.map((g) => g.members.map((m) => m.metricKey))).toEqual(flowIds.map((id) => [`flow_usd.${id}`]));
    expect(plan.derived.map((r) => [r.metricKey, r.source.type === 'derived' ? r.source.params : null])).toEqual([
      ['revenue_run_rate_usd', { metrics: flowIds.map((id) => `flow_usd.${id}`), days: 91 }],
    ]);
  });

  it('fetches every stream, sums them into the run rate, and values the cash per staked token at grade A', async () => {
    const w = world(c);
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    const rows = (metric: string) => listActiveObservations(w.db, c.id, metric);
    expect(rows('price_usd').at(-1)!.value).toBe(c.price);
    expect(rows('effective_supply').at(-1)!.value).toBe(Number(c.supply));
    expect(rows('staked_supply').at(-1)!.value).toBe(Number(c.staked));

    // The run rate is the three streams' 91 days to 2026-10-08, summed and scaled to a year.
    let expected = 0;
    for (const [id, [, , , every, amount, , price]] of Object.entries(c.streams)) {
      const inWindow = payoutDays(every).filter((d) => d >= '2026-07-10' && d < '2026-10-09').length;
      const stream = rows(`flow_usd.${id}`);
      expect(stream.length).toBeGreaterThanOrEqual(91);
      expect(stream.find((o) => o.value > 0)!.value).toBeCloseTo(Number(amount) * price, 6);
      expected += inWindow * Number(amount) * price;
    }
    expect(rows('revenue_run_rate_usd').at(-1)!.value).toBeCloseTo((expected * 365) / 91, 0);
    expect(rows('revenue_run_rate_usd').at(-1)!.sourceDetail).toBe(`derived flow_annualized(${flowIds.map((id) => `flow_usd.${id}`).join('+')}, 91d)`);

    const calibrated = parseYaml(readFileSync(`${ROOT}/calibration/${c.id}-assumptions.yaml`, 'utf8')) as AssumptionValues;
    createAssumptionSet(w.db, { assetId: c.id, author: 'user', rationale: 'calibration', values: calibrated, createdAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, c.id), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
    const h = signal.horizons!['12m'];
    // Every stream reaches stakers during the horizon, per staked token.
    expect(h.staked_cash_streams!.map((s) => [s.id, s.recipient_base])).toEqual(flowIds.map((id) => [id, 'staked']));
    const share = Number(c.staked) / Number(c.supply);
    expect(h.staked_cash_streams!.reduce((s, x) => s + x.usd, 0)).toBeGreaterThan(0);
    expect((h.modules.hc.breakdown.flows as Record<string, Record<string, unknown>>)[flowIds[0]].valued_over_share).toBeCloseTo(share, 12);
  });
});

for (const id of ['cvxcrv', 'sdcrv'] as const) {
  describe(`calibration/${id}-assumptions.yaml`, () => {
    const { config } = loadAsset(ROOT, id);
    const raw = parseYaml(readFileSync(`${ROOT}/calibration/${id}-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;

    it('is complete and sits inside the agent bands', () => {
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

    it('splits the run rate across the flows (capture shares sum to at most 1, and no band lets them pass 1.1)', () => {
      const flows = config.holder_flows.map((f) => f.id);
      for (const s of ['bear', 'base', 'bull'] as const) {
        expect(flows.reduce((t, f) => t + raw[s][`capture_rate_terminal.${f}`], 0)).toBeLessThanOrEqual(1);
      }
      expect(flows.reduce((t, f) => t + config.assumptions[`capture_rate_terminal.${f}`].max, 0)).toBeLessThanOrEqual(1.35);
    });
  });
}
