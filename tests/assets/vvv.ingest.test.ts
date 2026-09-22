import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { confirmObservation, insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { fixture } from '../helpers/sourceCtx.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-09-19T20:30:00.000Z');
const GENESIS_TS = NOW.getTime() / 1000 - 10 * 86_400 + 1;
const VENICE = 'https://outerface.venice.ai/api/app/vvv';
const E18 = 10n ** 18n;

const { config } = loadAsset(ROOT, 'vvv');
const C = config.contracts;
const chain = fixture('chain_reads.json') as { token: Record<string, string>; staking: Record<string, string>; diem: Record<string, string> };

function diemTables(): Record<string, bigint> {
  const calls: Record<string, bigint> = {};
  for (let i = 0; i < 256; i++) {
    const supply = 500 * (i + 1);
    const rate = Math.min(90 * Math.exp(2 * (supply / 40_000) ** 3), 1e30);
    calls[callKey(C.staking, 'diemSupply', [BigInt(i)])] = BigInt(supply) * E18;
    calls[callKey(C.staking, 'diemMintRates', [BigInt(i)])] = BigInt(Math.round(rate * 1e6)) * 10n ** 12n;
  }
  return calls;
}

function world() {
  // The Venice capture was taken an hour before the CoinGecko one and its price differs by 2.6 percent.
  // Align it, so that this test is about wiring. Tolerances have their own tests.
  const stats = { ...(fixture('venice_vvv_stats.json') as Record<string, unknown>), price: '26.03' };
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': fixture('cg_markets.json'),
    'https://api.coingecko.com/api/v3/coins/venice-token/market_chart': fixture('cg_venice_30_last72.json'),
    [`${VENICE}/vvv_stats`]: stats,
    [`${VENICE}/vvv_staking_yield`]: fixture('venice_vvv_staking_yield.json'),
    [`${VENICE}/vvv_burn_history`]: fixture('venice_vvv_burn_history.json'),
    [`${VENICE}/diem_stats`]: fixture('venice_diem_stats.json'),
    'https://api.llama.fi/summary/fees/venice': fixture('llama_venice.json'),
  });
  const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / 2));
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / 2)),
    calls: {
      [callKey(C.token, 'totalSupply')]: BigInt(chain.token.totalSupply),
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.token, 'balanceOf', [C.burn_sink])]: BigInt(chain.token.balanceOf_zero_address),
      [callKey(C.staking, 'totalSupply')]: BigInt(chain.staking.totalSupply),
      [callKey(C.staking, 'totalLockedStakedVVV')]: BigInt(chain.staking.totalLockedStakedVVV),
      [callKey(C.staking, 'emissionRatePerSecond')]: BigInt(chain.staking.emissionRatePerSecond),
      [callKey(C.staking, 'veniceEmissionsPercentage')]: BigInt(chain.staking.veniceEmissionsPercentage),
      [callKey(C.staking, 'veniceEmissionsPercentageWhenLocked')]: BigInt(chain.staking.veniceEmissionsPercentageWhenLocked),
      [callKey(C.diem, 'totalSupply')]: BigInt(chain.diem.totalSupply),
      ...diemTables(),
    },
    logs: [
      { blockNumber: blockAt('2026-09-17T10:00:00Z'), logIndex: 0, txHash: '0xa', from: C.aerodrome_pool, value: 400n * E18 },
      { blockNumber: blockAt('2026-09-18T10:00:00Z'), logIndex: 0, txHash: '0xb', from: C.buyback_safe, value: 10_000n * E18 },
    ],
  });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: {}, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http, rpc };
}

