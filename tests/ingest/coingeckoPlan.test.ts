import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { COINGECKO_API, coingeckoBase, coingeckoHeaders } from '../../src/ingest/sources/coingecko.js';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import { harness, MINI_REF, NOW } from '../helpers/fetchHarness.js';
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
    };
    const h = harness(testDb(), { routes: proRoutes, env: { TEST_RPC_URL: 'http://rpc.test', COINGECKO_PLAN: 'pro', COINGECKO_API_KEY: 'k' } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true });
    const cg = h.http.calls.filter((c) => c.url.includes('coingecko'));
    expect(cg.length).toBe(1); // the markets read (no price chart since Phase 3 R2)
    expect(cg.every((c) => c.url.startsWith(`${PRO}/`) && c.headers['x-cg-pro-api-key'] === 'k')).toBe(true);
    expect(r.sources.find((s) => s.sourceId === 'coingecko')?.status).toBe('ok');
  });

  it('coingecko: a bad plan stops the fetch as a configuration error', async () => {
    const h = harness(testDb(), { env: { TEST_RPC_URL: 'http://rpc.test', COINGECKO_PLAN: 'enterprise' } });
    await expect(fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true })).rejects.toMatchObject({ code: 'invalid_coingecko_plan' });
  });
});

describe('no CoinGecko price chart (Phase 3 R2 Task 6a)', () => {
  it('a full fetch values its transfer flows at chain prices: no market_chart request; /coins/markets only for the level ids', async () => {
    const h = harness(testDb());
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(r.written.filter((w) => w.metricKey === 'flow_usd.fees').length).toBeGreaterThan(0);
    expect(h.http.calls.filter((c) => c.url.includes('market_chart'))).toEqual([]);
    expect(h.http.calls.filter((c) => c.url.includes('coingecko')).map((c) => new URL(c.url).pathname)).toEqual(['/api/v3/coins/markets']);
    expect(h.prices.calls.map((c) => c.refs)).toEqual([[MINI_REF]]);
  });
});
