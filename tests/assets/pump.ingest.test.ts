import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { updateAsset } from '../../src/app/update.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { loadPersona } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys, requiredExtraMetrics } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { llamaOverview } from '../helpers/llamaOverview.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-16T06:00:00.000Z');
const DAY = 86_400_000;
const PRICE = 0.005;
const SOL = 'https://solana.test/v2/sol_SECRET';
const { config } = loadAsset(ROOT, 'pump');
const MINT = config.contracts.token;
/** 1B PUMP burned a day on chain; DefiLlama's history at 4M USD a day. */
const BURN_PER_DAY = 1e9;
const HISTORY_USD = 4_000_000;

function world(supplyNow: number) {
  const prices = (days: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let t = NOW.getTime() - days * DAY; t <= NOW.getTime(); t += 3_600_000) out.push([t, PRICE]);
    return out;
  };
  const llama = (usd: number) => {
    const totalDataChart: [number, number][] = [];
    for (let t = NOW.getTime() - 400 * DAY; t < NOW.getTime() - (NOW.getTime() % DAY); t += DAY) totalDataChart.push([Math.floor(t / DAY) * 86_400, usd]);
    return { totalDataChart };
  };
  const http = fakeHttp({
    'https://api.llama.fi/overview/fees': llamaOverview('parent#pump', 'Launchpad'),
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'pump-fun', symbol: 'pump', current_price: PRICE, market_cap: 2.3e9, circulating_supply: 462.8e9, total_supply: supplyNow }],
    'https://api.coingecko.com/api/v3/coins/pump-fun/market_chart': (url: string) => ({ prices: prices(Number(new URL(url).searchParams.get('days'))) }),
    'https://lite-api.jup.ag/price/v3': { [MINT]: { usdPrice: PRICE * 1.001 } },
    'https://api.llama.fi/summary/fees/pump?dataType=dailyHoldersRevenue': llama(HISTORY_USD),
    'https://api.llama.fi/summary/fees/pump?dataType=dailyRevenue': llama(HISTORY_USD * 2),
    'https://defillama-datasets.llama.fi/emissions/pump': {
      documentedData: { data: [
        { label: 'Team', data: [{ timestamp: NOW.getTime() / 1000 - 30 * 86_400, unlocked: 62.5e9 }, { timestamp: NOW.getTime() / 1000 + 365 * 86_400 - 60, unlocked: 112.5e9 }] },
        { label: 'Existing Investors', data: [{ timestamp: NOW.getTime() / 1000 - 30 * 86_400, unlocked: 40.6e9 }, { timestamp: NOW.getTime() / 1000 + 365 * 86_400 - 60, unlocked: 73.1e9 }] },
      ] },
    },
    [SOL]: (_u: string, body?: unknown) => {
      const b = body as { method: string; params: unknown[] };
      if (b.method === 'getTokenSupply') return { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { amount: BigInt(Math.round(supplyNow * 1e6)).toString(), decimals: 6 } } };
      if (b.method === 'getTokenAccountsByOwner') return { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } };
      throw new Error(`unexpected ${b.method}`);
    },
  });
  const deps: FetchDeps = { http, rpcFactory: () => { throw new Error('PUMP must not open an EVM RPC'); }, env: { ORION_SOL_RPC_URL: SOL }, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http };
}

/** Daily on-chain supply readings at 06:00 for the `n` days before NOW, as solana.token_supply writes them. */
function seedReadings(db: ReturnType<typeof openDb>, n: number, supplyNow: number) {
  for (let d = n; d >= 1; d--) {
    const at = new Date(NOW.getTime() - d * DAY).toISOString();
    insertObservation(db, { assetId: 'pump', metricKey: 'total_supply', observedAt: at, value: supplyNow + d * BURN_PER_DAY, source: 'onchain', sourceDetail: `solana getTokenSupply ${MINT} slot ${d}`, fetchedAt: at });
  }
}

