import { utcDay } from '../time.js';
import { narrow, type DailyPoint, type ReadingResult, type SourceHandler } from '../types.js';

export const DEFILLAMA_API = 'https://api.llama.fi';

/** A daily USD series from DefiLlama's fees summary. As a cross-check it is compared monthly; as a flow primary its days are written by src/ingest/apiFlow.ts. */
export const defillamaSource: SourceHandler = {
  id: 'defillama',
  async fetch(requests, ctx) {
    const results: ReadingResult[] = [];
    for (const r of requests) {
      const s = narrow(r.source, 'defillama');
      const url = `${DEFILLAMA_API}/summary/fees/${encodeURIComponent(s.slug)}?dataType=${encodeURIComponent(s.data_type)}`;
      const body = (await ctx.http.getJson(url)) as { totalDataChart?: unknown } | null;
      const chart = body?.totalDataChart;
      if (!Array.isArray(chart)) throw new Error(`defillama: ${url} has no totalDataChart`);
      const points: DailyPoint[] = chart.map((entry) => {
        const [ts, usd] = Array.isArray(entry) ? (entry as unknown[]) : [];
        if (typeof ts !== 'number' || typeof usd !== 'number' || !Number.isFinite(ts) || !Number.isFinite(usd)) {
          throw new Error(`defillama: malformed totalDataChart entry ${JSON.stringify(entry)}`);
        }
        return { day: utcDay(ts * 1000), value: usd };
      });
      results.push({ ok: true, value: { kind: 'daily_series', points, detail: url } });
    }
    return results;
  },
};
