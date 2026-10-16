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
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

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
  return { db: openDb(':memory:'), deps, http, rpc };
}

/** A flat wiring package, inside the placeholder bands. */
function assumptions(): AssumptionValues {
  const s = {
    rev_growth_y1: 0.1, growth_fade_years: 5, terminal_growth: 0.02, 'capture_rate_terminal.reserve': 0.85, 'capture_ramp_years.reserve': 0,
    discount_rate_base: 0.2, discount_premium_discretionary: 0.06, 'multiple.fm_holder_flow': 10, regime_multiplier: 1, staked_ratio_horizon: 0.5,
  };
  return { bear: s, base: s, bull: s } as unknown as AssumptionValues;
}

describe('assets/link.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'link', symbol: 'LINK', chain: 'ethereum', supply_basis: 'effective_total', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows).toEqual([{ id: 'reserve', kind: 'buy_and_hold', capture_rule: 'discretionary', recipient_base: 'all', metric: 'flow_usd.reserve', window_days: 91 }]);
    expect(config.modules.map((m) => [m.id, m.kind, m.weight ?? null])).toEqual([['hc', 'estimate', 0.6], ['fm_holder_flow', 'estimate', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.reserve', 'capture_rate_terminal.reserve', 'discount_premium_discretionary', 'discount_rate_base', 'growth_fade_years',
      'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual([]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // No DefiLlama at all (Mike, 2026-10-11): the Reserve flow and the releases are read on chain.
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama' || d.cross_checks?.some((c) => c.source.type === 'defillama')).map(([k]) => k)).toEqual([]);
    // The hold bucket's overhang haircut (Mike, 2026-10-16: 5 percent).
    expect(config.reporting!.haircuts).toEqual({ reserve: 0.05 });
    // A deliberate edit of assets/link.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/link.yaml`, 'utf8')).hash).toBe('1b561421d5e403957bf5e78895928bf2445dd805c931660d60566bc24d59900a');
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
    expect(plan.derived.map((r) => r.metricKey).sort()).toEqual(['released_rate', 'revenue_run_rate_usd']);
  });

  it('fetches every metric, counts only the fee converter, flags the stranger, and values the asset through the tick path', async () => {
    const w = world();
    createAssumptionSet(w.db, { assetId: 'link', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    // The year of releases first (live does this as the onboarding backfill); then the routine tick reads 100 days.
    await fetchAsset(w.db, { config, hash: 'backfill' }, NOW, w.deps, { backfillDays: 370, metrics: ['flow_tokens.released_hub', 'flow_tokens.released_rewards', 'released_rate'] });
    const { fetch: r, signal } = await updateAsset(w.db, loadAsset(ROOT, 'link'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error])).toEqual([]);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true]]);

    const rows = (metric: string) => listActiveObservations(w.db, 'link', metric);
    const value = (metric: string) => rows(metric).at(-1)!.value;
    expect(value('price_usd')).toBe(PRICE);
    expect(value('total_supply')).toBe(1_000_000_000);
    expect(value('reserve_link')).toBe(6_293_843);
    expect(value('emission_rate_annual')).toBe(0);

    // The stranger's 2,000 LINK is an unlisted sender (an alert on the holder flow), never counted; the 5-LINK test is dust.
    const reserveScan = r.sources.find((s) => s.sourceId.startsWith('transfer_flow:token>reserve'))!;
    expect(reserveScan.unlistedTransfers.map((t) => [t.from, t.tokens])).toEqual([[STRANGER, 2_000]]);
    expect(r.anomalies.map((a) => [a.kind, a.metricKey])).toEqual([['unlisted_sender', 'flow_usd.reserve']]);
    const paid = rows('flow_tokens.reserve').filter((o) => o.value > 0);
    expect(paid.map((o) => o.value).every((v) => v === 100_000)).toBe(true);
    expect(paid.length).toBe(15);
    // 13 Thursdays fall in the 91 days to 2026-10-15: 1.3M LINK at 12.5 USD, scaled to a year.
    expect(value('revenue_run_rate_usd')).toBeCloseTo((13 * 100_000 * PRICE * 365) / 91, 0);

    // Releases: the four quarters inside the last 365 days, the dust and the year-old release left out.
    expect(value('released_rate')).toBeCloseTo(4 * (15_000_000 + 2_500_000), 0);

    // The open alert holds the grade below A until it is acknowledged; the valuation itself runs.
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    expect(signal.spot!.price).toBe(PRICE);
  });

  it('reports the Reserve as a hold with the 5 percent haircut, and the releases as dilution', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { backfillDays: 370 });
    const rep = loadHolderYieldReport(w.db, config);
    expect(rep.day).toBe('2026-10-15');
    const gross = (13 * 100_000 * PRICE * 365) / 91;
    expect(rep.flows).toEqual([expect.objectContaining({ id: 'reserve', bucket: 'hold', haircut: 0.05, gross: expect.closeTo(gross, 0), net: expect.closeTo(gross * 0.95, 0) })]);
    expect(rep.buckets.hold!.net).toBeCloseTo(gross * 0.95, 0);
    expect(rep.buckets.burn).toBeNull();
    const fdv = 1_000_000_000 * PRICE;
    expect(rep.fdv).toBeCloseTo(fdv, 0);
    expect(rep.marketCap).toBeCloseTo(766_849_970 * PRICE, 0);
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

describe('calibration/link-assumptions.yaml', () => {
  const calibrated = parseYaml(readFileSync(`${ROOT}/calibration/link-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;
  it('is complete and sits inside the agent bands of assets/link.yaml', () => {
    for (const s of ['bear', 'base', 'bull'] as const) {
      expect(Object.keys(calibrated[s]).sort()).toEqual(requiredAssumptionKeys(config));
      for (const [key, value] of Object.entries(calibrated[s])) {
        const b = config.assumptions[key];
        const band = b[s] ?? b;
        expect(value, `${s} ${key}`).toBeGreaterThanOrEqual(band.min);
        expect(value, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
    }
    for (const key of ['rev_growth_y1', 'multiple.fm_holder_flow', 'discount_rate_base', 'capture_rate_terminal.reserve', 'discount_premium_discretionary']) {
      for (const s of ['bear', 'base', 'bull'] as const) expect(config.assumptions[key][s], `${s} ${key}`).toBeDefined();
    }
  });
});
