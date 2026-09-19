import { failed, level, narrow, type SourceHandler } from '../types.js';
import { toFiniteNumber } from '../units.js';

export const COINGECKO_API = 'https://api.coingecko.com/api/v3';

/** The demo-key header, when a key is configured. Keyless works too, at a lower rate limit. */
export function coingeckoHeaders(env: Record<string, string | undefined>): Record<string, string> {
  return env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY } : {};
}

const FIELD = { price: 'current_price', market_cap: 'market_cap', circulating_supply: 'circulating_supply' } as const;

/** All coingecko metrics of an asset come from one /coins/markets call. */
export const coingeckoSource: SourceHandler = {
  id: 'coingecko',
  async fetch(requests, ctx) {
    const sources = requests.map((r) => narrow(r.source, 'coingecko'));
    const ids = [...new Set(sources.map((s) => s.id))].sort();
    const url = `${COINGECKO_API}/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(',')}`;
    const body = await ctx.http.getJson(url, coingeckoHeaders(ctx.env));
    if (!Array.isArray(body)) throw new Error('coingecko: /coins/markets did not return an array');

    const rows = new Map<string, Record<string, unknown>>();
    for (const row of body) {
      if (row !== null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
        rows.set((row as { id: string }).id, row as Record<string, unknown>);
      }
    }
    return sources.map((s) => {
      const row = rows.get(s.id);
      if (!row) return failed(`coingecko: no market row for id "${s.id}"`);
      const value = toFiniteNumber(row[FIELD[s.field]]);
      if (value === null) return failed(`coingecko: ${s.id}.${FIELD[s.field]} is not a finite number`);
      return level(value, ctx.nowIso, 'api', `coingecko /coins/markets ${s.id}.${FIELD[s.field]}`);
    });
  },
};
