import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { updateAsset } from '../../src/app/update.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { loadPersona } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys, requiredExtraMetrics } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { addDays } from '../../src/ingest/time.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

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

function llamaChart(perDay: number): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 100; i >= 1; i--) points.push([Date.parse(`${addDays('2026-10-11', 1 - i)}T00:00:00Z`) / 1000, perDay]);
  return { totalDataChart: points };
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
    'https://api.llama.fi/summary/fees/pancakeswap?dataType=dailyFees': llamaChart(560_000),
    'https://api.llama.fi/summary/fees/pancakeswap?dataType=dailyRevenue': llamaChart(183_000),
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
  return { db: openDb(':memory:'), deps };
}

/** The calibration (central package, 2026-10-12). */
const calibrated = parseYaml(readFileSync(`${ROOT}/calibration/cake-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;
const placeholder = calibrated as unknown as AssumptionValues;

describe('assets/cake.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'cake', symbol: 'CAKE', chain: 'bnb', supply_basis: 'effective_total', ingest: { chain_id: 56, rpc_url_env: 'ORION_BNB_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows).toEqual([{ id: 'burn', kind: 'burn', capture_rule: 'programmatic', recipient_base: 'all', metric: 'flow_usd.burn', window_days: 91 }]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.burn', 'capture_rate_terminal.burn', 'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years',
      'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual([]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // DefiLlama only for the display series with no on-chain source (fees paid in thousands of pool tokens).
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama').map(([k]) => k)).toEqual(['flow_usd.fees', 'flow_usd.llama_revenue']);
    // A deliberate edit of assets/cake.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/cake.yaml`, 'utf8')).hash).toBe('dad03af04aa229460abab2b37ee03b1c8153152dceeb33e0e332a594af2c0696');
  });

  it('plans one allowlisted scan into the burner (chef ignored, dust floor) and one into the treasury', () => {
    const plan = buildPlan(config);
    expect(plan.flowGroups.map((g) => [g.sourceId, g.ignore, g.ignoreBelowTokens, g.members.map((m) => m.metricKey)])).toEqual([
      [expect.stringMatching(/^transfer_flow:token>burner/), [lc(C.zero), lc(C.masterchef_v2)], 1, ['flow_usd.burn', 'flow_tokens.burn']],
      [expect.stringMatching(/^transfer_flow:token>treasury/), [], 1, ['flow_usd.treasury']],
    ]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
  });

  it('fetches every metric, counts only the fee-funded burn, and values the asset at grade A through the tick path', async () => {
    const w = world();
    createAssumptionSet(w.db, { assetId: 'cake', author: 'user', rationale: 'calibrated', values: placeholder, createdAt: NOW.toISOString() });
    const { fetch: r, signal } = await updateAsset(w.db, loadAsset(ROOT, 'cake'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const burnScan = r.sources.find((s) => s.sourceId.startsWith('transfer_flow:token>burner'))!;
    expect(burnScan.unlistedTransfers).toEqual([]);
    expect(burnScan.notes).toContain('not counted, as configured: 28 from from_ignore senders, 1 dust (below 1 tokens)');

    const rows = (metric: string) => listActiveObservations(w.db, 'cake', metric);
    const value = (metric: string) => rows(metric).at(-1)!.value;
    expect(value('price_usd')).toBe(PRICE);
    expect(value('total_supply')).toBe(335_468_299);
    expect(value('emission_rate_annual') / 1e6).toBeCloseTo(7.9396, 3);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true]]);

    // 14 Mondays of 550k CAKE: 13 inside the 91 days to 2026-10-11 (07-13..10-05).
    const burns = rows('flow_tokens.burn').filter((o) => o.value > 0);
    expect(burns.map((o) => o.value)).toEqual(Array(14).fill(550_000));
    const revenue = rows('revenue_run_rate_usd').at(-1)!;
    expect(revenue.value).toBeCloseTo((13 * 550_000 * PRICE * 365) / 91, 0);
    expect(revenue.sourceDetail).toBe('derived flow_annualized(flow_usd.burn, 91d)');

    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
    expect(signal.generated_at.slice(0, 10)).toBe('2026-10-12');
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
  });

  it('reports the burn against emissions in tokens, and the treasury share as protocol income', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    const rep = loadHolderYieldReport(w.db, config);
    expect(rep.day).toBe('2026-10-11');
    expect(rep.yields.buyback).toBeCloseTo((13 * 550_000 * PRICE * 365) / 91 / (335_468_299 * PRICE), 6);
    expect(rep.supply).toMatchObject({ burnedPerYear: expect.closeTo((13 * 550_000 * 365) / 91, 0) });
    expect(rep.supply!.netPerYear).toBeLessThan(0);
    expect(rep.income!.revenue.annualized).toBeCloseTo((13 * 750_000 * PRICE * 365) / 91, 0);
    expect(rep.income!.payoutRatio).toBeCloseTo(550 / 750, 6);
    expect(rep.volume!.annualized).toBeCloseTo(560_000 * 365, 0);
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

describe('calibration/cake-assumptions.yaml', () => {
  it('is complete and sits inside the agent bands of assets/cake.yaml', () => {
    for (const s of ['bear', 'base', 'bull'] as const) {
      expect(Object.keys(calibrated[s]).sort()).toEqual(requiredAssumptionKeys(config));
      for (const [key, value] of Object.entries(calibrated[s])) {
        const b = config.assumptions[key];
        const band = b[s] ?? b;
        expect(value, `${s} ${key}`).toBeGreaterThanOrEqual(band.min);
        expect(value, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
    }
    // Bands exist for every key that moves the value; every band is sorted.
    for (const key of ['rev_growth_y1', 'multiple.fm_holder_flow', 'discount_rate_base', 'capture_rate_terminal.burn']) {
      for (const s of ['bear', 'base', 'bull'] as const) {
        const band = config.assumptions[key][s]!;
        expect(band.min, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
    }
  });
});
