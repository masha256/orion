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
import { loadHolderYieldReport } from '../../src/report/load.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

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
  return { db: openDb(':memory:'), deps, http, rpc };
}

/** The user's calibration (central package, 2026-10-11). */
const calibrated = parseYaml(readFileSync(`${ROOT}/calibration/uni-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;
function assumptions(): AssumptionValues {
  return calibrated as unknown as AssumptionValues;
}

describe('assets/uni.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'uni', symbol: 'UNI', chain: 'ethereum', supply_basis: 'effective_total', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows).toEqual([{ id: 'burn', kind: 'burn', capture_rule: 'programmatic', recipient_base: 'all', metric: 'flow_usd.burn', window_days: 91 }]);
    expect(config.modules.map((m) => [m.id, m.kind, m.weight ?? null])).toEqual([['hc', 'estimate', 0.6], ['fm_holder_flow', 'estimate', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.burn', 'capture_rate_terminal.burn', 'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years',
      'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual([]);
    // Every metric has a source, and none is manual: a bootstrap run has nothing to research and the grade can be A.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // DefiLlama only for the gross swap fees (Mike, 2026-10-11): the one series with no on-chain source.
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama' || d.cross_checks?.some((c) => c.source.type === 'defillama')).map(([k]) => k)).toEqual(['flow_usd.swap_fees']);
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check. A deliberate edit of assets/uni.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/uni.yaml`, 'utf8')).hash).toBe('384a206f0f018b3aa288ebe97d1e487d17e24c7933302b80a30e8dcab97dd3cd');
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
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
  });

  it('fetches every metric from canned sources, counts every burner but the Timelock, and values the asset at grade A through the tick path', async () => {
    const w = world();
    createAssumptionSet(w.db, { assetId: 'uni', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const { fetch: r, signal } = await updateAsset(w.db, loadAsset(ROOT, 'uni'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const scan = r.sources.find((s) => s.sourceId === 'transfer_flow:token>dead[*]')!;
    expect(scan.unlistedTransfers).toEqual([]);
    expect(scan.notes).toContain('not counted, as configured: 1 from from_ignore senders');

    const rows = (metric: string) => listActiveObservations(w.db, 'uni', metric);
    const value = (metric: string) => rows(metric).at(-1)!.value;
    expect(value('price_usd')).toBe(PRICE);
    expect(value('total_supply')).toBe(887_216_419);
    expect(value('staked_supply')).toBe(0);
    expect(value('emission_rate_annual')).toBe(0);
    expect(value('labs_vest_rate')).toBe(20_000_000);
    expect(value('labs_vest_approved')).toBe(20_000_000);
    expect(value('treasury_uni')).toBe(262_247_996);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true]]);

    // 100 days, 64,000 UNI each (the Timelock's 100M left out), at 7.5 USD.
    const burns = rows('flow_tokens.burn');
    expect(burns).toHaveLength(100);
    expect(burns.every((o) => o.value === 64_000)).toBe(true);
    expect(JSON.parse(rows('flow_usd.burn').at(-1)!.sourceDetail!).senders).toEqual({ [BRIDGE]: { count: 1, tokens: 48_000 }, [SEARCHER]: { count: 1, tokens: 16_000 } });
    const revenue = rows('revenue_run_rate_usd').at(-1)!;
    expect(revenue.value).toBeCloseTo((91 * 64_000 * PRICE * 365) / 91, 0);
    expect(revenue).toMatchObject({ source: 'onchain', sourceDetail: 'derived flow_annualized(flow_usd.burn, 91d)' });

    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
    expect(signal.generated_at.slice(0, 10)).toBe('2026-10-11');
    expect(signal.spot!.price).toBe(PRICE);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    // No staking: no staked cash, no emission yield.
    expect(signal.horizons!['12m'].staked_cash_per_token ?? 0).toBe(0);
  });

  it('reports the burn against the Labs vest as dilution, and the gross swap fees as volume', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    const rep = loadHolderYieldReport(w.db, config);
    expect(rep.day).toBe('2026-10-10');
    const mcap = 887_216_419 * PRICE;
    expect(rep.yields.buyback).toBeCloseTo((64_000 * 365 * PRICE) / mcap, 6);
    // 20M a year vesting (capped by the 20M approved) on 887.2M total supply: 2.25 percent.
    expect(rep.yields.dilution).toBeCloseTo(20_000_000 / 887_216_419, 6);
    expect(rep.yields.dilutionLines).toEqual([{ id: 'labs_vest', tokensPerYear: 20_000_000, yield: expect.closeTo(20_000_000 / 887_216_419, 6) }]);
    expect(rep.yields.netShareholder).toBeCloseTo((64_000 * 365 - 20_000_000) / 887_216_419, 6);
    expect(rep.volume!.annualized).toBeCloseTo(4_600_000 * 365, 0);
    // In tokens: 64,000 a day burned (23.36M a year) against 20M vested: supply shrinks 3.36M a year.
    expect(rep.supply).toMatchObject({ burnedPerYear: expect.closeTo(23_360_000, 0), addedPerYear: 20_000_000, netPerYear: expect.closeTo(-3_360_000, 0) });
    expect(rep.supply!.netPct).toBeCloseTo(-3_360_000 / 887_216_419, 6);
    expect(rep.income!.payoutRatio).toBeCloseTo(1);
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

describe('calibration/uni-assumptions.yaml', () => {
  it('is complete and sits inside the agent bands of assets/uni.yaml', () => {
    for (const s of ['bear', 'base', 'bull'] as const) {
      expect(Object.keys(calibrated[s]).sort()).toEqual(requiredAssumptionKeys(config));
      for (const [key, value] of Object.entries(calibrated[s])) {
        const b = config.assumptions[key];
        const band = b[s] ?? b;
        expect(value, `${s} ${key}`).toBeGreaterThanOrEqual(band.min);
        expect(value, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
    }
  });
});
