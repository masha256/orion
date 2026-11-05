import { asJson } from '../../provenance/types.js';
import { OrionError } from '../../types.js';
import { failed, level, narrow, type SourceHandler } from '../types.js';
import { toFiniteNumber } from '../units.js';

/** The public (keyless or demo-key) API. */
export const COINGECKO_API = 'https://api.coingecko.com/api/v3';
/** The paid plans' API (Basic and up), keyed with `x-cg-pro-api-key`. */
export const COINGECKO_PRO_API = 'https://pro-api.coingecko.com/api/v3';

type Env = Record<string, string | undefined>;

/** `COINGECKO_PLAN`: unset (or blank) and `demo` are the public API; `pro` is a paid plan. Anything else is refused. */
function coingeckoPlan(env: Env): 'demo' | 'pro' {
  const plan = env.COINGECKO_PLAN ?? '';
  if (plan === '' || plan === 'demo') return 'demo';
  if (plan === 'pro') return 'pro';
  throw new OrionError('invalid_coingecko_plan', `COINGECKO_PLAN must be demo or pro (or unset), not "${plan}"`);
}

/** Every CoinGecko URL starts here. */
export function coingeckoBase(env: Env): string {
  return coingeckoPlan(env) === 'pro' ? COINGECKO_PRO_API : COINGECKO_API;
}

/** The key header for the plan, when a key is configured. Keyless works too on the public API, at a lower rate limit. */
export function coingeckoHeaders(env: Env): Record<string, string> {
  const header = coingeckoPlan(env) === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
  return env.COINGECKO_API_KEY ? { [header]: env.COINGECKO_API_KEY } : {};
}

const FIELD = { price: 'current_price', market_cap: 'market_cap', circulating_supply: 'circulating_supply', total_supply: 'total_supply' } as const;

/** All coingecko metrics of an asset come from one /coins/markets call. */
export const coingeckoSource: SourceHandler = {
  id: 'coingecko',
  async fetch(requests, ctx) {
    const sources = requests.map((r) => narrow(r.source, 'coingecko'));
    const ids = [...new Set(sources.map((s) => s.id))].sort();
    const url = `${coingeckoBase(ctx.env)}/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(',')}`;
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
      // The slice: the market row's id and the field read.
      return level(value, ctx.nowIso, 'api', `coingecko /coins/markets ${s.id}.${FIELD[s.field]}`, { id: s.id, [FIELD[s.field]]: asJson(row[FIELD[s.field]]) });
    });
  },
};
