import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fakeHttp, type Route } from '../helpers/fakeHttp.js';
import { ingestAsset } from '../helpers/ingestAsset.js';
import { NOW_ISO, sourceCtx } from '../helpers/sourceCtx.js';

// Hyperliquid's info API, recorded on 2026-09-24 (the HYPE onboarding spec, section 2.1); the token-details fixture keeps
// every field but the 94,023 genesis balances, which no adapter reads.
const INFO = 'https://api.hyperliquid.xyz/info';
const TOKEN_ID = '0x0d01dc56dcaaca66ad901c959b4011ec';
const FUND = '0xfefefefefefefefefefefefefefefefefefefefe';
const recorded = (name: string): Record<string, unknown> | unknown[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/hype/${name}.json`, import.meta.url)), 'utf8')) as Record<string, unknown> | unknown[];
const tokenDetails = recorded('tokenDetails') as { totalSupply: string; nonCirculatingUserBalances: [string, string][] };
const validators = recorded('validatorSummaries') as { stake: number }[];

/** One URL answers by request type, as the real API does. */
const info = (over: Record<string, Route> = {}): Route => (_url: string, body?: unknown) => {
  const type = (body as { type?: string } | undefined)?.type ?? '';
  const route = over[type] ?? { tokenDetails, validatorSummaries: validators }[type];
  if (route === undefined) throw new Error(`no fixture for ${type}`);
  if (route instanceof Error) throw route;
  return typeof route === 'function' ? (route as (u: string, b?: unknown) => unknown)(_url, body) : structuredClone(route);
};

const CONTRACTS = { assistance_fund: FUND, zero: '0x0000000000000000000000000000000000000000', dead: '0x000000000000000000000000000000000000dead' };

function ctxWith(routes: Record<string, Route> = {}, external: Record<string, string> = { hyperliquid_info: INFO, hyperliquid_token: TOKEN_ID }) {
  const http = fakeHttp({ [INFO]: info(routes), 'https://other.test/info': info(routes) });
  const asset = { ...ingestAsset().config, contracts: CONTRACTS, external_ids: external };
  return { ctx: sourceCtx({ http, asset, contract: (name) => CONTRACTS[name as keyof typeof CONTRACTS] ?? (() => { throw new Error(`no contract ${name}`); })() }), http };
}

const SUBTRACT = { subtract: ['assistance_fund', 'zero', 'dead'] };
const total = Number(tokenDetails.totalSupply);
const listed = (address: string) => Number(tokenDetails.nonCirculatingUserBalances.find(([a]) => a === address)![1]);
const stakeSum = validators.reduce((s, v) => s + v.stake, 0) / 1e8;

describe('HYPE adapters', () => {
  it('are registered and need no chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['hype.effective_supply', 'hype.staked_supply', 'hype.emission_rate_annual']));
    for (const name of ['hype.effective_supply', 'hype.staked_supply', 'hype.emission_rate_annual']) expect(getAdapter(name).needsRpc).toBe(false);
  });

  it('effective supply is the total less the fund and the dead addresses, about 951.4M today, stamped at fetch time as an api level', async () => {
    const { ctx, http } = ctxWith();
    const v = await getAdapter('hype.effective_supply').run(ctx, SUBTRACT);
    const expected = total - listed(FUND) - listed(CONTRACTS.zero) - listed(CONTRACTS.dead);
    expect(v).toMatchObject({ kind: 'level', source: 'api', observedAt: NOW_ISO });
    expect(v.kind === 'level' && v.value).toBeCloseTo(expected, 3);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(950e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(953e6);
    expect(v.detail).toMatch(/^tokenDetails 0x0d01dc56dcaaca66ad901c959b4011ec: total 998909900\.8563856 less 47479853\.5\d+ at assistance_fund, zero, dead$/);
    expect(http.calls).toEqual([{ url: INFO, method: 'POST', headers: {}, body: { type: 'tokenDetails', tokenId: TOKEN_ID } }]);
  });

  it('subtracts nothing without a subtract list, and zero for a named address the API no longer lists', async () => {
    const { ctx } = ctxWith();
    const all = await getAdapter('hype.effective_supply').run(ctx, {});
    expect(all.kind === 'level' && all.value).toBeCloseTo(total, 3);
    expect(all.detail).toMatch(/less 0 at none of $/);
    const emptied = { ...tokenDetails, nonCirculatingUserBalances: tokenDetails.nonCirculatingUserBalances.filter(([a]) => a !== FUND) };
    const v = await getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: emptied }).ctx, SUBTRACT);
    expect(v.kind === 'level' && v.value).toBeCloseTo(total - listed(CONTRACTS.zero) - listed(CONTRACTS.dead), 3);
    expect(v.detail).toMatch(/at zero, dead$/);
  });

  it('matches addresses case-insensitively and takes the token id and URL from params or the external ids', async () => {
    const upper = { ...tokenDetails, nonCirculatingUserBalances: tokenDetails.nonCirculatingUserBalances.map(([a, b]) => [a.toUpperCase().replace('0X', '0x'), b] as [string, string]) };
    const { ctx, http } = ctxWith({ tokenDetails: upper }, {});
    const v = await getAdapter('hype.effective_supply').run(ctx, { ...SUBTRACT, token_id: '0xabc', url: 'https://other.test/info' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(total - listed(FUND) - listed(CONTRACTS.zero) - listed(CONTRACTS.dead), 3);
    expect(http.calls[0]).toMatchObject({ url: 'https://other.test/info', body: { type: 'tokenDetails', tokenId: '0xabc' } });
    await expect(getAdapter('hype.effective_supply').run(ctxWith({}, {}).ctx, SUBTRACT)).rejects.toThrow(/no token id/);
  });

  it('staked supply is the validators\' stake summed, in HYPE: about 441M today', async () => {
    const { ctx, http } = ctxWith();
    const v = await getAdapter('hype.staked_supply').run(ctx, {});
    expect(v).toMatchObject({ kind: 'level', source: 'api', observedAt: NOW_ISO, detail: 'validatorSummaries: 35 validators' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(440_716_882.74898976, 3);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(430e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(450e6);
    expect(http.calls).toEqual([{ url: INFO, method: 'POST', headers: {}, body: { type: 'validatorSummaries' } }]);
  });

  it('the emission rate is the docs formula on the stake: 9.48M a year at the 400M anchor, about 9.95M today', async () => {
    const anchor = [{ stake: 400_000_000 * 1e8 }];
    const at = await getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: anchor }).ctx, {});
    expect(at.kind === 'level' && at.value).toBeCloseTo(9_480_000, 6);
    expect(at.detail).toBe('validatorSummaries: 1 validators, stake 400000000, rate 2.370 percent a year');
    const v = await getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, {});
    const rate = 0.0237 * Math.sqrt(400_000_000 / stakeSum);
    expect(v.kind === 'level' && v.value).toBeCloseTo(rate * stakeSum, 6);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(9.8e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(10.1e6);
    // Four times the stake halves the rate and doubles the emissions.
    const quad = await getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: [{ stake: 1_600_000_000 * 1e8 }] }).ctx, {});
    expect(quad.kind === 'level' && quad.value).toBeCloseTo(2 * 9_480_000, 6);
  });

  it('takes the anchor, the stake decimals, and the URL from params', async () => {
    const { ctx, http } = ctxWith({ validatorSummaries: [{ stake: 100 }, { stake: 300 }] });
    const v = await getAdapter('hype.emission_rate_annual').run(ctx, { anchor_rate: 0.04, anchor_stake: 100, decimals: 0, url: 'https://other.test/info' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(0.04 * Math.sqrt(100 / 400) * 400, 9);
    expect(http.calls[0].url).toBe('https://other.test/info');
    const s = await getAdapter('hype.staked_supply').run(ctx, { decimals: 2 });
    expect(s.kind === 'level' && s.value).toBe(4);
  });

  it('refuses by name a missing field, an empty or zero stake list, a bad anchor, and a supply that is not positive', async () => {
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { name: 'HYPE' } }).ctx, SUBTRACT)).rejects.toThrow(/totalSupply is missing/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { totalSupply: '10', nonCirculatingUserBalances: [[FUND, 'lots']] } }).ctx, SUBTRACT)).rejects.toThrow(/balance at assistance_fund is missing/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { totalSupply: '10', nonCirculatingUserBalances: [[FUND, '10']] } }).ctx, SUBTRACT)).rejects.toThrow(/effective supply 0 is not positive/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: [] }).ctx, SUBTRACT)).rejects.toThrow(/not an object/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: 'nope' }).ctx, SUBTRACT)).rejects.toThrow(/not an object/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith().ctx, { subtract: ['treasury'] })).rejects.toThrow(/no contract treasury/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [] }).ctx, {})).rejects.toThrow(/not a non-empty list/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: { stake: 1 } }).ctx, {})).rejects.toThrow(/not a non-empty list/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [{ stake: 0 }, { stake: 0 }] }).ctx, {})).rejects.toThrow(/total stake is not positive/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [{ stake: 1 }, {}] }).ctx, {})).rejects.toThrow(/validator 1's stake is missing/);
    await expect(getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, { anchor_rate: 1.5 })).rejects.toThrow(/anchor_rate 1.5/);
    await expect(getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: new Error('HTTP 503') }).ctx, {})).rejects.toThrow(/HTTP 503/);
  });

  it('refuses a missing nonCirculatingUserBalances and malformed entries when subtract is present', async () => {
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { totalSupply: '100', nonCirculatingUserBalances: undefined } }).ctx, SUBTRACT)).rejects.toThrow(/nonCirculatingUserBalances is missing or not an array/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { totalSupply: '100', nonCirculatingUserBalances: 'not-an-array' } }).ctx, SUBTRACT)).rejects.toThrow(/nonCirculatingUserBalances is missing or not an array/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { totalSupply: '100', nonCirculatingUserBalances: [{ addr: FUND, bal: '50' }] } }).ctx, SUBTRACT)).rejects.toThrow(/not a \[string, balance\] pair/);
  });

  it('refuses a malformed subtract param and negative stake', async () => {
    await expect(getAdapter('hype.effective_supply').run(ctxWith().ctx, { subtract: 'assistance_fund' })).rejects.toThrow(/params.subtract must be an array/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith().ctx, { subtract: ['assistance_fund', 123] })).rejects.toThrow(/params.subtract must contain only strings/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [{ stake: -1 }] }).ctx, {})).rejects.toThrow(/validator 0's stake is negative/);
  });

  it('takes the exponent param and refuses an invalid value', async () => {
    const { ctx } = ctxWith({ validatorSummaries: [{ stake: 400_000_000 * 1e8 }] });
    const v = await getAdapter('hype.emission_rate_annual').run(ctx, { exponent: 0.5 });
    expect(v.kind === 'level' && v.value).toBeCloseTo(9_480_000, 6);
    const quad = await getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: [{ stake: 1_600_000_000 * 1e8 }] }).ctx, { exponent: 0.5 });
    expect(quad.kind === 'level' && quad.value).toBeCloseTo(2 * 9_480_000, 6);
    await expect(getAdapter('hype.emission_rate_annual').run(ctx, { exponent: 0 })).rejects.toThrow(/exponent 0 must be in \(0, 1\]/);
    await expect(getAdapter('hype.emission_rate_annual').run(ctx, { exponent: 1.5 })).rejects.toThrow(/exponent 1.5 must be in \(0, 1\]/);
  });
});
