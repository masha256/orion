import type { HttpTransport } from '../../src/ingest/transport/http.js';

export type Route = unknown | Error | ((url: string) => unknown);

export interface FakeHttp extends HttpTransport {
  calls: { url: string; headers: Record<string, string> }[];
}

/** A route key matches a URL that equals it or starts with it; the longest matching key wins. */
export function fakeHttp(routes: Record<string, Route>): FakeHttp {
  const calls: FakeHttp['calls'] = [];
  return {
    calls,
    async getJson(url, headers = {}) {
      calls.push({ url, headers });
      const key = Object.keys(routes)
        .filter((k) => url === k || url.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) throw new Error(`fakeHttp: no route for ${url}`);
      const route = routes[key];
      if (route instanceof Error) throw route;
      return typeof route === 'function' ? (route as (u: string) => unknown)(url) : structuredClone(route);
    },
  };
}
