import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys, requiredExtraMetrics } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-09T07:30:00.000Z'); // a Friday
const BLOCK_SEC = 12;
const GENESIS_TS = NOW.getTime() / 1000 - 110 * 86_400 + 1;
const LLAMA = 'https://coins.llama.fi/prices/current/ethereum:0xFCc5c47bE19d06BF83eB04298b026F81069ff65b';
const E18 = 10n ** 18n;

const { config } = loadAsset(ROOT, 'ycrv');
const C = config.contracts;

/** crvUSD market chart: flat at 0.9991 every hour over the window. */
function crvusdChart(url: string): { prices: [number, number][] } {
  const days = Number(new URL(url).searchParams.get('days'));
  const end = NOW.getTime();
  const step = days > 90 ? 86_400_000 : 3_600_000;
  const prices: [number, number][] = [];
  for (let t = end - days * 86_400_000; t <= end; t += step) prices.push([t, 0.9991]);
  return { prices };
}

/** The Saturdays from 2026-07-04 to 2026-10-03, at 12:00Z: 25,000 yvcrvUSD-2 shares each (about the live weekly mean). */
function saturdays(): string[] {
  const out: string[] = [];
  for (let d = Date.parse('2026-07-04T12:00:00Z'); d <= Date.parse('2026-10-03T12:00:00Z'); d += 7 * 86_400_000) out.push(new Date(d).toISOString());
  return out;
}
const PAYOUT = 25_000n;
const PPS = 1_159_000_000_000_000_000n; // 1.159 crvUSD per share, read live 2026-10-09

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'yearn-crv', symbol: 'ycrv', current_price: 0.18345, market_cap: 13.2e6, circulating_supply: 71_960_697, total_supply: 71_960_697 }],
    'https://api.coingecko.com/api/v3/coins/crvusd/market_chart': crvusdChart,
    'https://api.coingecko.com/api/v3/coins/yearn-crv/market_chart': crvusdChart, // the st-yCRV fee scan (no fee logs here)
    [LLAMA]: { coins: { 'ethereum:0xFCc5c47bE19d06BF83eB04298b026F81069ff65b': { decimals: 18, symbol: 'yCRV', price: 0.1806, timestamp: 1791521457, confidence: 0.99 } } },
  });
  const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    blockTimeSec: BLOCK_SEC,
    maxLogRange: 10_000n,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC)),
    calls: {
      // Read live on 2026-10-09.
      [callKey(C.token, 'totalSupply')]: 71_960_697n * E18,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.ybs, 'totalSupply')]: 63_328_341n * E18,
      [callKey(C.yv_crvusd, 'decimals')]: 18n,
      [callKey(C.yv_crvusd, 'pricePerShare')]: PPS,
      [callKey(C.crvusd, 'decimals')]: 18n, // the report-only gross scan
      [callKey(C.st_ycrv, 'decimals')]: 18n, // the report-only st-yCRV fee scan
    },
    logs: saturdays().map((iso, i) => ({ blockNumber: blockAt(iso), logIndex: 0, txHash: `0x${i.toString(16)}`, from: C.receiver, value: PAYOUT * E18 })),
  });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http, rpc };
}

/** A flat, plausible set for the wiring test; the real one comes from the user's calibration. */
function assumptions(): AssumptionValues {
  const one = {
    rev_growth_y1: -0.1, growth_fade_years: 3, terminal_growth: -0.05, 'capture_rate_terminal.fees': 1, 'capture_ramp_years.fees': 0,
    discount_rate_base: 0.15, discount_premium_programmatic: 0.02, 'multiple.fm_holder_flow': 8, regime_multiplier: 1, staked_ratio_horizon: 0.88,
  };
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}

