import { HOURS_PER_DAY, MS_PER_HOUR, solanaTokenRef } from '../../db/prices.js';
import { ownerBalance, solanaRpcUrl, tokenSupply } from '../transport/solana.js';
import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber } from '../units.js';
import { text } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Solana (PUMP first; RAY, JUP later). Solana has no `eth_*` surface and no supply-at-a-past-slot call, so these adapters
 * read the chain over plain JSON-RPC (src/ingest/transport/solana.ts) at fetch time. The mint comes from the asset's
 * `contracts` map (`params.mint`, default `token`); the RPC from `ORION_SOL_RPC_URL` (or `params.rpc_url_env`), falling
 * back to the keyless public endpoint.
 */

const MS_PER_DAY = 86_400_000;

function rpcUrl(ctx: SourceContext, params: Record<string, unknown>): string {
  return solanaRpcUrl(ctx.env, text(params, 'rpc_url_env', 'ORION_SOL_RPC_URL'));
}

/** The mint's supply now: burns reduce it. Stamped with the fetch time (Solana's slot time costs another call). */
async function tokenSupplyLevel(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const mint = ctx.contract(text(params, 'mint', 'token'));
  const s = await tokenSupply(ctx.http, rpcUrl(ctx, params), mint);
  return { kind: 'level', value: s.amount, observedAt: ctx.nowIso, source: 'onchain', detail: `solana getTokenSupply ${mint} slot ${s.slot}` };
}

/** One owner's balance of the mint (all its token accounts). */
async function ownerBalanceLevel(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const mint = ctx.contract(text(params, 'mint', 'token'));
  const ownerName = text(params, 'owner', '');
  if (ownerName === '') throw new Error('params.owner (a name in the asset\'s contracts map) is required');
  const owner = ctx.contract(ownerName);
  const b = await ownerBalance(ctx.http, rpcUrl(ctx, params), owner, mint);
  return { kind: 'level', value: b.amount, observedAt: ctx.nowIso, source: 'onchain', detail: `solana ${ownerName} ${owner} balance of ${mint} slot ${b.slot}` };
}

/** Ruling R8 / M8: pump.fun's own hosts are never read; PUMP is read only through our own Solana RPC. */
const PUMP_FUN_HOST = /(^|\.)pump\.fun$/i;
const isName = (x: unknown): x is string => typeof x === 'string' && /^[a-z0-9_]+$/.test(x);

function ownersIssues(p: Record<string, unknown>, list: 'subtract' | 'owners'): string[] {
  const out = Object.keys(p).filter((k) => !['mint', list, 'rpc_url_env'].includes(k)).map((k) => `unknown param "${k}"`);
  if (!isName(p.mint)) out.push('mint must be a contract name');
  const names = p[list];
  if (!Array.isArray(names) || names.length === 0 || !names.every(isName)) out.push(`${list} must be a non-empty list of contract names (owners, not token accounts)`);
  else if (new Set(names).size !== names.length) out.push(`${list} must not name an owner twice`);
  if (p.rpc_url_env !== undefined && !(typeof p.rpc_url_env === 'string' && /^[A-Z][A-Z0-9_]*$/.test(p.rpc_url_env))) out.push('rpc_url_env must be an environment variable name');
  return out;
}

const validateSupplyLessOwners = (p: Record<string, unknown>): string[] => ownersIssues(p, 'subtract');
const validateOwnersBalance = (p: Record<string, unknown>): string[] => ownersIssues(p, 'owners');

/** The RPC URL for an owners read, refused (before any request) on a pump.fun host (R8). */
function ownRpcUrl(ctx: SourceContext, params: Record<string, unknown>): string {
  const url = rpcUrl(ctx, params);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('the Solana RPC URL is not a URL');
  }
  if (PUMP_FUN_HOST.test(host)) throw new Error(`${host}: PUMP is read only through our own Solana RPC, never a pump.fun host (R8)`);
  return url;
}

/** Every named owner's balance of the mint (all of each owner's token accounts), one finalized read each: the sum and a part per owner. */
async function ownersHeld(ctx: SourceContext, url: string, mint: string, list: unknown, param: string): Promise<{ held: number; parts: string[] }> {
  if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) throw new Error(`params.${param} must be a list of contract names (owners)`);
  const names = list as string[];
  const owners = names.map((n) => ctx.contract(n)); // an unknown name is a configuration error and propagates
  let held = 0;
  const parts: string[] = [];
  for (const [i, name] of names.entries()) {
    const b = await ownerBalance(ctx.http, url, owners[i], mint);
    held += b.amount;
    parts.push(`${name} ${owners[i]} ${b.amount} at slot ${b.slot}`);
  }
  return { held, parts };
}

