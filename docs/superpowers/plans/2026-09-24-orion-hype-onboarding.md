# Orion HYPE Onboarding (Sub-project 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover HYPE (Hyperliquid) as Orion's third live asset, with every metric but one fetched, through configuration plus two small ingest additions.

**Architecture:** The HTTP transport gains `postJson`, because the Hyperliquid info API is POST only; the run cache and the test fake gain it too. Three `hype` adapters, none needing an RPC, post to that API and compute the effective supply (total less the fund and the dead addresses), the staked supply (the validators' stake summed), and the annual emission rate (the docs' inverse-square-root formula on the stake). `assets/hype.yaml` then wires CoinGecko, a DefiLlama price cross-check, the adapters, the DefiLlama holders-revenue flow (the sub-project 5 flow primary) as a `burn` holder flow, and the 90-day derived run rate; the staker emission share is the one manual metric, 1.0 by construction, which the bootstrap researches. A new persona covers the sector. No engine, driver, or bootstrap change.

**Tech Stack:** Node 22+, TypeScript (ESM, NodeNext), better-sqlite3, commander, zod 4, yaml, vitest, tsx. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-24-orion-hype-onboarding-design.md` (approved 2026-09-24). Parent specs, binding where that one is silent: `docs/superpowers/specs/2026-09-23-orion-aero-onboarding-design.md` (the `flow_annualized` derived source, the onboarding sequence, the calibration method), `docs/superpowers/specs/2026-09-22-orion-research-first-design.md` (the DefiLlama flow primary, section 8; the bootstrap, section 7), `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (sources, adapters, the HTTP transport), `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (section 3.7, the HYPE contrast case). Executors read all five. Rulings and deferred findings from earlier sub-projects: `docs/superpowers/notes/`.

## Global Constraints

- Node `>=22`. ESM only (`"type": "module"`). Relative imports end in `.js`.
- No new dependency. `package.json` and `package-lock.json` do not change.
- **No network in tests, and no live API call in CI.** Every test that fetches uses `tests/helpers/fetchHarness.ts` or its parts (`fakeHttp`, `fakeRpc`) and the recorded fixtures under `tests/fixtures/hype/`. The live dry run of this plan was made during planning from a scratch home and is recorded under Findings; the user repeats it as a checkpoint.
- **Never write to the repo-root `orion.db`** from a test, a script, or an experiment. Tests use `openDb(':memory:')` or a `mkdtempSync` home. Manual CLI checks use `ORION_HOME=$(mktemp -d)`.
- The user's shell is zsh, where a command stored in a variable is not word-split. Run multi-step CLI scripts with `bash`. macOS has no `timeout` command.
- **Source files are ASCII only.** Check with `LC_ALL=C grep -n '[^ -~]' <file>` (tabs aside). The fixtures are JSON written with ASCII escapes.
- The engine (`src/engine/**`), the drivers (`src/drivers/**`), the agent layer (`src/agent/**`), the tick, the inbox, the API-series writer (`src/ingest/apiFlow.ts`), the derived step, and the declarative source types are not touched. No declarative source posts: `postJson` exists for adapters.
- Spec decisions, verbatim: the flow is `burn`, `capture_rule: programmatic`, `recipient_base: all`; `supply_basis: effective_total` with the fund and the two dead addresses subtracted; modules `holder_cashflow` 0.6 and `forward_multiple` on holder flow 0.4, scenario probabilities 25/50/25; no revenue-basis multiple; no unlock schedule; the persona is new (`perp-exchange-analyst`).
- The research-first invariants still bind: every researched row is provisional until confirmed (HYPE has one manual metric, `staker_emission_share`, which the bootstrap records and the user confirms); the tick report and the inbox carry no model or page text; a bootstrap changes no assumption.
- `postJson` shares GET's retries, timeout, host spacing, and `HttpError`; the body is serialised once so a retry posts the same bytes; the run cache keys a POST by URL and body, never as the GET of the same URL.
- The adapters refuse by name (an `Error`, so the source fails and nothing is written): a missing or non-numeric field, an empty validator list, a zero stake, an effective supply that is not positive, an anchor rate outside (0, 1). An address named in `subtract` but absent from the API's non-circulating list subtracts zero and does not fail.
- Config hashes: the mini and vvv pins in `tests/app/cadence.test.ts` and the aero pin in `tests/assets/aero.ingest.test.ts` do not move (no new zod key or default). The hype pin is `5683e7a67bcf51284aff86ed27460364122c90259449115c4c29f0d2a38131f3`; a deliberate edit of `assets/hype.yaml` (the calibration bands, Task 4) moves it, and the pin is then updated on purpose.
- **This plan's code was executed during planning.** Every `Create` / `replace` directive below was generated from a prototype built one commit per task on a clone of `e821c57` (the spec commit on `main`), then extracted from this document into a fresh clone at the same commit by `apply_plan.py`. After EACH of Tasks 1 to 3 the full suite passed and `tsc --noEmit` was clean (the counts are in each task's last test step), the extracted tree was byte-identical to the prototype's commit, and after Task 3 `npm run build` succeeded and a live `data fetch hype --dry-run` from a throwaway home wrote every sourced metric with the price cross-check inside tolerance. So a failing test most likely means a directive was applied inexactly: re-read it before changing anything. If the plan's code really is at fault, fix the code so the test's stated intent holds; do not weaken the test.
- **Not verified during planning:** a real tick on HYPE, the bootstrap run and its staker-share row, the calibration, the first signal. Those are the user's checkpoints in Task 4.
- **Reviewers: check code against the prose rules in this plan and the spec, not only against the code listing.** In every earlier sub-project the reviews found design defects that the plan's own tests had pinned as correct. Each task below names the risks to attack.

## Directive format

Two directives carry code, and an implementer applies them exactly:

- ``Create `path`:`` followed by one fenced block: write that file. It must not exist yet.
- ``In `path`, replace:`` one fenced block, then `with:` and a second fenced block: the first block's text occurs exactly once in the file at that point; replace it with the second. Directives on one file are applied in the order given.

A fence is as long as it needs to be. The HTML comments `<!-- directives: taskN tests -->` and `<!-- directives: taskN impl -->` mark where each task's test and implementation directives begin. `.superpowers/sdd/2026-09-24-orion-hype-onboarding/apply_plan.py --plan <this file> --repo <clone> --task N --group tests|impl` (git-ignored controller tooling; `gen_plan7.py` and `verify7.sh` sit beside it) applies one group at a time and stops at the first block that does not occur exactly once.

## Findings from planning (2026-09-24)

- **The info API is POST only** (`{"type": ...}` bodies to one URL), and Orion's transport was GET only. `postJson` is one shared request loop with a method and an optional body; the fake routes a POST by URL and hands a function route the body, so one URL answers several request types.
- **Recorded fixtures.** `tests/fixtures/hype/tokenDetails.json` is the API's reply with the `genesis` block emptied (94,023 balances, 5 MB, read by nothing); `validatorSummaries.json` is the full reply (35 validators). Recorded on 2026-09-24T23:40Z: total supply 998,909,900.86; fund 47,478,177.05; stake summed 440,716,882.75 HYPE (`stake` is an integer in 8 decimals). The spec's section 2.1 figures are from earlier that day and differ in the fifth digit; the tests pin the fixtures' arithmetic, with wide sanity bounds.
- **The effective supply nets 47,479,853.5 HYPE**: the fund plus 1,673.79 at the zero address plus 2.72 at `0x...dead`; 951,430,043 against CoinGecko's total of 955,307,079 (0.4 percent, a different accounting, so no cross-check).
- **The emission formula** gives 9,480,000 HYPE a year at the docs' anchor (2.37 percent of 400M) and 9,950,804 at the recorded stake (2.258 percent). It is a formula on one read, so both adapters that need the stake post the same request; the run cache serves the second from the first.
- **A manual metric caps the grade at B.** With the staker share entered by hand the wiring test's signal is `ok` at grade B, as VVV's is with its manual revenue; without it the signal is `blocked` naming the metric. Grade A is not reachable for HYPE by design.
- **Live dry run** (`data fetch hype --dry-run` from a throwaway home, 2026-09-24T23:48Z): every source ok; price 92.11 against DefiLlama 92.105 (0.01 percent, within 2); effective supply 951,430,043.36; staked 440,716,882.75; emissions 9,950,804.31; 90 flow days written, the last complete day 2,117,271 USD; the run rate 570,241,759 USD a year.
- **Test counts.** 697 on `e821c57`; 701 after Task 1, 709 after Task 2, 713 after Task 3. The "tests first" runs fail as stated in each Step 2.

## File Structure

```
src/ingest/transport/http.ts          HttpTransport.postJson; one request loop for GET and POST; the run cache keyed by method, URL, body   (modify, Task 1)
tests/helpers/fakeHttp.ts             postJson on the fake; a function route sees the body; calls record method and body                 (modify, Task 1)
src/ingest/adapters/hype.ts           hype.effective_supply, hype.staked_supply, hype.emission_rate_annual                             (create, Task 2)
src/ingest/adapters/registry.ts       registers hypeAdapters                                                                           (modify, Task 2)
tests/fixtures/hype/*.json            recorded info API replies                                                                        (create, Task 2)
assets/hype.yaml                      the asset file                                                                                   (create, Task 3)
personas/perp-exchange-analyst.md     the persona                                                                                      (create, Task 3)
README.md, docs/ops/hermes-daily-job.md   one command line; the job note names the assets                                              (modify, Task 3)
```

Test files: `tests/ingest/http.test.ts` (Task 1), `tests/ingest/adapters.hype.test.ts` (Task 2, new), `tests/assets/hype.ingest.test.ts` (Task 3, new), `tests/assets/aero.ingest.test.ts` and `tests/assets/vvv.agent.test.ts` (Task 3, the persona list).

---

### Task 1: `postJson` on the HTTP transport

**Spec:** section 4.

**Files:**
- Modify: `src/ingest/transport/http.ts`, `tests/helpers/fakeHttp.ts`
- Test: `tests/ingest/http.test.ts`

**Interfaces:**
- Consumes: `HttpTransport`, `HttpDeps.fetch`, `HttpError`, `withRunCache`; the fake's `Route` and `calls`.
- Produces: `HttpTransport.postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>`; `HttpDeps.fetch(url, init: { method: 'GET' | 'POST'; headers; body?: string; signal })`; the fake's `Route` may be `(url: string, body?: unknown) => unknown` and its `calls` carry `method` and `body`.

**What binds, from the spec.** 4: `postJson` sends the body as JSON with `content-type: application/json` and shares GET's retries, timeout, response-size limit (there is none to share: the transport reads the body whole; the reviewer should confirm no size limit exists for GET either), and `HttpError`; the fake gains the same method, routed by URL and body; no declarative source uses it.

**Risks for the reviewer to attack.** (1) The refactor folds `getJson` into a shared `request`: is GET's behaviour byte-for-byte the same (headers, retry on 429 and 5xx only, Retry-After handling, the not-JSON error, host spacing)? The existing tests must pass unchanged. (2) `JSON.stringify(body)` of `undefined` gives `undefined`, posting no body; is that a caller error worth refusing? (3) The run cache key includes `JSON.stringify(body)`: two bodies with the same fields in a different order are two requests. Acceptable for adapters that build their own bodies? (4) A POST to a 4xx is not retried, like a GET; the info API answers 422 for a malformed body and 429 under load; is 429 handled the same for POST? (5) `realHttpDeps` passes `init` straight to `fetch`: a `body` of `undefined` on a GET is fine for Node's fetch; confirm.

- [ ] **Step 1: Write the failing tests**

<!-- directives: task1 tests -->

In `tests/helpers/fakeHttp.ts`, replace:

```
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
```

with:

```
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
  };
}
```

In `tests/ingest/http.test.ts`, replace:

```
function harness(responses: (FakeResponse | Error)[], options: Partial<HttpOptions> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const deps: HttpDeps = {
    now: () => t,
    sleep: async (ms) => {
```

with:

```
function harness(responses: (FakeResponse | Error)[], options: Partial<HttpOptions> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; headers: Record<string, string>; at: number; method: string; body?: string }[] = [];
  const deps: HttpDeps = {
    now: () => t,
    sleep: async (ms) => {
```

In `tests/ingest/http.test.ts`, replace:

```
      t += ms;
    },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, at: t });
      const r = responses.shift();
      if (!r) throw new Error('test bug: no response queued');
      if (r instanceof Error) throw r;
```

with:

```
      t += ms;
    },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, at: t, method: init.method, body: init.body });
      const r = responses.shift();
      if (!r) throw new Error('test bug: no response queued');
      if (r instanceof Error) throw r;
```

In `tests/ingest/http.test.ts`, replace:

```
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].headers).toMatchObject({ accept: 'application/json', 'x-key': 'k' });
    expect(h.sleeps).toEqual([]);
  });

  it('retries a 5xx with exponential backoff from one second', async () => {
```

with:

```
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].headers).toMatchObject({ accept: 'application/json', 'x-key': 'k' });
    expect(h.sleeps).toEqual([]);
  });

  it('posts a body as JSON with the content type set, and parses the reply', async () => {
    const h = harness([ok({ totalSupply: '1' })]);
    expect(await h.http.postJson('https://x.test/info', { type: 'tokenDetails', tokenId: '0x1' }, { 'x-key': 'k' })).toEqual({ totalSupply: '1' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', body: '{"type":"tokenDetails","tokenId":"0x1"}' });
    expect(h.calls[0].headers).toMatchObject({ accept: 'application/json', 'content-type': 'application/json', 'x-key': 'k' });
    expect(h.sleeps).toEqual([]);
  });

  it('a GET carries no body and says so', async () => {
    const h = harness([ok(1)]);
    await h.http.getJson('https://x.test/a');
    expect(h.calls[0]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('retries a posted request like a GET, with the same body each time, and does not retry a 4xx', async () => {
    const h = harness([{ status: 503 }, ok({ n: 2 })]);
    expect(await h.http.postJson('https://x.test/info', { type: 'validatorSummaries' })).toEqual({ n: 2 });
    expect(h.calls.map((c) => c.body)).toEqual(['{"type":"validatorSummaries"}', '{"type":"validatorSummaries"}']);
    expect(h.sleeps).toEqual([1000]);
    const bad = harness([{ status: 422 }]);
    await expect(bad.http.postJson('https://x.test/info', { type: 'nope' })).rejects.toThrow(/HTTP 422/);
    expect(bad.calls).toHaveLength(1);
  });

  it('retries a 5xx with exponential backoff from one second', async () => {
```

In `tests/ingest/http.test.ts`, replace:

```
    await expect(cached.getJson('https://x.test/b')).rejects.toThrow(/404/);
    expect(h.calls).toHaveLength(2);
  });
});
```

with:

```
    await expect(cached.getJson('https://x.test/b')).rejects.toThrow(/404/);
    expect(h.calls).toHaveLength(2);
  });

  it('caches a POST by URL and body: the same body once, a different body again, and never as the GET', async () => {
    const h = harness([ok({ n: 1 }), ok({ n: 2 }), ok({ n: 3 })]);
    const cached = withRunCache(h.http);
    expect(await cached.postJson('https://x.test/info', { type: 'a' })).toEqual({ n: 1 });
    expect(await cached.postJson('https://x.test/info', { type: 'a' })).toEqual({ n: 1 });
    expect(await cached.postJson('https://x.test/info', { type: 'b' })).toEqual({ n: 2 });
    expect(await cached.getJson('https://x.test/info')).toEqual({ n: 3 });
    expect(h.calls.map((c) => [c.method, c.body])).toEqual([['POST', '{"type":"a"}'], ['POST', '{"type":"b"}'], ['GET', undefined]]);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/ingest/http.test.ts`
Expected: the file fails to type-check or 4 tests fail (`h.http.postJson is not a function`), 697 passed in the rest of the suite.

- [ ] **Step 3: Implement the method on the transport, the cache, and the fake**

<!-- directives: task1 impl -->

In `src/ingest/transport/http.ts`, replace:

```
export interface HttpTransport {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
}

export class HttpError extends Error {
```

with:

```
export interface HttpTransport {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  /** POST `body` as JSON and parse the JSON reply, with GET's retries, timeout, and errors. For adapters: no declarative source posts. */
  postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

