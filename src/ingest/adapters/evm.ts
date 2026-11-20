import { reserveTwap, sideOf, sqrtPriceInQuote } from '../../prices/evmMethods.js';
import { DAYS_PER_YEAR } from '../../types.js';
import { firstBlockAtOrAfter, type BlockRef, type ContractCall } from '../transport/rpc.js';
import type { SourceContext, SourceValue } from '../types.js';
import { unitsToNumber } from '../units.js';
import { chain, view } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Generic EVM contract-state adapters (spec docs/superpowers/specs/2026-11-09-orion-aero-supply-design.md §3.2, §3.4).
 * Every address is a name from the asset's `contracts` map, so one adapter serves any asset. Two of them read an earlier
 * block (archive `eth_call`) at the first block at or after a target time, found with the interpolating block search.
 */

const SECONDS_PER_DAY = 86_400;
type Params = Record<string, unknown>;

// ---- param checks ------------------------------------------------------------------------------------------------------

const isName = (x: unknown): x is string => typeof x === 'string' && /^[a-z0-9_]+$/.test(x);
const isFn = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const isPos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

function unknownKeys(p: Params, allowed: string[], where = ''): string[] {
  return Object.keys(p).filter((k) => !allowed.includes(k)).map((k) => `unknown param "${where}${k}"`);
}

function checkArgs(p: Params, where: string): string[] {
  if (p.args === undefined) return [];
  return Array.isArray(p.args) && p.args.every(isName) ? [] : [`${where}args must be a list of contract names`];
}

function checkShare(x: unknown): string[] {
  if (x === undefined) return [];
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return ['plus_share must be { contract, function, denominator }'];
  const s = x as Params;
  const out = unknownKeys(s, ['contract', 'function', 'denominator'], 'plus_share.');
  if (!isName(s.contract)) out.push('plus_share.contract must be a contract name');
  if (!isFn(s.function)) out.push('plus_share.function must be a function name');
  if (!isPos(s.denominator)) out.push('plus_share.denominator must be a positive number');
  return out;
}

const decimalsOk = (x: unknown, key: string): string[] => (x === undefined || isInt(x, 0, 36) ? [] : [`${key} must be an integer 0..36`]);
const feedOk = (p: Params): string[] => [...(p.usd_feed === undefined || isName(p.usd_feed) ? [] : ['usd_feed must be a contract name']), ...decimalsOk(p.feed_decimals, 'feed_decimals')];

// ---- reads -------------------------------------------------------------------------------------------------------------

/** Every call at one block; the first failed call fails the adapter, naming it. */
async function readAt(ctx: SourceContext, block: bigint, calls: ContractCall[]): Promise<bigint[]> {
  const { rpc } = chain(ctx);
  const results = await rpc.multicall(calls, block);
  return results.map((r, i) => {
    if (!r.ok) throw new Error(`${calls[i].functionName}(${(calls[i].args ?? []).join(',')}) at block ${block}: ${r.error}`);
    return r.value;
  });
}

function viewCall(ctx: SourceContext, contract: string, fn: string, args: unknown): ContractCall {
  const names = Array.isArray(args) ? (args as string[]) : [];
  return { address: ctx.contract(contract), signature: view(fn, names.map(() => 'address').join(',')), functionName: fn, ...(names.length ? { args: names.map((n) => ctx.contract(n)) } : {}) };
}

/** 1 + value/denominator, the value read at the run block (the Minter's team share on top of each mint). */
async function shareFactor(ctx: SourceContext, share: unknown): Promise<{ factor: number; detail: string }> {
  if (share === undefined) return { factor: 1, detail: '' };
  const s = share as { contract: string; function: string; denominator: number };
  const [raw] = await readAt(ctx, chain(ctx).block.number, [viewCall(ctx, s.contract, s.function, undefined)]);
  const share_ = Number(raw) / s.denominator;
  return { factor: 1 + share_, detail: `; + ${s.function} ${raw}/${s.denominator}` };
}

async function blockAt(ctx: SourceContext, ts: number): Promise<BlockRef> {
  const { rpc, block } = chain(ctx);
  return await firstBlockAtOrAfter(rpc, ts, block, block);
}

