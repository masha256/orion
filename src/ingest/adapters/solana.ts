import { parseMarketChart } from '../flow.js';
import { COINGECKO_API, coingeckoHeaders } from '../sources/coingecko.js';
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

/** Mean of the price points inside each UTC day. */
function dailyMeanPrice(points: { ts: number; price: number }[]): Map<string, number> {
  const sum = new Map<string, { s: number; n: number }>();
  for (const p of points) {
    const day = new Date(p.ts).toISOString().slice(0, 10);
    const v = sum.get(day) ?? { s: 0, n: 0 };
    v.s += p.price;
    v.n += 1;
    sum.set(day, v);
  }
  return new Map([...sum].map(([d, v]) => [d, v.s / v.n]));
}

/**
 * The burn flow per completed UTC day (`unit: tokens`, or `usd` at the day's mean CoinGecko price) from the fall in the
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
  const priceId = text(params, 'coingecko', ctx.asset.external_ids.coingecko ?? '');
  if (priceId === '') throw new Error('params.coingecko (or external_ids.coingecko) is required to price the burns');
  const days = ctx.backfillDays ?? (typeof params.days === 'number' ? params.days : 7);

  const now = await tokenSupply(ctx.http, rpcUrl(ctx, params), mint);
  const stored = ctx.observations(supplyMetric).filter((o) => o.source === 'onchain' && (o.sourceDetail ?? '').includes(mint));
  const readings: SupplyReading[] = [...stored.map((o) => ({ ms: Date.parse(o.observedAt), supply: o.value })), { ms: Date.parse(ctx.nowIso), supply: now.amount }];
  const onchain = burnsByDay(readings);
  const firstReadingMs = Math.min(...readings.map((r) => r.ms));

  const todayStart = Math.floor(Date.parse(ctx.nowIso) / MS_PER_DAY) * MS_PER_DAY;
  const windowStart = todayStart - days * MS_PER_DAY;
  const hourly = parseMarketChart(
    await ctx.http.getJson(`${COINGECKO_API}/coins/${encodeURIComponent(priceId)}/market_chart?vs_currency=usd&days=${Math.min(365, Math.max(2, days + 1))}`, coingeckoHeaders(ctx.env)),
    `coingecko ${priceId}`,
  );
  const price = dailyMeanPrice(hourly);

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

  const points: { day: string; value: number }[] = [];
  let fromChain = 0;
  let fromHistory = 0;
  const unpriced: string[] = [];
  for (let ms = windowStart; ms < todayStart; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const p = price.get(day);
    const tokens = onchain.get(day);
    if (tokens !== undefined) {
      if (unit === 'tokens') points.push({ day, value: tokens });
      else if (p !== undefined) points.push({ day, value: tokens * p });
      else {
        unpriced.push(day);
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
  // Two days of readings must give a completed day: a series that stays empty means the readings stopped being stored.
  if (fromChain === 0 && Date.parse(ctx.nowIso) - firstReadingMs > 2 * MS_PER_DAY) {
    throw new Error(`no completed day from ${readings.length} supply readings since ${new Date(firstReadingMs).toISOString()}`);
  }
  const hist = fromHistory > 0 ? `; ${fromHistory} days from DefiLlama ${String(h?.slug)} ${String(h?.data_type)} (before the first on-chain reading)` : '';
  const miss = unpriced.length > 0 ? `; no price for ${unpriced.join(', ')}` : '';
  return {
    kind: 'daily_series',
    points,
    detail: `solana supply drop of ${mint} (${unit}): ${fromChain} days from ${readings.length} getTokenSupply readings${hist}${miss}; supply now ${now.amount.toFixed(0)} at slot ${now.slot}`,
  };
}

export const solanaAdapters: AdapterDef[] = [
  { name: 'solana.token_supply', needsRpc: false, run: tokenSupplyLevel },
  { name: 'solana.owner_balance', needsRpc: false, run: ownerBalanceLevel },
  { name: 'solana.supply_burn_daily', needsRpc: false, run: supplyBurnDaily },
];
