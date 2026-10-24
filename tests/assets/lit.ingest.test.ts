import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { structuralNotes } from '../../src/agent/describe.js';
import { Ledger } from '../../src/agent/ledger.js';
import { AGENT_TOOLS, runTool, type ToolContext } from '../../src/agent/tools/index.js';
import { updateAsset } from '../../src/app/update.js';
import { budgetsFor } from '../../src/config/agentPolicy.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { loadPersona } from '../../src/config/personas.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { openDb } from '../../src/db/connection.js';
import { requiredAssumptionKeys, requiredExtraMetrics } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { addDays } from '../../src/ingest/time.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { llamaOverview } from '../helpers/llamaOverview.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-16T12:30:00.000Z');
const BLOCK_SEC = 12;
const GENESIS_TS = NOW.getTime() / 1000 - 160 * 86_400;
const E18 = 10n ** 18n;
const PRICE = 3.04;
const DAY = 86_400_000;
const TODAY = Date.parse('2026-10-16T00:00:00Z');

const { config } = loadAsset(ROOT, 'lit');
const C = config.contracts;
const lc = (a: string) => a.toLowerCase();
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));

/** The treasury buys 25,000 LIT a day at the price (12 trades a day), for 100 days back. */
function trades(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let d = 0; d < 100; d++) {
    for (let k = 0; k < 12; k++) {
      out.push({ timestamp: TODAY - d * DAY - 1 - k * 3_600_000, price: String(PRICE), size: '2083.3333', bid_account_id: 0, ask_account_id: 501, market_id: 2049 });
    }
  }
  return out;
}

function llamaChart(perDay: number): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 150; i >= 1; i--) points.push([Date.parse(`${addDays('2026-10-15', 1 - i)}T00:00:00Z`) / 1000, perDay]);
  return { totalDataChart: points };
}

function world() {
  const all = trades();
  const t0 = Date.parse('2026-12-29T00:00:00Z') / 1000;
  const linear = (perWeek: number) => Array.from({ length: 1200 }, (_, i) => ({ timestamp: t0 + (i - 80) * 86_400, unlocked: Math.max(0, ((i - 80) * perWeek) / 7) }));
  const http = fakeHttp({
    'https://api.llama.fi/overview/fees': llamaOverview('parent#lighter', 'Derivatives'),
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'lighter', symbol: 'lit', current_price: PRICE, market_cap: 7.6e8, circulating_supply: 250_000_000, total_supply: 1_000_000_000 }],
    'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=2049': { code: 200, order_book_details: [], spot_order_book_details: [{ market_id: 2049, last_trade_price: 3.05 }] },
    'https://mainnet.zklighter.elliot.ai/api/v1/trades': (url: string) => {
      const from = Number(new URL(url).searchParams.get('cursor') ?? '0');
      return { code: 200, trades: all.slice(from, from + 100), next_cursor: from + 100 < all.length ? String(from + 100) : undefined };
    },
    'https://api.llama.fi/summary/fees/lighter?dataType=dailyHoldersRevenue': llamaChart(25_000 * PRICE),
    'https://api.llama.fi/summary/fees/lighter?dataType=dailyFees': llamaChart(150_000),
    'https://api.llama.fi/summary/fees/lighter?dataType=dailyRevenue': llamaChart(120_000),
    'https://defillama-datasets.llama.fi/emissions/lighter': {
      documentedData: { data: [{ label: 'Team', data: linear(1_661_000) }, { label: 'Investors', data: linear(1_533_000) }] },
    },
  });
  const base = fakeRpc({
    genesisTs: GENESIS_TS,
    blockTimeSec: BLOCK_SEC,
    maxLogRange: 50_000n,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC)),
    calls: {
      // Read live on 2026-10-16.
      [callKey(C.token, 'totalSupply')]: 1_000_000_000n * E18,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.token, 'balanceOf', [C.dead])]: 18_090_720n * E18,
      [callKey(C.token, 'balanceOf', [C.ecosystem_reserve])]: 231_809_000n * E18,
    },
  });
  // The two quarterly burns, from the Safe to dead.
  const burns: Omit<TransferLog, 'timestamp'>[] = [
    { blockNumber: blockAt('2026-07-10T18:00:00Z'), logIndex: 0, txHash: '0xq2', from: lc(C.burn_safe), value: 15_640_000n * E18 },
    { blockNumber: blockAt('2026-10-09T19:00:00Z'), logIndex: 0, txHash: '0xq3', from: lc(C.burn_safe), value: 2_450_000n * E18 },
  ];
  // September's routing: the buyback wallet sends bought LIT to the Coinbase Prime pass-through; one unrelated sender too.
  const routed: Omit<TransferLog, 'timestamp'>[] = [
    { blockNumber: blockAt('2026-09-08T21:44:00Z'), logIndex: 0, txHash: '0xr1', from: lc(C.buyback_wallet), value: 1_400_000n * E18 },
    { blockNumber: blockAt('2026-09-30T14:27:00Z'), logIndex: 0, txHash: '0xr2', from: lc(C.buyback_wallet), value: 1_500_000n * E18 },
    { blockNumber: blockAt('2026-09-10T12:00:00Z'), logIndex: 0, txHash: '0xr3', from: '0x7630c870da000000000000000000000000000000', value: 100_000n * E18 },
  ];
  const rpc: RpcTransport = {
    ...base,
    async getTransferLogs(q) {
      if (lc(q.token) !== lc(C.token)) return [];
      if (lc(q.to) === lc(C.prime_passthrough)) {
        return routed.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock).map((l) => ({ ...l, timestamp: base.timestampOf(l.blockNumber) }));
      }
      if (lc(q.to) !== lc(C.dead)) return [];
      return burns.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock).map((l) => ({ ...l, timestamp: base.timestampOf(l.blockNumber) }));
    },
  };
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http };
}