const at = (b: BlockRef): string => `block ${b.number} (${new Date(b.timestamp * 1000).toISOString()})`;
const level = (ctx: SourceContext, value: number, detail: string): SourceValue => {
  const { block } = chain(ctx);
  return { kind: 'level', value, observedAt: new Date(block.timestamp * 1000).toISOString(), source: 'onchain', detail };
};

/** The USD price of the quote token from a Chainlink feed (`latestAnswer`), or 1 when no feed is named. */
async function feedPrice(ctx: SourceContext, p: Params): Promise<{ usd: number; detail: string }> {
  if (p.usd_feed === undefined) return { usd: 1, detail: '' };
  const [answer] = await readAt(ctx, chain(ctx).block.number, [{ address: ctx.contract(p.usd_feed as string), signature: 'function latestAnswer() view returns (uint256)', functionName: 'latestAnswer' }]);
  const usd = unitsToNumber(answer, (p.feed_decimals as number | undefined) ?? 8);
  if (!(usd > 0)) throw new Error(`the USD feed answered ${answer}: not a positive price`);
  return { usd, detail: ` x feed ${usd}` };
}

/** Which side of a pool the priced token is on: 0, 1, or a refusal. */
async function side(ctx: SourceContext, pool: string, token: string): Promise<0 | 1> {
  const [t0, t1] = await readAt(ctx, chain(ctx).block.number, [
    { address: pool, signature: view('token0'), functionName: 'token0' },
    { address: pool, signature: view('token1'), functionName: 'token1' },
  ]);
  return sideOf(t0, t1, token, pool);
}

// ---- chain.counter_rate ------------------------------------------------------------------------------------------------

const COUNTER_KEYS = ['contract', 'function', 'args', 'decimals', 'direction', 'days', 'not_before', 'plus_share', 'refuse_if_supply_falls'];

function validateCounter(p: Params): string[] {
  const out = unknownKeys(p, COUNTER_KEYS);
  if (!isName(p.contract)) out.push('contract must be a contract name');
  if (!isFn(p.function)) out.push('function must be a function name');
  out.push(...checkArgs(p, ''), ...decimalsOk(p.decimals, 'decimals'), ...checkShare(p.plus_share));
  if (p.direction !== 'rise' && p.direction !== 'fall') out.push('direction must be rise or fall');
  if (!isPos(p.days)) out.push('days must be a positive number');
  if (p.not_before !== undefined && !(typeof p.not_before === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.not_before) && Number.isFinite(Date.parse(p.not_before)))) out.push('not_before must be an ISO timestamp');
  if (p.refuse_if_supply_falls !== undefined && !isName(p.refuse_if_supply_falls)) out.push('refuse_if_supply_falls must be a contract name');
  return out;
}

async function counterRate(ctx: SourceContext, p: Params): Promise<SourceValue> {
  const { block } = chain(ctx);
  const decimals = (p.decimals as number | undefined) ?? 18;
  const notBefore = typeof p.not_before === 'string' ? Math.ceil(Date.parse(p.not_before) / 1000) : -Infinity;
  const target = Math.max(block.timestamp - (p.days as number) * SECONDS_PER_DAY, notBefore);
  const start = await blockAt(ctx, target);
  const elapsedDays = (block.timestamp - start.timestamp) / SECONDS_PER_DAY;
  if (!(elapsedDays >= 1)) throw new Error(`the window from ${at(start)} to ${at(block)} is less than one day`);
  const calls = [viewCall(ctx, p.contract as string, p.function as string, p.args)];
  const guard = p.refuse_if_supply_falls as string | undefined;
  if (guard !== undefined) calls.push({ address: ctx.contract(guard), signature: view('totalSupply'), functionName: 'totalSupply' });
  const [nowV, nowSupply] = await readAt(ctx, block.number, calls);
  const [thenV, thenSupply] = await readAt(ctx, start.number, calls);
  if (guard !== undefined && nowSupply! < thenSupply!) {
    throw new Error(`${guard} supply fell from ${thenSupply} to ${nowSupply} over the window: a burn, not a ${p.direction}; look before counting it`);
  }
  const delta = p.direction === 'rise' ? nowV - thenV : thenV - nowV;
  if (delta < 0n) throw new Error(`${p.function} ${p.direction === 'rise' ? 'fell' : 'rose'} from ${thenV} to ${nowV}: against its direction ${p.direction}`);
  const share = await shareFactor(ctx, p.plus_share);
  const value = (unitsToNumber(delta, decimals) / elapsedDays) * DAYS_PER_YEAR * share.factor;
  return level(ctx, value, `${p.function} ${thenV} at ${at(start)} -> ${nowV} at ${at(block)}: ${p.direction} over ${elapsedDays.toFixed(3)} d${share.detail}`);
}

