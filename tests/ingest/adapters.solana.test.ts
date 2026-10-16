import { describe, expect, it } from 'vitest';
import { burnsByDay, solanaAdapters } from '../../src/ingest/adapters/solana.js';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { scrubUrl, solanaRpcUrl, tokenSupply, ownerBalance, PUBLIC_SOL_RPC_URL } from '../../src/ingest/transport/solana.js';
import type { Observation } from '../../src/db/observations.js';
import { loadAsset } from '../../src/config/load.js';
import { fileURLToPath } from 'node:url';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

// Shapes read live on 2026-10-16 from Alchemy's Solana RPC (getTokenSupply, getTokenAccountsByOwner jsonParsed), CoinGecko's
// market_chart and DefiLlama's summary/fees totalDataChart.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
const KEYED = 'https://solana-mainnet.g.alchemy.com/v2/sol_SECRETKEY';
const NOW = '2026-10-16T06:00:00.000Z';
const DAY = 86_400_000;
const T = (iso: string) => Date.parse(iso);
const pump = loadAsset(ROOT, 'pump').config;

const supplyReply = (raw: string, slot = 457_761_523) => ({ jsonrpc: '2.0', id: 1, result: { context: { slot }, value: { amount: raw, decimals: 6, uiAmount: Number(raw) / 1e6 } } });
/** Raw amount, 6 decimals, from whole tokens. */
const raw = (tokens: number) => BigInt(Math.round(tokens * 1e6)).toString();

describe('Solana transport', () => {
  it('reads getTokenSupply as whole tokens, exactly (BigInt), at finalized commitment', async () => {
    const http = fakeHttp({ [KEYED]: (_u: string, body?: unknown) => {
      expect(body).toMatchObject({ method: 'getTokenSupply', params: [MINT, { commitment: 'finalized' }] });
      return supplyReply('827638439354214174');
    } });
    const s = await tokenSupply(http, KEYED, MINT);
    expect(s.amount).toBeCloseTo(827_638_439_354.214174, 5);
    expect(s.slot).toBe(457_761_523);
  });

  it('sums an owner balance over all its token accounts', async () => {
    const acct = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } } });
    const http = fakeHttp({ [KEYED]: { jsonrpc: '2.0', id: 1, result: { context: { slot: 9 }, value: [acct('3212614552'), acct('1000000')] } } });
    expect((await ownerBalance(http, KEYED, 'owner', MINT)).amount).toBeCloseTo(3213.614552, 6);
  });

  it('never puts the keyed URL in an error: RPC errors and transport errors name only the origin', async () => {
    const rpcErr = fakeHttp({ [KEYED]: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } } });
    await expect(tokenSupply(rpcErr, KEYED, MINT)).rejects.toThrow('solana getTokenSupply at https://solana-mainnet.g.alchemy.com: RPC error -32602 Invalid param');
    const down = fakeHttp({ [KEYED]: new Error(`${KEYED}: HTTP 503`) });
    const e = await tokenSupply(down, KEYED, MINT).catch((x: Error) => x.message);
    expect(e).not.toContain('SECRETKEY');
    expect(e).toContain('https://solana-mainnet.g.alchemy.com: HTTP 503');
    expect(scrubUrl(KEYED)).toBe('https://solana-mainnet.g.alchemy.com');
  });

  it('uses ORION_SOL_RPC_URL when set, else the public endpoint', () => {
    expect(solanaRpcUrl({ ORION_SOL_RPC_URL: KEYED })).toBe(KEYED);
    expect(solanaRpcUrl({})).toBe(PUBLIC_SOL_RPC_URL);
    expect(solanaRpcUrl({ ORION_SOL_RPC_URL: ' ' })).toBe(PUBLIC_SOL_RPC_URL);
  });
});

