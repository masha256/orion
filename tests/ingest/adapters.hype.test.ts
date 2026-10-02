import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fakeHttp, type Route } from '../helpers/fakeHttp.js';
import { ingestAsset } from '../helpers/ingestAsset.js';
import { NOW_ISO, sourceCtx } from '../helpers/sourceCtx.js';

// Hyperliquid's info API, recorded on 2026-09-24 (validators) and 2026-10-02 (the spot meta, trimmed to the HYPE/USDC pair, a
// HYPE pair against another quote, PURR/USDC and their tokens; the three clearinghouse states, whole). See the HYPE onboarding
// spec, sections 2.1 and 12.
const INFO = 'https://api.hyperliquid.xyz/info';
const TOKEN_ID = '0x0d01dc56dcaaca66ad901c959b4011ec';
const FUND = '0xfefefefefefefefefefefefefefefefefefefefe';
const recorded = (name: string): Record<string, unknown> | unknown[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/hype/${name}.json`, import.meta.url)), 'utf8')) as Record<string, unknown> | unknown[];
type Meta = { tokens: { name: string; index: number; tokenId: string }[]; universe: { tokens: number[]; name: string }[] };
type Ctx = { coin: string; totalSupply: string };
type State = { balances: { coin: string; total: string }[] };
const spotMeta = recorded('spotMetaAndAssetCtxs') as [Meta, Ctx[]];
const validators = recorded('validatorSummaries') as { stake: number }[];
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const states: Record<string, State> = Object.fromEntries([FUND, ZERO, DEAD].map((a) => [a, recorded(`spotClearinghouseState-${a}`) as State]));

/** One URL answers by request type, as the real API does. */
/** `over` keys: a request type, or `spotClearinghouseState:<address>` for one address's state. */
const info = (over: Record<string, Route> = {}): Route => (_url: string, body?: unknown) => {
  const { type = '', user = '' } = (body as { type?: string; user?: string } | undefined) ?? {};
  const key = type === 'spotClearinghouseState' ? `${type}:${user.toLowerCase()}` : type;
  const defaults: Record<string, unknown> = { spotMetaAndAssetCtxs: spotMeta, validatorSummaries: validators };
  const route = over[key] ?? over[type] ?? (type === 'spotClearinghouseState' ? states[user.toLowerCase()] : defaults[type]);
  if (route === undefined) throw new Error(`no fixture for ${type}`);
  if (route instanceof Error) throw route;
  return typeof route === 'function' ? (route as (u: string, b?: unknown) => unknown)(_url, body) : structuredClone(route);
};

const CONTRACTS = { assistance_fund: FUND, zero: ZERO, dead: DEAD };

function ctxWith(routes: Record<string, Route> = {}, external: Record<string, string> = { hyperliquid_info: INFO, hyperliquid_token: TOKEN_ID }) {
  const http = fakeHttp({ [INFO]: info(routes), 'https://other.test/info': info(routes) });
  const asset = { ...ingestAsset().config, contracts: CONTRACTS, external_ids: external };
  return { ctx: sourceCtx({ http, asset, contract: (name) => CONTRACTS[name as keyof typeof CONTRACTS] ?? (() => { throw new Error(`no contract ${name}`); })() }), http };
}

const SUBTRACT = { subtract: ['assistance_fund', 'zero', 'dead'] };
const total = Number(spotMeta[1].find((c) => c.coin === '@107')!.totalSupply);
const held = (address: string) => Number(states[address].balances.find((b) => b.coin === 'HYPE')!.total);
const CALL = (body: Record<string, unknown>) => ({ url: INFO, method: 'POST', headers: {}, body });
const stakeSum = validators.reduce((s, v) => s + v.stake, 0) / 1e8;

describe('HYPE adapters', () => {
  it('are registered and need no chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['hype.effective_supply', 'hype.staked_supply', 'hype.emission_rate_annual']));
    for (const name of ['hype.effective_supply', 'hype.staked_supply', 'hype.emission_rate_annual']) expect(getAdapter(name).needsRpc).toBe(false);
  });

  it('effective supply is the total less the fund and the dead addresses, about 951.3M today, stamped at fetch time as an api level', async () => {
    const { ctx, http } = ctxWith();
    const v = await getAdapter('hype.effective_supply').run(ctx, SUBTRACT);
    const expected = total - held(FUND) - held(ZERO) - held(DEAD);
    expect(v).toMatchObject({ kind: 'level', source: 'api', observedAt: NOW_ISO });
    expect(v.kind === 'level' && v.value).toBeCloseTo(expected, 3);
    // The recorded figures, computed once by hand: 998891801.4858174324 - 47632360.5447392315 - 1673.78676325 - 2.71671343.
    expect(v.kind === 'level' && v.value).toBeCloseTo(951_257_764.4376, 3);
    expect(v.detail).toMatch(/^spotMetaAndAssetCtxs @107: total 998891801\.4858174 less 47634037\.0\d+ at assistance_fund, zero, dead$/);
    expect(http.calls).toEqual([
      CALL({ type: 'spotMetaAndAssetCtxs' }),
      CALL({ type: 'spotClearinghouseState', user: FUND }),
      CALL({ type: 'spotClearinghouseState', user: ZERO }),
      CALL({ type: 'spotClearinghouseState', user: DEAD }),
    ]);
  });

  it('subtracts nothing without a subtract list, and zero for a named address that holds no HYPE', async () => {
    const { ctx, http } = ctxWith();
    const all = await getAdapter('hype.effective_supply').run(ctx, {});
    expect(all.kind === 'level' && all.value).toBeCloseTo(total, 3);
    expect(all.detail).toMatch(/less 0 at none of $/);
    expect(http.calls).toHaveLength(1);
    const emptied: State = { balances: states[FUND].balances.filter((b) => b.coin !== 'HYPE') };
    const v = await getAdapter('hype.effective_supply').run(ctxWith({ [`spotClearinghouseState:${FUND}`]: emptied }).ctx, SUBTRACT);
    expect(v.kind === 'level' && v.value).toBeCloseTo(total - held(ZERO) - held(DEAD), 3);
    expect(v.detail).toMatch(/at zero, dead$/);
  });

  it('matches the token id case-insensitively, finds the pair against the configured quote, and takes the token id and URL from params or the external ids', async () => {
    const { ctx, http } = ctxWith({}, {});
    const v = await getAdapter('hype.effective_supply').run(ctx, { ...SUBTRACT, token_id: TOKEN_ID.toUpperCase().replace('0X', '0x'), url: 'https://other.test/info' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(total - held(FUND) - held(ZERO) - held(DEAD), 3);
    expect(http.calls[0]).toMatchObject({ url: 'https://other.test/info', body: { type: 'spotMetaAndAssetCtxs' } });
    // The HYPE pair against token 268 (the fixture's second HYPE pair) carries the same total.
    const other = await getAdapter('hype.effective_supply').run(ctxWith().ctx, { quote_index: 268 });
    expect(other.kind === 'level' && other.value).toBeCloseTo(total, 3);
    expect(other.detail).toMatch(/^spotMetaAndAssetCtxs @207: /);
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

  it('refuses by name a malformed spot meta, a missing token, pair or context, a bad balance, and a supply that is not positive', async () => {
    const run = (over: Record<string, Route>, params: Record<string, unknown> = SUBTRACT) => getAdapter('hype.effective_supply').run(ctxWith(over).ctx, params);
    await expect(run({ spotMetaAndAssetCtxs: { tokens: [] } })).rejects.toThrow(/not a \[meta, contexts\] pair/);
    await expect(run({ spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []] })).rejects.toThrow(/no token with id 0x0d01/);
    await expect(run({ spotMetaAndAssetCtxs: [{ tokens: spotMeta[0].tokens, universe: [] }, []] })).rejects.toThrow(/no pair of HYPE \(token 150\) against quote token 0/);
    await expect(run({ spotMetaAndAssetCtxs: [spotMeta[0], []] })).rejects.toThrow(/no context for pair @107/);
    await expect(run({ spotMetaAndAssetCtxs: [spotMeta[0], [{ coin: '@107' }]] })).rejects.toThrow(/@107 totalSupply is missing/);
    await expect(run({ [`spotClearinghouseState:${FUND}`]: { balances: 'nope' } })).rejects.toThrow(/spotClearinghouseState assistance_fund: balances is missing/);
    await expect(run({ [`spotClearinghouseState:${FUND}`]: { balances: [{ coin: 'HYPE', total: 'lots' }] } })).rejects.toThrow(/the HYPE balance at assistance_fund is missing/);
    await expect(run({ [`spotClearinghouseState:${FUND}`]: { balances: [{ coin: 'HYPE', total: '998891801.4858174324' }] } })).rejects.toThrow(/effective supply .* is not positive/);
    await expect(run({ [`spotClearinghouseState:${FUND}`]: [] })).rejects.toThrow(/not an object/);
    await expect(run({ [`spotClearinghouseState:${FUND}`]: 'nope' })).rejects.toThrow(/not an object/);
    await expect(run({}, { subtract: ['treasury'] })).rejects.toThrow(/no contract treasury/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [] }).ctx, {})).rejects.toThrow(/not a non-empty list/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: { stake: 1 } }).ctx, {})).rejects.toThrow(/not a non-empty list/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [{ stake: 0 }, { stake: 0 }] }).ctx, {})).rejects.toThrow(/total stake is not positive/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [{ stake: 1 }, {}] }).ctx, {})).rejects.toThrow(/validator 1's stake is missing/);
    await expect(getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, { anchor_rate: 1.5 })).rejects.toThrow(/anchor_rate 1.5/);
    await expect(getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: new Error('HTTP 503') }).ctx, {})).rejects.toThrow(/HTTP 503/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ spotMetaAndAssetCtxs: new Error('The operation was aborted due to timeout') }).ctx, SUBTRACT)).rejects.toThrow(/timeout/);
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

  it('uses the recorded fixture with non-default exponents', async () => {
    // exponent 1: rate = 0.0237 * (400M / stakeSum) ^ 1 * stakeSum = 0.0237 * 400M = 9.48M always
    const exp1 = await getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, { exponent: 1 });
    expect(exp1.kind === 'level' && exp1.value).toBeCloseTo(9_480_000, 6);
    // exponent 0.25: rate = 0.0237 * (400M / stakeSum) ^ 0.25 * stakeSum
    const exp025 = await getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, { exponent: 0.25 });
    const rate025 = 0.0237 * ((400_000_000 / stakeSum) ** 0.25);
    expect(exp025.kind === 'level' && exp025.value).toBeCloseTo(rate025 * stakeSum, 6);
    // Both differ from default (0.5)
    const exp05 = await getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, { exponent: 0.5 });
    expect(exp1.kind === 'level' && exp1.value).not.toBeCloseTo(exp05.kind === 'level' && exp05.value ? exp05.value : 0, 3);
    expect(exp025.kind === 'level' && exp025.value).not.toBeCloseTo(exp05.kind === 'level' && exp05.value ? exp05.value : 0, 3);
  });
});
