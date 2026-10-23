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

interface Tranches {
  first: string;
  every_months: number;
  count: number;
}

const UNLOCKS_KEYS = ['url', 'allocations', 'tranches'];
const TRANCHE_KEYS = ['first', 'every_months', 'count'];

/** `y-m-d` moved by `months` (negative allowed), same day of month clamped to the month's end, as UTC midnight in ms. */
function addMonthsClamped(y: number, m: number, d: number, months: number): number {
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d, lastDay));
}

/** A real calendar date written YYYY-MM-DD, as [y, m, d]; else null. */
function isoDate(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function validateUnlocksParams(params: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const k of Object.keys(params)) if (!UNLOCKS_KEYS.includes(k)) issues.push(`unknown key "${k}" (${UNLOCKS_KEYS.join(', ')})`);
  if (params.url !== undefined && typeof params.url !== 'string') issues.push('url: a string');
  const a = params.allocations;
  if (!Array.isArray(a) || a.length === 0 || !a.every((x) => typeof x === 'string')) issues.push('allocations: a non-empty list of DefiLlama allocation labels (strings)');
  const t = params.tranches;
  if (t === undefined) return issues;
  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    issues.push('tranches: an object { first: YYYY-MM-DD, every_months: 1..12, count: 1..120 }');
    return issues;
  }
  const tr = t as Record<string, unknown>;
  for (const k of Object.keys(tr)) if (!TRANCHE_KEYS.includes(k)) issues.push(`tranches: unknown key "${k}" (${TRANCHE_KEYS.join(', ')})`);
  if (isoDate(tr.first) === null) issues.push(`tranches.first: a calendar date YYYY-MM-DD, not ${JSON.stringify(tr.first ?? null)}`);
  if (!intIn(tr.every_months, 1, 12)) issues.push(`tranches.every_months: an integer 1..12, not ${JSON.stringify(tr.every_months ?? null)}`);
  if (!intIn(tr.count, 1, 120)) issues.push(`tranches.count: an integer 1..120, not ${JSON.stringify(tr.count ?? null)}`);
  return issues;
}

/**
 * Tokens unlocking over the next 365 days from the named allocations (Team, Investors), from DefiLlama's emissions
 * dataset: no vesting contract holds them on chain (the large holders are plain wallets, 2026-10-16), so this is the
 * asset-specific series DefiLlama is allowed for (Mike, 2026-10-11). Report-only dilution: these tokens are already in
 * total supply. Each allocation's `unlocked` is cumulative; the rate is unlocked(now + 365d) - unlocked(now).
 *
 * With `params.tranches` (the issuer's own schedule, when it differs from DefiLlama's curve): each allocation's amount
 * A = its final cumulative minus its cumulative at the schedule start (`first` minus `every_months`), split into `count`
 * equal tranches on `first + k * every_months` (same day of month, clamped to the month's end, UTC); the rate is the
 * tranches dated in (now, now + 365d].
 */
async function unlocksNextYear(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const url = text(params, 'url', 'https://defillama-datasets.llama.fi/emissions/lighter');
  const labels = Array.isArray(params.allocations) ? params.allocations.filter((x): x is string => typeof x === 'string') : [];
  if (labels.length === 0) throw new Error('params.allocations (the allocation labels to sum, e.g. [Team, Investors]) is required');
  let tranches: Tranches | undefined;
  if (params.tranches !== undefined) {
    const bad = validateUnlocksParams(params).filter((e) => e.startsWith('tranches'));
    if (bad.length > 0) throw new Error(`params.${bad.join('; ')}`);
    tranches = params.tranches as Tranches;
  }
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
    const next = tranches ? inTranches(rows, at, tranches, nowSec) : at(rows, nowSec + 365 * 86_400) - at(rows, nowSec);
    total += next;
    parts.push(`${label} ${(next / 1e6).toFixed(2)}M`);
  }
  const schedule = tranches ? `; tranches ${tranches.count} x ${tranches.every_months}mo from ${tranches.first}` : '';
  return { kind: 'level', value: total, observedAt: ctx.nowIso, source: 'api', detail: `${url} unlocks over the next 365 days: ${parts.join(', ')}${schedule}` };
}

/** One allocation's tokens unlocking in (now, now + 365d] on the tranche schedule (see unlocksNextYear). */
function inTranches<R extends { unlocked: number }>(rows: R[], at: (rows: R[], t: number) => number, tr: Tranches, nowSec: number): number {
  const [y, m, d] = isoDate(tr.first)!;
  const startSec = addMonthsClamped(y, m, d, -tr.every_months) / 1000;
  const finalCumulative = rows.length > 0 ? rows[rows.length - 1].unlocked : 0;
  const remaining = finalCumulative - at(rows, startSec);
  const endSec = nowSec + 365 * 86_400;
  let due = 0;
  for (let k = 0; k < tr.count; k++) {
    const t = addMonthsClamped(y, m, d, k * tr.every_months) / 1000;
    if (t > nowSec && t <= endSec) due++;
  }
  return (remaining / tr.count) * due;
}

export const litAdapters: AdapterDef[] = [
  { name: 'lit.treasury_buys_daily', needsRpc: false, run: treasuryBuysDaily },
  {
    name: 'lit.unlocks_next_year',
    needsRpc: false,
    paramsDoc:
      "allocations: string[] (DefiLlama allocation labels, required); tranches?: { first: YYYY-MM-DD, every_months: 1..12, count: 1..120 }: the issuer's own tranche schedule; each allocation's remaining amount from the schedule start is split evenly over the tranches",
    validateParams: validateUnlocksParams,
    run: unlocksNextYear,
  },
];
