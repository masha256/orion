import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber } from '../units.js';
import { number, text } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Lighter (LIT). The protocol buys LIT on its own L2 exchange: the treasury account (index 0, also the fee account) bids
 * on the LIT/USDC spot market (2049) every day with part of the trading fees (Mike, 2026-10-16: the holder flow is read
 * from Lighter's own data, not DefiLlama). The bought LIT is withdrawn to L1 and an equal count is burned from the
 * ecosystem reserve each quarter, so on a total-supply basis the buys are a buyback-and-burn (discretionary).
 */

const DEFAULT_API = 'https://mainnet.zklighter.elliot.ai/api/v1';
const PAGE = 100;
const MS_PER_DAY = 86_400_000;

function amount(v: unknown, what: string): number {
  const n = toFiniteNumber(v);
  if (n === null) throw new Error(`${what} is missing or not a number in Lighter's reply`);
  return n;
}

/**
 * USDC the treasury account spent per completed UTC day buying LIT (`unit: usd`; or the LIT bought, `unit: tokens`): sum of price x size over its trades on `market` where
 * it is the bid. The trades endpoint pages newest first (100 a page, `next_cursor`), so the read walks back from now
 * until it passes the first day wanted; a day is only returned when the walk reached its start, so a page cut short
 * never stores a partial day. Days: the run's `--backfill-days` when given, else `params.days` (default 7), which
 * covers the writer's 3 revision days with room for a missed run or two.
 */
async function treasuryBuysDaily(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const api = text(params, 'api', DEFAULT_API).replace(/\/$/, '');
  const account = number(params, 'account', 0);
  const market = number(params, 'market', -1);
  if (market < 0) throw new Error('params.market (the LIT/USDC spot market id, e.g. 2049) is required');
  const days = ctx.backfillDays ?? number(params, 'days', 7);
  const unit = text(params, 'unit', 'usd');
  if (unit !== 'usd' && unit !== 'tokens') throw new Error(`params.unit must be usd or tokens, not ${unit}`);
  // About 430 treasury trades a day on 2026-10-16 (4.3 pages); the cap allows ten times that before it fails the read.
  const maxPages = number(params, 'max_pages_per_day', 50) * days + 20;

  const todayStart = Math.floor(Date.parse(ctx.nowIso) / MS_PER_DAY) * MS_PER_DAY;
  const windowStart = todayStart - days * MS_PER_DAY;
  const buys = new Map<string, number>();
  let sells = 0;
  let trades = 0;
  let reachedStart = false;
  let oldestSeen = Number.POSITIVE_INFINITY;
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new Error(`trades: ${pages} pages read without reaching ${new Date(windowStart).toISOString().slice(0, 10)}; refusing a partial series`);
    const url = `${api}/trades?account_index=${account}&market_id=${market}&sort_by=timestamp&limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const reply = (await ctx.http.getJson(url)) as { code?: unknown; trades?: unknown; next_cursor?: unknown };
    pages++;
    if (!reply || !Array.isArray(reply.trades)) throw new Error("trades: Lighter's reply has no trades list");
    for (const t of reply.trades as Record<string, unknown>[]) {
      const ts = amount(t.timestamp, 'a trade timestamp');
      oldestSeen = Math.min(oldestSeen, ts);
      if (ts < windowStart) {
        reachedStart = true;
        continue;
      }
      if (ts >= todayStart) continue;
      if (amount(t.market_id, 'a trade market_id') !== market) continue;
      const size = amount(t.size, 'a trade size');
      const usd = amount(t.price, 'a trade price') * size;
      trades++;
      if (amount(t.bid_account_id, 'a trade bid_account_id') === account) {
        const day = new Date(ts).toISOString().slice(0, 10);
        buys.set(day, (buys.get(day) ?? 0) + (unit === 'usd' ? usd : size));
      } else if (amount(t.ask_account_id, 'a trade ask_account_id') === account) sells += usd;
    }
    cursor = typeof reply.next_cursor === 'string' && reply.next_cursor !== '' ? reply.next_cursor : null;
    if (reachedStart || cursor === null || reply.trades.length === 0) break;
  }
  if (buys.size === 0) throw new Error(`trades: no buy by account ${account} on market ${market} in the last ${days} days`);

  // The API's memory ended before the window began: the oldest day it returned is partial, so start the day after it.
  const firstMs = reachedStart ? windowStart : Math.floor(oldestSeen / MS_PER_DAY) * MS_PER_DAY + MS_PER_DAY;
  const points: { day: string; value: number }[] = [];
  // The treasury buys every day (146 of 146 days to 2026-10-16), so a day inside the walk with no buy is a real zero.
  for (let ms = firstMs; ms < todayStart; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    points.push({ day, value: buys.get(day) ?? 0 });
  }
  const sold = sells > 0 ? `; SOLD ${sells.toFixed(0)} USD of LIT (not netted)` : '';
  const short = reachedStart ? '' : `; history ends ${new Date(oldestSeen).toISOString().slice(0, 10)}`;
  return { kind: 'daily_series', points, detail: `lighter trades account ${account} market ${market} ${unit === 'usd' ? 'buys' : 'LIT bought'} (${trades} trades, ${pages} pages${short}${sold})` };
}

/**
 * Tokens unlocking over the next 365 days from the named allocations (Team, Investors), from DefiLlama's emissions
 * dataset: no vesting contract holds them on chain (the large holders are plain wallets, 2026-10-16), so this is the
 * asset-specific series DefiLlama is allowed for (Mike, 2026-10-11). Report-only dilution: these tokens are already in
 * total supply. Each allocation's `unlocked` is cumulative; the rate is unlocked(now + 365d) - unlocked(now).
 */
async function unlocksNextYear(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const url = text(params, 'url', 'https://defillama-datasets.llama.fi/emissions/lighter');
  const labels = Array.isArray(params.allocations) ? params.allocations.filter((x): x is string => typeof x === 'string') : [];
  if (labels.length === 0) throw new Error('params.allocations (the allocation labels to sum, e.g. [Team, Investors]) is required');
  const body = (await ctx.http.getJson(url)) as { documentedData?: { data?: { label?: unknown; data?: unknown }[] } };
  const series = body?.documentedData?.data;
  if (!Array.isArray(series)) throw new Error(`${url}: no documentedData.data`);
  const nowSec = Date.parse(ctx.nowIso) / 1000;
  const at = (rows: { timestamp: number; unlocked: number }[], t: number) => {
    let v = 0;
    for (const r of rows) {
      if (r.timestamp > t) break;
      v = r.unlocked;
    }
    return v;
  };
  let total = 0;
  const parts: string[] = [];
  for (const label of labels) {
    const s = series.find((x) => x.label === label);
    if (!s || !Array.isArray(s.data)) throw new Error(`${url}: no allocation "${label}"`);
    const rows = (s.data as Record<string, unknown>[])
      .map((r) => ({ timestamp: amount(r.timestamp, `${label} timestamp`), unlocked: amount(r.unlocked, `${label} unlocked`) }))
      .sort((a, b) => a.timestamp - b.timestamp);
    const next = at(rows, nowSec + 365 * 86_400) - at(rows, nowSec);
    total += next;
    parts.push(`${label} ${(next / 1e6).toFixed(2)}M`);
  }
  return { kind: 'level', value: total, observedAt: ctx.nowIso, source: 'api', detail: `${url} unlocks over the next 365 days: ${parts.join(', ')}` };
}

export const litAdapters: AdapterDef[] = [
  { name: 'lit.treasury_buys_daily', needsRpc: false, run: treasuryBuysDaily },
  { name: 'lit.unlocks_next_year', needsRpc: false, run: unlocksNextYear },
];