describe('assets/vvv.yaml ingestion', () => {
  it('plans the VVV source map of the spec', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => b.sourceId).sort()).toEqual([
      'adapter:vvv.burn_history_tokens', 'adapter:vvv.diem_target_supply', 'adapter:vvv.staker_emission_share', 'adapter:vvv.staker_share_from_api',
      'chain_levels', 'coingecko', 'defillama:venice:dailyHoldersRevenue',
      `http_json:${VENICE}/diem_stats`, `http_json:${VENICE}/vvv_staking_yield`, `http_json:${VENICE}/vvv_stats`,
    ]);
    expect(plan.flowGroups).toHaveLength(1);
    expect(plan.flowGroups[0].members.map((m) => [m.metricKey, m.unit, m.countFrom.length])).toEqual([
      ['flow_usd.burn', 'usd', 2], ['flow_tokens.burn', 'tokens', 2], ['flow_usd.burn_programmatic', 'usd', 1],
    ]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['usage_index']);
    expect(config.metrics.revenue_run_rate_usd.source).toBeUndefined();
    expect(config.contracts.aerodrome_pool).toBe('0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce');
    expect(config.contracts.buyback_safe).toBe('0x35FB3b67C57849bF57eB24B061EeF0b5e560DC57');
  });

  it('fetches every sourced metric from the real captures with every cross-check in tolerance', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { backfillDays: 2 });
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');

    const value = (metric: string) => listActiveObservations(w.db, 'vvv', metric).at(-1)!.value;
    expect(value('price_usd')).toBe(26.03);
    expect(value('diem_price_usd')).toBe(1941.6);
    expect(value('circulating_supply')).toBeCloseTo(48058904.92603289, 4);
    expect(value('effective_supply')).toBeCloseTo(81009270.24659143, 3);
    expect(value('staked_supply')).toBeCloseTo(33941208.98799314, 3);
    expect(value('locked_supply')).toBeCloseTo(8954489.934888212, 3);
    expect(value('emission_rate_annual')).toBeCloseTo(2_500_000, 2);
    expect(value('staker_emission_share')).toBeCloseTo(0.9472352918362107, 9);
    expect(value('diem_supply')).toBeCloseTo(37713.657734473534, 6);
    expect(value('diem_target_supply')).toBeCloseTo(40_000, 1);
    expect(value('diem_locked_yield_share')).toBeCloseTo(0.8, 12);
    expect(listActiveObservations(w.db, 'vvv', 'flow_tokens.burn').map((o) => o.value)).toEqual([400, 10_000]);
    expect(listActiveObservations(w.db, 'vvv', 'flow_usd.burn_programmatic').map((o) => o.value > 0)).toEqual([true, false]);

    const checked = r.sources.flatMap((s) => s.crossChecks).map((c) => c.metricKey).sort();
    expect(checked).toEqual([
      'circulating_supply', 'diem_supply', 'diem_target_supply', 'effective_supply', 'emission_rate_annual', 'locked_supply', 'price_usd',
      'staked_supply', 'staker_emission_share',
    ]);
    expect(w.rpc.stats.multicall).toBeLessThanOrEqual(4); // levels, two adapters, token decimals: never one call per read
  });

  it('produces a signal once the researched revenue figure is confirmed and the calibrated assumptions are in', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { backfillDays: 2 });
    // The analyst's researched row. The user's rule (2026-09-22): it reaches no signal until the user confirms it.
    const researched = insertObservation(w.db, {
      assetId: 'vvv', metricKey: 'revenue_run_rate_usd', observedAt: '2026-08-17', value: 100_000_000, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com/revenue', fetchedAt: NOW.toISOString(),
    });
    const raw = parseYaml(readFileSync(`${ROOT}/calibration/vvv-assumptions.yaml`, 'utf8')) as Record<string, Record<string, number>>;
    const values: AssumptionValues = { bear: { ...raw.all, ...raw.bear }, base: { ...raw.all, ...raw.base }, bull: { ...raw.all, ...raw.bull } };
    createAssumptionSet(w.db, { assetId: 'vvv', author: 'user', rationale: 'calibrated', values, createdAt: NOW.toISOString() });

    const before = runValuation(w.db, loadAsset(ROOT, 'vvv'), NOW).signal;
    expect(before.status).toBe('blocked');
    expect(before.status_reasons).toEqual(['missing_metric:revenue_run_rate_usd']);

    confirmObservation(w.db, researched.id, NOW.toISOString());
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'vvv'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('B'); // the revenue figure is a confirmed manual row
    expect(signal.spot!.price).toBe(26.03);
  });
});