/**
 * The mint's supply less every named owner's balance of it (all of each owner's token accounts): PUMP's circulating
 * supply less pump.fun's Token Custodian and the dormant custodian-funded vaults (Phase 3 R3, decision N1d). One
 * finalized read each, at fetch time (Solana has no past-slot supply); refused when not positive. The owners are names
 * in the asset's contracts map, and the RPC is only ever ORION_SOL_RPC_URL's (or rpc_url_env's), never a pump.fun host.
 */
async function supplyLessOwners(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const mint = ctx.contract(text(params, 'mint', 'token'));
  if (!Array.isArray(params.subtract) || !params.subtract.every((n) => typeof n === 'string')) throw new Error('params.subtract must be a list of contract names (owners)');
  const names = params.subtract as string[];
  names.forEach((n) => ctx.contract(n)); // an unknown name is a configuration error, before any request
  const url = ownRpcUrl(ctx, params);
  const supply = await tokenSupply(ctx.http, url, mint);
  const { held, parts } = await ownersHeld(ctx, url, mint, names, 'subtract');
  const value = supply.amount - held;
  if (!(value > 0)) throw new Error(`supply less owners ${value} is not positive (supply ${supply.amount}, owners ${held})`);
  return { kind: 'level', value, observedAt: ctx.nowIso, source: 'onchain', detail: `solana getTokenSupply ${mint} ${supply.amount} at slot ${supply.slot} less ${held}: ${parts.join(', ')}` };
}

/**
 * The named owners' balance of the mint, summed (Phase 3 R3, Ruling R4): what solana.supply_less_owners subtracts, as a
 * monitor-only level, so a move out of the custodian or a dormant vault (what would invalidate decision N1d) is watched.
 * Same reads and the same R8 rule as supply_less_owners; 0 when no owner holds any.
 */
async function ownersBalance(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const mint = ctx.contract(text(params, 'mint', 'token'));
  if (Array.isArray(params.owners)) params.owners.forEach((n) => typeof n === 'string' && ctx.contract(n));
  const url = ownRpcUrl(ctx, params);
  const { held, parts } = await ownersHeld(ctx, url, mint, params.owners, 'owners');
  return { kind: 'level', value: held, observedAt: ctx.nowIso, source: 'onchain', detail: `solana owners' balance of ${mint}: ${parts.join(', ')}` };
}

export interface SupplyReading {
  ms: number;
  supply: number;
}

/**
 * Tokens burned on each UTC day, from successive supply readings: the drop between two readings is spread over the time
 * between them (burns run all day: ~9k a day for PUMP), so a day is complete once one reading sits at or before its
 * start and one at or after its end. A rise in supply is refused: the asset's config must point at a mint with no mint
 * authority, where supply can only fall.
 */
export function burnsByDay(readings: SupplyReading[]): Map<string, number> {
  const rs = [...readings].sort((a, b) => a.ms - b.ms);
  const out = new Map<string, number>();
  if (rs.length < 2) return out;
  for (let i = 1; i < rs.length; i++) {
    const a = rs[i - 1];
    const b = rs[i];
    if (b.ms === a.ms) continue;
    const drop = a.supply - b.supply;
    if (drop < 0) {
      throw new Error(`supply rose by ${(-drop).toFixed(6)} between ${new Date(a.ms).toISOString()} and ${new Date(b.ms).toISOString()}: not a burn-only mint`);
    }
    const rate = drop / (b.ms - a.ms);
    for (let d = Math.floor(a.ms / MS_PER_DAY) * MS_PER_DAY; d < b.ms; d += MS_PER_DAY) {
      const overlap = Math.min(b.ms, d + MS_PER_DAY) - Math.max(a.ms, d);
      if (overlap <= 0) continue;
      const day = new Date(d).toISOString().slice(0, 10);
      out.set(day, (out.get(day) ?? 0) + rate * overlap);
    }
  }
  // Only whole days: the first reading at or before the day's start and the last at or after its end.
  const first = rs[0].ms;
  const last = rs[rs.length - 1].ms;
  for (const day of [...out.keys()]) {
    const start = Date.parse(`${day}T00:00:00.000Z`);
    if (first > start || last < start + MS_PER_DAY) out.delete(day);
  }
  return out;
}