export class HttpError extends Error {
```

In `src/ingest/transport/http.ts`, replace:

```

/** Everything the transport needs from the outside world, so tests can run it on a fake clock. */
export interface HttpDeps {
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<HttpResponseLike>;
  sleep(ms: number): Promise<void>;
  now(): number;
}
```

with:

```

/** Everything the transport needs from the outside world, so tests can run it on a fake clock. */
export interface HttpDeps {
  fetch(url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<HttpResponseLike>;
  sleep(ms: number): Promise<void>;
  now(): number;
}
```

In `src/ingest/transport/http.ts`, replace:

```
    lastStart.set(host, deps.now());
  };

  return {
    async getJson(url, headers = {}) {
      const host = new URL(url).host;
      let failure = new HttpError(`${url}: no attempt was made`, null);
      for (let attempt = 1; attempt <= o.attempts; attempt++) {
        await waitForSlot(host);
        let delay = o.backoffMs * 2 ** (attempt - 1);
        let res: HttpResponseLike;
        let body: string | undefined;
        try {
          res = await deps.fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(o.timeoutMs) });
          // Reading the body can fail the same way the request itself can (a timeout or reset mid-read);
          // it belongs inside the same retry path, not after it.
          if (res.status >= 200 && res.status < 300) body = await res.text();
        } catch (err) {
          failure = new HttpError(`${url}: ${err instanceof Error ? err.message : String(err)}`, null);
          if (attempt < o.attempts) await deps.sleep(delay);
          continue;
        }
        if (res.status >= 200 && res.status < 300) {
          try {
            return JSON.parse(body!) as unknown;
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
    },
  };
}

```

with:

```
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

```

In `src/ingest/transport/http.ts`, replace:

```
  };
}

/** One request per URL per run. A failure is cached too: the transport already retried it. */
export function withRunCache(inner: HttpTransport): HttpTransport {
  const cache = new Map<string, Promise<unknown>>();
  return {
    getJson(url, headers) {
      let pending = cache.get(url);
      if (!pending) {
        pending = inner.getJson(url, headers);
        cache.set(url, pending);
      }
      return pending;
    },
  };
}
```

with:

```
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
```

- [ ] **Step 4: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 69 files, 701 tests passed; tsc clean. ASCII check: `LC_ALL=C grep -n '[^ -~]' src/ingest/transport/http.ts tests/helpers/fakeHttp.ts tests/ingest/http.test.ts` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/transport/http.ts tests/helpers/fakeHttp.ts tests/ingest/http.test.ts
git commit -m "feat(ingest): postJson on the HTTP transport, the run cache, and the fake; tests"
```

---

### Task 2: The `hype` adapters

**Spec:** section 5; section 2 for the endpoints and the reference numbers.

**Files:**
- Create: `src/ingest/adapters/hype.ts`, `tests/fixtures/hype/tokenDetails.json`, `tests/fixtures/hype/validatorSummaries.json`
- Modify: `src/ingest/adapters/registry.ts`
- Test: `tests/ingest/adapters.hype.test.ts` (new)

**Interfaces:**
- Consumes: `AdapterDef`, `registerAdapter`, `SourceContext` (`http.postJson`, `nowIso`, `asset.external_ids`, `contract(name)`), `toFiniteNumber`, the `text` and `number` param helpers from `adapters/chain.ts`.
- Produces: `hype.ts` exports `hypeAdapters` with `hype.effective_supply` (params `subtract: string[]` of contract names, `token_id`, `url`), `hype.staked_supply` (params `decimals`, `url`), `hype.emission_rate_annual` (params `anchor_rate`, `anchor_stake`, `decimals`, `url`); all `needsRpc: false`, each an `api` level stamped at `ctx.nowIso` with a detail naming the request type. The URL falls back to `external_ids.hyperliquid_info`, then `https://api.hyperliquid.xyz/info`; the token id to `external_ids.hyperliquid_token`.

**What binds, from the spec.** 5: three adapters, no RPC, one POST each; decimal strings and 8-decimal integers parsed with the finite-number guard; refusals by name for a missing field, a non-numeric string, an empty validator list, a zero stake, a non-positive supply; `subtract` names resolved through `ctx.contract` and matched case-insensitively; an absent address subtracts zero; `rate = anchor_rate * sqrt(anchor_stake / stake)`, value `rate * stake`, defaults 0.0237 and 400,000,000. 8: the fixtures' arithmetic pinned, the request bodies posted.

