import { describe, expect, it } from 'vitest';
import { getAdapter, registerAdapter } from '../../src/ingest/adapters/registry.js';
import { sourceId } from '../../src/ingest/sourceId.js';
import { readPath } from '../../src/ingest/sources/httpJson.js';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import type { ReadingResult } from '../../src/ingest/types.js';
import type { OrionError } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { fixture, NOW_ISO, req, sourceCtx } from '../helpers/sourceCtx.js';

const VENICE = 'https://outerface.venice.ai/api/app/vvv';
const levelOf = (r: ReadingResult): number => {
  if (!r.ok || r.value.kind !== 'level') throw new Error(`expected a level reading, got ${JSON.stringify(r)}`);
  return r.value.value;
};

describe('sourceId', () => {
  it('gives one stable id per source', () => {
    expect(sourceId({ type: 'coingecko', id: 'a', field: 'price' })).toBe('coingecko');
    expect(sourceId({ type: 'http_json', url: `${VENICE}/vvv_stats`, path: 'price', scale: 1, decimals: 0 })).toBe(`http_json:${VENICE}/vvv_stats`);
    expect(sourceId({ type: 'defillama', slug: 'venice', data_type: 'dailyHoldersRevenue', compare: 'monthly_sum' })).toBe('defillama:venice:dailyHoldersRevenue');
    expect(sourceId({ type: 'erc20_supply', token: 'token', subtract_balances: [] })).toBe('chain_levels');
    expect(sourceId({ type: 'contract_read', contract: 'staking', function: 'f', abi_type: 'uint256', decimals: 0, scale: 1, offset: 0 })).toBe('chain_levels');
    expect(sourceId({ type: 'transfer_flow', token: 'token', to: 'burn_sink', from_allowlist: ['safe', 'pool'], unit: 'tokens' })).toBe('transfer_flow:token>burn_sink[pool,safe]');
    expect(sourceId({ type: 'adapter', name: 'vvv.x', params: {} })).toBe('adapter:vvv.x');
    expect(sourceId({ type: 'derived', name: 'burn_momentum', params: {} })).toBe('derived:burn_momentum');
  });
});

describe('coingecko source', () => {
  const handler = getSourceHandler('coingecko');
  const requests = [
    req('price_usd', { type: 'coingecko', id: 'venice-token', field: 'price' }),
    req('diem_price_usd', { type: 'coingecko', id: 'diem', field: 'price' }),
    req('circulating_supply', { type: 'coingecko', id: 'venice-token', field: 'circulating_supply' }),
    req('missing', { type: 'coingecko', id: 'not-a-coin', field: 'market_cap' }),
  ];

  it('serves every request from one /coins/markets call, stamped at fetch time', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/api/v3/coins/markets': fixture('cg_markets.json') });
    const out = await handler.fetch(requests, sourceCtx({ http }));
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=diem,not-a-coin,venice-token');
    expect(http.calls[0].headers).toEqual({});
    expect(levelOf(out[0])).toBe(26.03);
    expect(levelOf(out[1])).toBe(1941.6);
    expect(levelOf(out[2])).toBeCloseTo(48058904.92603289, 6);
    expect(out[0]).toMatchObject({ ok: true, value: { observedAt: NOW_ISO, source: 'api' } });
    expect(out[3]).toEqual({ ok: false, error: 'coingecko: no market row for id "not-a-coin"' });
  });

  it('sends the demo key header when COINGECKO_API_KEY is set', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/': fixture('cg_markets.json') });
    await handler.fetch(requests.slice(0, 1), sourceCtx({ http, env: { COINGECKO_API_KEY: 'secret' } }));
    expect(http.calls[0].headers).toEqual({ 'x-cg-demo-api-key': 'secret' });
  });

  it('throws for the whole batch when the response is not an array', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/': { status: { error_code: 429 } } });
    await expect(handler.fetch(requests, sourceCtx({ http }))).rejects.toThrow(/did not return an array/);
  });

  it('fails one reading when its field is not a finite number', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/': [{ id: 'venice-token', current_price: null, circulating_supply: 5 }] });
    const out = await handler.fetch([requests[0], requests[2]], sourceCtx({ http }));
    expect(out[0]).toEqual({ ok: false, error: 'coingecko: venice-token.current_price is not a finite number' });
    expect(levelOf(out[1])).toBe(5);
  });
});