// ---- chain.view_sum ----------------------------------------------------------------------------------------------------

const TERM_KEYS = ['contract', 'function', 'args', 'sign', 'times'];
const SCHEDULE_KEYS = ['amount', 'first_tranche', 'tranches', 'every_months', 'citation'];

interface Times {
  contract: string;
  function: string;
  decimals: number;
}
interface Term {
  contract: string;
  function: string;
  args?: string[];
  sign?: 1 | -1;
  times?: Times;
}
interface LockedSchedule {
  amount: number;
  first_tranche: string;
  tranches: number;
  every_months: number;
  citation: string;
}

const isObject = (x: unknown): x is Params => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A real calendar day, YYYY-MM-DD (2027-02-30 is refused: it does not round-trip). */
const isDay = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x;

function checkTimes(x: unknown, where: string): string[] {
  if (x === undefined) return [];
  if (!isObject(x)) return [`${where} must be { contract, function, decimals }`];
  const out = unknownKeys(x, ['contract', 'function', 'decimals'], `${where}.`);
  if (!isName(x.contract)) out.push(`${where}.contract must be a contract name`);
  if (!isFn(x.function)) out.push(`${where}.function must be a function name`);
  if (!isInt(x.decimals, 0, 36)) out.push(`${where}.decimals must be an integer 0..36`);
  return out;
}

function checkSchedule(x: unknown): string[] {
  if (x === undefined) return [];
  if (!isObject(x)) return ['locked_schedule must be { amount, first_tranche, tranches, every_months, citation }'];
  const out = unknownKeys(x, SCHEDULE_KEYS, 'locked_schedule.');
  if (!isPos(x.amount)) out.push('locked_schedule.amount must be a positive number (tokens)');
  if (!isDay(x.first_tranche)) out.push('locked_schedule.first_tranche must be a day, YYYY-MM-DD');
  if (!isInt(x.tranches, 1, 1200)) out.push('locked_schedule.tranches must be an integer 1..1200');
  if (!isInt(x.every_months, 1, 120)) out.push('locked_schedule.every_months must be an integer 1..120');
  if (!(typeof x.citation === 'string' && /^https?:\/\/\S+$/.test(x.citation))) out.push('locked_schedule.citation must be the URL the schedule is cited from');
  return out;
}

function validateViewSum(p: Params): string[] {
  const out = unknownKeys(p, ['terms', 'decimals', 'scale', 'plus_share', 'locked_schedule']);
  if (!Array.isArray(p.terms) || p.terms.length === 0) return [...out, 'terms must be a non-empty list'];
  p.terms.forEach((t: unknown, i) => {
    if (!isObject(t)) return void out.push(`terms[${i}] must be { contract, function, args?, sign?, times? }`);
    out.push(...unknownKeys(t, TERM_KEYS, `terms[${i}].`), ...checkArgs(t, `terms[${i}].`), ...checkTimes(t.times, `terms[${i}].times`));
    if (!isName(t.contract)) out.push(`terms[${i}].contract must be a contract name`);
    if (!isFn(t.function)) out.push(`terms[${i}].function must be a function name`);
    if (t.sign !== undefined && t.sign !== 1 && t.sign !== -1) out.push(`terms[${i}].sign must be 1 or -1`);
  });
  out.push(...decimalsOk(p.decimals, 'decimals'), ...checkShare(p.plus_share), ...checkSchedule(p.locked_schedule));
  if (p.scale !== undefined && !isPos(p.scale)) out.push('scale must be a positive number');
  // The schedule is in tokens of the result: subtracting it from a scaled or shared sum would mix units.
  if (p.locked_schedule !== undefined && (p.scale !== undefined || p.plus_share !== undefined)) out.push('locked_schedule does not combine with scale or plus_share');
  return out;
}