describe('assets/ycrv.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'ycrv', symbol: 'yCRV', chain: 'ethereum', supply_basis: 'effective_total', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows).toEqual([
      { id: 'fees', kind: 'fee_share', capture_rule: 'programmatic', recipient_base: 'staked', valued_per: 'recipients', metric: 'flow_usd.fees', window_days: 91 },
    ]);
    expect(config.modules.map((m) => [m.id, m.kind, m.weight ?? null])).toEqual([['hc', 'estimate', 0.6], ['fm_holder_flow', 'estimate', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.fees', 'capture_rate_terminal.fees', 'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years',
      'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual([]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // Pinned on 2026-10-10 with the report-only block. A deliberate edit of assets/ycrv.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/ycrv.yaml`, 'utf8')).hash).toBe('75fecc8e8b1902bd5cc87c094d47d1d5dda1a381b5609d2ad1f2132504ea0996');
  });

  it('plans one transfer scan of vault shares, converted at the share price', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd']],
      [`http_json:${LLAMA}`, ['cross_check:price_usd']],
      ['chain_levels', ['primary:effective_supply', 'primary:staked_supply']],
      ['constant', ['primary:staker_emission_share', 'primary:emission_rate_annual']],
    ]);
    expect(plan.flowGroups.map((g) => g.members)).toEqual([
      [{ metricKey: 'flow_usd.fees', unit: 'usd', countFrom: [C.receiver.toLowerCase()], priceCoingeckoId: 'crvusd', sharePrice: { address: C.yv_crvusd.toLowerCase(), functionName: 'pricePerShare', decimals: 18 } }],
      // Report-only: Yearn's revenue (vault shares into its treasury vault) and the gross crvUSD into the splitter.
      [{ metricKey: 'flow_usd.yearn_revenue', unit: 'usd', countFrom: [C.splitter.toLowerCase(), C.receiver.toLowerCase()], priceCoingeckoId: 'crvusd', sharePrice: { address: C.yv_crvusd.toLowerCase(), functionName: 'pricePerShare', decimals: 18 } }],
      [{ metricKey: 'flow_usd.yearn_styc_fee', unit: 'usd', countFrom: [C.st_ycrv.toLowerCase()], priceCoingeckoId: 'yearn-crv', sharePrice: { address: C.st_ycrv.toLowerCase(), functionName: 'pricePerShare', decimals: 18 } }],
      [{ metricKey: 'flow_usd.yearn_gross', unit: 'usd', countFrom: [C.voter.toLowerCase(), C.fee_burner.toLowerCase()], priceCoingeckoId: 'crvusd', sharePrice: null }],
    ]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
  });

  it('fetches every metric from canned sources, then values the cash per staked yCRV at grade A', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    const rows = (metric: string) => listActiveObservations(w.db, 'ycrv', metric);
    const value = (metric: string) => rows(metric).at(-1)!.value;
    expect(value('price_usd')).toBe(0.18345);
    expect(value('effective_supply')).toBe(71_960_697);
    expect(value('staked_supply')).toBe(63_328_341);
    expect(value('staker_emission_share')).toBe(0);
    expect(rows('emission_rate_annual').map((o) => o.value)).toEqual([0]);

    const fees = rows('flow_usd.fees');
    expect(fees).toHaveLength(100);
    expect(fees.filter((o) => o.value > 0)).toHaveLength(14); // the Saturdays 2026-07-04 to 2026-10-03
    // Each payout: 25,000 shares x 1.159 crvUSD per share x 0.9991 USD.
    expect(fees.find((o) => o.value > 0)!.value).toBeCloseTo(25_000 * 1.159 * 0.9991, 6);
    // 13 payouts in the 91 days to 2026-10-08, scaled to a year.
    expect(rows('revenue_run_rate_usd').at(-1)!.value).toBeCloseTo((13 * 25_000 * 1.159 * 0.9991 * 365) / 91, 0);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['price_usd', true]]);

    createAssumptionSet(w.db, { assetId: 'ycrv', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'ycrv'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
    const hc = signal.horizons!['12m'].modules.hc;
    const share = 63_328_341 / 71_960_697;
    expect((hc.breakdown.flows as Record<string, Record<string, unknown>>).fees.valued_over_share).toBeCloseTo(share, 12);
    expect(signal.horizons!['12m'].modules.fm_holder_flow.breakdown.valued_per_recipients).toEqual({ fees: expect.closeTo(share, 12) });
    // No emissions: supply at the horizon is today's.
    expect(hc.breakdown.supply_at_horizon).toBe(71_960_697);
  });

  it('refuses to run without the Ethereum RPC URL', async () => {
    const w = world();
    await expect(fetchAsset(w.db, { config, hash: 'test' }, NOW, { ...w.deps, env: {} })).rejects.toMatchObject({ code: 'missing_rpc_url' });
  });
});

describe('calibration/ycrv-assumptions.yaml', () => {
  it('is complete and sits inside the agent bands of assets/ycrv.yaml', () => {
    const raw = parseYaml(readFileSync(`${ROOT}/calibration/ycrv-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;
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
});