describe('assets/lit.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'lit', symbol: 'LIT', chain: 'ethereum', supply_basis: 'effective_total', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    // Mike, 2026-10-16: discretionary.
    expect(config.holder_flows).toEqual([{ id: 'buyback', kind: 'burn', capture_rule: 'discretionary', recipient_base: 'all', metric: 'flow_usd.buyback', window_days: 91 }]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.buyback', 'capture_rate_terminal.buyback', 'discount_premium_discretionary', 'discount_rate_base', 'growth_fade_years',
      'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual([]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // Lighter's own data for the holder flow (Mike, 2026-10-16); DefiLlama only for display series and the unlock schedule.
    expect(config.metrics['flow_usd.buyback'].source).toMatchObject({ type: 'adapter', name: 'lit.treasury_buys_daily' });
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama').map(([k]) => k)).toEqual(['flow_usd.fees', 'flow_usd.llama_revenue']);
    // Category share from DefiLlama (Mike, 2026-10-17): monitor-only, never a driver or in the grade.
    for (const key of ['dominance_share', 'dominance_share_1y']) expect(config.metrics[key]).toMatchObject({ type: 'level', unit: 'ratio', monitor_only: true, staleness_days: 7 });
    expect(config.metrics.dominance_share.source).toEqual({ type: 'defillama_share', parent: 'parent#lighter', category: 'Derivatives', overview: 'fees', window: '30d' });
    expect(config.metrics.dominance_share_1y.source).toEqual({ type: 'defillama_share', parent: 'parent#lighter', category: 'Derivatives', overview: 'fees', window: '1y' });
    // A deliberate edit of assets/lit.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-10-17: dominance_share / dominance_share_1y (monitor-only category share).
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/lit.yaml`, 'utf8')).hash).toBe('ad683e198b9b97af4d0067e339b89323b1711fe3e689fbb7f9fd404353f926a5');
  });

  it('plans one allowlisted scan into dead (the quarterly burns) and the buyback run rate', () => {
    const plan = buildPlan(config);
    expect(plan.flowGroups.map((g) => [g.sourceId, g.members.map((m) => m.metricKey)])).toEqual([
      [expect.stringMatching(/^transfer_flow:token>dead/), ['flow_tokens.burn']],
      [expect.stringMatching(/^transfer_flow:token>prime_passthrough/), ['flow_tokens.routed_to_prime']],
    ]);
    expect(plan.derived.map((r) => r.metricKey).sort()).toEqual(['revenue_run_rate_usd', 'routed_to_prime_rate']);
  });

  it('fetches every metric, reads the buys from Lighter, and values the asset through the tick path', async () => {
    const w = world();
    const { fetch: r, signal } = await updateAsset(w.db, loadAsset(ROOT, 'lit'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    // The category share (monitor-only): 30 of 100 over 30 days, 250 of 1,000 over a year, from the overview.
    expect(['dominance_share', 'dominance_share_1y'].map((k) => listActiveObservations(w.db, 'lit', k).map((o) => o.value))).toEqual([[0.3], [0.25]]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');

    const rows = (metric: string) => listActiveObservations(w.db, 'lit', metric);
    const value = (metric: string) => rows(metric).at(-1)!.value;
    expect(value('price_usd')).toBe(PRICE);
    expect(value('total_supply')).toBe(981_909_280);
    expect(value('reserve_lit')).toBe(231_809_000);
    // 74 days to the cliff leaves 291 of the next 365.
    expect(value('unlocks_next_year') / 1e6).toBeCloseTo((291 * 3_194_000) / 7 / 1e6, 1);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual(
      expect.arrayContaining([['total_supply', true], ['price_usd', true]]),
    );

    // The routine (first) fetch writes the backfill window the API returned: the 100 days of trades less the oldest, partial one.
    const buys = rows('flow_tokens.buyback');
    expect(buys.length).toBeGreaterThanOrEqual(91);
    expect(buys.at(-1)!.value).toBeCloseTo(25_000, 0);
    const revenue = rows('revenue_run_rate_usd').at(-1)!;
    expect(revenue.value).toBeCloseTo(25_000 * PRICE * 365, -3);
    expect(revenue.sourceDetail).toBe('derived flow_annualized(flow_usd.buyback, 91d)');
    expect(rows('flow_tokens.burn').filter((o) => o.value > 0).map((o) => o.value)).toEqual([15_640_000, 2_450_000]);
    // Routing to Coinbase Prime: only the buyback wallet's sends count; the unrelated sender raises nothing (monitor-only).
    expect(rows('flow_tokens.routed_to_prime').filter((o) => o.value > 0).map((o) => o.value)).toEqual([1_400_000, 1_500_000]);
    expect(value('routed_to_prime_rate')).toBeCloseTo((2_900_000 * 365) / 91, 0);
    // The valuation's inputs are unchanged by it.
    expect(config.metrics['flow_tokens.routed_to_prime'].monitor_only).toBe(true);

    // No assumption set yet: blocked, as every new asset is until calibration.
    expect(signal.status_reasons).toContain('no_assumption_set');

    // The next routine fetch has a cursor, so it reads only the adapter's own 7-day window: one page (84 trades), not the 12 of the first.
    const pages = () => w.http.calls.filter((c) => c.url.includes('/trades?')).length;
    const first = pages();
    expect(first).toBe(12);
    await fetchAsset(w.db, { config, hash: 'test' }, new Date(NOW.getTime() + DAY), w.deps);
    expect(pages() - first).toBe(1);
  });

  it('reports the buys as the payout, the unlocks as dilution, and the market cap on circulating supply', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    const rep = loadHolderYieldReport(w.db, config);
    expect(rep.day).toBe('2026-10-15');
    expect(rep.marketCap).toBeCloseTo(PRICE * 250_000_000, 0);
    expect(rep.fdv).toBeCloseTo(PRICE * 981_909_280, 0);
    expect(rep.yields.buyback).toBeCloseTo((25_000 * PRICE * 365) / (981_909_280 * PRICE), 3);
    expect(rep.income!.payoutRatio).toBeCloseTo((25_000 * PRICE) / 120_000, 2);
    expect(rep.supply).toMatchObject({ burnedPerYear: expect.closeTo(25_000 * 365, -3) });
    // Unlocks (about 133M a year) swamp the burn (9.1M) in tokens.
    expect(rep.supply!.netPerYear).toBeGreaterThan(0);
  });

  it('get_drivers marks staked_ratio structural with the staked_supply note, as the analyst pack does (Ruling 13)', async () => {
    const w = world();
    const loaded = loadAsset(ROOT, 'lit');
    await fetchAsset(w.db, loaded, NOW, w.deps);
    const ctx: ToolContext = {
      db: w.db, loaded, ledger: new Ledger('lit', 'analyst', null), now: () => NOW, budgets: budgetsFor(loaded.config, 'weekly'), runType: 'weekly',
      fetchedPages: () => [], citableDocs: () => [], targetDoc: null,
    };
    const out = runTool(AGENT_TOOLS, ctx, 'get_drivers', {});
    expect(out.isError).toBe(false);
    const drivers = (JSON.parse(out.content) as { drivers: Record<string, { structural?: string }> }).drivers;
    const note = (config.metrics.staked_supply.source as { note: string }).note;
    expect(note).toMatch(/not a fee share/);
    expect(drivers.staked_ratio.structural).toBe(note);
    expect(drivers.staker_emission_share.structural).toBe(structuralNotes(config).staker_emission_share);
  });

  it('is covered by the perp exchange analyst, who knows the burn is drawn from the reserve', () => {
    const persona = loadPersona(ROOT, 'perp-exchange-analyst');
    expect(persona.body).toContain('A buyback with the burn drawn from the reserve (LIT)');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
  });
});

describe('calibration/lit-assumptions.yaml', () => {
  const calibrated = parseYaml(readFileSync(`${ROOT}/calibration/lit-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;
  it('is complete and sits inside the agent bands of assets/lit.yaml', () => {
    for (const s of ['bear', 'base', 'bull'] as const) {
      expect(Object.keys(calibrated[s]).sort()).toEqual(requiredAssumptionKeys(config));
      for (const [key, value] of Object.entries(calibrated[s])) {
        const b = config.assumptions[key];
        const band = b[s] ?? b;
        expect(value, `${s} ${key}`).toBeGreaterThanOrEqual(band.min);
        expect(value, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
    }
    for (const key of ['rev_growth_y1', 'multiple.fm_holder_flow', 'discount_rate_base', 'capture_rate_terminal.buyback', 'discount_premium_discretionary']) {
      for (const s of ['bear', 'base', 'bull'] as const) expect(config.assumptions[key][s], `${s} ${key}`).toBeDefined();
    }
  });
});
