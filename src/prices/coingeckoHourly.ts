import type { PriceRow } from '../db/prices.js';
import { MS_PER_HOUR } from '../db/prices.js';
import { parseMarketChart, type PricePoint } from '../ingest/flow.js';
import { coingeckoBase, coingeckoHeaders } from '../ingest/sources/coingecko.js';
import type { HttpTransport } from '../ingest/transport/http.js';
import { MS_PER_DAY } from '../types.js';

/** The `prices.source` of every CoinGecko row. */
export const COINGECKO_PRICE_SOURCE = 'coingecko';

/**
 * CoinGecko market_chart points as hourly price rows: each point floored to the top of its UTC hour, and of two points
 * in one hour the earlier kept (the hourly point, not the live "now" point the series ends with), so a re-fetch maps to
 * the same rows. Daily points must not be passed in: a daily point is not an hour's price.
 */
export function hourlyPriceRows(points: PricePoint[]): PriceRow[] {
  const byHour = new Map<number, PricePoint>();
  for (const p of points) {
    const hour = Math.floor(p.ts / MS_PER_HOUR) * MS_PER_HOUR;
    const have = byHour.get(hour);
    if (have === undefined || p.ts < have.ts) byHour.set(hour, p);
  }
  return [...byHour.entries()].sort(([a], [b]) => a - b).map(([hour, p]) => ({ ts: new Date(hour).toISOString(), priceUsd: p.price }));
}

/**
 * CoinGecko answers a market_chart range of 2 to 90 days with hourly points (above 90 days: daily). Windows are 89 days,
 * so a window never tips into daily granularity, and at least 2 days, so the oldest one is never 5-minutely.
 */
export const HOURLY_WINDOW_DAYS = 89;
const MIN_WINDOW_MS = 2 * MS_PER_DAY;

export interface HourlyRangeResult {
  points: PricePoint[];
  /** The start of the oldest window that answered (ms); null when none did. */
  reachedMs: number | null;
  /** One line per window that failed: the reach of the key's history (plan correction 13), or an outage. */
  failures: string[];
  requests: number;
}

/**
 * Hourly prices of `id` over [fromMs, toMs], newest window first, one request at a time through `http` (which spaces
 * CoinGecko requests: 2.5 s keyless). The first failing window stops the walk: what is older keeps `value` as its only
 * USD (correction 13), and the failure says why.
 */
export async function fetchHourlyRange(
  http: HttpTransport, env: Record<string, string | undefined>, id: string, fromMs: number, toMs: number,
): Promise<HourlyRangeResult> {
  const out: HourlyRangeResult = { points: [], reachedMs: null, failures: [], requests: 0 };
  let end = toMs;
  while (end > fromMs) {
    let start = Math.max(fromMs, end - HOURLY_WINDOW_DAYS * MS_PER_DAY);
    if (end - start < MIN_WINDOW_MS) start = end - MIN_WINDOW_MS;
    const url = `${coingeckoBase(env)}/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=usd&from=${Math.floor(start / 1000)}&to=${Math.ceil(end / 1000)}`;
    out.requests++;
    try {
      const points = parseMarketChart(await http.getJson(url, coingeckoHeaders(env)), `coingecko ${id} range`);
      out.points.push(...points.filter((p) => p.ts >= start && p.ts <= end));
      out.reachedMs = start;
    } catch (err) {
      out.failures.push(`${new Date(start).toISOString().slice(0, 10)} to ${new Date(end).toISOString().slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    end = start;
  }
  out.points.sort((a, b) => a.ts - b.ts);
  return out;
}
