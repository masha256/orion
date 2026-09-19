import { describe, expect, it } from 'vitest';
import { createHttpTransport, HttpError, withRunCache, type HttpDeps, type HttpOptions } from '../../src/ingest/transport/http.js';

interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function harness(responses: (FakeResponse | Error)[], options: Partial<HttpOptions> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const deps: HttpDeps = {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, at: t });
      const r = responses.shift();
      if (!r) throw new Error('test bug: no response queued');
      if (r instanceof Error) throw r;
      return { status: r.status, headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? '' };
    },
  };
  return { http: createHttpTransport(deps, options), sleeps, calls };
}

const ok = (value: unknown): FakeResponse => ({ status: 200, body: JSON.stringify(value) });

describe('http transport', () => {
  it('returns parsed JSON and sends the headers it was given', async () => {
    const h = harness([ok({ a: 1 })]);
    expect(await h.http.getJson('https://x.test/a', { 'x-key': 'k' })).toEqual({ a: 1 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].headers).toMatchObject({ accept: 'application/json', 'x-key': 'k' });
    expect(h.sleeps).toEqual([]);
  });

  it('retries a 5xx with exponential backoff from one second', async () => {
    const h = harness([{ status: 503 }, { status: 500 }, ok({ done: true })]);
    expect(await h.http.getJson('https://x.test/a')).toEqual({ done: true });
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it('gives up after three attempts and reports the status', async () => {
    const h = harness([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const err = await h.http.getJson('https://x.test/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it('retries a rejected fetch (timeout or network error)', async () => {
    const h = harness([new Error('The operation was aborted due to timeout'), ok(1)]);
    expect(await h.http.getJson('https://x.test/a')).toBe(1);
    expect(h.sleeps).toEqual([1000]);
  });

  it('does not retry a 404', async () => {
    const h = harness([{ status: 404 }, ok(1)]);
    await expect(h.http.getJson('https://x.test/a')).rejects.toThrow(/HTTP 404/);
    expect(h.calls).toHaveLength(1);
  });

  it('retries a failed body read like a rejected fetch, with the URL in the message', async () => {
    let t = 1_000_000;
    let call = 0;
    const sleeps: number[] = [];
    const deps: HttpDeps = {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      fetch: async () => {
        call++;
        if (call === 1) return { status: 200, headers: { get: () => null }, text: async () => Promise.reject(new Error('stream reset')) };
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true }) };
      },
    };
    const http = createHttpTransport(deps);
    expect(await http.getJson('https://x.test/a')).toEqual({ ok: true });
    expect(sleeps).toEqual([1000]);
  });

  it('does not retry a 2xx body that is not JSON', async () => {
    const h = harness([{ status: 200, body: '<html>' }, ok(1)]);
    await expect(h.http.getJson('https://x.test/a')).rejects.toThrow(/not JSON/);
    expect(h.calls).toHaveLength(1);
  });

  it('honors Retry-After in seconds on a 429', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': '5' } }, ok(1)]);
    expect(await h.http.getJson('https://x.test/a')).toBe(1);
    expect(h.sleeps).toEqual([5000]);
  });

  it('honors Retry-After as an HTTP date', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': new Date(1_000_000 + 7000).toUTCString() } }, ok(1)]);
    expect(await h.http.getJson('https://x.test/a')).toBe(1);
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThan(6000 - 1000); // HTTP dates have one-second resolution
    expect(h.sleeps[0]).toBeLessThanOrEqual(7000);
  });

  it('fails at once, without sleeping, when Retry-After exceeds sixty seconds', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': '1200' } }, ok(1)]);
    await expect(h.http.getJson('https://x.test/a')).rejects.toThrow(/Retry-After/);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('spaces requests to one host, and only that host', async () => {
    const h = harness([ok(1), ok(2), ok(3), ok(4)]);
    await h.http.getJson('https://api.coingecko.com/api/v3/a');
    await h.http.getJson('https://api.coingecko.com/api/v3/b');
    await h.http.getJson('https://x.test/a');
    await h.http.getJson('https://x.test/b');
    expect(h.sleeps).toEqual([2500, 250]);
    expect(h.calls[1].at - h.calls[0].at).toBe(2500);
  });

  it('caches one request per URL per run, failures included', async () => {
    const h = harness([ok({ n: 1 }), { status: 404 }]);
    const cached = withRunCache(h.http);
    expect(await cached.getJson('https://x.test/a')).toEqual({ n: 1 });
    expect(await cached.getJson('https://x.test/a')).toEqual({ n: 1 });
    await expect(cached.getJson('https://x.test/b')).rejects.toThrow(/404/);
    await expect(cached.getJson('https://x.test/b')).rejects.toThrow(/404/);
    expect(h.calls).toHaveLength(2);
  });
});
