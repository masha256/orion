import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber } from '../units.js';
import { number, text } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Hyperliquid's info API (POST, one JSON request type per read), for HYPE. The Assistance Fund lives on HyperCore, which
 * no EVM RPC exposes, so the supply and the stake are read from the API: total supply less the fund and the dead
 * addresses, the sum of validator stake, and the staking reward rate the docs give as inversely proportional to the
 * square root of total stake ("at 400M total HYPE staked, the reward rate is approximately 2.37% per year"; staking
 * page, read 2026-09-24). None of these adapters needs an RPC.
 */

const DEFAULT_INFO_URL = 'https://api.hyperliquid.xyz/info';
/** `stake` in validatorSummaries is an integer in the token's wei decimals (8 for HYPE). */
const STAKE_DECIMALS = 8;
const ANCHOR_RATE = 0.0237;
const ANCHOR_STAKE = 400_000_000;
const EXPONENT = 0.5;

const infoUrl = (ctx: SourceContext, params: Record<string, unknown>): string =>
  text(params, 'url', ctx.asset.external_ids.hyperliquid_info ?? DEFAULT_INFO_URL);

/** A level stamped at fetch time: the API reports the present, not a block. */
const api = (ctx: SourceContext, value: number, detail: string): SourceValue => ({ kind: 'level', value, observedAt: ctx.nowIso, source: 'api', detail });

/** The API writes amounts as decimal strings; a missing or non-numeric field fails the read by name. */
function amount(v: unknown, what: string): number {
  const n = toFiniteNumber(v);
  if (n === null) throw new Error(`${what} is missing or not a number in the info API's reply`);
  return n;
}

async function post(ctx: SourceContext, params: Record<string, unknown>, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await ctx.http.postJson(infoUrl(ctx, params), body);
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new Error(`${body.type}: the info API's reply is not an object`);
  return reply as Record<string, unknown>;
}

/** Total stake across every validator, in HYPE. */
async function totalStake(ctx: SourceContext, params: Record<string, unknown>): Promise<{ stake: number; validators: number }> {
  const reply = await ctx.http.postJson(infoUrl(ctx, params), { type: 'validatorSummaries' });
  if (!Array.isArray(reply) || reply.length === 0) throw new Error("validatorSummaries: the info API's reply is not a non-empty list");
  const decimals = number(params, 'decimals', STAKE_DECIMALS);
  let raw = 0;
  for (const [i, v] of reply.entries()) {
    const rawStake = amount((v as Record<string, unknown> | null)?.stake, `validator ${i}'s stake`);
    if (rawStake < 0) throw new Error(`validator ${i}'s stake is negative`);
    raw += rawStake;
  }
  const stake = raw / 10 ** decimals;
  if (!(stake > 0)) throw new Error('validatorSummaries: the total stake is not positive');
  return { stake, validators: reply.length };
}

/** Total supply less the balances the API lists as non-circulating at the named addresses: the fund and the dead addresses. */
const effectiveSupply: AdapterDef = {
  name: 'hype.effective_supply',
  needsRpc: false,
  async run(ctx, params) {
    const tokenId = text(params, 'token_id', ctx.asset.external_ids.hyperliquid_token ?? '');
    if (tokenId === '') throw new Error('no token id: set params.token_id or external_ids.hyperliquid_token');
    if ('subtract' in params && !Array.isArray(params.subtract)) throw new Error('params.subtract must be an array of contract names');
    const subtract = Array.isArray(params.subtract) ? params.subtract : [];
    const names = subtract.filter((n): n is string => typeof n === 'string');
    if ('subtract' in params && names.length !== subtract.length) throw new Error('params.subtract must contain only strings (contract names)');
    const addresses = names.map((n) => ctx.contract(n).toLowerCase()); // an unknown name is a configuration error and propagates
    const reply = await post(ctx, params, { type: 'tokenDetails', tokenId });
    const total = amount(reply.totalSupply, 'totalSupply');
    if (names.length > 0 && !Array.isArray(reply.nonCirculatingUserBalances)) throw new Error('nonCirculatingUserBalances is missing or not an array');
    const listed = Array.isArray(reply.nonCirculatingUserBalances) ? reply.nonCirculatingUserBalances : [];
    let subtracted = 0;
    const found: string[] = [];
    for (const entry of listed) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
        if (names.length > 0) throw new Error(`nonCirculatingUserBalances has an entry that is not a [string, balance] pair`);
        continue;
      }
      const at = addresses.indexOf(entry[0].toLowerCase());
      if (at === -1) continue;
      // An address absent from the list subtracts zero: a fund emptied by a vote shows as a supply jump, not a failed read.
      subtracted += amount(entry[1], `the balance at ${names[at]}`);
      found.push(names[at]);
    }
    const value = total - subtracted;
    if (!(value > 0)) throw new Error(`effective supply ${value} is not positive (total ${total}, subtracted ${subtracted})`);
    return api(ctx, value, `tokenDetails ${tokenId}: total ${total} less ${subtracted} at ${found.length > 0 ? found.join(', ') : 'none of ' + names.join(', ')}`);
  },
};

const stakedSupply: AdapterDef = {
  name: 'hype.staked_supply',
  needsRpc: false,
  async run(ctx, params) {
    const { stake, validators } = await totalStake(ctx, params);
    return api(ctx, stake, `validatorSummaries: ${validators} validators`);
  },
};

/** Staking rewards a year: rate(stake) times stake, with rate = anchor_rate * (anchor_stake / stake) ** exponent. All of it goes to stakers. */
const emissionRateAnnual: AdapterDef = {
  name: 'hype.emission_rate_annual',
  needsRpc: false,
  async run(ctx, params) {
    const anchorRate = number(params, 'anchor_rate', ANCHOR_RATE);
    const anchorStake = number(params, 'anchor_stake', ANCHOR_STAKE);
    const exponent = number(params, 'exponent', EXPONENT);
    if (!(anchorRate > 0 && anchorRate < 1) || !(anchorStake > 0)) throw new Error(`anchor_rate ${anchorRate} and anchor_stake ${anchorStake} must be a rate in (0, 1) and a positive stake`);
    if (!(exponent > 0 && exponent <= 1)) throw new Error(`exponent ${exponent} must be in (0, 1]`);
    const { stake, validators } = await totalStake(ctx, params);
    const rate = anchorRate * ((anchorStake / stake) ** exponent);
    return api(ctx, rate * stake, `validatorSummaries: ${validators} validators, stake ${stake.toFixed(0)}, rate ${(rate * 100).toFixed(3)} percent a year`);
  },
};

export const hypeAdapters: AdapterDef[] = [effectiveSupply, stakedSupply, emissionRateAnnual];