describe('http_json source', () => {
  const handler = getSourceHandler('http_json');
  const stats = `${VENICE}/vvv_stats`;
  const http = () =>
    fakeHttp({ [stats]: fixture('venice_vvv_stats.json'), [`${VENICE}/diem_stats`]: fixture('venice_diem_stats.json'), [`${VENICE}/vvv_staking_yield`]: fixture('venice_vvv_staking_yield.json') });

  it('reads numeric strings, applies decimals and scale, and fetches each URL once', async () => {
    const h = http();
    const out = await handler.fetch(
      [
        req('price_usd', { type: 'http_json', url: stats, path: 'price', scale: 1, decimals: 0 }, 'cross_check'),
        req('circulating_supply', { type: 'http_json', url: stats, path: 'circulatingSupplyCryptoBaseUnit', scale: 1, decimals: 18 }, 'cross_check'),
        req('diem_target_supply', { type: 'http_json', url: `${VENICE}/diem_stats`, path: 'targetSupplyCryptoBaseUnit', scale: 1, decimals: 18 }, 'cross_check'),
        req('emission_rate_annual', { type: 'http_json', url: `${VENICE}/vvv_staking_yield`, path: 'totalEmissionsCryptoBaseUnit', scale: 365, decimals: 18 }, 'cross_check'),
      ],
      sourceCtx({ http: h }),
    );
    expect(levelOf(out[0])).toBeCloseTo(26.7, 12);
    expect(levelOf(out[1])).toBeCloseTo(48356944.49576091, 4);
    expect(levelOf(out[2])).toBeCloseTo(39500, 6); // "3.95e+22"
    expect(levelOf(out[3])).toBeCloseTo(2497395.8333333335, 3);
    expect(h.calls.map((c) => c.url)).toEqual([stats, `${VENICE}/diem_stats`, `${VENICE}/vvv_staking_yield`]);
    expect(out[0]).toMatchObject({ ok: true, value: { observedAt: NOW_ISO, source: 'api' } });
  });

  it('fails only the reading whose path is missing or not numeric', async () => {
    const out = await handler.fetch(
      [
        req('a', { type: 'http_json', url: stats, path: 'nope.deeper', scale: 1, decimals: 0 }),
        req('b', { type: 'http_json', url: stats, path: 'price', scale: 1, decimals: 0 }),
      ],
      sourceCtx({ http: http() }),
    );
    expect(out[0]).toEqual({ ok: false, error: `http_json: "nope.deeper" is not a finite number in ${stats}` });
    expect(levelOf(out[1])).toBeCloseTo(26.7, 12);
  });

  it('fails the readings of a URL that cannot be fetched, and only those', async () => {
    const h = fakeHttp({ [stats]: new Error('HTTP 503'), [`${VENICE}/diem_stats`]: fixture('venice_diem_stats.json') });
    const out = await handler.fetch(
      [
        req('a', { type: 'http_json', url: stats, path: 'price', scale: 1, decimals: 0 }),
        req('b', { type: 'http_json', url: `${VENICE}/diem_stats`, path: 'totalSupplyCryptoBaseUnit', scale: 1, decimals: 18 }),
      ],
      sourceCtx({ http: h }),
    );
    expect(out[0]).toEqual({ ok: false, error: 'HTTP 503' });
    expect(levelOf(out[1])).toBeCloseTo(37713.45712758114, 6);
  });

  it('walks dot paths through objects and arrays', () => {
    const body = { a: { b: [{ c: 7 }, { c: 8 }] } };
    expect(readPath(body, 'a.b.1.c')).toBe(8);
    expect(readPath(body, 'a.x.c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('defillama source', () => {
  const handler = getSourceHandler('defillama');
  const source = { type: 'defillama', slug: 'venice', data_type: 'dailyHoldersRevenue', compare: 'monthly_sum' } as const;

  it('returns the daily USD series, one point per UTC day', async () => {
    const http = fakeHttp({ 'https://api.llama.fi/summary/fees/venice?dataType=dailyHoldersRevenue': fixture('llama_venice.json') });
    const [out] = await handler.fetch([req('flow_usd.burn', source, 'cross_check', 5)], sourceCtx({ http }));
    if (!out.ok || out.value.kind !== 'daily_series') throw new Error('expected a daily series');
    expect(out.value.points).toHaveLength(286);
    expect(out.value.points[0]).toEqual({ day: '2025-12-08', value: 64402 });
    expect(out.value.points.at(-1)).toEqual({ day: '2026-09-19', value: 14949 });
    const august = out.value.points.filter((p) => p.day.startsWith('2026-08'));
    expect(august).toHaveLength(31);
    expect(august.reduce((s, p) => s + p.value, 0)).toBe(697337);
  });

  it('throws when totalDataChart is missing or malformed', async () => {
    await expect(handler.fetch([req('m', source)], sourceCtx({ http: fakeHttp({ 'https://api.llama.fi/': {} }) }))).rejects.toThrow(/totalDataChart/);
    const bad = fakeHttp({ 'https://api.llama.fi/': { totalDataChart: [[1765152000, 'x']] } });
    await expect(handler.fetch([req('m', source)], sourceCtx({ http: bad }))).rejects.toThrow(/totalDataChart/);
  });
});

describe('adapter source and registry', () => {
  it('runs a registered adapter and isolates one that throws', async () => {
    registerAdapter({ name: 'test.ok', needsRpc: false, run: async (ctx, params) => ({ kind: 'level', value: Number(params.n), observedAt: ctx.nowIso, source: 'api', detail: 'test' }) });
    registerAdapter({ name: 'test.boom', needsRpc: false, run: async () => { throw new Error('boom'); } });
    const handler = getSourceHandler('adapter');
    const out = await handler.fetch(
      [req('a', { type: 'adapter', name: 'test.ok', params: { n: 4 } }), req('b', { type: 'adapter', name: 'test.boom', params: {} })],
      sourceCtx(),
    );
    expect(levelOf(out[0])).toBe(4);
    expect(out[1]).toEqual({ ok: false, error: 'adapter test.boom: boom' });
  });

  it('rejects an unknown adapter name and an unbatchable source type', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as OrionError).code;
      }
      return undefined;
    };
    expect(codeOf(() => getAdapter('nope'))).toBe('unknown_adapter');
    expect(codeOf(() => getSourceHandler('transfer_flow'))).toBe('unknown_source_type');
    expect(codeOf(() => getSourceHandler('derived'))).toBe('unknown_source_type');
  });
});
