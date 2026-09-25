export interface HttpTransport {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  /** POST `body` as JSON and parse the JSON reply, with GET's retries, timeout, and errors. For adapters: no declarative source posts. */
  postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Everything the transport needs from the outside world, so tests can run it on a fake clock. */
export interface HttpDeps {
  fetch(url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<HttpResponseLike>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface HttpOptions {
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
  maxRetryAfterMs: number;
  defaultSpacingMs: number;
  hostSpacingMs: Record<string, number>;
}

export const DEFAULT_HTTP_OPTIONS: HttpOptions = {
  timeoutMs: 15_000,
  attempts: 3,
  backoffMs: 1000,
  maxRetryAfterMs: 60_000,
  defaultSpacingMs: 250,
  // Keyless CoinGecko allows about two rapid requests and then answers 429.
  hostSpacingMs: { 'api.coingecko.com': 2500 },
};

/** Retry-After is either a number of seconds or an HTTP date. Returns milliseconds to wait, or null. */
function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export function createHttpTransport(deps: HttpDeps, options: Partial<HttpOptions> = {}): HttpTransport {
  const o: HttpOptions = { ...DEFAULT_HTTP_OPTIONS, ...options };
  const lastStart = new Map<string, number>();

  const waitForSlot = async (host: string): Promise<void> => {
    const last = lastStart.get(host);
    if (last !== undefined) {
      const wait = last + (o.hostSpacingMs[host] ?? o.defaultSpacingMs) - deps.now();
      if (wait > 0) await deps.sleep(wait);
    }
    lastStart.set(host, deps.now());
  };

  const request = async (method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: string): Promise<unknown> => {
    const host = new URL(url).host;
    let failure = new HttpError(`${url}: no attempt was made`, null);
    for (let attempt = 1; attempt <= o.attempts; attempt++) {
      await waitForSlot(host);
      let delay = o.backoffMs * 2 ** (attempt - 1);
      let res: HttpResponseLike;
      let text: string | undefined;
      try {
        res = await deps.fetch(url, { method, headers: { accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(o.timeoutMs) });
        // Reading the body can fail the same way the request itself can (a timeout or reset mid-read);
        // it belongs inside the same retry path, not after it.
        if (res.status >= 200 && res.status < 300) text = await res.text();
      } catch (err) {
        failure = new HttpError(`${url}: ${err instanceof Error ? err.message : String(err)}`, null);
        if (attempt < o.attempts) await deps.sleep(delay);
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        try {
          return JSON.parse(text!) as unknown;
        } catch {
          throw new HttpError(`${url}: the response is not JSON`, res.status);
        }
      }
      failure = new HttpError(`${url}: HTTP ${res.status}`, res.status);
      if (res.status !== 429 && res.status < 500) throw failure;
      const retryAfter = retryAfterMs(res.headers.get('retry-after'), deps.now());
      if (retryAfter !== null) {
        if (retryAfter > o.maxRetryAfterMs) {
          throw new HttpError(
            `${url}: HTTP ${res.status} with Retry-After ${Math.ceil(retryAfter / 1000)}s, above the ${o.maxRetryAfterMs / 1000}s limit`,
            res.status,
          );
        }
        delay = retryAfter;
      }
      if (attempt < o.attempts) await deps.sleep(delay);
    }
    throw failure;
  };

  return {
    getJson: (url, headers = {}) => request('GET', url, headers),
    // The body is serialised once, here, so a retry posts the same bytes.
    postJson: (url, body, headers = {}) => request('POST', url, { 'content-type': 'application/json', ...headers }, JSON.stringify(body)),
  };
}

export function realHttpDeps(): HttpDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** One request per URL (and, for a POST, per body) per run. A failure is cached too: the transport already retried it. */
export function withRunCache(inner: HttpTransport): HttpTransport {
  const cache = new Map<string, Promise<unknown>>();
  const once = (key: string, make: () => Promise<unknown>): Promise<unknown> => {
    let pending = cache.get(key);
    if (!pending) {
      pending = make();
      cache.set(key, pending);
    }
    return pending;
  };
  return {
    getJson: (url, headers) => once(`GET ${url}`, () => inner.getJson(url, headers)),
    postJson: (url, body, headers) => once(`POST ${url} ${JSON.stringify(body)}`, () => inner.postJson(url, body, headers)),
  };
}