/**
 * The UTC midnight `months` calendar months after `day` (YYYY-MM-DD), in ms. The day of the month is kept, clamped to
 * the target month's last day only when that month lacks it: 2027-01-29 + 1 month = 2027-02-28 (February 2027 has 28
 * days), + 2 months = 2027-03-29. Each tranche is counted from the first tranche, never from a clamped one, so a clamp
 * does not carry into later months.
 */
export function addMonthsUtc(day: string, months: number): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d, last));
}

/**
 * The still-locked part of a cited schedule at `atMs`: amount x (tranches - k) / tranches, k = the tranches whose day
 * (first_tranche + i x every_months, i = 0..tranches-1, 00:00Z) is at or before `atMs`. 0 once the last tranche is out.
 */
export function lockedAt(s: LockedSchedule, atMs: number): { locked: number; unlocked: number } {
  let k = 0;
  for (let i = 0; i < s.tranches; i++) if (addMonthsUtc(s.first_tranche, i * s.every_months) <= atMs) k++;
  return { locked: (s.amount * (s.tranches - k)) / s.tranches, unlocked: k };
}

async function viewSum(ctx: SourceContext, p: Params): Promise<SourceValue> {
  const { block } = chain(ctx);
  const terms = p.terms as Term[];
  // Every term and every term's `times` view in one multicall at the run block: a reverting call fails the whole level
  // (readAt throws, naming it), never a sum missing one term.
  const calls = terms.map((t) => viewCall(ctx, t.contract, t.function, t.args));
  const timesAt = terms.map((t) => (t.times === undefined ? -1 : calls.push(viewCall(ctx, t.times.contract, t.times.function, undefined)) - 1));
  const values = await readAt(ctx, block.number, calls);
  const term = (i: number): bigint => {
    const t = terms[i];
    return t.times === undefined ? values[i] : (values[i] * values[timesAt[i]]) / 10n ** BigInt(t.times.decimals);
  };
  const raw = terms.reduce((s, t, i) => s + (t.sign === -1 ? -term(i) : term(i)), 0n);
  if (raw < 0n) throw new Error(`the signed sum is negative (${raw})`);
  const share = await shareFactor(ctx, p.plus_share);
  let value = unitsToNumber(raw, (p.decimals as number | undefined) ?? 18) * ((p.scale as number | undefined) ?? 1) * share.factor;
  let schedule = '';
  if (p.locked_schedule !== undefined) {
    const s = p.locked_schedule as LockedSchedule;
    const { locked, unlocked } = lockedAt(s, block.timestamp * 1000);
    value -= locked;
    if (value < 0) throw new Error(`the sum less the locked schedule is negative (${value}: ${locked} still locked)`);
    schedule = ` - locked_schedule ${s.amount} x ${s.tranches - unlocked}/${s.tranches} = ${locked} (${unlocked} of ${s.tranches} tranches out, every ${s.every_months} months from ${s.first_tranche}; ${s.citation})`;
  }
  const parts = terms
    .map((t, i) => {
      const times = t.times === undefined ? '' : ` x ${t.times.contract}.${t.times.function}() ${values[timesAt[i]]}/1e${t.times.decimals}`;
      return `${t.sign === -1 ? '-' : '+'} ${t.contract}.${t.function}(${(t.args ?? []).join(',')}) ${values[i]}${times}`;
    })
    .join(' ');
  return level(ctx, value, `${at(block)}: ${parts}${p.scale !== undefined ? ` x ${p.scale}` : ''}${share.detail}${schedule}`);
}

// ---- pool prices -------------------------------------------------------------------------------------------------------

const POOL_KEYS = ['pool', 'token', 'token_decimals', 'quote_decimals', 'usd_feed', 'feed_decimals'];

function validatePool(p: Params, extra: string[]): string[] {
  const out = unknownKeys(p, [...POOL_KEYS, ...extra]);
  if (!isName(p.pool)) out.push('pool must be a contract name');
  if (!isName(p.token)) out.push('token must be a contract name');
  if (!isInt(p.quote_decimals, 0, 36)) out.push('quote_decimals must be an integer 0..36');
  out.push(...decimalsOk(p.token_decimals, 'token_decimals'), ...feedOk(p));
  return out;
}

const CUM = 'function currentCumulativePrices() view returns (uint256, uint256, uint256)';

