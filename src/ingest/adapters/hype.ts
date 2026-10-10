import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber } from '../units.js';
import { number, text } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Hyperliquid's info API (POST, one JSON request type per read), for HYPE. The Assistance Fund lives on HyperCore, which
 * no EVM RPC exposes, so the supply and the stake are read from the API: total supply (from the spot meta) less the fund and the dead
 * addresses (their clearinghouse balances), the sum of validator stake, and the staking reward rate the docs give as inversely proportional to the
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

/**
 * The token's total supply, from the spot meta: the token's pair against the quote (USDC, index 0) carries `totalSupply`.
 * The `tokenDetails` reply carries it too, but with 94,023 genesis balances (5 MB), which a slow link cannot finish
 * inside any sane timeout; the spot meta is 300 KB.
 */
async function totalSupply(ctx: SourceContext, params: Record<string, unknown>, tokenId: string): Promise<{ total: number; symbol: string; pair: string }> {
  const reply = await ctx.http.postJson(infoUrl(ctx, params), { type: 'spotMetaAndAssetCtxs' });
  if (!Array.isArray(reply) || reply.length < 2 || reply[0] === null || typeof reply[0] !== 'object' || !Array.isArray(reply[1])) {
    throw new Error("spotMetaAndAssetCtxs: the info API's reply is not a [meta, contexts] pair");
  }
  const meta = reply[0] as Record<string, unknown>;
  const row = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null);
  const tokens = Array.isArray(meta.tokens) ? meta.tokens.map(row) : [];
  const token = tokens.find((t) => typeof t?.tokenId === 'string' && t.tokenId.toLowerCase() === tokenId.toLowerCase());
  if (!token || typeof token.index !== 'number' || typeof token.name !== 'string') throw new Error(`spotMetaAndAssetCtxs: no token with id ${tokenId}`);
  const quote = number(params, 'quote_index', 0);
  const universe = Array.isArray(meta.universe) ? meta.universe.map(row) : [];
  const pair = universe.find((p) => Array.isArray(p?.tokens) && p.tokens[0] === token.index && p.tokens[1] === quote);
  if (!pair || typeof pair.name !== 'string') throw new Error(`spotMetaAndAssetCtxs: no pair of ${token.name} (token ${token.index}) against quote token ${quote}`);
  const context = (reply[1] as unknown[]).map(row).find((c) => c?.coin === pair.name);
  if (!context) throw new Error(`spotMetaAndAssetCtxs: no context for pair ${pair.name}`);
  return { total: amount(context.totalSupply, `${pair.name} totalSupply`), symbol: token.name, pair: pair.name };
}

/** One address's balance of the token from its clearinghouse state; an address holding none has no entry and counts as zero. */
async function balanceAt(ctx: SourceContext, params: Record<string, unknown>, name: string, address: string, symbol: string): Promise<number> {
  const reply = await post(ctx, params, { type: 'spotClearinghouseState', user: address });
  if (!Array.isArray(reply.balances)) throw new Error(`spotClearinghouseState ${name}: balances is missing or not an array`);
  const entry = reply.balances.find((b) => b !== null && typeof b === 'object' && (b as Record<string, unknown>).coin === symbol) as Record<string, unknown> | undefined;
  // A fund emptied by a vote shows as a supply jump the deviation trigger sees, not as a failed read.
  return entry ? amount(entry.total, `the ${symbol} balance at ${name}`) : 0;
}

/** Total supply less the token held at the named addresses: the fund and the dead addresses. Four small requests, cached per run. */
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
    const addresses = names.map((n) => ctx.contract(n)); // an unknown name is a configuration error and propagates
    const { total, symbol, pair } = await totalSupply(ctx, params, tokenId);
    let subtracted = 0;
    const found: string[] = [];
    for (const [i, name] of names.entries()) {
      const balance = await balanceAt(ctx, params, name, addresses[i], symbol);
      subtracted += balance;
      if (balance > 0) found.push(name);
    }
    const value = total - subtracted;
    if (!(value > 0)) throw new Error(`effective supply ${value} is not positive (total ${total}, subtracted ${subtracted})`);
    return api(ctx, value, `spotMetaAndAssetCtxs ${pair}: total ${total} less ${subtracted} at ${found.length > 0 ? found.join(', ') : 'none of ' + names.join(', ')}`);
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

/**
 * The fund's buys, read from its own fills: USDC spent per completed UTC day on the HYPE spot pair (`pair`, e.g. "@107"),
 * summed px x sz over buy fills. A daily series, written like an API flow (cursor, revision days, never a zero for a day
 * the API did not return). The info API keeps about two weeks of fills, so history starts when this goes live: it is
 * collected forward, next to the DefiLlama series the valuation reads, until it has a window of its own.
 */
const FILLS_PAGE = 2000;
const fundBuysDaily: AdapterDef = {
  name: 'hype.fund_buys_daily',
  needsRpc: false,
  async run(ctx, params) {
    const user = ctx.contract(text(params, 'fund', 'assistance_fund'));
    const pair = text(params, 'pair', '');
    if (pair === '') throw new Error('params.pair (the spot pair the fund buys on, e.g. "@107") is required');
    const days = number(params, 'days', 14);
    const nowMs = Date.parse(ctx.nowIso);
    const todayStart = Math.floor(nowMs / 86_400_000) * 86_400_000;
    const sums = new Map<string, number>();
    let fills = 0;
    for (let d = days; d >= 1; d--) {
      const start = todayStart - d * 86_400_000;
      const end = start + 86_400_000;
      let from = start;
      // Pages of at most FILLS_PAGE fills, oldest first: continue from the last fill's time until the day is done.
      for (let page = 0; page < 50; page++) {
        const reply = await ctx.http.postJson(infoUrl(ctx, params), { type: 'userFillsByTime', user, startTime: from, endTime: end - 1, aggregateByTime: false });
        if (!Array.isArray(reply)) throw new Error("userFillsByTime: the info API's reply is not a list");
        const day = new Date(start).toISOString().slice(0, 10);
        let lastTime = from;
        for (const f of reply as Record<string, unknown>[]) {
          const t = amount(f.time, 'a fill time');
          lastTime = Math.max(lastTime, t);
          if (f.coin !== pair || f.side !== 'B' || t < start || t >= end) continue;
          sums.set(day, (sums.get(day) ?? 0) + amount(f.px, 'a fill price') * amount(f.sz, 'a fill size'));
          fills++;
        }
        if (reply.length < FILLS_PAGE) break;
        from = lastTime + 1;
      }
    }
    // A day with no fill is a real zero only when the API returned something for the days around it: the fund buys
    // every day, so an empty day inside the API's memory is written as 0 and an empty run fails the read.
    if (fills === 0) throw new Error(`userFillsByTime: no ${pair} buy fill by the fund in the last ${days} days`);
    const points: { day: string; value: number }[] = [];
    for (let d = days; d >= 1; d--) {
      const day = new Date(todayStart - d * 86_400_000).toISOString().slice(0, 10);
      points.push({ day, value: sums.get(day) ?? 0 });
    }
    // Drop leading empty days: before the API's memory, not zero buys.
    while (points.length > 0 && points[0].value === 0) points.shift();
    return { kind: 'daily_series', points, detail: `hyperliquid userFillsByTime ${user} ${pair} buys` };
  },
};

export const hypeAdapters: AdapterDef[] = [effectiveSupply, stakedSupply, emissionRateAnnual, fundBuysDaily];
