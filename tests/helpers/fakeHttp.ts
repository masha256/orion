import type { HttpTransport } from '../../src/ingest/transport/http.js';

/** A function route sees the URL and, for a POST, the body: one URL can answer several request types. */
export type Route = unknown | Error | ((url: string, body?: unknown) => unknown);

export interface FakeHttp extends HttpTransport {
  calls: { url: string; headers: Record<string, string>; method: 'GET' | 'POST'; body?: unknown }[];
}

/** A route key matches a URL that equals it or starts with it; the longest matching key wins. */
export function fakeHttp(routes: Record<string, Route>): FakeHttp {
  const calls: FakeHttp['calls'] = [];
  const answer = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown): unknown => {
    calls.push({ url, headers, method, body });
    const key = Object.keys(routes)
      .filter((k) => url === k || url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`fakeHttp: no route for ${url}`);
    const route = routes[key];
    if (route instanceof Error) throw route;
    return typeof route === 'function' ? (route as (u: string, b?: unknown) => unknown)(url, body) : structuredClone(route);
  };
  return {
    calls,
    async getJson(url, headers = {}) {
      return answer('GET', url, headers);
    },
    async postJson(url, body, headers = {}) {
      return answer('POST', url, headers, body);
    },
    /** A text read answers a string route; any other route is a test bug, so it throws. */
    async getText(url, headers = {}) {
      const v = answer('GET', url, headers);
      if (typeof v !== 'string') throw new Error(`fakeHttp: the route for ${url} is not text`);
      return v;
    },
  };
}