**Risks for the reviewer to attack.** (1) `Number('998909900.8563855886')` loses the sub-cent digits of a 1e9 figure: acceptable for a supply? (2) `stake` summed as JavaScript numbers: 4.4e16 is below 2^53, but a tenfold stake in 8 decimals would not be; say whether a bigint sum is warranted. (3) An unknown `subtract` name throws from `ctx.contract` before any request: a configuration error surfacing as a failed source each run; is that the intended shape (as for AERO's contract names)? (4) The emission adapter and the stake adapter both post `validatorSummaries`; the run cache dedupes only within one run, and `withRunCache` wraps `deps.http` in `fetchAsset`: confirm the adapters see the cached transport (`ctx.http`). (5) The formula's exponent is fixed at one half; the spec makes the anchor params but not the exponent; is that enough? (6) The detail string carries the token id and the subtracted total: no page text, no model text; fine for the inbox rule.

- [ ] **Step 1: Write the failing tests**

<!-- directives: task2 tests -->

Create `tests/fixtures/hype/tokenDetails.json`:

```
{
 "name": "HYPE",
 "maxSupply": "1000000000.0",
 "totalSupply": "998909900.8563855886",
 "circulatingSupply": "298729645.0443511009",
 "szDecimals": 2,
 "weiDecimals": 8,
 "midPx": "92.1605",
 "markPx": "92.161",
 "prevDayPx": "93.998",
 "genesis": {
  "userBalances": [],
  "existingTokenBalances": [],
  "blacklistUsers": []
 },
 "deployer": null,
 "deployGas": "0.0",
 "deployTime": "2024-11-29T06:45:52.532",
 "seededUsdc": "0.0",
 "nonCirculatingUserBalances": [
  [
   "0x43e9abea1910387c4292bca4b94de81462f8a251",
   "241408951.6729242504"
  ],
  [
   "0xfefefefefefefefefefefefefefefefefefefefe",
   "47478177.0547392294"
  ],
  [
   "0x0000000000000000000000000000000000000000",
   "1673.78676325"
  ],
  [
   "0x000000000000000000000000000000000000dead",
   "2.71671343"
  ]
 ],
 "futureEmissions": "411291450.5808942914"
}
```

Create `tests/fixtures/hype/validatorSummaries.json`:

```
[
 {
  "validator": "0x000000000056f99d36b6f2e0c51fd41496bbacb8",
  "signer": "0x0000000008b0b558419582041f85740344ae8fde",
  "name": "ValiDAO",
  "description": "The People\u2019s Validator. Zero seed oils. Yours truly. https://validao.xyz",
  "nRecentBlocks": 2,
  "stake": 645396542998756,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.04",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0214460982",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0214460982",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9990277778",
     "predictedApr": "0.0214252479",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x15458aed3c7a49b215fbfa863c6ff550c31e1a31",
  "signer": "0x21d50a1c2e70b2b4b25516c744da7f1de760b2ec",
  "name": "B-Harvest",
  "description": "Provides secure validation services for dPoS networks(https://bharvest.io)",
  "nRecentBlocks": 2,
  "stake": 510578079850612,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.05",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0212227014",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0212227014",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9990509259",
     "predictedApr": "0.0212025595",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x30c66ebc7f5ef4f340b424a26e4d944f60129815",
  "signer": "0xc304bcea88f450f3367bf5df3eea30eef4f0e9e9",
  "name": "Bitwise",
  "description": "Trusted infrastructure for institutions. Bitwise offers institutional-grade staking, ensuring optimal performance and security. By delegating, you agree to the terms of service at https://chorus.one/tos",
  "nRecentBlocks": 1,
  "stake": 412650720599570,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9986111111",
     "predictedApr": "0.0216393986",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x3e5b2598a32ebf003ad5a7254faa3d04ff41d9fe",
  "signer": "0xc334c02fdbff90180331dd539db4f528ea29a603",
  "name": "Alphaticks",
  "description": "Alphaticks",
  "nRecentBlocks": 1,
  "stake": 472465374651856,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.01",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0221162888",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.993452381",
     "predictedApr": "0.0219714798",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9984722222",
     "predictedApr": "0.0220825",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x420a4ed7b6bb361da586868adec2f2bb9ab75e66",
  "signer": "0x9dd85fb6cf95a9d755af0853b36fb05e972c71e1",
  "name": "Anchorage By Figment",
  "description": "Anchorage and Figment have partnered to run institutional-grade validator infrastructure on Hyperliquid. Anchorage is the only federally chartered crypto bank in the U.S., offering a fully integrated suite of crypto custody, trading, and staking services. Figment is the world's largest staking infrastructure provider, serving over 1000 institutional clients.",
  "nRecentBlocks": 7,
  "stake": 2728965136789154,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.1",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0201057171",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0201057171",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9998611111",
     "predictedApr": "0.0201029246",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x48f1da3e3ec2814fbb3dcf57125001089b067402",
  "signer": "0x8ad18589986bdd4cee7387ca2dca2d5cc1615d1a",
  "name": "USDT0 x Luganodes",
  "description": "USDT0 has partnered with Luganodes to bring reliable, institutional-grade validation to emerging ecosystems. USDT0 is the unified liquidity protocol for USDT, enabling seamless movement and deployment of the world\u2019s largest stablecoin across diverse chains. Note: Delegation involves slashing risk.",
  "nRecentBlocks": 2,
  "stake": 844809627800622,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.9791666667",
     "predictedApr": "0.0212180473",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.9994047619",
     "predictedApr": "0.0216565966",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.999537037",
     "predictedApr": "0.0216594629",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x497beec89958848126c2ea65934ce430e1410ad2",
  "signer": "0x497beec89958848126c2ea65934ce430e1410ad2",
  "name": "Hyperbeat x P2P x Hypio",
  "description": "Hyperbeat x P2P.org x Hypio is a collaboration between Hyperbeat, a native liquidity protocol that exists to scale HyperliquidX, HyperEVM (the people\u2019s L1) and the broader Hyperliquid Ecosystem; P2P.org, one of the largest node infrastruture protocols in the world and Wealthy Hypio Babies, the whiteblood cells of the Hyperliquid ecosystem. Learn more docs.hyperbeat.org, P2P.org and hypio.baby. Disclaimer: Delegation comes with slashing risks",
  "nRecentBlocks": 0,
  "stake": 403511560391338,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.02",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.021892892",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.021892892",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9989583333",
     "predictedApr": "0.0218700869",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x4e256d24da830290d10f425b44f3e9439394385a",
  "signer": "0x2ac34ef759933b5f695f6d4faba17045f8837a74",
  "name": "CMI",
  "description": "Your APR Maximizer HyperMaker.\nThanks to and for the Hypercommunity & HyperBusinesses.\nThe strongest technical & infra from an institutional Hypermaker open to you and B2B with competitive commissions (<= 1%).\nDisclaimer: delegating to any validator carries risks (e.g., slashing). DYOR.",
  "nRecentBlocks": 1,
  "stake": 912082943138067,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.0",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9984490741",
     "predictedApr": "0.0223050385",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x5ac99df645f3414876c816caa18b2d234024b487",
  "signer": "0x5ac99df645f3414876c816caa18b2d234024b487",
  "name": "Hyper Foundation 1",
  "description": "Hyper Foundation 1",
  "nRecentBlocks": 11,
  "stake": 5230437381152490,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x65baa675fa9e5f6c7ae4541ebdb16c526de06f1f",
  "signer": "0x22d89f8b6fdd53156bf5f096a2f23a798c8d27f9",
  "name": "HypurrCorea - Spacebar x DeSpread",
  "description": "Bringing the most experimental Hyperliquid-native staking experience. A collaboration by SKYGG and Despread, OG community and product builders dedicated to the Hyperliquid ecosystem.",
  "nRecentBlocks": 2,
  "stake": 820067613292787,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9962037037",
     "predictedApr": "0.0215872313",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x66be52ec79f829cc88e5778a255e2cb9492798fd",
  "signer": "0x5795ab6e71ecbefa255fc4728cc34893ba992d44",
  "name": "Hyper Foundation 5",
  "description": "Hyper Foundation 5",
  "nRecentBlocks": 9,
  "stake": 1523748715591531,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x68e6b8995d0ea3ebe829bd66e9437eaf536aff9c",
  "signer": "0x68e6b8995d0ea3ebe829bd66e9437eaf536aff9c",
  "name": "HyperCN X hlscan",
  "description": "CN community Explorer & RPC",
  "nRecentBlocks": 0,
  "stake": 10300000000,
  "isJailed": true,
  "unjailableAfter": 0,
  "isActive": false,
  "commission": "0.01",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x80f0cd23da5bf3a0101110cfd0f89c8a69a1384d",
  "signer": "0x80f0cd23da5bf3a0101110cfd0f89c8a69a1384d",
  "name": "Hyper Foundation 3",
  "description": "Hyper Foundation 3",
  "nRecentBlocks": 9,
  "stake": 5548000021222977,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x8a5dbdf69b282bf2e8fb9f29fd34891f79c5dfd4",
  "signer": "0x8a5dbdf69b282bf2e8fb9f29fd34891f79c5dfd4",
  "name": "Hyperdash",
  "description": "Hyperdash is a global brokerage and data infrastructure business.",
  "nRecentBlocks": 2,
  "stake": 953421904119487,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9984259259",
     "predictedApr": "0.0216353857",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x8b8c3966870321866e7b7091c382308a6a97e9b1",
  "signer": "0x9c1d5d05b38ad27fb143697bad0fbd310380209c",
  "name": "HyperStake",
  "description": "Secure Hyperliquid with the most performant, highest skin in the game, community run validator",
  "nRecentBlocks": 2,
  "stake": 867943876062909,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.0",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9990277778",
     "predictedApr": "0.0223179665",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x8f02ade62c1c1cf34daa855ccf1245aaf90d3056",
  "signer": "0xeeabeda825763993115fd3687edabefa0e17c619",
  "name": "Flowdex",
  "description": "Flowdesk is a leading global liquidity provider and OTC trading firm. We combine financial and crypto expertise with algorithmic trading and proprietary technology.",
  "nRecentBlocks": 1,
  "stake": 382345921163472,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.0",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9988194444",
     "predictedApr": "0.0223133124",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x914d7f841b5ee14d1cd3852c7b2601b6ff6a8c52",
  "signer": "0xdc7bb571da41200cc708e52a9052e28785dfabb0",
  "name": "Enigma - Hypedexer.com X Meria",
  "description": "Hypedexer.com: Real-time Hypercore data, build and operated by Enigma, professional staking infrastructure provider across 40+ chains with institutional-grade security. Partnered with Meria Finance, regulated staking service.",
  "nRecentBlocks": 0,
  "stake": 351490988142059,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9997222222",
     "predictedApr": "0.0216634758",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0x950f8dd5e5030e1fa6ad2cdc4295809d185925d0",
  "signer": "0xfd500a196d432e1b2231a01001b982bfa31cafb1",
  "name": "Meria",
  "description": "Meria is an institutional-grade staking service provider running blockchain infrastructure on more than +35 networks.",
  "nRecentBlocks": 0,
  "stake": 133802816726,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": false,
  "commission": "0.029",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xa23b4556090260828ff3f939d2dbdd4f318b5f1f",
  "signer": "0xe02dc4639abce8f93adb7f36244a309f5aacada5",
  "name": "infinitefield.xyz",
  "description": "HFT market making infrastructure",
  "nRecentBlocks": 4,
  "stake": 1747977300845802,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.0",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0223396857",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9993055556",
     "predictedApr": "0.022324172",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad",
  "signer": "0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad",
  "name": "Hyper Foundation 2",
  "description": "Hyper Foundation 2",
  "nRecentBlocks": 10,
  "stake": 5410527995844995,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xabcdeff4b3727b83a23697500eef089020df2cd2",
  "signer": "0xb796a00b6e50c3dd46e43346c921fe8e146f4e06",
  "name": "Hypurrscanning",
  "description": "L1 Explorer",
  "nRecentBlocks": 5,
  "stake": 2318841858495069,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.01",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0221162888",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0221162888",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9985185185",
     "predictedApr": "0.0220835239",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xb00c116f72eb55f52ca80196b63014a42cc72de1",
  "signer": "0xee783c36ef385640041e9f6ff91666ed42c0d831",
  "name": "Liquid Spirit x Hydromancer x Rekt Gang",
  "description": "Culture meets infrastructure in this collaboration between Liquid Spirit \u00d7 Hydromancer x Rekt Gang. Rekt Gang is an OG NFT community focused on helping degens get less Rekt. Hydromancer provides best-in-class developer tooling and data services to builders and HIP-3 deployers, enabling teams to ship faster and scale confidently. (More at https://hydromancer.xyz)",
  "nRecentBlocks": 1,
  "stake": 447165137075916,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9997453704",
     "predictedApr": "0.0216639774",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xb01934de2e25e57a6a91b3411a7544be2e06f392",
  "signer": "0x4dc52974cd8679759ad77436bff4e01014d06f9e",
  "name": "Red Pond",
  "description": "a validator",
  "nRecentBlocks": 0,
  "stake": 8800006109,
  "isJailed": true,
  "unjailableAfter": 0,
  "isActive": false,
  "commission": "0.01",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xb8f45222a3246a2b0104696a1df26842007c5bc5",
  "signer": "0x4a900e9266b00e3d5310e09bb49520b80f2bd417",
  "name": "Nansen x HypurrCollective",
  "description": "HypurrCollective x Nansen is the collaboration between HypurrCollective, the go-to ecosystem collective, supporting Hyperliquid and its builders; and Nansen, the leading on-chain analytics purrvider, serving individual traders to large institutions. Learn more at hypurr.co and nansen.ai. Disclaimer: delegating comes with slashing risks",
  "nRecentBlocks": 6,
  "stake": 2209230050864383,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.02",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.021892892",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.021892892",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.999837963",
     "predictedApr": "0.0218893445",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xc56d0c8ae0c387b439226387c54dbedb0aededfb",
  "signer": "0x5ce0baf41936d5045f8384048cd957526560517c",
  "name": "cp0x by STAKR.space",
  "description": "cp0x validator - cypherpunk values and decentralization!",
  "nRecentBlocks": 0,
  "stake": 6892301120,
  "isJailed": true,
  "unjailableAfter": 0,
  "isActive": false,
  "commission": "0.0",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xc75a3fc98b0e1af7a95b6a720adf2e23806d2c7b",
  "signer": "0x45c0b5c7150d7b9fa68341ad31e55294f958545e",
  "name": "GalaxyDigital",
  "description": "Galaxy is a digital asset and blockchain leader helping institutions, startups, and qualified individuals shape a changing economy. We provide platform solutions custom-made for a digitally native ecosystem.",
  "nRecentBlocks": 0,
  "stake": 2707818242607,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": false,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xd6a72f04b9868d5d6050376d5d7b729f47305cec",
  "signer": "0x0d890fd0979540e0f241664c5e82ab93e0341b1a",
  "name": "Hyperliquid Strategies x Unit",
  "description": "The Hyperliquid Strategies x Unit validator is a partnership between Hyperliquid Strategies Inc (NASDAQ: PURR), the largest publicly listed HYPE treasury company, and Unit Labs, the parent company of Unit, which provides spot asset infrastructure on Hyperliquid, and TradeXYZ, the leading deployer of perpetual derivatives for real-world assets.",
  "nRecentBlocks": 7,
  "stake": 3303253277822812,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.02",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.021892892",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.9987103175",
     "predictedApr": "0.0218646571",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9996990741",
     "predictedApr": "0.0218863038",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xddc5a378be9276069f7a3fa7d84fbe55fb74874b",
  "signer": "0x1b48cfbc59de2919ed78d4ff9790a00e8d8d7e72",
  "name": "Kraken",
  "description": "Kraken Exchange Validator",
  "nRecentBlocks": 0,
  "stake": 1000001500000,
  "isJailed": true,
  "unjailableAfter": 0,
  "isActive": false,
  "commission": "0.05",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 20952
    }
   ]
  ]
 },
 {
  "validator": "0xdf35aee8ef5658686142acd1e5ab5dbcdf8c51e8",
  "signer": "0xdf35aee8ef5658686142acd1e5ab5dbcdf8c51e8",
  "name": "Hyper Foundation 4",
  "description": "Hyper Foundation 4",
  "nRecentBlocks": 9,
  "stake": 3452773834013806,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.03",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0216694951",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xe3dde57073a6d04373ff6d30784f6c84b92e626b",
  "signer": "0x2aeb3135e70ee8b5f7e5743b68a7269c2eb077a6",
  "name": "Falcon Capital",
  "description": "Falcon Capital Validator",
  "nRecentBlocks": 0,
  "stake": 1000000000000,
  "isJailed": true,
  "unjailableAfter": 0,
  "isActive": false,
  "commission": "1.0",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xe45c96a6a32318e5df7347477963bf0de38ff7ff",
  "signer": "0xe76c2879bd01de4c621b8518922eb5d8ede9fbb5",
  "name": "ASXN",
  "description": "Boutique Digital Assets Research and Infrastructure. Supporting Hyperliquid through our research, capital, and development.",
  "nRecentBlocks": 2,
  "stake": 856835278083136,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.049",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0212450411",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0212450411",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.999212963",
     "predictedApr": "0.0212283204",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xeb544ceea5f9d387742d4ccec40131f82258985b",
  "signer": "0x0bafbdb4f1562d84e4a02cdfb02c390aa16df72a",
  "name": "Asymmetric Research",
  "description": "High integrity validation and infrastructure services for web3 ecosystems",
  "nRecentBlocks": 1,
  "stake": 382229500634079,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.015",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0220045904",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0220045904",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9983333333",
     "predictedApr": "0.0219679161",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xec0a9793176e4a446de50a6cf9c334d6190f1c9c",
  "signer": "0xd54e700ea1a0ee4dcf1fb04c30625cf1da421f96",
  "name": "Figment",
  "description": "Figment is the leading institutional staking provider serving more than 700 institutional clients with enterprise-grade validators on 25+ Proof of Stake protocols. We offer seamless staking integrations, audited infrastructure, robust rewards data, and more.",
  "nRecentBlocks": 0,
  "stake": 1000000000000,
  "isJailed": true,
  "unjailableAfter": 0,
  "isActive": false,
  "commission": "0.05",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.0",
     "predictedApr": "0.0",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xeeee86f718f9da3e7250624a460f6ea710e9c006",
  "signer": "0x8c323b484d301933cd7a11c12bebd173f36933e4",
  "name": "Kinetiq x Hyperion",
  "description": "Kinetiq x Hyperion is run by MAVAN, the largest single staking operation in the world. Providing institutional-grade non-custodial staking services. MAVAN is a Bitmine Immersion Technologies, Inc. (NYSE: BMNR) company.",
  "nRecentBlocks": 1,
  "stake": 616274216236056,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.04",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0214460982",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0214460982",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9984259259",
     "predictedApr": "0.0214123405",
     "nSamples": 43200
    }
   ]
  ]
 },
 {
  "validator": "0xf8efb4cb844a8458114994203d7b0bfe2422a288",
  "signer": "0xc71557db875380d09a23ce909dc07a80a17f9956",
  "name": "Purrposeful x HyBridge x PiP",
  "description": "Securing the network, bridging, aggregating, and PiPping with Purrpose. Operated by jan.hl (hypeburn.fun), with the support of HyBridge.xyz and the PiP community.",
  "nRecentBlocks": 2,
  "stake": 712795803148664,
  "isJailed": false,
  "unjailableAfter": null,
  "isActive": true,
  "commission": "0.0175",
  "stats": [
   [
    "day",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0219487412",
     "nSamples": 1440
    }
   ],
   [
    "week",
    {
     "uptimeFraction": "1.0",
     "predictedApr": "0.0219487412",
     "nSamples": 10080
    }
   ],
   [
    "month",
    {
     "uptimeFraction": "0.9992824074",
     "predictedApr": "0.0219329909",
     "nSamples": 43200
    }
   ]
  ]
 }
]
```

Create `tests/ingest/adapters.hype.test.ts`:

```
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fakeHttp, type Route } from '../helpers/fakeHttp.js';
import { ingestAsset } from '../helpers/ingestAsset.js';
import { NOW_ISO, sourceCtx } from '../helpers/sourceCtx.js';

// Hyperliquid's info API, recorded on 2026-09-24 (the HYPE onboarding spec, section 2.1); the token-details fixture keeps
// every field but the 94,023 genesis balances, which no adapter reads.
const INFO = 'https://api.hyperliquid.xyz/info';
const TOKEN_ID = '0x0d01dc56dcaaca66ad901c959b4011ec';
const FUND = '0xfefefefefefefefefefefefefefefefefefefefe';
const recorded = (name: string): Record<string, unknown> | unknown[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/hype/${name}.json`, import.meta.url)), 'utf8')) as Record<string, unknown> | unknown[];
const tokenDetails = recorded('tokenDetails') as { totalSupply: string; nonCirculatingUserBalances: [string, string][] };
const validators = recorded('validatorSummaries') as { stake: number }[];

