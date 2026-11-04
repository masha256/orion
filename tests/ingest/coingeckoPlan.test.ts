import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { COINGECKO_API, coingeckoBase, coingeckoHeaders } from '../../src/ingest/sources/coingecko.js';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import { isMarketChartUrl, withSharedCache } from '../../src/ingest/transport/http.js';
import { isMarketChartBody } from '../../src/ingest/flow.js';
import { CG_CHART, harness, NOW } from '../helpers/fetchHarness.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';
import { req, sourceCtx } from '../helpers/sourceCtx.js';

const testDb = useTestDb();

const PRO = 'https://pro-api.coingecko.com/api/v3';

describe('COINGECKO_PLAN', () => {
  it('coingecko: pro plan uses pro-api host and x-cg-pro-api-key; default stays demo; a bad plan is refused', () => {
    expect(COINGECKO_API).toBe('https://api.coingecko.com/api/v3');
    expect(coingeckoBase({})).toBe(COINGECKO_API);
    expect(coingeckoBase({ COINGECKO_PLAN: 'demo' })).toBe(COINGECKO_API);
    expect(coingeckoBase({ COINGECKO_PLAN: '' })).toBe(COINGECKO_API);
    expect(coingeckoBase({ COINGECKO_PLAN: 'pro' })).toBe(PRO);

    expect(coingeckoHeaders({})).toEqual({});
    expect(coingeckoHeaders({ COINGECKO_API_KEY: 'k' })).toEqual({ 'x-cg-demo-api-key': 'k' });
    expect(coingeckoHeaders({ COINGECKO_API_KEY: 'k', COINGECKO_PLAN: 'demo' })).toEqual({ 'x-cg-demo-api-key': 'k' });
    expect(coingeckoHeaders({ COINGECKO_API_KEY: 'k', COINGECKO_PLAN: 'pro' })).toEqual({ 'x-cg-pro-api-key': 'k' });

    for (const plan of ['Pro', 'basic', 'analyst']) {
      expect(() => coingeckoBase({ COINGECKO_PLAN: plan })).toThrow(expect.objectContaining({ code: 'invalid_coingecko_plan' }) as Error);
      expect(() => coingeckoHeaders({ COINGECKO_PLAN: plan, COINGECKO_API_KEY: 'k' })).toThrow(expect.objectContaining({ code: 'invalid_coingecko_plan' }) as Error);
    }
  });

  it('coingecko: the markets source builds its URL from the plan', async () => {
    const http = fakeHttp({ [PRO]: [{ id: 'mini-token', current_price: 3 }] });
    const out = await getSourceHandler('coingecko').fetch(
      [req('price_usd', { type: 'coingecko', id: 'mini-token', field: 'price' })],
      sourceCtx({ http, env: { COINGECKO_PLAN: 'pro', COINGECKO_API_KEY: 'k' } }),
    );
    expect(out[0].ok).toBe(true);
    expect(http.calls).toEqual([{ url: `${PRO}/coins/markets?vs_currency=usd&ids=mini-token`, headers: { 'x-cg-pro-api-key': 'k' }, method: 'GET', body: undefined }]);
  });

  it('coingecko: a whole fetch on the pro plan reaches only the pro host for CoinGecko', async () => {
    const proRoutes = {
      [`${PRO}/coins/markets`]: [{ id: 'mini-token', current_price: 10, market_cap: 600, circulating_supply: 60 }],
      [`${PRO}/coins/mini-token/market_chart`]: { prices: Array.from({ length: 240 }, (_, i) => [Date.parse('2026-09-10T00:00:00Z') + i * 3_600_000, 10]) },
    };
    const h = harness(testDb(), { routes: proRoutes, env: { TEST_RPC_URL: 'http://rpc.test', COINGECKO_PLAN: 'pro', COINGECKO_API_KEY: 'k' } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true });
    const cg = h.http.calls.filter((c) => c.url.includes('coingecko'));
    expect(cg.length).toBeGreaterThan(1);
    expect(cg.every((c) => c.url.startsWith(`${PRO}/`) && c.headers['x-cg-pro-api-key'] === 'k')).toBe(true);
    expect(r.sources.find((s) => s.sourceId === 'coingecko')?.status).toBe('ok');
  });

  it('coingecko: a bad plan stops the fetch as a configuration error', async () => {
    const h = harness(testDb(), { env: { TEST_RPC_URL: 'http://rpc.test', COINGECKO_PLAN: 'enterprise' } });
    await expect(fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true })).rejects.toMatchObject({ code: 'invalid_coingecko_plan' });
  });
});

