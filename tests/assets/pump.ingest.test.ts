import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { loadPersona } from '../../src/config/personas.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { useTestDb } from '../helpers/db.js';
import { statementShape } from '../helpers/assets.js';

const testDb = useTestDb();

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
  return { db: testDb(), deps, http };
}

/** Daily on-chain supply readings at 06:00 for the `n` days before NOW, as solana.token_supply writes them. */
async function seedReadings(db: Db, n: number, supplyNow: number) {
  for (let d = n; d >= 1; d--) {
    const at = new Date(NOW.getTime() - d * DAY).toISOString();
    await insertObservation(db, { assetId: 'pump', metricKey: 'total_supply', observedAt: at, value: supplyNow + d * BURN_PER_DAY, source: 'onchain', sourceDetail: `solana getTokenSupply ${MINT} slot ${d}`, fetchedAt: at });
  }
}

describe('assets/pump.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'pump', symbol: 'PUMP', chain: 'solana' });
    expect(config.ingest).toBeUndefined(); // no EVM RPC: Solana is read by the solana.* adapters
    expect(config.holder_flows).toEqual([{ id: 'buyback', kind: 'burn', capture_rule: 'discretionary', recipient_base: 'all', metric: 'flow_usd.buyback', window_days: 91 }]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // DefiLlama only for the pre-reading history, the unlocks and the revenue display line (Mike, 2026-10-16).
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama').map(([k]) => k)).toEqual(['flow_usd.llama_revenue']);
    expect(config.metrics['flow_usd.llama_revenue'].monitor_only).toBe(true);
    expect(config.reporting!.dilution).toEqual([expect.objectContaining({ id: 'unlocks', metric: 'unlocks_next_year' })]);
    for (const key of ['dominance_share', 'dominance_share_1y', 'revenue_run_rate_usd']) expect(config.metrics[key], key).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // A deliberate edit of assets/pump.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/pump.yaml`, 'utf8')).hash).toBe('981a2959037c7a13cc62bb880481cf124cdf12afec1237ff7f83744bd328a072');
  });

  it('v2 block shape: an income_statement with the plan line ids', () => {
    // Income statement v2 (Phase 2 Task 2), beside reporting for one release: the plan's line ids, which the v2 report and
    // the parity map key on. A revenue line a use line passes on with the same name is `<name>_rev` (ruling R8).
    expect(statementShape(config.income_statement)).toEqual({
      category: 'launchpad',
      scope: 'protocol_share_only',
      window_days: 91,
      revenue: ['protocol'],
      cost_of_revenue: ['creators', 'lps'],
      holders: ['buyback'],
      remainder: 'protocol',
      of: {},
    });
  });

  it('plans the Solana readers, CoinGecko, the Jupiter price check, the unlocks and the revenue line, and no EVM scan', () => {
    const plan = buildPlan(config);
    expect(plan.needsRpc).toBe(false);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.batches.map((b) => b.sourceId)).toEqual(expect.arrayContaining([
      'coingecko', 'adapter:solana.token_supply', 'adapter:solana.supply_burn_daily', 'adapter:solana.owner_balance', 'adapter:lit.unlocks_next_year', 'defillama:pump:dailyRevenue',
    ]));
    expect(plan.derived).toEqual([]);
  });

  it('first fetch: a year of DefiLlama history converted at the day price; then on-chain days replace it as readings accrue', async () => {
    const supplyNow = 827.6e9;
    const w = world(supplyNow);
    await fetchAsset(w.db, { config, hash: 'backfill' }, NOW, w.deps, { backfillDays: 362 });
    const rows = async (m: string) => await listActiveObservations(w.db, 'pump', m);
    expect((await rows('flow_usd.buyback')).filter((o) => o.periodDays === 1)).toHaveLength(362);
    expect((await rows('flow_usd.buyback')).every((o) => o.value === HISTORY_USD)).toBe(true);
    expect((await rows('flow_tokens.buyback')).at(-1)!.value).toBeCloseTo(HISTORY_USD / PRICE, 0);
    expect(await rows('revenue_run_rate_usd')).toEqual([]); // no derived run rate any more (it fed only the valuation)
    expect((await rows('total_supply')).at(-1)!.value).toBeCloseTo(supplyNow, 3);
    // The keyed Solana URL never lands in a stored detail.
    expect((await rows('flow_usd.buyback')).some((o) => (o.sourceDetail ?? '').includes('SECRET'))).toBe(false);
  });

  it('fetches on-chain days with no anomaly, and reports the burn and the unlocks', async () => {
    const supplyNow = 827.6e9;
    const w = world(supplyNow);
    // The onboarding backfill eleven days ago (only the flows: its supply reading would be out of line with the seeded ones),
    // then a daily supply reading each morning since.
    await fetchAsset(w.db, { config, hash: 'backfill' }, new Date(NOW.getTime() - 11 * DAY), w.deps, { backfillDays: 362, metrics: ['flow_usd.buyback', 'flow_tokens.buyback'] });
    await seedReadings(w.db, 10, supplyNow);
    const r = await fetchAsset(w.db, loadAsset(ROOT, 'pump'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual(expect.arrayContaining([['total_supply', true], ['price_usd', true]]));
    const rows = async (m: string) => await listActiveObservations(w.db, 'pump', m);
    // The last 7 completed days are on-chain: 1B PUMP a day at 0.005 = 5M USD, superseding DefiLlama's 4M.
    const last7 = (await rows('flow_usd.buyback')).filter((o) => o.periodDays === 1).slice(-7);
    expect(last7.map((o) => Math.round(o.value))).toEqual(Array(7).fill(5_000_000));
    expect(last7.every((o) => o.source === 'api')).toBe(true);
    expect((await rows('burn_wallet_a_pump')).at(-1)!.value).toBe(0);

    const rep = await loadHolderYieldReport(w.db, config);
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