/** One URL answers by request type, as the real API does. */
const info = (over: Record<string, Route> = {}): Route => (_url: string, body?: unknown) => {
  const type = (body as { type?: string } | undefined)?.type ?? '';
  const route = over[type] ?? { tokenDetails, validatorSummaries: validators }[type];
  if (route === undefined) throw new Error(`no fixture for ${type}`);
  if (route instanceof Error) throw route;
  return typeof route === 'function' ? (route as (u: string, b?: unknown) => unknown)(_url, body) : structuredClone(route);
};

const CONTRACTS = { assistance_fund: FUND, zero: '0x0000000000000000000000000000000000000000', dead: '0x000000000000000000000000000000000000dead' };

function ctxWith(routes: Record<string, Route> = {}, external: Record<string, string> = { hyperliquid_info: INFO, hyperliquid_token: TOKEN_ID }) {
  const http = fakeHttp({ [INFO]: info(routes), 'https://other.test/info': info(routes) });
  const asset = { ...ingestAsset().config, contracts: CONTRACTS, external_ids: external };
  return { ctx: sourceCtx({ http, asset, contract: (name) => CONTRACTS[name as keyof typeof CONTRACTS] ?? (() => { throw new Error(`no contract ${name}`); })() }), http };
}

const SUBTRACT = { subtract: ['assistance_fund', 'zero', 'dead'] };
const total = Number(tokenDetails.totalSupply);
const listed = (address: string) => Number(tokenDetails.nonCirculatingUserBalances.find(([a]) => a === address)![1]);
const stakeSum = validators.reduce((s, v) => s + v.stake, 0) / 1e8;