/**
 * The mean of each UTC day's 24 hourly chain prices (`hours`: hour ms -> USD) over [fromMs, toMs); a day with fewer than
 * 24 priced hours has none (flow_usd_chain_v's daily_mean rule: all 24 hours, or no price).
 */
export function dailyMeanChainPrice(hours: Map<number, number>, fromMs: number, toMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let day = fromMs; day < toMs; day += MS_PER_DAY) {
    let sum = 0;
    let n = 0;
    for (let h = 0; h < HOURS_PER_DAY; h++) {
      const p = hours.get(day + h * MS_PER_HOUR);
      if (p === undefined) break;
      sum += p;
      n++;
    }
    if (n === HOURS_PER_DAY) out.set(new Date(day).toISOString().slice(0, 10), sum / n);
  }
  return out;
}

/**
 * The burn flow per completed UTC day (`unit: tokens`, or `usd` at the mean of the day's 24 chain prices of the mint's
 * ref, read from `prices`: a day with fewer than 24 is not priced and gets no usd row, Phase 3 R2) from the fall in the
 * mint's supply: the stored readings of `params.supply_metric` (written by `solana.token_supply` on this mint) plus one
 * read now. Days before the first stored reading come from `params.history` (DefiLlama's daily holders revenue, Mike
 * 2026-10-16: the one-time year of history, since Solana cannot read a past supply), converted to tokens at the day's
 * price; once on-chain readings cover a day, the chain wins. Days: the run's `--backfill-days`, else `params.days` (7).
 */
