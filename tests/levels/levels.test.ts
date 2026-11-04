import { describe, expect, it } from 'vitest';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { listLatestLevels, upsertLatestLevels, deleteLatestLevels } from '../../src/db/latestLevels.js';
import { insertObservation } from '../../src/db/observations.js';
import { levelMetricKeys, prefetchMarkets, runLevels, toLatestLevels, withPrefetchedMarkets } from '../../src/levels/levels.js';
import type { FetchDeps } from '../../src/ingest/run.js';
import type { RpcTransport } from '../../src/ingest/transport/rpc.js';
import { CG_MARKETS, harness, NOW } from '../helpers/fetchHarness.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';
import { watchAsset } from '../helpers/watchAsset.js';

const testDb = useTestDb();

/** The mini asset under another id and CoinGecko id; `extra` is appended to its metrics. */
function variant(id: string, cg: string, extra = '', rpcEnv = 'TEST_RPC_URL'): LoadedAsset {
  return parseAssetYaml(
    INGEST_ASSET_YAML.replace('id: mini\n', `id: ${id}\n`)
      .replaceAll('mini-token', cg)
      .replace('rpc_url_env: TEST_RPC_URL', `rpc_url_env: ${rpcEnv}`)
      .replace('holder_flows:', `${extra}holder_flows:`),
  );
}

const PEER = `  peer_price_usd:
    type: level
    unit: usd
    staleness_days: 3
    source: { type: coingecko, id: peer-token, field: price }
`;
const DISPLAY = `  display_price:
    type: level
    unit: usd
    staleness_days: 3
    monitor_only: true
    source: { type: http_json, url: "https://api.example.test/display", path: price }
`;

const MARKETS = [
  { id: 'mini-token', current_price: 10, market_cap: 600, circulating_supply: 60 },
  { id: 'b-token', current_price: 2, market_cap: 20, circulating_supply: 10 },
  { id: 'c-token', current_price: 3, market_cap: 30, circulating_supply: 10 },
  { id: 'peer-token', current_price: 4, market_cap: 40, circulating_supply: 10 },
];

const count = async (db: Db, table: string) => Number((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))!.n);

function world(routes: Record<string, unknown> = {}) {
  const h = harness(testDb(), { routes: { [CG_MARKETS]: MARKETS, ...routes } });
  return h;
}

describe('levelMetricKeys', () => {
  it('lists sourced level and schedule metrics, not derived or constant ones, and monitor-only ones only when watched', () => {
    expect(levelMetricKeys(variant('a', 'mini-token').config)).toEqual(['circulating_supply', 'emission_rate_annual', 'price_usd', 'staked_supply', 'total_supply']);
    expect(levelMetricKeys(variant('d', 'mini-token', DISPLAY).config)).not.toContain('display_price');
    expect(levelMetricKeys(watchAsset().config)).toEqual(['circulating_supply', 'emission_rate_annual', 'price_usd', 'staked_supply', 'stats_apr', 'stats_price', 'total_supply']);
    const constant = parseAssetYaml(
      INGEST_ASSET_YAML.replace('holder_flows:', '  fixed_supply:\n    type: level\n    unit: tokens\n    staleness_days: 7\n    source: { type: constant, value: 5, note: fixed }\nholder_flows:'),
    ).config;
    expect(levelMetricKeys(constant)).not.toContain('fixed_supply');
  });
});