describe('HYPE adapters', () => {
  it('are registered and need no chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['hype.effective_supply', 'hype.staked_supply', 'hype.emission_rate_annual']));
    for (const name of ['hype.effective_supply', 'hype.staked_supply', 'hype.emission_rate_annual']) expect(getAdapter(name).needsRpc).toBe(false);
  });

  it('effective supply is the total less the fund and the dead addresses, about 951.4M today, stamped at fetch time as an api level', async () => {
    const { ctx, http } = ctxWith();
    const v = await getAdapter('hype.effective_supply').run(ctx, SUBTRACT);
    const expected = total - listed(FUND) - listed(CONTRACTS.zero) - listed(CONTRACTS.dead);
    expect(v).toMatchObject({ kind: 'level', source: 'api', observedAt: NOW_ISO });
    expect(v.kind === 'level' && v.value).toBeCloseTo(expected, 3);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(950e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(953e6);
    expect(v.detail).toMatch(/^tokenDetails 0x0d01dc56dcaaca66ad901c959b4011ec: total 998909900\.8563856 less 47479853\.5\d+ at assistance_fund, zero, dead$/);
    expect(http.calls).toEqual([{ url: INFO, method: 'POST', headers: {}, body: { type: 'tokenDetails', tokenId: TOKEN_ID } }]);
  });

  it('subtracts nothing without a subtract list, and zero for a named address the API no longer lists', async () => {
    const { ctx } = ctxWith();
    const all = await getAdapter('hype.effective_supply').run(ctx, {});
    expect(all.kind === 'level' && all.value).toBeCloseTo(total, 3);
    expect(all.detail).toMatch(/less 0 at none of $/);
    const emptied = { ...tokenDetails, nonCirculatingUserBalances: tokenDetails.nonCirculatingUserBalances.filter(([a]) => a !== FUND) };
    const v = await getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: emptied }).ctx, SUBTRACT);
    expect(v.kind === 'level' && v.value).toBeCloseTo(total - listed(CONTRACTS.zero) - listed(CONTRACTS.dead), 3);
    expect(v.detail).toMatch(/at zero, dead$/);
  });

  it('matches addresses case-insensitively and takes the token id and URL from params or the external ids', async () => {
    const upper = { ...tokenDetails, nonCirculatingUserBalances: tokenDetails.nonCirculatingUserBalances.map(([a, b]) => [a.toUpperCase().replace('0X', '0x'), b] as [string, string]) };
    const { ctx, http } = ctxWith({ tokenDetails: upper }, {});
    const v = await getAdapter('hype.effective_supply').run(ctx, { ...SUBTRACT, token_id: '0xabc', url: 'https://other.test/info' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(total - listed(FUND) - listed(CONTRACTS.zero) - listed(CONTRACTS.dead), 3);
    expect(http.calls[0]).toMatchObject({ url: 'https://other.test/info', body: { type: 'tokenDetails', tokenId: '0xabc' } });
    await expect(getAdapter('hype.effective_supply').run(ctxWith({}, {}).ctx, SUBTRACT)).rejects.toThrow(/no token id/);
  });

  it('staked supply is the validators\' stake summed, in HYPE: about 441M today', async () => {
    const { ctx, http } = ctxWith();
    const v = await getAdapter('hype.staked_supply').run(ctx, {});
    expect(v).toMatchObject({ kind: 'level', source: 'api', observedAt: NOW_ISO, detail: 'validatorSummaries: 35 validators' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(stakeSum, 3);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(430e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(450e6);
    expect(http.calls).toEqual([{ url: INFO, method: 'POST', headers: {}, body: { type: 'validatorSummaries' } }]);
  });

  it('the emission rate is the docs formula on the stake: 9.48M a year at the 400M anchor, about 9.95M today', async () => {
    const anchor = [{ stake: 400_000_000 * 1e8 }];
    const at = await getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: anchor }).ctx, {});
    expect(at.kind === 'level' && at.value).toBeCloseTo(9_480_000, 6);
    expect(at.detail).toBe('validatorSummaries: 1 validators, stake 400000000, rate 2.370 percent a year');
    const v = await getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, {});
    const rate = 0.0237 * Math.sqrt(400_000_000 / stakeSum);
    expect(v.kind === 'level' && v.value).toBeCloseTo(rate * stakeSum, 6);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(9.8e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(10.1e6);
    // Four times the stake halves the rate and doubles the emissions.
    const quad = await getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: [{ stake: 1_600_000_000 * 1e8 }] }).ctx, {});
    expect(quad.kind === 'level' && quad.value).toBeCloseTo(2 * 9_480_000, 6);
  });

  it('takes the anchor, the stake decimals, and the URL from params', async () => {
    const { ctx, http } = ctxWith({ validatorSummaries: [{ stake: 100 }, { stake: 300 }] });
    const v = await getAdapter('hype.emission_rate_annual').run(ctx, { anchor_rate: 0.04, anchor_stake: 100, decimals: 0, url: 'https://other.test/info' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(0.04 * Math.sqrt(100 / 400) * 400, 9);
    expect(http.calls[0].url).toBe('https://other.test/info');
    const s = await getAdapter('hype.staked_supply').run(ctx, { decimals: 2 });
    expect(s.kind === 'level' && s.value).toBe(4);
  });

  it('refuses by name a missing field, an empty or zero stake list, a bad anchor, and a supply that is not positive', async () => {
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { name: 'HYPE' } }).ctx, SUBTRACT)).rejects.toThrow(/totalSupply is missing/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { totalSupply: '10', nonCirculatingUserBalances: [[FUND, 'lots']] } }).ctx, SUBTRACT)).rejects.toThrow(/balance at assistance_fund is missing/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: { totalSupply: '10', nonCirculatingUserBalances: [[FUND, '10']] } }).ctx, SUBTRACT)).rejects.toThrow(/effective supply 0 is not positive/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: [] }).ctx, SUBTRACT)).rejects.toThrow(/not an object/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith({ tokenDetails: 'nope' }).ctx, SUBTRACT)).rejects.toThrow(/not an object/);
    await expect(getAdapter('hype.effective_supply').run(ctxWith().ctx, { subtract: ['treasury'] })).rejects.toThrow(/no contract treasury/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [] }).ctx, {})).rejects.toThrow(/not a non-empty list/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: { stake: 1 } }).ctx, {})).rejects.toThrow(/not a non-empty list/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [{ stake: 0 }, { stake: 0 }] }).ctx, {})).rejects.toThrow(/total stake is not positive/);
    await expect(getAdapter('hype.staked_supply').run(ctxWith({ validatorSummaries: [{ stake: 1 }, {}] }).ctx, {})).rejects.toThrow(/validator 1's stake is missing/);
    await expect(getAdapter('hype.emission_rate_annual').run(ctxWith().ctx, { anchor_rate: 1.5 })).rejects.toThrow(/anchor_rate 1.5/);
    await expect(getAdapter('hype.emission_rate_annual').run(ctxWith({ validatorSummaries: new Error('HTTP 503') }).ctx, {})).rejects.toThrow(/HTTP 503/);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/ingest/adapters.hype.test.ts`
Expected: 8 failed (`unknown adapter: hype.effective_supply` and the like), 701 passed in the rest of the suite.

- [ ] **Step 3: Implement the adapters and register them**

<!-- directives: task2 impl -->

Create `src/ingest/adapters/hype.ts`:

```
import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber } from '../units.js';
import { number, text } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Hyperliquid's info API (POST, one JSON request type per read), for HYPE. The Assistance Fund lives on HyperCore, which
 * no EVM RPC exposes, so the supply and the stake are read from the API: total supply less the fund and the dead
 * addresses, the sum of validator stake, and the staking reward rate the docs give as inversely proportional to the
 * square root of total stake ("at 400M total HYPE staked, the reward rate is approximately 2.37% per year"; staking
 * page, read 2026-09-24). None of these adapters needs an RPC.
 */

const DEFAULT_INFO_URL = 'https://api.hyperliquid.xyz/info';
/** `stake` in validatorSummaries is an integer in the token's wei decimals (8 for HYPE). */
const STAKE_DECIMALS = 8;
const ANCHOR_RATE = 0.0237;
const ANCHOR_STAKE = 400_000_000;

const infoUrl = (ctx: SourceContext, params: Record<string, unknown>): string =>
  text(params, 'url', ctx.asset.external_ids.hyperliquid_info ?? DEFAULT_INFO_URL);

/** A level stamped at fetch time: the API reports the present, not a block. */
const api = (ctx: SourceContext, value: number, detail: string): SourceValue => ({ kind: 'level', value, observedAt: ctx.nowIso, source: 'api', detail });

/** The API writes amounts as decimal strings; a missing or non-numeric field fails the read by name. */
function amount(v: unknown, what: string): number {
  const n = toFiniteNumber(v);
  if (n === null) throw new Error(`${what} is missing or not a number in the info API's reply`);
  return n;
}