async function supplyBurnDaily(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const mint = ctx.contract(text(params, 'mint', 'token'));
  const unit = text(params, 'unit', 'tokens');
  if (unit !== 'usd' && unit !== 'tokens') throw new Error(`params.unit must be usd or tokens, not ${unit}`);
  const supplyMetric = text(params, 'supply_metric', '');
  if (supplyMetric === '') throw new Error('params.supply_metric (the level metric solana.token_supply writes) is required');
  if (!ctx.observations) throw new Error('this adapter reads stored supply readings; the run gave it none');
  if (!ctx.chainHourPrices) throw new Error('this adapter prices from the stored chain prices; the run gave it none');
  const days = ctx.backfillDays ?? (typeof params.days === 'number' ? params.days : 7);

  const now = await tokenSupply(ctx.http, rpcUrl(ctx, params), mint);
  const stored = (await ctx.observations(supplyMetric)).filter((o) => o.source === 'onchain' && (o.sourceDetail ?? '').includes(mint));
  const readings: SupplyReading[] = [...stored.map((o) => ({ ms: Date.parse(o.observedAt), supply: o.value })), { ms: Date.parse(ctx.nowIso), supply: now.amount }];
  const onchain = burnsByDay(readings);
  const firstReadingMs = Math.min(...readings.map((r) => r.ms));

  const todayStart = Math.floor(Date.parse(ctx.nowIso) / MS_PER_DAY) * MS_PER_DAY;
  const windowStart = todayStart - days * MS_PER_DAY;
  const ref = solanaTokenRef(mint);
  const price = dailyMeanChainPrice(await ctx.chainHourPrices(ref, windowStart, todayStart), windowStart, todayStart);

  // The history: days that began before the first on-chain reading (the day it lands in included, so the series has no
  // gap where the two meet), from the named DefiLlama series (USD per day). Read only while such a day is in the window.
  const history = new Map<string, number>();
  const h = params.history as { slug?: unknown; data_type?: unknown } | undefined;
  if (h !== undefined && windowStart < firstReadingMs) {
    if (typeof h.slug !== 'string' || typeof h.data_type !== 'string') throw new Error('params.history needs slug and data_type');
    const body = (await ctx.http.getJson(`https://api.llama.fi/summary/fees/${encodeURIComponent(h.slug)}?dataType=${encodeURIComponent(h.data_type)}`)) as { totalDataChart?: unknown };
    if (!Array.isArray(body?.totalDataChart)) throw new Error(`defillama ${h.slug} ${h.data_type}: no totalDataChart`);
    for (const row of body.totalDataChart as unknown[]) {
      if (!Array.isArray(row)) continue;
      const t = toFiniteNumber(row[0]);
      const v = toFiniteNumber(row[1]);
      if (t === null || v === null) continue;
      const dayMs = Math.floor((t * 1000) / MS_PER_DAY) * MS_PER_DAY;
      if (dayMs < firstReadingMs) history.set(new Date(dayMs).toISOString().slice(0, 10), v);
    }
  }

  // Chain days carry the supply drop in tokens as `amount` (spec §4; no hourly buckets: a supply reading has no
  // transfers to place in hours). History days are DefiLlama dollars and carry none (never converted, decision 1).
  const points: { day: string; value: number; amount?: number }[] = [];
  let fromChain = 0;
  let fromHistory = 0;
  let unpricedChain = 0;
  const unpriced: string[] = [];
  for (let ms = windowStart; ms < todayStart; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const p = price.get(day);
    const tokens = onchain.get(day);
    if (tokens !== undefined) {
      if (unit === 'tokens') points.push({ day, value: tokens, amount: tokens });
      else if (p !== undefined) points.push({ day, value: tokens * p, amount: tokens });
      else {
        unpriced.push(day);
        unpricedChain++;
        continue;
      }
      fromChain++;
      continue;
    }
    const usd = history.get(day);
    if (usd === undefined) continue;
    if (unit === 'usd') points.push({ day, value: usd });
    else if (p !== undefined && p > 0) points.push({ day, value: usd / p });
    else {
      unpriced.push(day);
      continue;
    }
    fromHistory++;
  }
  // On-chain days none of which has its 24 chain hours: the read fails (the prices are missing), it never stores nothing.
  if (fromChain === 0 && unpricedChain > 0) {
    throw new Error(`no on-chain day has its 24 chain prices of ${ref} (${unpriced.join(', ')}); no day was priced`);
  }
  // Two days of readings must give a completed day: a series that stays empty means the readings stopped being stored.
  if (fromChain === 0 && Date.parse(ctx.nowIso) - firstReadingMs > 2 * MS_PER_DAY) {
    throw new Error(`no completed day from ${readings.length} supply readings since ${new Date(firstReadingMs).toISOString()}`);
  }
  const hist = fromHistory > 0 ? `; ${fromHistory} days from DefiLlama ${String(h?.slug)} ${String(h?.data_type)} (before the first on-chain reading)` : '';
  const miss = unpriced.length > 0 ? `; no price (fewer than 24 chain hours of ${ref}) for ${unpriced.join(', ')}` : '';
  return {
    kind: 'daily_series',
    points,
    detail: `solana supply drop of ${mint} (${unit}): ${fromChain} days from ${readings.length} getTokenSupply readings${hist}${miss}; supply now ${now.amount.toFixed(0)} at slot ${now.slot}`,
    token: { tokenRef: ref, symbol: text(params, 'mint', 'token') === 'token' ? ctx.asset.symbol : text(params, 'mint', 'token'), decimals: null, coingeckoId: null },
  };
}

export const solanaAdapters: AdapterDef[] = [
  { name: 'solana.token_supply', needsRpc: false, run: tokenSupplyLevel },
  { name: 'solana.owner_balance', needsRpc: false, run: ownerBalanceLevel },
  {
    name: 'solana.supply_less_owners',
    needsRpc: false,
    paramsDoc: 'mint: contract name, subtract: contract names of owners (not token accounts), rpc_url_env? (ORION_SOL_RPC_URL). getTokenSupply of the mint less each owner\'s balance over all its token accounts (getTokenAccountsByOwner), finalized, at fetch time; refused when not positive.',
    validateParams: validateSupplyLessOwners,
    run: supplyLessOwners,
  },
  {
    name: 'solana.owners_balance',
    needsRpc: false,
    paramsDoc: 'mint: contract name, owners: contract names of owners (not token accounts), rpc_url_env? (ORION_SOL_RPC_URL). The sum of each owner\'s balance of the mint over all its token accounts (getTokenAccountsByOwner), finalized, at fetch time: what solana.supply_less_owners subtracts, as a level.',
    validateParams: validateOwnersBalance,
    run: ownersBalance,
  },
  { name: 'solana.supply_burn_daily', needsRpc: false, run: supplyBurnDaily, computedFrom: ['solana.token_supply'] },
];