describe('burnsByDay: the daily burn from successive supply readings', () => {
  it('spreads each drop over the time between readings and keeps only whole days', () => {
    const days = burnsByDay([
      { ms: T('2026-10-13T06:00:00Z'), supply: 1000 },
      { ms: T('2026-10-14T06:00:00Z'), supply: 976 }, // 24 over 24h: 1 an hour
      { ms: T('2026-10-15T18:00:00Z'), supply: 940 }, // 36 over 36h: 1 an hour
      { ms: T('2026-10-16T06:00:00Z'), supply: 916 }, // 24 over 12h: 2 an hour
    ]);
    // 10-13 starts before the first reading and 10-16 ends after the last: both partial, dropped.
    expect([...days]).toEqual([
      ['2026-10-14', 24],
      ['2026-10-15', 18 + 6 * 2], // 18h at 1 an hour, 6h at 2 an hour
    ]);
  });

  it('refuses a rise in supply: the config must name a burn-only mint', () => {
    expect(() => burnsByDay([{ ms: 0, supply: 10 }, { ms: DAY, supply: 11 }])).toThrow(/supply rose by 1\.000000/);
  });

  it('gives nothing from fewer than two readings', () => {
    expect(burnsByDay([{ ms: 0, supply: 10 }]).size).toBe(0);
  });
});

/** Stored total_supply readings, as the solana.token_supply adapter writes them. */
function stored(rows: [string, number][]): Observation[] {
  return rows.map(([observedAt, value], i) => ({
    id: i + 1, assetId: 'pump', metricKey: 'total_supply', observedAt, periodDays: null, value, source: 'onchain',
    sourceDetail: `solana getTokenSupply ${MINT} slot ${i}`, status: 'confirmed', citationUrl: null, quotedText: null, fetchedAt: observedAt, supersededBy: null,
  }));
}

/** CoinGecko hourly prices: `p(day)` every hour from 30 days back. */
function chart(p: (day: string) => number) {
  const prices: [number, number][] = [];
  for (let t = T(NOW) - 30 * DAY; t <= T(NOW); t += 3_600_000) prices.push([t, p(new Date(t).toISOString().slice(0, 10))]);
  return { prices, market_caps: [], total_volumes: [] };
}

/** DefiLlama dailyHoldersRevenue: `usd` every day from 400 days back (timestamps at 00:00 UTC, seconds). */
function llama(usd: number) {
  const totalDataChart: [number, number][] = [];
  for (let t = Math.floor(T(NOW) / DAY) * DAY - 400 * DAY; t < T(NOW); t += DAY) totalDataChart.push([t / 1000, usd]);
  return { totalDataChart };
}

const routes = (supplyNow: number, price = (_d: string) => 0.005, history = 1_000_000) => ({
  [KEYED]: supplyReply(raw(supplyNow)),
  'https://api.coingecko.com/api/v3/coins/pump-fun/market_chart': chart(price),
  'https://api.llama.fi/summary/fees/pump?dataType=dailyHoldersRevenue': llama(history),
});

const params = (unit: 'usd' | 'tokens') => ({ mint: 'token', unit, supply_metric: 'total_supply', days: 7, history: { slug: 'pump', data_type: 'dailyHoldersRevenue' } });

function burnRun(unit: 'usd' | 'tokens', obs: Observation[], supplyNow: number, extra: { backfillDays?: number; price?: (d: string) => number } = {}) {
  const http = fakeHttp(routes(supplyNow, extra.price));
  const ctx = sourceCtx({
    asset: pump, nowIso: NOW, http, env: { ORION_SOL_RPC_URL: KEYED },
    observations: (m) => (m === 'total_supply' ? obs : []),
    ...(extra.backfillDays !== undefined ? { backfillDays: extra.backfillDays } : {}),
  });
  return { http, result: getAdapter('solana.supply_burn_daily').run(ctx, params(unit)) };
}