/** The calibrated package (the CAKE/LIT/LINK central, Mike 2026-10-16: "Option 1"). */
const calibrated = parseYaml(readFileSync(`${ROOT}/calibration/pump-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;

describe('assets/pump.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'pump', symbol: 'PUMP', chain: 'solana', supply_basis: 'effective_total' });
    expect(config.ingest).toBeUndefined(); // no EVM RPC: Solana is read by the solana.* adapters
    expect(config.holder_flows).toEqual([{ id: 'buyback', kind: 'burn', capture_rule: 'discretionary', recipient_base: 'all', metric: 'flow_usd.buyback', window_days: 91 }]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.buyback', 'capture_rate_terminal.buyback', 'discount_premium_discretionary', 'discount_rate_base', 'growth_fade_years',
      'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual([]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // DefiLlama only for the pre-reading history, the unlocks and the revenue display line (Mike, 2026-10-16).
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama').map(([k]) => k)).toEqual(['flow_usd.llama_revenue']);
    expect(config.metrics['flow_usd.llama_revenue'].monitor_only).toBe(true);
    expect(config.reporting!.dilution).toEqual([expect.objectContaining({ id: 'unlocks', metric: 'unlocks_next_year' })]);
    // Category share from DefiLlama (Mike, 2026-10-17): monitor-only, never a driver or in the grade.
    for (const key of ['dominance_share', 'dominance_share_1y']) expect(config.metrics[key]).toMatchObject({ type: 'level', unit: 'ratio', monitor_only: true, staleness_days: 7 });
    expect(config.metrics.dominance_share.source).toEqual({ type: 'defillama_share', parent: 'parent#pump', category: 'Launchpad', overview: 'fees', window: '30d' });
    expect(config.metrics.dominance_share_1y.source).toEqual({ type: 'defillama_share', parent: 'parent#pump', category: 'Launchpad', overview: 'fees', window: '1y' });
    // A deliberate edit of assets/pump.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/pump.yaml`, 'utf8')).hash).toBe('f98a4954af424e8a750f8731954bf2d7db2448d697ddec0381503d6779a38ddc');
  });

  it('plans the Solana readers, CoinGecko, the Jupiter price check, the unlocks and the revenue line, and no EVM scan', () => {
    const plan = buildPlan(config);
    expect(plan.needsRpc).toBe(false);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.batches.map((b) => b.sourceId)).toEqual(expect.arrayContaining([
      'coingecko', 'adapter:solana.token_supply', 'adapter:solana.supply_burn_daily', 'adapter:solana.owner_balance', 'adapter:lit.unlocks_next_year', 'defillama:pump:dailyRevenue',
    ]));
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
  });

  it('first fetch: a year of DefiLlama history converted at the day price; then on-chain days replace it as readings accrue', async () => {
    const supplyNow = 827.6e9;
    const w = world(supplyNow);
    await fetchAsset(w.db, { config, hash: 'backfill' }, NOW, w.deps, { backfillDays: 362 });
    const rows = (m: string) => listActiveObservations(w.db, 'pump', m);
    expect(rows('flow_usd.buyback').filter((o) => o.periodDays === 1)).toHaveLength(362);
    expect(rows('flow_usd.buyback').every((o) => o.value === HISTORY_USD)).toBe(true);
    expect(rows('flow_tokens.buyback').at(-1)!.value).toBeCloseTo(HISTORY_USD / PRICE, 0);
    expect(rows('revenue_run_rate_usd').at(-1)!.value).toBeCloseTo(HISTORY_USD * 365, 0);
    expect(rows('total_supply').at(-1)!.value).toBeCloseTo(supplyNow, 3);
    // The keyed Solana URL never lands in a stored detail.
    expect(rows('flow_usd.buyback').some((o) => (o.sourceDetail ?? '').includes('SECRET'))).toBe(false);
  });

  it('values through the tick path from on-chain days, with no anomaly, and reports the burn and the unlocks', async () => {
    const supplyNow = 827.6e9;
    const w = world(supplyNow);
    createAssumptionSet(w.db, { assetId: 'pump', author: 'user', rationale: 'calibrated', values: calibrated as unknown as AssumptionValues, createdAt: NOW.toISOString() });
    // The onboarding backfill eleven days ago (only the flows: its supply reading would be out of line with the seeded ones),
    // then a daily supply reading each morning since.
    await fetchAsset(w.db, { config, hash: 'backfill' }, new Date(NOW.getTime() - 11 * DAY), w.deps, { backfillDays: 362, metrics: ['flow_usd.buyback', 'flow_tokens.buyback', 'revenue_run_rate_usd'] });
    seedReadings(w.db, 10, supplyNow);
    const { fetch: r, signal } = await updateAsset(w.db, loadAsset(ROOT, 'pump'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error])).toEqual([]);
    // The category share (monitor-only): 30 of 100 over 30 days, 250 of 1,000 over a year, from the overview.
    expect(['dominance_share', 'dominance_share_1y'].map((k) => listActiveObservations(w.db, 'pump', k).map((o) => o.value))).toEqual([[0.3], [0.25]]);
    expect(r.anomalies).toEqual([]);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual(expect.arrayContaining([['total_supply', true], ['price_usd', true]]));
    const rows = (m: string) => listActiveObservations(w.db, 'pump', m);
    // The last 7 completed days are on-chain: 1B PUMP a day at 0.005 = 5M USD, superseding DefiLlama's 4M.
    const last7 = rows('flow_usd.buyback').filter((o) => o.periodDays === 1).slice(-7);
    expect(last7.map((o) => Math.round(o.value))).toEqual(Array(7).fill(5_000_000));
    expect(last7.every((o) => o.source === 'api')).toBe(true);
    expect(rows('burn_wallet_a_pump').at(-1)!.value).toBe(0);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    expect(signal.spot!.price).toBe(PRICE);

    const rep = loadHolderYieldReport(w.db, config);
    expect(rep.flows).toEqual([expect.objectContaining({ id: 'buyback', bucket: 'burn', haircut: 0 })]);
    expect(rep.yields.dilutionLines).toEqual([{ id: 'unlocks', tokensPerYear: expect.closeTo(82.5e9, -6), yield: expect.closeTo(82.5e9 / supplyNow, 6) }]);
  });

  it('never opens an EVM RPC, and works keyless on the public Solana endpoint', async () => {
    const w = world(827.6e9);
    const pub = fakeHttp({});
    const deps: FetchDeps = { ...w.deps, env: {}, http: { ...w.http, async postJson(url, body, headers) {
      expect(url).toBe('https://api.mainnet-beta.solana.com');
      return w.http.postJson(SOL, body, headers);
    } } };
    void pub;
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, deps, { metrics: ['total_supply'] });
    expect(r.sources.find((s) => s.sourceId === 'adapter:solana.token_supply')!.status).toBe('ok');
  });
});

describe('the PUMP persona', () => {
  it('is the consumer-launchpad analyst, which knows the company sets the share and the unlocks outweigh the burn', () => {
    const persona = loadPersona(ROOT, 'consumer-launchpad-analyst');
    expect(persona.body).toContain('The company sets the share (PUMP)');
    expect(persona.body).toContain('Insider unlocks outweigh the burn');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
  });
});

describe('calibration/pump-assumptions.yaml', () => {
  it('is complete, sits inside the agent bands of assets/pump.yaml, and is LIT\'s central unchanged', () => {
    const lit = parseYaml(readFileSync(`${ROOT}/calibration/lit-assumptions.yaml`, 'utf8')) as typeof calibrated;
    for (const s of ['bear', 'base', 'bull'] as const) {
      expect(Object.keys(calibrated[s]).sort()).toEqual(requiredAssumptionKeys(config));
      for (const [key, value] of Object.entries(calibrated[s])) {
        const b = config.assumptions[key];
        const band = b[s] ?? b;
        expect(value, `${s} ${key}`).toBeGreaterThanOrEqual(band.min);
        expect(value, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
      expect(calibrated[s]).toEqual(lit[s]);
    }
  });
});
