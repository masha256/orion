import { describe, expect, it } from 'vitest';
import { burnsByDay, solanaAdapters } from '../../src/ingest/adapters/solana.js';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { scrubUrl, solanaRpcUrl, tokenSupply, ownerBalance, PUBLIC_SOL_RPC_URL } from '../../src/ingest/transport/solana.js';
import type { Observation } from '../../src/db/observations.js';
import { loadAsset } from '../../src/config/load.js';
import { fileURLToPath } from 'node:url';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { sourceCtx } from '../helpers/sourceCtx.js';
import { ADAPTER_SOURCE_TYPES } from '../../src/report/sourceTypes.js';
import { ADAPTER_ORIGINS } from '../../src/provenance/origin.js';

// Shapes read live on 2026-10-16 from Alchemy's Solana RPC (getTokenSupply, getTokenAccountsByOwner jsonParsed) and
// DefiLlama's summary/fees totalDataChart. The burns are priced from the stored chain prices (Phase 3 R2 Task 6a).
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

const PUMP_REF = `solana:mainnet/${MINT}`;
const HOUR = 3_600_000;
/** The stored chain prices of PUMP: `p(hourMs)` at every hour from 400 days back (null: no row that hour). */
function chainHours(p: (hourMs: number) => number | null) {
  const asked: [string, number, number][] = [];
  const read = async (ref: string, fromMs: number, toMs: number) => {
    asked.push([ref, fromMs, toMs]);
    const out = new Map<number, number>();
    for (let h = Math.max(fromMs, T(NOW) - 400 * DAY); h < toMs; h += HOUR) {
      const v = ref === PUMP_REF ? p(h) : null;
      if (v !== null) out.set(h, v);
    }
    return out;
  };
  return { asked, read };
}
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** DefiLlama dailyHoldersRevenue: `usd` every day from 400 days back (timestamps at 00:00 UTC, seconds). */
function llama(usd: number) {
  const totalDataChart: [number, number][] = [];
  for (let t = Math.floor(T(NOW) / DAY) * DAY - 400 * DAY; t < T(NOW); t += DAY) totalDataChart.push([t / 1000, usd]);
  return { totalDataChart };
}

const routes = (supplyNow: number, history = 1_000_000) => ({
  [KEYED]: supplyReply(raw(supplyNow)),
  'https://api.llama.fi/summary/fees/pump?dataType=dailyHoldersRevenue': llama(history),
});

const params = (unit: 'usd' | 'tokens') => ({ mint: 'token', unit, supply_metric: 'total_supply', days: 7, history: { slug: 'pump', data_type: 'dailyHoldersRevenue' } });

function burnRun(unit: 'usd' | 'tokens', obs: Observation[], supplyNow: number, extra: { backfillDays?: number; price?: (hourMs: number) => number | null } = {}) {
  const http = fakeHttp(routes(supplyNow));
  const prices = chainHours(extra.price ?? (() => 0.005));
  const ctx = sourceCtx({
    asset: pump, nowIso: NOW, http, env: { ORION_SOL_RPC_URL: KEYED },
    observations: async (m) => (m === 'total_supply' ? obs : []),
    chainHourPrices: prices.read,
    ...(extra.backfillDays !== undefined ? { backfillDays: extra.backfillDays } : {}),
  });
  return { http, prices, result: getAdapter('solana.supply_burn_daily').run(ctx, params(unit)) };
}

