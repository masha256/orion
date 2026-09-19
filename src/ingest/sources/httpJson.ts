import { failed, level, narrow, type ReadingResult, type SourceHandler } from '../types.js';
import { toFiniteNumber } from '../units.js';

/** Dot path into parsed JSON. Numeric segments index arrays. Undefined when any step is missing. */
export function readPath(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A level from one field of a JSON endpoint: scale * value / 10^decimals, stamped at fetch time. */
export const httpJsonSource: SourceHandler = {
  id: 'http_json',
  async fetch(requests, ctx) {
    const bodies = new Map<string, { body: unknown } | { error: string }>();
    const results: ReadingResult[] = [];
    for (const r of requests) {
      const s = narrow(r.source, 'http_json');
      let fetched = bodies.get(s.url);
      if (!fetched) {
        try {
          fetched = { body: await ctx.http.getJson(s.url) };
        } catch (err) {
          fetched = { error: err instanceof Error ? err.message : String(err) };
        }
        bodies.set(s.url, fetched);
      }
      if ('error' in fetched) {
        results.push(failed(fetched.error));
        continue;
      }
      const raw = toFiniteNumber(readPath(fetched.body, s.path));
      results.push(
        raw === null
          ? failed(`http_json: "${s.path}" is not a finite number in ${s.url}`)
          : level((s.scale * raw) / 10 ** s.decimals, ctx.nowIso, 'api', `${s.url} ${s.path}`),
      );
    }
    return results;
  },
};
