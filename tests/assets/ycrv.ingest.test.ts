import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
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

describe('assets/ycrv.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'ycrv', symbol: 'yCRV', chain: 'ethereum', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    expect(config.holder_flows).toEqual([
      { id: 'fees', kind: 'fee_share', capture_rule: 'programmatic', recipient_base: 'staked', valued_per: 'recipients', metric: 'flow_usd.fees', window_days: 91 },
    ]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    expect(config.metrics.revenue_run_rate_usd).toBeUndefined(); // valuation-only: left with the valuation layer (Phase 1)
    // Re-pinned on 2026-10-12: effective_supply renamed total_supply, CoinGecko total_supply cross-check (wrappers: + circulating_supply). A deliberate edit of assets/ycrv.yaml moves it; update the pin on purpose.
    // Re-pinned 2026-11-01: the valuation keys (supply_basis, modules, scenario_probabilities, assumptions, agent budgets, review_triggers, peer_set) and the valuation-only metrics (dominance_share*, revenue_run_rate_usd) left (Phase 1).
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/ycrv.yaml`, 'utf8')).hash).toBe('6e51d315fcf0148ccdfe1ff76f6ed57fa42337c5abf4de734c86c95020ba149b');
  });

  it('plans one transfer scan of vault shares, converted at the share price', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd']], // no total_supply check: CoinGecko's yCRV supply is a 2022 snapshot (Mike, 2026-10-12)
      [`http_json:${LLAMA}`, ['cross_check:price_usd']],
      ['chain_levels', ['primary:total_supply', 'primary:circulating_supply', 'primary:staked_supply']], // circulating = the on-chain total
      ['constant', ['primary:staker_emission_share', 'primary:emission_rate_annual']],
    ]);
    expect(plan.flowGroups.map((g) => g.members)).toEqual([
      [{ metricKey: 'flow_usd.fees', unit: 'usd', countFrom: [C.receiver.toLowerCase()], priceCoingeckoId: 'crvusd', sharePrice: { address: C.yv_crvusd.toLowerCase(), functionName: 'pricePerShare', decimals: 18 } }],
      // Report-only: Yearn's revenue (vault shares into its treasury vault) and the gross crvUSD into the splitter.
      [{ metricKey: 'flow_usd.yearn_revenue', unit: 'usd', countFrom: [C.splitter.toLowerCase(), C.receiver.toLowerCase()], priceCoingeckoId: 'crvusd', sharePrice: { address: C.yv_crvusd.toLowerCase(), functionName: 'pricePerShare', decimals: 18 } }],
      [{ metricKey: 'flow_usd.yearn_styc_fee', unit: 'usd', countFrom: [C.st_ycrv.toLowerCase()], priceCoingeckoId: 'yearn-crv', sharePrice: { address: C.st_ycrv.toLowerCase(), functionName: 'pricePerShare', decimals: 18 } }],
      [{ metricKey: 'flow_usd.yearn_gross', unit: 'usd', countFrom: [C.voter.toLowerCase(), C.fee_burner.toLowerCase()], priceCoingeckoId: 'crvusd', sharePrice: null }],
    ]);
    expect(plan.derived).toEqual([]);
  });

  it('fetches every metric from canned sources', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    const rows = (metric: string) => listActiveObservations(w.db, 'ycrv', metric);
    const value = (metric: string) => rows(metric).at(-1)!.value;
    expect(value('price_usd')).toBe(0.18345);
    expect(value('total_supply')).toBe(71_960_697);
    expect(value('staked_supply')).toBe(63_328_341);
    expect(value('staker_emission_share')).toBe(0);
    expect(rows('emission_rate_annual').map((o) => o.value)).toEqual([0]);

    const fees = rows('flow_usd.fees');
    expect(fees).toHaveLength(100);
    expect(fees.filter((o) => o.value > 0)).toHaveLength(14); // the Saturdays 2026-07-04 to 2026-10-03
    // Each payout: 25,000 shares x 1.159 crvUSD per share x 0.9991 USD.
    expect(fees.find((o) => o.value > 0)!.value).toBeCloseTo(25_000 * 1.159 * 0.9991, 6);
    expect(rows('revenue_run_rate_usd')).toEqual([]); // no derived run rate any more (it fed only the valuation)
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['price_usd', true]]);
  });

  it('refuses to run without the Ethereum RPC URL', async () => {
    const w = world();
    await expect(fetchAsset(w.db, { config, hash: 'test' }, NOW, { ...w.deps, env: {} })).rejects.toMatchObject({ code: 'missing_rpc_url' });
  });
});