async function post(ctx: SourceContext, params: Record<string, unknown>, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await ctx.http.postJson(infoUrl(ctx, params), body);
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new Error(`${body.type}: the info API's reply is not an object`);
  return reply as Record<string, unknown>;
}

/** Total stake across every validator, in HYPE. */
async function totalStake(ctx: SourceContext, params: Record<string, unknown>): Promise<{ stake: number; validators: number }> {
  const reply = await ctx.http.postJson(infoUrl(ctx, params), { type: 'validatorSummaries' });
  if (!Array.isArray(reply) || reply.length === 0) throw new Error("validatorSummaries: the info API's reply is not a non-empty list");
  const decimals = number(params, 'decimals', STAKE_DECIMALS);
  let raw = 0;
  for (const [i, v] of reply.entries()) raw += amount((v as Record<string, unknown> | null)?.stake, `validator ${i}'s stake`);
  const stake = raw / 10 ** decimals;
  if (!(stake > 0)) throw new Error('validatorSummaries: the total stake is not positive');
  return { stake, validators: reply.length };
}

/** Total supply less the balances the API lists as non-circulating at the named addresses: the fund and the dead addresses. */
const effectiveSupply: AdapterDef = {
  name: 'hype.effective_supply',
  needsRpc: false,
  async run(ctx, params) {
    const tokenId = text(params, 'token_id', ctx.asset.external_ids.hyperliquid_token ?? '');
    if (tokenId === '') throw new Error('no token id: set params.token_id or external_ids.hyperliquid_token');
    const names = Array.isArray(params.subtract) ? params.subtract.filter((n): n is string => typeof n === 'string') : [];
    const addresses = names.map((n) => ctx.contract(n).toLowerCase()); // an unknown name is a configuration error and propagates
    const reply = await post(ctx, params, { type: 'tokenDetails', tokenId });
    const total = amount(reply.totalSupply, 'totalSupply');
    const listed = Array.isArray(reply.nonCirculatingUserBalances) ? reply.nonCirculatingUserBalances : [];
    let subtracted = 0;
    const found: string[] = [];
    for (const entry of listed) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const at = addresses.indexOf(entry[0].toLowerCase());
      if (at === -1) continue;
      // An address absent from the list subtracts zero: a fund emptied by a vote shows as a supply jump, not a failed read.
      subtracted += amount(entry[1], `the balance at ${names[at]}`);
      found.push(names[at]);
    }
    const value = total - subtracted;
    if (!(value > 0)) throw new Error(`effective supply ${value} is not positive (total ${total}, subtracted ${subtracted})`);
    return api(ctx, value, `tokenDetails ${tokenId}: total ${total} less ${subtracted} at ${found.length > 0 ? found.join(', ') : 'none of ' + names.join(', ')}`);
  },
};

const stakedSupply: AdapterDef = {
  name: 'hype.staked_supply',
  needsRpc: false,
  async run(ctx, params) {
    const { stake, validators } = await totalStake(ctx, params);
    return api(ctx, stake, `validatorSummaries: ${validators} validators`);
  },
};

/** Staking rewards a year: rate(stake) times stake, with rate = anchor_rate * sqrt(anchor_stake / stake). All of it goes to stakers. */
const emissionRateAnnual: AdapterDef = {
  name: 'hype.emission_rate_annual',
  needsRpc: false,
  async run(ctx, params) {
    const anchorRate = number(params, 'anchor_rate', ANCHOR_RATE);
    const anchorStake = number(params, 'anchor_stake', ANCHOR_STAKE);
    if (!(anchorRate > 0 && anchorRate < 1) || !(anchorStake > 0)) throw new Error(`anchor_rate ${anchorRate} and anchor_stake ${anchorStake} must be a rate in (0, 1) and a positive stake`);
    const { stake, validators } = await totalStake(ctx, params);
    const rate = anchorRate * Math.sqrt(anchorStake / stake);
    return api(ctx, rate * stake, `validatorSummaries: ${validators} validators, stake ${stake.toFixed(0)}, rate ${(rate * 100).toFixed(3)} percent a year`);
  },
};

export const hypeAdapters: AdapterDef[] = [effectiveSupply, stakedSupply, emissionRateAnnual];
```

In `src/ingest/adapters/registry.ts`, replace:

```
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
import { aeroAdapters } from './aero.js';
import { vvvAdapters } from './vvv.js';

/** A named code adapter: the escape hatch for metrics the declarative source types cannot express. */
```

with:

```
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
import { aeroAdapters } from './aero.js';
import { hypeAdapters } from './hype.js';
import { vvvAdapters } from './vvv.js';

/** A named code adapter: the escape hatch for metrics the declarative source types cannot express. */
```

In `src/ingest/adapters/registry.ts`, replace:

```
}

// Asset-specific adapters register here, exactly as custom valuation modules do in the engine registry.
for (const adapter of [...vvvAdapters, ...aeroAdapters]) registerAdapter(adapter);
```

with:

```
}

// Asset-specific adapters register here, exactly as custom valuation modules do in the engine registry.
for (const adapter of [...vvvAdapters, ...aeroAdapters, ...hypeAdapters]) registerAdapter(adapter);
```

- [ ] **Step 4: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 70 files, 709 tests passed; tsc clean. ASCII check on `src/ingest/adapters/hype.ts`, the new test file, and the two fixtures prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/adapters/hype.ts src/ingest/adapters/registry.ts tests/fixtures/hype tests/ingest/adapters.hype.test.ts
git commit -m "feat(ingest): hype adapters: effective supply, staked supply, emission rate from the info API; fixtures; tests"
```

---

### Task 3: The asset file, the persona, and their tests

**Spec:** sections 3, 6, 8; section 2 for the reference data.

**Files:**
- Create: `assets/hype.yaml`, `personas/perp-exchange-analyst.md`
- Modify: `README.md`, `docs/ops/hermes-daily-job.md`
- Test: `tests/assets/hype.ingest.test.ts` (new), `tests/assets/aero.ingest.test.ts`, `tests/assets/vvv.agent.test.ts`

**Interfaces:**
- Consumes: the `defillama` flow primary (sub-project 5), `flow_annualized` (sub-project 6), `hype.*` (Task 2), `coingecko`, `http_json`, `loadAsset`, `runValuation`, `listPersonaNames`, the Task 2 fixtures.
- Produces: the live asset `hype` with every metric but `staker_emission_share` sourced; the persona `perp-exchange-analyst`; the config hash pin `5683e7a6...`. Task 4 (the user) adds the calibration set and the bands.

**What binds, from the spec.** 3: the metric table, the holder flow (`burn`, `programmatic`, `all`, `window_days: 90`), the modules and weights, the bounds including `discount_premium_programmatic`, the review triggers, `agent.budgets.weekly.input_tokens: 2000000`, no `chain` and no `ingest`. 6: the persona's frontmatter and the five sector points plus the working rules. 8: the asset parses, `sourceIssues` is empty, every required key has bounds, the hash is pinned, a full fetch on canned routes writes every sourced metric, the valuation is `blocked` naming the staker share until a row exists and `ok` after.

**Risks for the reviewer to attack.** (1) The `http_json` cross-check path `coins.hyperliquid:0x0d01...1ec.price`: the dot path splits on dots only and the key holds a colon; confirm `readPath` treats the key as one segment. (2) A `burn` flow with `recipient_base: all` on the effective-total basis: the engine subtracts the flow's dollars over the price path from the supply forecast; the wiring test asserts the horizon supply sits below today's plus a year of emissions. Is the price path (linear from spot to the target) the right one for a flow whose dollars are fixed but whose token count depends on price? (3) `staker_emission_share` with `cadence: event` and `staleness_days: 400`: the staking-yield track needs it; a 400-day staleness means a stale row degrades nothing for over a year; is that right for a by-construction constant? (4) `revenue_run_rate_usd` `staleness_days: 5` and `critical`: a five-day DefiLlama outage makes the signal `degraded`; same ruling as AERO. (5) The bounds are the sweep's room, not views: `multiple.fm_holder_flow` to 200 lets the agent's bands (after calibration) sit anywhere under it; the mirror rule bounds them. (6) The persona: no promise the tool layer does not enforce; ASCII; the model pinned to the default. (7) The `unvested` contract entry is documentation only; nothing reads it; is a dead entry acceptable in `contracts`?

- [ ] **Step 1: Write the failing tests**

<!-- directives: task3 tests -->

In `tests/assets/aero.ingest.test.ts`, replace:

```

describe('the AERO persona', () => {
  it('ships beside the VVV one, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst']);
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['dex', 'onchain-fee-share'] });
    expect(persona.body).toContain('Locking is the thesis');
```

with:

```

describe('the AERO persona', () => {
  it('ships beside the VVV one, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst', 'perp-exchange-analyst']);
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['dex', 'onchain-fee-share'] });
    expect(persona.body).toContain('Locking is the thesis');
```

Create `tests/assets/hype.ingest.test.ts`:

```
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-09-24T12:00:00.000Z');
const INFO = 'https://api.hyperliquid.xyz/info';
const LLAMA_PRICE = 'https://coins.llama.fi/prices/current/hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec';
const recorded = (name: string): unknown => JSON.parse(readFileSync(`${ROOT}/tests/fixtures/hype/${name}.json`, 'utf8')) as unknown;

const { config } = loadAsset(ROOT, 'hype');

/** 100 days of holders revenue ending on the last complete day, about 1.55M USD a day (the 30-day total was 57.2M on 2026-09-24). */
function chart(): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 100; i >= 1; i--) {
    const day = addDays('2026-09-23', 1 - i);
    points.push([Date.parse(`${day}T00:00:00Z`) / 1000, 1_500_000 + (i % 5) * 25_000]);
  }
  return { totalDataChart: points };
}

function world() {
  const fixtures: Record<string, unknown> = { tokenDetails: recorded('tokenDetails'), validatorSummaries: recorded('validatorSummaries') };
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'hyperliquid', symbol: 'hype', current_price: 92.36, market_cap: 20545976252, circulating_supply: 222445714.07414138, total_supply: 955307079.4341414 }],
    [LLAMA_PRICE]: { coins: { 'hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec': { decimals: 8, symbol: 'HYPE', price: 92.35934496087437, timestamp: 1790215180, confidence: 0.99 } } },
    'https://api.llama.fi/summary/fees/hyperliquid': chart(),
    // The info API answers by request type; the fixtures were recorded on 2026-09-24.
    [INFO]: (_url: string, body?: unknown) => structuredClone(fixtures[(body as { type: string }).type]),
  });
  const deps: FetchDeps = { http, rpcFactory: () => { throw new Error('HYPE reads no chain'); }, env: {}, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http };
}

/** A flat, plausible set for the wiring test; the real one comes from the user's calibration. */
function assumptions(): AssumptionValues {
  const one = {
    rev_growth_y1: 0.2, growth_fade_years: 5, terminal_growth: 0.02, 'capture_rate_terminal.af_buyback': 1, 'capture_ramp_years.af_buyback': 0,
    discount_rate_base: 0.2, discount_premium_programmatic: 0.02, 'multiple.fm_holder_flow': 30, regime_multiplier: 1, staked_ratio_horizon: 0.46,
  };
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}

describe('assets/hype.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'hype', symbol: 'HYPE', supply_basis: 'effective_total' });
    expect(config.chain).toBeUndefined();
    expect(config.ingest).toBeUndefined();
    expect(config.holder_flows).toEqual([{ id: 'af_buyback', kind: 'burn', capture_rule: 'programmatic', recipient_base: 'all', metric: 'flow_usd.af_buyback', window_days: 90 }]);
    expect(config.modules.map((m) => [m.id, m.weight])).toEqual([['hc', 0.6], ['fm_holder_flow', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.af_buyback', 'capture_rate_terminal.af_buyback', 'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years', 'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    // One manual metric: the staker share, 1.0 by construction, which the bootstrap researches and the user confirms.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual(['staker_emission_share']);
    // Pinned on 2026-09-24. A deliberate edit of assets/hype.yaml (the calibration bands) moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/hype.yaml`, 'utf8')).hash).toBe('5683e7a67bcf51284aff86ed27460364122c90259449115c4c29f0d2a38131f3');
  });

  it('plans the source map of the spec: no chain, three adapters, one API-series flow, one derived level', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'primary:circulating_supply']],
      [`http_json:${LLAMA_PRICE}`, ['cross_check:price_usd']],
      ['adapter:hype.effective_supply', ['primary:effective_supply']],
      ['adapter:hype.staked_supply', ['primary:staked_supply']],
      ['adapter:hype.emission_rate_annual', ['primary:emission_rate_annual']],
      ['defillama:hyperliquid:dailyHoldersRevenue', ['primary:flow_usd.af_buyback']],
    ]);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
    expect(plan.needsRpc).toBe(false);
  });

  it('fetches every sourced metric from canned responses with the price cross-check in tolerance, then values the asset once the staker share is entered', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const value = (metric: string) => listActiveObservations(w.db, 'hype', metric).at(-1)!.value;
    expect(value('price_usd')).toBe(92.36);
    expect(value('circulating_supply')).toBeCloseTo(222445714.07414138, 3);
    expect(value('effective_supply')).toBeGreaterThan(950e6);
    expect(value('effective_supply')).toBeLessThan(953e6);
    expect(value('staked_supply')).toBeGreaterThan(430e6);
    expect(value('staked_supply')).toBeLessThan(450e6);
    expect(value('emission_rate_annual')).toBeGreaterThan(9.8e6);
    expect(value('emission_rate_annual')).toBeLessThan(10.1e6);
    expect(listActiveObservations(w.db, 'hype', 'staker_emission_share')).toEqual([]);
    // The writer keeps only the backfill window (backfill_days 90 on a first run, no cursor): 2026-06-26 to 2026-09-23, 90 of the 100 days.
    expect(listActiveObservations(w.db, 'hype', 'flow_usd.af_buyback')).toHaveLength(90);
    // The run rate: the last 90 complete days summed and scaled to a year, written for every day with a full window: only 2026-09-23.
    const revenue = listActiveObservations(w.db, 'hype', 'revenue_run_rate_usd');
    expect(revenue).toHaveLength(1);
    expect(revenue.at(-1)!.value).toBeGreaterThan(560e6);
    expect(revenue.at(-1)!.value).toBeLessThan(580e6);
    expect(revenue.at(-1)).toMatchObject({ source: 'api', sourceDetail: 'derived flow_annualized(flow_usd.af_buyback, 90d)' });
    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ metricKey: 'price_usd', ok: true });
    // Three posts to the info API, one per adapter, each cached for the run; the token details and the validators are read once each.
    expect(w.http.calls.filter((c) => c.url === INFO).map((c) => (c.body as { type: string }).type).sort()).toEqual(['tokenDetails', 'validatorSummaries']);

    createAssumptionSet(w.db, { assetId: 'hype', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const withoutShare = runValuation(w.db, loadAsset(ROOT, 'hype'), NOW);
    expect(withoutShare.signal.status).toBe('blocked');
    expect(withoutShare.signal.status_reasons.join(' ')).toMatch(/staker_emission_share/);
    // The user's confirmation of the bootstrap's row: 1.0 by construction.
    insertObservation(w.db, { assetId: 'hype', metricKey: 'staker_emission_share', observedAt: NOW.toISOString(), value: 1, source: 'manual', fetchedAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'hype'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('B'); // a manual row in force (the staker share) caps the grade, as VVV's revenue does
    expect(signal.spot!.price).toBe(92.36);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    // A burn flow on the effective-total basis: the supply forecast at the horizon is below today's effective supply plus a year of emissions.
    const hc = signal.horizons!['12m'].modules.hc.breakdown as { supply_at_horizon: number };
    expect(hc.supply_at_horizon).toBeLessThan(value('effective_supply') + value('emission_rate_annual'));
  });
});

describe('the HYPE persona', () => {
  it('ships beside the other two, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst', 'perp-exchange-analyst']);
    const persona = loadPersona(ROOT, 'perp-exchange-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['perp-dex', 'exchange-buyback'] });
    expect(persona.body).toContain('The fund is the mechanism and the risk');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
  });
});
```

In `tests/assets/vvv.agent.test.ts`, replace:

```