async function v2TwapPrice(ctx: SourceContext, p: Params): Promise<SourceValue> {
  const { block } = chain(ctx);
  const pool = ctx.contract(p.pool as string);
  const which = await side(ctx, pool, ctx.contract(p.token as string));
  const calls: ContractCall[] = [0, 1, 2].map((i) => ({ address: pool, signature: CUM, functionName: 'currentCumulativePrices', pick: i }));
  const start = await blockAt(ctx, block.timestamp - (p.seconds as number));
  const [c0, c1, t] = await readAt(ctx, block.number, calls);
  const [s0, s1, st] = await readAt(ctx, start.number, calls);
  const td = (p.token_decimals as number | undefined) ?? 18;
  const qd = p.quote_decimals as number;
  const { dt, inQuote } = reserveTwap([c0, c1, t], [s0, s1, st], which, td, qd);
  const feed = await feedPrice(ctx, p);
  return level(ctx, inQuote * feed.usd, `${at(block)}: pool ${pool} twap ${dt} s from ${at(start)}, ${inQuote} quote per token${feed.detail}`);
}

async function clSpotPrice(ctx: SourceContext, p: Params): Promise<SourceValue> {
  const { block } = chain(ctx);
  const pool = ctx.contract(p.pool as string);
  const which = await side(ctx, pool, ctx.contract(p.token as string));
  const [sqrt] = await readAt(ctx, block.number, [
    { address: pool, signature: 'function slot0() view returns (uint256, uint256, uint256, uint256, uint256, uint256)', functionName: 'slot0', pick: 0 },
  ]);
  const td = (p.token_decimals as number | undefined) ?? 18;
  const qd = p.quote_decimals as number;
  const inQuote = sqrtPriceInQuote(sqrt, which, td, qd);
  const feed = await feedPrice(ctx, p);
  return level(ctx, inQuote * feed.usd, `${at(block)}: pool ${pool} slot0 sqrtPriceX96 ${sqrt}, ${inQuote} quote per token${feed.detail}`);
}

export const evmAdapters: AdapterDef[] = [
  {
    name: 'chain.counter_rate',
    needsRpc: true,
    paramsDoc:
      'contract, function (a uint256 view), args?: contract names, decimals? (18), direction: rise | fall, days: the window, not_before?: ISO (clamps the window start), plus_share?: { contract, function, denominator } (x (1 + value/denominator)), refuse_if_supply_falls?: token contract name. Tokens a year: the counter\'s change from the first block at or after the window start to the run block, over the days elapsed, x 365.',
    validateParams: validateCounter,
    run: counterRate,
  },
  {
    name: 'chain.view_sum',
    needsRpc: true,
    paramsDoc:
      'terms: [{ contract, function, args?: contract names, sign?: 1 | -1, times?: { contract, function, decimals } (the term x that view / 10^decimals, read in the same multicall) }], decimals? (18), scale?: number, plus_share?: { contract, function, denominator }, locked_schedule?: { amount (tokens), first_tranche: YYYY-MM-DD, tranches, every_months, citation: URL } (subtracts amount x the tranches not yet out at the run block\'s time, 00:00Z each; not with scale or plus_share). The signed sum of uint256 views at the run block (refused when negative), x scale, x (1 + share), less the locked schedule (refused when negative). A view that reverts fails the level.',
    validateParams: validateViewSum,
    run: viewSum,
  },
  {
    name: 'chain.v2_pool_twap_price',
    needsRpc: true,
    paramsDoc: 'pool, token (contract names), token_decimals? (18), quote_decimals, seconds (>= 60): an Aero/Velodrome basic pool\'s time-weighted reserves over the window (currentCumulativePrices), quote per token; usd_feed?: a Chainlink feed for the quote token (latestAnswer), feed_decimals? (8).',
    validateParams: (p) => [...validatePool(p, ['seconds']), ...(isInt(p.seconds, 60, 7 * SECONDS_PER_DAY) ? [] : ['seconds must be an integer 60..604800'])],
    run: v2TwapPrice,
  },
  {
    name: 'chain.cl_pool_spot_price',
    needsRpc: true,
    paramsDoc: 'pool, token (contract names), token_decimals? (18), quote_decimals: a concentrated-liquidity pool\'s slot0 price at the run block, quote per token; usd_feed?: a Chainlink feed for the quote token (latestAnswer), feed_decimals? (8).',
    validateParams: (p) => validatePool(p, []),
    run: clSpotPrice,
  },
];