describe('solana.supply_burn_daily', () => {
  it('is registered, with the other Solana readers, and needs no EVM chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['solana.token_supply', 'solana.owner_balance', 'solana.supply_burn_daily']));
    for (const a of solanaAdapters) expect(a.needsRpc).toBe(false);
  });

  it('prices each on-chain day at the mean of its 24 chain prices, no CoinGecko request; the days before the first reading from DefiLlama', async () => {
    // Daily readings at 06:00 from 10-12: 1B PUMP burned a day. 10-12 starts before the first reading, so it is DefiLlama's.
    const obs = stored([['2026-10-12T06:00:00.000Z', 900e9], ['2026-10-13T06:00:00.000Z', 899e9], ['2026-10-14T06:00:00.000Z', 898e9], ['2026-10-15T06:00:00.000Z', 897e9]]);
    // 10-14: hours 0-11 at 0.005 and 12-23 at 0.007, a mean of 0.006; every other hour 0.005.
    const price = (h: number) => (dayOf(h) === '2026-10-14' ? (new Date(h).getUTCHours() < 12 ? 0.005 : 0.007) : 0.005);
    const { result, http, prices } = burnRun('usd', obs, 896e9, { price });
    const v = await result;
    expect(v.kind).toBe('daily_series');
    if (v.kind !== 'daily_series') return;
    expect(v.points.map((p) => [p.day, Math.round(p.value)])).toEqual([
      ['2026-10-09', 1_000_000], ['2026-10-10', 1_000_000], ['2026-10-11', 1_000_000], ['2026-10-12', 1_000_000], // DefiLlama
      ['2026-10-13', 5_000_000], ['2026-10-14', 6_000_000], ['2026-10-15', 5_000_000], // 1B PUMP x the day's price
    ]);
    expect(v.detail).toContain('3 days from 5 getTokenSupply readings; 4 days from DefiLlama pump dailyHoldersRevenue');
    expect(v.detail).not.toContain('SECRETKEY');
    expect(v.token).toEqual({ tokenRef: PUMP_REF, symbol: 'PUMP', decimals: null, coingeckoId: null });
    // The chain prices of the window's whole days were read from `prices` for the PUMP ref; no market_chart (no CoinGecko at all).
    expect(prices.asked).toEqual([[PUMP_REF, T('2026-10-09T00:00:00Z'), T('2026-10-16T00:00:00Z')]]);
    expect(http.calls.filter((c) => c.url.includes('coingecko'))).toEqual([]);
  });

  it('refuses a day with fewer than 24 chain prices: no USD row for it (the token row keeps it: unit tokens needs no price)', async () => {
    const obs = stored([['2026-10-12T06:00:00.000Z', 900e9], ['2026-10-13T06:00:00.000Z', 899e9], ['2026-10-14T06:00:00.000Z', 898e9], ['2026-10-15T06:00:00.000Z', 897e9]]);
    const gap = T('2026-10-14T17:00:00Z');
    const v = await burnRun('usd', obs, 896e9, { price: (h) => (h === gap ? null : 0.005) }).result;
    if (v.kind !== 'daily_series') throw new Error(v.kind);
    expect(v.points.map((p) => p.day)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-15']);
    expect(v.detail).toContain(`no price (fewer than 24 chain hours of ${PUMP_REF}) for 2026-10-14`);
    const t = await burnRun('tokens', obs, 896e9, { price: (h) => (h === gap ? null : 0.005) }).result;
    if (t.kind !== 'daily_series') throw new Error(t.kind);
    expect(t.points.find((p) => p.day === '2026-10-14')).toMatchObject({ value: expect.closeTo(1e9, 0), amount: expect.closeTo(1e9, 0) });
  });

  it('converts the DefiLlama days to tokens at the day\'s mean chain price (unit: tokens)', async () => {
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

  it('ignores stored readings of another mint, and fails when on-chain days exist but none has its 24 chain prices', async () => {
    const obs = stored([['2026-10-12T06:00:00.000Z', 900e9]]);
    await expect(burnRun('usd', obs, 896e9).result).resolves.toMatchObject({ kind: 'daily_series' });
    // No chain price at all: the read fails rather than storing no day.
    await expect(burnRun('usd', obs, 896e9, { price: () => null }).result).rejects.toThrow(/no on-chain day has its 24 chain prices of solana:mainnet\/pump/);
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

// Phase 3 R3 Task 3 (decision N1d, option B): PUMP's circulating supply = the mint's supply less pump.fun's Token
// Custodian and the five dormant custodian-funded vaults (owners, task-4-values.md), read 2026-11-20.
describe('solana.supply_less_owners', () => {
  const OWNERS: Record<string, string> = {
    token: MINT,
    token_custodian: 'Cfq1ts1iFr1eUWWBm8eFxUzm5R3YA3UvMZznwiShbgZt',
    dormant_a: '8UhbNoBXmGoxJr2TeWW8wmSMoWmjS2rTT2tVJxzuTogC',
    dormant_b: '9pkFKCR1mdS31JxjKdtmWg2awZUg6vJUYVY722DAcXzv',
    dormant_c: 'BBvQteuawKB2UtExfevL8HYLjWWsgmWXsp922vFbvCfT',
    dormant_d: 'GTeSSwovPiVirpvWJpThUWiLDSLsuApmJw621Yom3MhB',
    dormant_e: 'AvqFxKNrYZNvxsj2oWhLW8det68HzCXBqswshoD2TdT6',
    empty_owner: '11111111111111111111111111111111',
  };
  const acct = (amount: string) => ({ pubkey: 'x', account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount, decimals: 6 } } } } } });
  /** Token accounts by owner (raw amounts, 6 decimals): the custodian's 229,261,858,182.10 split over two accounts. */
  const HELD: Record<string, string[]> = {
    [OWNERS.token_custodian]: ['229000000000000000', '261858182100000'],
    [OWNERS.dormant_a]: [raw(80e9)],
    [OWNERS.dormant_b]: [raw(35e9)],
    [OWNERS.dormant_c]: [raw(25e9)],
    [OWNERS.dormant_d]: [raw(25e9)],
    [OWNERS.dormant_e]: [raw(24e9)],
  };
  const SUPPLY = '821771911575120000'; // 821,771,911,575.12 PUMP
  const rpc = (over: { supply?: string; held?: Record<string, string[]>; fail?: string } = {}) => (_u: string, body?: unknown) => {
    const { method, params: p } = body as { method: string; params: unknown[] };
    if (over.fail === method) throw new Error(`${KEYED}: HTTP 503`);
    if (method === 'getTokenSupply') return supplyReply(over.supply ?? SUPPLY, 380_000_100);
    if (method === 'getTokenAccountsByOwner') {
      const owner = p[0] as string;
      expect(p[1]).toEqual({ mint: MINT });
      expect(p[2]).toMatchObject({ commitment: 'finalized' });
      return { jsonrpc: '2.0', id: 1, result: { context: { slot: 380_000_101 }, value: ((over.held ?? HELD)[owner] ?? []).map(acct) } };
    }
    throw new Error(`unexpected ${method}`);
  };
  const SUB = { mint: 'token', subtract: ['token_custodian', 'dormant_a', 'dormant_b', 'dormant_c', 'dormant_d', 'dormant_e'] };
  function solRun(params: Record<string, unknown> = SUB, over: Parameters<typeof rpc>[0] = {}, env: Record<string, string> = { ORION_SOL_RPC_URL: KEYED }) {
    const http = fakeHttp({ [KEYED]: rpc(over), [PUBLIC_SOL_RPC_URL]: rpc(over), 'https://frontend-api-v3.pump.fun': rpc(over) });
    const ctx = sourceCtx({ asset: pump, nowIso: NOW, http, env, contract: (n) => OWNERS[n] ?? (() => { throw new Error(`no contract ${n}`); })() });
    return { http, result: getAdapter('solana.supply_less_owners').run(ctx, params) };
  }

  it('is registered on the contract-state rung, onchain, and needs no EVM chain', () => {
    expect(adapterNames()).toContain('solana.supply_less_owners');
    expect(getAdapter('solana.supply_less_owners').needsRpc).toBe(false);
    expect(ADAPTER_SOURCE_TYPES['solana.supply_less_owners']).toBe('contract_state');
    expect(ADAPTER_ORIGINS['solana.supply_less_owners']).toBe('onchain');
  });

  it('is the mint supply less every named owner\'s balance: 821,771.9M - 229,261.9M - 189,000M = 403,510,053,393.02', async () => {
    const { result, http } = solRun();
    const v = await result;
    expect(v).toMatchObject({ kind: 'level', source: 'onchain', observedAt: NOW });
    expect(v.kind === 'level' && v.value).toBeCloseTo(403_510_053_393.02, 2);
    expect(v.detail).toBe(
      `solana getTokenSupply ${MINT} 821771911575.12 at slot 380000100 less 418261858182.1: ` +
        `token_custodian ${OWNERS.token_custodian} 229261858182.1 at slot 380000101, dormant_a ${OWNERS.dormant_a} 80000000000 at slot 380000101, ` +
        `dormant_b ${OWNERS.dormant_b} 35000000000 at slot 380000101, dormant_c ${OWNERS.dormant_c} 25000000000 at slot 380000101, ` +
        `dormant_d ${OWNERS.dormant_d} 25000000000 at slot 380000101, dormant_e ${OWNERS.dormant_e} 24000000000 at slot 380000101`,
    );
    expect(v.detail).not.toContain('SECRETKEY');
    // One finalized read each: the supply, then each owner's accounts of the mint.
    expect(http.calls.map((c) => (c.body as { method: string }).method)).toEqual(['getTokenSupply', ...Array(6).fill('getTokenAccountsByOwner')]);
  });

  it('sums an owner\'s token accounts, counts an owner with none as 0, and refuses a result that is not positive', async () => {
    const two = await solRun({ mint: 'token', subtract: ['token_custodian'] }).result;
    expect(two.kind === 'level' && two.value).toBeCloseTo(821_771_911_575.12 - 229_261_858_182.1, 2);
    const none = await solRun({ mint: 'token', subtract: ['empty_owner'] }).result;
    expect(none.kind === 'level' && none.value).toBeCloseTo(821_771_911_575.12, 2);
    expect(none.detail).toContain(`empty_owner ${OWNERS.empty_owner} 0 at slot 380000101`);
    await expect(solRun(SUB, { supply: raw(418_261_858_182.1) }).result).rejects.toThrow(/not positive/);
    await expect(solRun(SUB, { supply: raw(1e9) }).result).rejects.toThrow(/not positive/);
  });

  it('fails the level on a transport error, naming only the RPC origin', async () => {
    const e = await solRun(SUB, { fail: 'getTokenAccountsByOwner' }).result.catch((x: Error) => x.message);
    expect(e).toContain('solana getTokenAccountsByOwner at https://solana-mainnet.g.alchemy.com: ');
    expect(e).not.toContain('SECRETKEY');
    await expect(solRun(SUB, { fail: 'getTokenSupply' }).result).rejects.toThrow(/solana getTokenSupply at https:\/\/solana-mainnet\.g\.alchemy\.com/);
    await expect(solRun({ mint: 'token', subtract: ['nobody'] }).result).rejects.toThrow(/no contract nobody/);
  });

  it('reads only the host ORION_SOL_RPC_URL names, never a pump.fun host (R8)', async () => {
    const { http, result } = solRun();
    await result;
    expect(http.calls.length).toBe(7);
    expect(new Set(http.calls.map((c) => new URL(c.url).host))).toEqual(new Set(['solana-mainnet.g.alchemy.com']));
    expect(http.calls.some((c) => /pump\.fun/i.test(c.url))).toBe(false);
    // An RPC URL on a pump.fun host is refused before any request.
    const bad = solRun(SUB, {}, { ORION_SOL_RPC_URL: 'https://frontend-api-v3.pump.fun/rpc' });
    await expect(bad.result).rejects.toThrow(/pump\.fun/);
    expect(bad.http.calls).toEqual([]);
  });

  // Ruling R4/R10: PUMP's N5 check, the six subtracted owners' balance as a monitor-only level (watch change_pct 1).
  it('solana.owners_balance is the same owners\' sum alone: 418,261,858,182.10, one finalized read each, never a pump.fun host', async () => {
    expect(adapterNames()).toContain('solana.owners_balance');
    expect(getAdapter('solana.owners_balance').needsRpc).toBe(false);
    expect(ADAPTER_SOURCE_TYPES['solana.owners_balance']).toBe('contract_state');
    expect(ADAPTER_ORIGINS['solana.owners_balance']).toBe('onchain');
    const params = { mint: 'token', owners: SUB.subtract };
    const run = (p: Record<string, unknown>, over: Parameters<typeof rpc>[0] = {}, env: Record<string, string> = { ORION_SOL_RPC_URL: KEYED }) => {
      const http = fakeHttp({ [KEYED]: rpc(over), [PUBLIC_SOL_RPC_URL]: rpc(over), 'https://frontend-api-v3.pump.fun': rpc(over) });
      const ctx = sourceCtx({ asset: pump, nowIso: NOW, http, env, contract: (n) => OWNERS[n] ?? (() => { throw new Error(`no contract ${n}`); })() });
      return { http, result: getAdapter('solana.owners_balance').run(ctx, p) };
    };
    const { http, result } = run(params);
    const v = await result;
    expect(v).toMatchObject({ kind: 'level', source: 'onchain', observedAt: NOW });
    expect(v.kind === 'level' && v.value).toBeCloseTo(418_261_858_182.1, 2);
    expect(v.detail).toBe(
      `solana owners' balance of ${MINT}: ` +
        `token_custodian ${OWNERS.token_custodian} 229261858182.1 at slot 380000101, dormant_a ${OWNERS.dormant_a} 80000000000 at slot 380000101, ` +
        `dormant_b ${OWNERS.dormant_b} 35000000000 at slot 380000101, dormant_c ${OWNERS.dormant_c} 25000000000 at slot 380000101, ` +
        `dormant_d ${OWNERS.dormant_d} 25000000000 at slot 380000101, dormant_e ${OWNERS.dormant_e} 24000000000 at slot 380000101`,
    );
    expect(http.calls.map((c) => (c.body as { method: string }).method)).toEqual(Array(6).fill('getTokenAccountsByOwner'));
    expect(new Set(http.calls.map((c) => new URL(c.url).host))).toEqual(new Set(['solana-mainnet.g.alchemy.com']));
    // An owner with no account is 0; all empty is 0 (a monitor-only tokens level may read 0).
    const none = await run({ mint: 'token', owners: ['empty_owner'] }).result;
    expect(none.kind === 'level' && none.value).toBe(0);
    await expect(run(params, { fail: 'getTokenAccountsByOwner' }).result).rejects.toThrow(/solana getTokenAccountsByOwner at https:\/\/solana-mainnet\.g\.alchemy\.com/);
    const bad = run(params, {}, { ORION_SOL_RPC_URL: 'https://frontend-api-v3.pump.fun/rpc' });
    await expect(bad.result).rejects.toThrow(/pump\.fun/);
    expect(bad.http.calls).toEqual([]);
    const validate = getAdapter('solana.owners_balance').validateParams!;
    expect(validate(params)).toEqual([]);
    expect(validate({ ...params, subtract: ['x'] })).toEqual(['unknown param "subtract"']);
    expect(validate({ mint: 'token', owners: [] })).not.toEqual([]);
    expect(validate({ mint: 'token', owners: ['dormant_a', 'dormant_a'] })).not.toEqual([]);
    expect(validate({ owners: ['dormant_a'] })).not.toEqual([]);
  });

  it('validates its params: mint and subtract contract names, rpc_url_env an env var name, nothing else', () => {
    const v = getAdapter('solana.supply_less_owners').validateParams!;
    expect(v(SUB)).toEqual([]);
    expect(v({ ...SUB, rpc_url_env: 'ORION_SOL_RPC_URL' })).toEqual([]);
    expect(v({ ...SUB, owner: 'x' })).toEqual(['unknown param "owner"']);
    expect(v({ subtract: SUB.subtract })).not.toEqual([]);
    expect(v({ mint: 'token', subtract: [] })).not.toEqual([]);
    expect(v({ mint: 'token', subtract: 'token_custodian' })).not.toEqual([]);
    expect(v({ mint: 'token', subtract: ['Cfq1ts1iFr1eUWWBm8eFxUzm5R3YA3UvMZznwiShbgZt'] })).not.toEqual([]);
    expect(v({ mint: 'token', subtract: ['dormant_a', 'dormant_a'] })).not.toEqual([]);
    expect(v({ ...SUB, rpc_url_env: 'https://x.test' })).not.toEqual([]);
  });
});
