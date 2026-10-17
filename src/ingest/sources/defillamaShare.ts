import { failed, level, narrow, type ReadingResult, type SourceHandler } from '../types.js';
import { DEFILLAMA_API } from './defillama.js';

interface OverviewRow {
  slug?: unknown;
  category?: unknown;
  parentProtocol?: unknown;
  total30d?: unknown;
  total1y?: unknown;
}

/** A missing, null or non-finite total counts as 0, so one bad row never turns the sum into NaN. */
const amount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * A parent protocol's share of one DefiLlama category over 30 days or a year, from the free fees/dexs overview (all
 * chains, or one). Children are grouped by `parentProtocol`, or by slug for a protocol without a parent. Only rows of the
 * requested category count, on both sides. A parent with no row in the category fails the reading (never 0: 0 is a valid
 * ratio), as does a category whose total is 0. A body without a protocols array fails the batch.
 */
export const defillamaShareSource: SourceHandler = {
  id: 'defillama_share',
  async fetch(requests, ctx) {
    const bodies = new Map<string, OverviewRow[]>();
    const results: ReadingResult[] = [];
    for (const r of requests) {
      const s = narrow(r.source, 'defillama_share');
      const url = `${DEFILLAMA_API}/overview/${s.overview}${s.chain ? '/' + encodeURIComponent(s.chain) : ''}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
      let rows = bodies.get(url);
      if (rows === undefined) {
        const body = (await ctx.http.getJson(url)) as { protocols?: unknown } | null;
        if (!Array.isArray(body?.protocols)) throw new Error(`defillama_share: ${url} has no protocols array`);
        rows = body.protocols as OverviewRow[];
        bodies.set(url, rows);
      }
      const field = s.window === '30d' ? 'total30d' : 'total1y';
      let total = 0;
      let mine = 0;
      let found = false;
      for (const row of rows) {
        if (row === null || typeof row !== 'object' || row.category !== s.category) continue;
        const v = amount(row[field]);
        total += v;
        if ((row.parentProtocol ?? row.slug) === s.parent) {
          mine += v;
          found = true;
        }
      }
      if (total === 0) {
        results.push(failed(`defillama_share: category "${s.category}" in ${url}: ${field} total is 0`));
      } else if (!found) {
        results.push(failed(`defillama_share: parent ${s.parent} not found in category "${s.category}" of ${url}`));
      } else {
        results.push(level(mine / total, ctx.nowIso, 'api', `${url}: ${s.parent} ${field} ${mine} / category "${s.category}" ${total}`));
      }
    }
    return results;
  },
};