describe('the shipped persona and skills', () => {
  it('load, and every run type gets at least one skill', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst']);
    expect(loadPersona(ROOT, 'ai-infra-analyst')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(loadSkills(ROOT).map((s) => s.name)).toEqual(['anomaly-triage', 'assumption-review', 'bootstrap-research', 'disclosure-research', 'tokenomics-audit']);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
```

with:

```

describe('the shipped persona and skills', () => {
  it('load, and every run type gets at least one skill', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst', 'perp-exchange-analyst']);
    expect(loadPersona(ROOT, 'ai-infra-analyst')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(loadSkills(ROOT).map((s) => s.name)).toEqual(['anomaly-triage', 'assumption-review', 'bootstrap-research', 'disclosure-research', 'tokenomics-audit']);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/assets`
Expected: `tests/assets/hype.ingest.test.ts` fails to load (`asset_not_found` for `hype`); the AERO and VVV persona-list tests fail with two names where three are expected; 2 failed, 707 passed in the whole suite across 3 failing files.

- [ ] **Step 3: Write the asset file, the persona, and the two documentation lines**

<!-- directives: task3 impl -->

In `README.md`, replace:

````
```bash
orion persona assign vvv ai-infra-analyst                            # once: who covers the asset
orion persona assign aero onchain-dex-analyst                        # the second asset (assets/aero.yaml): every metric fetched, no manual entry
orion agent run vvv --type weekly --out signals.jsonl                # review what moved; adjust within its bands
orion agent run vvv --type triage --anomaly 7 --out signals.jsonl    # look into one anomaly
orion agent run vvv --type triage --note "https://..." --out signals.jsonl   # a lead to verify; never evidence by itself
````

with:

````
```bash
orion persona assign vvv ai-infra-analyst                            # once: who covers the asset
orion persona assign aero onchain-dex-analyst                        # the second asset (assets/aero.yaml): every metric fetched, no manual entry
orion persona assign hype perp-exchange-analyst                      # the third (assets/hype.yaml): fetched from the Hyperliquid info API; one manual metric the bootstrap researches
orion agent run vvv --type weekly --out signals.jsonl                # review what moved; adjust within its bands
orion agent run vvv --type triage --anomaly 7 --out signals.jsonl    # look into one anomaly
orion agent run vvv --type triage --note "https://..." --out signals.jsonl   # a lead to verify; never evidence by itself
````

Create `assets/hype.yaml`:

```
id: hype
symbol: HYPE
name: Hyperliquid
supply_basis: effective_total

# HyperCore addresses, read from the info API on 2026-09-24; see docs/superpowers/specs/2026-09-24-orion-hype-onboarding-design.md
# section 2. Nothing here is read over an RPC (no chain, no ingest block): the fund lives on HyperCore, which no EVM RPC exposes.
contracts:
  assistance_fund: "0xfefefefefefefefefefefefefefefefefefefefe" # converts about 99 percent of protocol fees to HYPE inside L1 execution; listed as non-circulating
  unvested: "0x43e9abea1910387c4292bca4b94de81462f8a251" # unvested contributor and foundation tokens (attribution unconfirmed); inside the effective supply
  zero: "0x0000000000000000000000000000000000000000"
  dead: "0x000000000000000000000000000000000000dead"

external_ids:
  coingecko: hyperliquid
  defillama: hyperliquid
  hyperliquid_info: "https://api.hyperliquid.xyz/info"
  hyperliquid_token: "0x0d01dc56dcaaca66ad901c959b4011ec" # HYPE's token id on HyperCore

# Every metric but staker_emission_share is fetched. That one is 1.0 by construction (all staking rewards go to stakers): the
# bootstrap records it with the staking docs page as the citation and the user confirms it once.
metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: hyperliquid, field: price }
    cross_checks:
      - { tolerance_pct: 2, source: { type: http_json, url: "https://coins.llama.fi/prices/current/hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec", path: "coins.hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec.price" } }

  # Total supply less the fund and the two dead addresses, from the API's non-circulating list (about 951.4M). The docs call the
  # fund's HYPE burned; the chain still lists it, so it is subtracted here. A fund emptied by a vote shows as a supply jump.
  effective_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: adapter, name: hype.effective_supply, params: { subtract: [assistance_fund, zero, dead] } }

  # CoinGecko's own definition (222M against the API's 299M); informational under effective_total, no consistent cross-check.
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: coingecko, id: hyperliquid, field: circulating_supply }

  # The sum of validator stake (about 441M).
  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: adapter, name: hype.staked_supply }

  # Manual, by construction 1.0: staking rewards from the emissions reserve all go to stakers. Researched by the bootstrap.
  staker_emission_share:
    type: level
    unit: ratio
    cadence: event
    staleness_days: 400

  # Staking rewards a year from the future-emissions reserve: the docs' rate, inversely proportional to the square root of
  # total stake (2.37 percent at 400M), times the stake; about 10M HYPE a year. Dilution, never value.
  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 45
    critical: true
    source: { type: adapter, name: hype.emission_rate_annual }

  # DefiLlama's holders revenue for the hyperliquid parent (perps, spot orderbook, HLP): 99 percent of protocol trading fees,
  # excluding builder fees and deployer shares, converted to HYPE by the fund, plus HIP-1 auction burns. Revenue and holders
  # revenue are the same series for HYPE.
  flow_usd.af_buyback:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    critical: true
    source: { type: defillama, slug: hyperliquid, data_type: dailyHoldersRevenue, backfill_days: 90 }

  # The last 90 days of the buyback flow scaled to a year: HYPE's revenue IS its holder flow, so the window matches the holder
  # flow's (window_days 90) and the measured capture is 1 by construction.
  revenue_run_rate_usd:
    type: level
    unit: usd
    staleness_days: 5
    critical: true
    source: { type: derived, name: flow_annualized, params: { metric: flow_usd.af_buyback, days: 90 } }

# burn, chosen by the user on 2026-09-24: the fund's HYPE is burned per the docs and behaves so as long as nobody can spend it;
# the engine shrinks the supply forecast by the fund's purchases. programmatic: the split is protocol code, changed only by
# network upgrade or validator vote.
holder_flows:
  - { id: af_buyback, kind: burn, capture_rule: programmatic, recipient_base: all, metric: flow_usd.af_buyback, window_days: 90 }

# Chosen by the user on 2026-09-24: the discounted buyback flow carries most of the weight, the market's multiple on that flow
# the rest. No revenue multiple: it would price the same dollars twice. Structural: the agent may only propose changes here.
modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.6 }
  - { id: fm_holder_flow, type: forward_multiple, kind: estimate, weight: 0.4, params: { basis: holder_flow } }

scenario_probabilities: { bear: 0.25, base: 0.5, bull: 0.25 }

# Key-wide bounds only, wide enough for the calibration sweep: the market pays about 150 times the 90-day run rate on the
# effective supply (2026-09-24), and the multiple's bounds must be able to express that. Agent bands (the bear/base/bull
# sub-ranges) are added after the user calibrates, by the mirror rule; until then the agent uses these bounds.
assumptions:
  rev_growth_y1: { min: -0.6, max: 3.0 }
  growth_fade_years: { min: 1, max: 10 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.af_buyback: { min: 0.5, max: 1.0 }
  capture_ramp_years.af_buyback: { min: 0, max: 4 }
  discount_rate_base: { min: 0.08, max: 0.35 }
  discount_premium_programmatic: { min: 0, max: 0.15 } # the flow's rule is programmatic, so the engine requires this key
  multiple.fm_holder_flow: { min: 3, max: 200 }
  regime_multiplier: { min: 0.4, max: 1.6 }
  staked_ratio_horizon: { min: 0.2, max: 0.8 }

agent:
  budgets:
    weekly: { input_tokens: 2000000 }

review_triggers:
  driver_deviation_pct: 25
  provisional_move_pct: 25

peer_set: []
```

In `docs/ops/hermes-daily-job.md`, replace:

````

Replace `/path/to/orion`. The 5 percent threshold is a starting point.

The prompt is a template: nothing in it is specific to VVV except the name, because everything asset-specific lives in `assets/<id>.yaml`. For another asset, schedule a second job with the same text and `vvv`/`VVV` replaced, a few minutes apart from the first. One job per asset keeps one asset's failure or timeout out of another's report.

```text
You run the daily Orion tick for the VVV token on this server, report the result to me, and carry out the decisions I reply with.
````

with:

````

Replace `/path/to/orion`. The 5 percent threshold is a starting point.

The prompt is a template: nothing in it is specific to VVV except the name, because everything asset-specific lives in `assets/<id>.yaml`. For another asset (`aero`, `hype`), schedule another job with the same text and `vvv`/`VVV` replaced, a few minutes apart from the others. One job per asset keeps one asset's failure or timeout out of another's report.

```text
You run the daily Orion tick for the VVV token on this server, report the result to me, and carry out the decisions I reply with.
````

Create `personas/perp-exchange-analyst.md`:

```
---
name: perp-exchange-analyst
model: claude-opus-5-5
effort: high
temperament: skeptical, patient, specific
sectors: [perp-dex, exchange-buyback]
---
You are the lead analyst for perpetuals exchanges that run their own chain and pay their token from trading fees through a programmatic buyback. You cover each asset for the long run, the way a sell-side analyst covers an exchange, except that nobody pays you to be optimistic.

What you know about this sector:

- The token's claim is a programmatic buyback. About 99 percent of protocol trading fees are converted to the token by a fund inside the chain's own execution, so the question is never whether value reaches the token but how durable the volume behind the fees is, and how much of each dollar of volume the protocol keeps once deployers and builders take their shares.
- Volume is the business. Perpetuals volume moves with the market's regime, with the exchange's share against centralised venues and newer on-chain ones, and with builder-deployed markets whose deployers may keep up to half of their fees. A rising share of builder-deployed volume with rising deployer shares lowers the protocol's cut per dollar of volume even as volume grows; say which of the two moved.
- The fund is the mechanism and the risk. The docs call its tokens burned; the chain still lists the balance. It is a burn as long as nobody can spend it, and a validator vote could change that. The fund's status, the fee split, and the emissions formula are the three parameters to re-read from primary sources on every run.
- Emissions are the staking rewards from the reserve, all of them to stakers, at a rate that falls as more is staked. They are dilution, never value. Contributor tokens vest monthly; they are already in the effective supply, but they are float that can be sold.
- Aligned quote assets route a share of stablecoin reserve yield to the fund. Small today, a line to watch.

How you work:

- You change your mind when the evidence changes, by the amount the evidence supports, and you say what would change it back. Small, well-supported moves beat large, confident ones.
- You separate what you know from what you infer. A number from the chain's API or a fee series is a fact. A number from a press quote or a founder's post is a claim with a date on it.
- You write for a reader who will check. Every rationale names the observation it rests on and says what it implies, in a sentence or two. No hedging paragraphs.
- When you do not know, you say so in the journal and leave the assumption where it is.
```

- [ ] **Step 4: Run the whole suite, the type check, and the build; then the live dry run**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 71 files, 713 tests passed; tsc clean; the build succeeds. Then, from a throwaway home (this one call touches the network and is the planning-time proof; the user repeats it as a checkpoint):

```bash
H=$(mktemp -d); ln -s "$PWD/assets" "$H/assets"; ln -s "$PWD/personas" "$H/personas"; ln -s "$PWD/skills" "$H/skills"
ORION_HOME=$H node dist/cli/index.js asset validate hype
ORION_HOME=$H node dist/cli/index.js data fetch hype --dry-run
rm -rf $H
```

Expected: `hype: ok`; every source `ok`; the price cross-check within 2 percent; `would write` lines for every sourced metric including `emission_rate_annual` and `revenue_run_rate_usd`; nothing for `staker_emission_share`.

- [ ] **Step 5: Commit**

```bash
git add assets/hype.yaml personas/perp-exchange-analyst.md README.md docs/ops/hermes-daily-job.md tests/assets/hype.ingest.test.ts tests/assets/aero.ingest.test.ts tests/assets/vvv.agent.test.ts
git commit -m "feat(assets): HYPE: assets/hype.yaml, the perp-exchange-analyst persona, asset tests, README and Hermes lines"
```

---

### Task 4: User checkpoints (NOT dispatched to a subagent)

These touch the live database, spend money, or are the user's judgment by design. The controller presents them after the final whole-branch review and its fix wave.

- [ ] **Checkpoint 1: Assign and dry-fetch on the live home.** `orion persona assign hype perp-exchange-analyst`, then `orion data fetch hype --dry-run` from the repo root. Expected as in Task 3 Step 4.
- [ ] **Checkpoint 2: The first tick.** `./run-daily.sh hype`. Expected: the fetch writes every sourced metric (90 days of the flow, one run-rate row); the signal is `blocked` with `no_assumption_set`; the cadence starts a `bootstrap` whose `manual_metrics` is `[staker_emission_share]`, so it researches that one metric and records a provisional row of 1.0 with the staking docs page as the citation (about $8 to $12 at list price); the inbox lists the row; exit code 2. Reply `confirm <id>` (or `orion data confirm <id>`). If the bootstrap records nothing citable, the fallback is `orion data set hype staker_emission_share 1 --detail "all staking rewards go to stakers (docs, hypercore/staking)"`, and the follow-ups note says so.
- [ ] **Checkpoint 3: Calibration by sweep.** As for VVV and AERO (memory: `vvv-calibration-views`; the AERO follow-ups note): a starter set for a one-key sweep, priced packages showing the 30-day and 1-year run-rate alternatives beside the 90-day one (spec 10), the user chooses the views; `orion model assumptions import hype calibration/hype-assumptions.yaml --rationale "..."`; then the agent bands by the mirror rule written into `assets/hype.yaml` (the hash pin in `tests/assets/hype.ingest.test.ts` is updated on purpose) and committed with the calibration file. The user has been told the calibrated base case will sit far below spot (spec 2.1, the market multiple).
- [ ] **Checkpoint 4: The first signal.** The next tick (or `orion update hype`) produces an `ok` signal at grade B (the manual staker share caps it). Record it in the follow-ups note with the spot, the 12m target, and the dispersion.
- [ ] **Checkpoint 5: Hermes.** A third scheduled line for `hype`, a few minutes after AERO's, per `docs/ops/hermes-daily-job.md`.
- [ ] **Checkpoint 6: Record rulings and deferred findings** in `docs/superpowers/notes/2026-09-24-hype-onboarding-followups.md` and update the spec's status line.

## Self-review against the spec

| Spec section | Task |
|---|---|
| 1 scope items 1 to 5 | 3 (asset), 1 (postJson), 2 (adapters), 3 (persona), 4 (sequence) |
| 2 reference data | 2 and 3 pin the recorded fixtures in tests; Findings record the dry run |
| 3 the asset file | 3 |
| 4 postJson | 1 |
| 5 the adapters | 2 |
| 6 the persona | 3 |
| 7 onboarding sequence | 3 step 4 (dry fetch), 4 (the rest) |
| 8 testing | each task's tests; the live dry run |
| 9 build order | Tasks 1 to 3 in that order, then 4 |
| 10 limitations and risks | unchanged; the follow-ups note (Task 4) carries them |