describe('batched CoinGecko', () => {
  it('prefetchMarkets makes one /coins/markets call per 250 ids, sorted', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/api/v3/coins/markets': (url: string) => new URL(url).searchParams.get('ids')!.split(',').map((id) => ({ id })) });
    const ids = Array.from({ length: 260 }, (_, i) => `id-${String(i).padStart(3, '0')}`).reverse();
    const rows = await prefetchMarkets(http, { COINGECKO_API_KEY: 'k' }, [...ids, 'id-001']);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].url).toBe(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${[...ids].sort().slice(0, 250).join(',')}`);
    expect(http.calls[0].headers).toEqual({ 'x-cg-demo-api-key': 'k' });
    expect(rows.size).toBe(260);
    expect(await prefetchMarkets(http, {}, [])).toEqual(new Map());
    expect(http.calls).toHaveLength(2);
  });

  it('withPrefetchedMarkets answers markets reads from the rows, in the requested order, and passes the rest through', async () => {
    const inner = fakeHttp({ 'https://other.test/': { ok: 1 } });
    const rows = new Map(MARKETS.map((m) => [m.id, m]));
    const http = withPrefetchedMarkets(inner, rows);
    expect(await http.getJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=peer-token,b-token,nope')).toEqual([MARKETS[3], MARKETS[1]]);
    expect(await http.getJson('https://other.test/x')).toEqual({ ok: 1 });
    expect(inner.calls.map((c) => c.url)).toEqual(['https://other.test/x']);
  });

  it('levels: one batched coins/markets call for all assets', async () => {
    const h = world();
    const assets = [h.loaded, variant('b', 'b-token'), variant('c', 'c-token', PEER)];
    const out = await runLevels(h.db, assets, h.deps, NOW, 7);
    const markets = h.http.calls.filter((c) => c.url.includes('/coins/markets'));
    expect(markets.map((c) => c.url)).toEqual([`${CG_MARKETS}?vs_currency=usd&ids=b-token,c-token,mini-token,peer-token`]);
    const price = (a: string, m = 'price_usd') => out.rows.find((r) => r.assetId === a && r.metricKey === m)?.value;
    expect([price('mini'), price('b'), price('c'), price('c', 'peer_price_usd')]).toEqual([10, 2, 3, 4]);
  });
});

describe('runLevels', () => {
  it('levels: a failed batched markets call fails each CoinGecko read with its error, and the rest is read', async () => {
    const h = world({ [CG_MARKETS]: new Error('HTTP 429') });
    const out = await runLevels(h.db, [h.loaded, variant('b', 'b-token')], h.deps, NOW, 1);
    expect(h.http.calls.filter((c) => c.url.includes('/coins/markets'))).toHaveLength(1);
    for (const p of out.perAsset) {
      expect(p.ok).toEqual(['emission_rate_annual', 'staked_supply', 'total_supply']);
      expect(p.failed).toEqual([{ sourceId: 'coingecko', error: expect.stringMatching(/HTTP 429/) as string }]);
    }
  });

  it('levels: writes latest_levels and nothing else', async () => {
    const h = world();
    const before = { o: await count(h.db, 'observations'), f: await count(h.db, 'fetch_runs'), a: await count(h.db, 'anomalies') };
    const out = await runLevels(h.db, [h.loaded], h.deps, NOW, 7);
    expect(out.perAsset).toEqual([{ assetId: 'mini', ok: ['circulating_supply', 'emission_rate_annual', 'price_usd', 'staked_supply', 'total_supply'], failed: [], firings: [] }]);
    expect({ o: await count(h.db, 'observations'), f: await count(h.db, 'fetch_runs'), a: await count(h.db, 'anomalies') }).toEqual(before);
    const stored = await listLatestLevels(h.db, 'mini');
    expect(stored).toEqual(out.rows);
    const latest = await h.rpc.latestBlock();
    expect(stored.find((r) => r.metricKey === 'total_supply')).toEqual({
      assetId: 'mini', metricKey: 'total_supply', value: 100, observedAt: new Date(latest.timestamp * 1000).toISOString(), source: 'onchain',
      blockNumber: Number(latest.number), jobId: 7,
    });
    expect(stored.find((r) => r.metricKey === 'price_usd')).toMatchObject({ value: 10, source: 'api', blockNumber: null, jobId: 7 });
  });

  it('levels: a re-run overwrites the row (one row per asset and metric)', async () => {
    const h = world();
    await runLevels(h.db, [h.loaded], h.deps, NOW, 1);
    const later = new Date(NOW.getTime() + 3_600_000);
    const h2 = harness(h.db, { routes: { [CG_MARKETS]: [{ ...MARKETS[0], current_price: 11 }] }, now: later });
    await runLevels(h.db, [h2.loaded], h2.deps, later, 2);
    const rows = await listLatestLevels(h.db, 'mini');
    expect(rows.filter((r) => r.metricKey === 'price_usd')).toEqual([
      { assetId: 'mini', metricKey: 'price_usd', value: 11, observedAt: later.toISOString(), source: 'api', blockNumber: null, jobId: 2 },
    ]);
    expect(await count(h.db, 'latest_levels')).toBe(5);
  });

  it('levels: a monitor-only level without a watch is not read', async () => {
    const h = world({ 'https://api.example.test/display': { price: 1 } });
    const out = await runLevels(h.db, [variant('d', 'mini-token', DISPLAY)], h.deps, NOW, 1);
    expect(h.http.calls.some((c) => c.url.includes('/display'))).toBe(false);
    expect(out.rows.some((r) => r.metricKey === 'display_price')).toBe(false);
  });

  it('levels: a schedule metric stores the newest step at or before now', async () => {
    const h = world();
    const out = await runLevels(h.db, [h.loaded], h.deps, NOW, 1);
    const row = out.rows.find((r) => r.metricKey === 'emission_rate_annual')!;
    expect(row.value).toBe(0);
    expect(Date.parse(row.observedAt)).toBeLessThanOrEqual(NOW.getTime());
  });

  it("levels: one asset's RPC failure leaves the other assets' rows written", async () => {
    const h = world();
    const broken: RpcTransport = {
      latestBlock: async () => {
        throw new Error('rpc down');
      },
      getBlock: async () => {
        throw new Error('rpc down');
      },
      multicall: async () => {
        throw new Error('rpc down');
      },
      getTransferLogs: async () => [],
    };
    const deps: FetchDeps = {
      ...h.deps,
      env: { ...h.deps.env, BROKEN_RPC_URL: 'http://broken.test' },
      rpcFactory: (url, chainId) => (url === 'http://broken.test' ? broken : h.deps.rpcFactory(url, chainId)),
    };
    // One asset whose fetch throws outright: chain 1 has no default RPC URL and its variable is unset.
    const unreachable = parseAssetYaml(INGEST_ASSET_YAML.replace('id: mini\n', 'id: eth\n').replace('chain_id: 8453, rpc_url_env: TEST_RPC_URL', 'chain_id: 1, rpc_url_env: UNSET_RPC_URL'));
    const out = await runLevels(h.db, [variant('b', 'b-token', '', 'BROKEN_RPC_URL'), unreachable, h.loaded], deps, NOW, 1);
    const b = out.perAsset.find((p) => p.assetId === 'b')!;
    expect(b.ok).toEqual(['circulating_supply', 'price_usd']);
    expect(b.failed.map((f) => f.sourceId)).toEqual(['chain_levels']);
    expect(b.failed[0].error).toMatch(/rpc down/);
    expect(out.perAsset.find((p) => p.assetId === 'eth')).toMatchObject({ ok: [], failed: [{ sourceId: '*', error: expect.stringMatching(/UNSET_RPC_URL/) as string }] });
    expect((await listLatestLevels(h.db, 'mini')).map((r) => r.metricKey)).toEqual(['circulating_supply', 'emission_rate_annual', 'price_usd', 'staked_supply', 'total_supply']);
    expect((await listLatestLevels(h.db, 'b')).map((r) => r.metricKey)).toEqual(['circulating_supply', 'price_usd']);
    expect(await listLatestLevels(h.db, 'eth')).toEqual([]);
  });

  it('levels: change_pct firings compare with the newest stored nightly row', async () => {
    const h = harness(testDb(), { loaded: watchAsset({ changePct: 5 }), routes: { 'https://api.example.test/stats': { price: '12', apr: 0.06, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    await insertObservation(h.db, { assetId: 'mini', metricKey: 'stats_price', observedAt: '2026-09-19T00:45:00.000Z', value: 10, source: 'api', sourceDetail: null, fetchedAt: '2026-09-19T00:45:00.000Z' });
    const out = await runLevels(h.db, [h.loaded], h.deps, NOW, 1);
    expect(out.perAsset[0].firings).toEqual([{ metric: 'stats_price', rule: 'change_pct', value: 12, previous: 10, day: '2026-09-19' }]);
  });
});

describe('toLatestLevels', () => {
  it('a schedule keeps its newest step at or before now; a level its reading; flows are not levels', () => {
    const asset = harness(testDb()).loaded.config;
    const step = (observedAt: string, value: number) => ({ metricKey: 'emission_rate_annual', value, observedAt, periodDays: null, source: 'onchain' as const, observationId: null });
    const rows = toLatestLevels(asset, [
      step('2026-01-01T00:00:00.000Z', 3), step('2026-09-01T00:00:00.000Z', 2), step('2027-01-01T00:00:00.000Z', 1),
      { metricKey: 'price_usd', value: 10, observedAt: '2026-09-19T12:00:01.000Z', periodDays: null, source: 'api' as const, observationId: null },
      { metricKey: 'flow_usd.fees', value: 5, observedAt: '2026-09-19T00:00:00.000Z', periodDays: 1, source: 'onchain' as const, observationId: null },
    ], NOW, 3, { number: 77n, timestamp: 0 });
    expect(rows).toEqual([
      { assetId: 'mini', metricKey: 'emission_rate_annual', value: 2, observedAt: '2026-09-01T00:00:00.000Z', source: 'onchain', blockNumber: 77, jobId: 3 },
      { assetId: 'mini', metricKey: 'price_usd', value: 10, observedAt: '2026-09-19T12:00:01.000Z', source: 'api', blockNumber: null, jobId: 3 },
    ]);
  });
});

describe('latest_levels store', () => {
  it('deleteLatestLevels removes the rows the predicate does not keep', async () => {
    const row = { assetId: 'a', metricKey: 'm', value: 1, observedAt: NOW.toISOString(), source: 'api', blockNumber: null, jobId: null };
    await upsertLatestLevels(testDb(), [row, { ...row, metricKey: 'n' }, { ...row, assetId: 'b' }]);
    expect(await deleteLatestLevels(testDb(), (r) => r.assetId === 'a')).toBe(1);
    expect((await listLatestLevels(testDb())).map((r) => `${r.assetId}.${r.metricKey}`)).toEqual(['a.m', 'a.n']);
  });
});