describe('shared market_chart cache (N8)', () => {
  it('sharedCache: two assets with the same price id fetch market_chart once', async () => {
    const h = harness(testDb());
    const other = parseAssetYaml(INGEST_ASSET_YAML.replace('id: mini\n', 'id: mini2\n'));
    const charts = () => h.http.calls.filter((c) => c.url.startsWith(CG_CHART)).length;

    const cache = new Map<string, Promise<unknown>>();
    const deps = { ...h.deps, sharedHttpCache: cache };
    const a = await fetchAsset(h.db, h.loaded, NOW, deps);
    expect(charts()).toBe(1);
    const b = await fetchAsset(h.db, other, NOW, deps);
    expect(charts()).toBe(1);
    // Only the chart is shared: each asset reads its own markets row.
    expect(h.http.calls.filter((c) => c.url.includes('/coins/markets')).length).toBe(2);
    const flows = (r: typeof a) => r.written.filter((w) => w.metricKey.startsWith('flow_')).map((w) => [w.metricKey, w.observedAt, w.value]);
    expect(flows(b)).toEqual(flows(a));

    // Without the map every asset fetches its own (today's behaviour).
    const c = await fetchAsset(h.db, parseAssetYaml(INGEST_ASSET_YAML.replace('id: mini\n', 'id: mini3\n')), NOW, h.deps);
    expect(charts()).toBe(2);
    expect(flows(c)).toEqual(flows(a));
  });

  it('sharedCache: only matching URLs are shared, and a failure is not kept', async () => {
    let fail = true;
    const inner = fakeHttp({
      'https://x.test/chart': () => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return { ok: 1 };
      },
      'https://x.test/other': { other: 1 },
    });
    const cache = new Map<string, Promise<unknown>>();
    const http = withSharedCache(inner, cache, (url) => url.includes('/chart'));
    await expect(http.getJson('https://x.test/chart')).rejects.toThrow(/boom/);
    expect(await http.getJson('https://x.test/chart')).toEqual({ ok: 1 });
    expect(await withSharedCache(inner, cache, (url) => url.includes('/chart')).getJson('https://x.test/chart')).toEqual({ ok: 1 });
    await http.getJson('https://x.test/other');
    await http.getJson('https://x.test/other');
    expect(inner.calls.map((c) => c.url)).toEqual(['https://x.test/chart', 'https://x.test/chart', 'https://x.test/other', 'https://x.test/other']);
  });

  it('shared cache (M-8): a 200 reply that fails validation (a rate-limit body) is not kept; the next asset asks again', async () => {
    let n = 0;
    const inner = fakeHttp({ 'https://x.test/market_chart': () => (++n === 1 ? { status: { error_code: 429, error_message: 'rate limited' } } : { prices: [[1, 2]] }) });
    const cache = new Map<string, Promise<unknown>>();
    const http = withSharedCache(inner, cache, isMarketChartUrl, isMarketChartBody);
    expect(await http.getJson('https://x.test/market_chart')).toEqual({ status: { error_code: 429, error_message: 'rate limited' } });
    expect(await http.getJson('https://x.test/market_chart')).toEqual({ prices: [[1, 2]] });
    expect(await http.getJson('https://x.test/market_chart')).toEqual({ prices: [[1, 2]] }); // a good one is kept
    expect(n).toBe(2);
    expect(isMarketChartBody({ prices: [] })).toBe(false);
    expect(isMarketChartBody({ prices: [[1, 0]] })).toBe(false);
  });
});