describe('solana.supply_burn_daily', () => {
  it('is registered, with the other Solana readers, and needs no EVM chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['solana.token_supply', 'solana.owner_balance', 'solana.supply_burn_daily']));
    for (const a of solanaAdapters) expect(a.needsRpc).toBe(false);
  });

  it('prices each on-chain day at its mean CoinGecko price and fills the days before the first reading from DefiLlama', async () => {
    // Daily readings at 06:00 from 10-12: 1B PUMP burned a day. 10-12 starts before the first reading, so it is DefiLlama's.
    const obs = stored([['2026-10-12T06:00:00.000Z', 900e9], ['2026-10-13T06:00:00.000Z', 899e9], ['2026-10-14T06:00:00.000Z', 898e9], ['2026-10-15T06:00:00.000Z', 897e9]]);
    const { result } = burnRun('usd', obs, 896e9, { price: (d) => (d === '2026-10-14' ? 0.006 : 0.005) });
    const v = await result;
    expect(v.kind).toBe('daily_series');
    if (v.kind !== 'daily_series') return;
    expect(v.points.map((p) => [p.day, Math.round(p.value)])).toEqual([
      ['2026-10-09', 1_000_000], ['2026-10-10', 1_000_000], ['2026-10-11', 1_000_000], ['2026-10-12', 1_000_000], // DefiLlama
      ['2026-10-13', 5_000_000], ['2026-10-14', 6_000_000], ['2026-10-15', 5_000_000], // 1B PUMP x the day's price
    ]);
    expect(v.detail).toContain('3 days from 5 getTokenSupply readings; 4 days from DefiLlama pump dailyHoldersRevenue');
    expect(v.detail).not.toContain('SECRETKEY');
  });

  it('converts the DefiLlama days to tokens at the day price (unit: tokens)', async () => {
    const { result } = burnRun('tokens', stored([['2026-10-15T06:00:00.000Z', 897e9]]), 896e9);
    const v = await result;
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    // One reading yesterday: no whole on-chain day yet, so all 7 days are history, 1M USD / 0.005.
    expect(v.points).toHaveLength(7);
    expect(v.points.every((p) => Math.round(p.value) === 200_000_000)).toBe(true);
  });

  it('reads the year of history on a backfill, and stops calling DefiLlama once the chain covers the window', async () => {
    const back = burnRun('usd', stored([['2026-10-15T06:00:00.000Z', 897e9]]), 896e9, { backfillDays: 362 });
    const v = await back.result;
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    expect(v.points).toHaveLength(362);

    const rows: [string, number][] = [];
    for (let d = 10; d >= 1; d--) rows.push([new Date(T(NOW) - d * DAY).toISOString(), 900e9 - (10 - d) * 1e9]);
    const routine = burnRun('usd', stored(rows), 891e9);
    const r = await routine.result;
    if (r.kind !== 'daily_series') throw new Error(r.kind);
    expect(r.points).toHaveLength(7);
    expect(routine.http.calls.some((c) => c.url.includes('llama.fi'))).toBe(false);
  });

  it('ignores stored readings of another mint, and fails when on-chain days exist but none can be priced', async () => {
    const obs = stored([['2026-10-12T06:00:00.000Z', 900e9]]);
    await expect(burnRun('usd', obs, 896e9).result).resolves.toMatchObject({ kind: 'daily_series' });
    // A broken price chart fails the read rather than storing unpriced days.
    await expect(burnRun('usd', obs, 896e9, { price: () => Number.NaN }).result).rejects.toThrow(/coingecko pump-fun: malformed/);
    const foreign = stored([['2026-10-12T06:00:00.000Z', 900e9]]).map((o) => ({ ...o, sourceDetail: 'solana getTokenSupply OTHERMINT slot 1' }));
    const v = await burnRun('usd', foreign, 896e9).result;
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    expect(v.detail).toContain('0 days from 1 getTokenSupply readings');
  });

  it('refuses a supply that rose (a mint that can still mint)', async () => {
    await expect(burnRun('usd', stored([['2026-10-14T06:00:00.000Z', 800e9]]), 896e9).result).rejects.toThrow(/supply rose/);
  });
});

describe('solana.token_supply and solana.owner_balance', () => {
  it('stamp the reading at the fetch time and name the mint and slot', async () => {
    const http = fakeHttp({ [KEYED]: (_u: string, body?: unknown) => {
      const m = (body as { method: string }).method;
      if (m === 'getTokenSupply') return supplyReply('827638439354214174', 77);
      return { jsonrpc: '2.0', id: 1, result: { context: { slot: 78 }, value: [] } };
    } });
    const ctx = sourceCtx({ asset: pump, nowIso: NOW, http, env: { ORION_SOL_RPC_URL: KEYED } });
    const s = await getAdapter('solana.token_supply').run(ctx, { mint: 'token' });
    expect(s).toMatchObject({ kind: 'level', observedAt: NOW, source: 'onchain', detail: `solana getTokenSupply ${MINT} slot 77` });
    const b = await getAdapter('solana.owner_balance').run(ctx, { mint: 'token', owner: 'burn_wallet_a' });
    expect(b).toMatchObject({ kind: 'level', value: 0, source: 'onchain' });
    await expect(getAdapter('solana.owner_balance').run(ctx, { mint: 'token' })).rejects.toThrow(/params.owner/);
  });
});
