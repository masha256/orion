import { describe, expect, it } from 'vitest';
import { pingDeadman, DEADMAN_RETRY_DELAY_MS } from '../../src/notify/deadman.js';
import { SLACK_MAX_TOTAL_MS, SLACK_POST_TIMEOUT_MS, SLACK_RETRY_DELAYS_MS, slackEscape, slackNotifier } from '../../src/notify/slack.js';

const HOOK = 'https://hooks.slack.example/services/T000/B000/SECRETSECRET';

interface Call { url: string; init: RequestInit | undefined }

/** A status, a status with a Retry-After header, or an Error to throw. */
type Answer = number | Error | { status: number; retryAfter: string };

/** A fake `fetch` answering each call from `answers` in turn. No network. Every Response it made is kept. */
function fakeFetch(answers: Answer[]): { fetch: typeof fetch; calls: Call[]; responses: Response[] } {
  const calls: Call[] = [];
  const responses: Response[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    const status = typeof a === 'number' ? a : a.status;
    const headers = typeof a === 'number' ? undefined : { 'retry-after': a.retryAfter };
    const res = new Response(status === 200 ? 'ok' : 'nope', { status, headers });
    responses.push(res);
    return res;
  }) as typeof fetch;
  return { fetch: fn, calls, responses };
}

function harness(answers: Answer[], webhookUrl: string | undefined) {
  const f = fakeFetch(answers);
  const slept: number[] = [];
  const logs: string[] = [];
  const notifier = slackNotifier({ webhookUrl, fetch: f.fetch, sleep: async (ms) => { slept.push(ms); }, log: (l) => logs.push(l) });
  return { notifier, calls: f.calls, responses: f.responses, slept, logs };
}

describe('slack notifier', () => {
  it('slack: 5xx, a network error and 429 are retried after 30 s, 1 min, 2 min; success posts once with attempts 4', async () => {
    const h = harness([500, new Error(`connect ECONNREFUSED ${HOOK}`), 429, 200], HOOK);
    expect(await h.notifier.post('ORION nightly\nline 2')).toEqual({ ok: true, attempts: 4 });
    expect(h.slept).toEqual([30_000, 60_000, 120_000]);
    expect(SLACK_RETRY_DELAYS_MS).toEqual([30_000, 60_000, 120_000]);
    expect(h.calls).toHaveLength(4);
    for (const c of h.calls) {
      expect(c.url).toBe(HOOK);
      expect(c.init?.method).toBe('POST');
      expect(new Headers(c.init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(c.init?.body))).toEqual({ text: 'ORION nightly\nline 2' });
    }
    // Every response body was drained (a failed one too), so no socket waits for GC (M-10).
    expect(h.responses).toHaveLength(3);
    for (const r of h.responses) expect(r.bodyUsed).toBe(true);
  });

  it('slack: four failures returns ok false and never logs the webhook URL', async () => {
    const h = harness([503, new Error(`request to ${HOOK} failed`), 500, new Error(`fetch ${HOOK}`)], HOOK);
    const out = await h.notifier.post('ORION ALERT x');
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(4);
    expect(out.error).toBeTruthy();
    expect(h.calls).toHaveLength(4);
    expect(h.slept).toEqual([30_000, 60_000, 120_000]); // no wait after the last try
    expect(h.logs.length).toBeGreaterThan(0);
    for (const text of [...h.logs, out.error ?? '']) {
      expect(text).not.toContain('SECRETSECRET');
      expect(text).not.toContain('hooks.slack.example');
    }
  });

  it('slack: a 4xx other than 429 fails at once with its status, not retried (I-4)', async () => {
    for (const status of [400, 403, 404, 410]) {
      const h = harness([status, 200], HOOK);
      expect(await h.notifier.post('ORION ALERT x')).toEqual({ ok: false, attempts: 1, error: `HTTP ${status} (not retried)` });
      expect(h.calls).toHaveLength(1);
      expect(h.slept).toEqual([]);
      expect(h.responses[0]!.bodyUsed).toBe(true);
    }
  });

  it('slack: Retry-After is honoured, and the worst case stays within 5 min (I-4)', async () => {
    const h = harness([{ status: 429, retryAfter: '20' }, 200], HOOK);
    expect(await h.notifier.post('x')).toEqual({ ok: true, attempts: 2 });
    expect(h.slept).toEqual([20_000]);
    // A Retry-After past the budget waits only what is left of it; then no try is left in the budget.
    const long = harness([{ status: 429, retryAfter: '600' }, 503, 503, 503], HOOK);
    const out = await long.notifier.post('x');
    expect(out.ok).toBe(false);
    const budget = SLACK_MAX_TOTAL_MS - (SLACK_RETRY_DELAYS_MS.length + 1) * SLACK_POST_TIMEOUT_MS;
    expect(long.slept).toEqual([budget]);
    expect(long.calls).toHaveLength(2);
    // The default delays and every try timing out fit in 5 min.
    expect(SLACK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + (SLACK_RETRY_DELAYS_MS.length + 1) * SLACK_POST_TIMEOUT_MS).toBeLessThanOrEqual(SLACK_MAX_TOTAL_MS);
    expect(SLACK_MAX_TOTAL_MS).toBe(300_000);
  });

  it('slack: unset webhook posts nothing and logs one line', async () => {
    for (const url of [undefined, '', '  ']) {
      const h = harness([200], url);
      expect(await h.notifier.post('ORION nightly dev\nsecond line')).toEqual({ ok: true, attempts: 0 });
      expect(h.calls).toEqual([]);
      expect(h.logs).toEqual(['slack disabled: ORION nightly dev']);
    }
  });

  it('slack: the posted text has control and format characters removed and <, >, & escaped', async () => {
    const h = harness([200], HOOK);
    await h.notifier.post('a\u0007b\u200b <!channel> & <@U1>\u202e\nnext\tline');
    expect(JSON.parse(String(h.calls[0]!.init?.body)).text).toBe('ab &lt;!channel&gt; &amp; &lt;@U1&gt;\nnext\tline');
  });

  it('slack: bare @channel, @here and @everyone get a zero-width break (M-6)', async () => {
    expect(slackEscape('hey @channel, @here and @Everyone; me@channel.io stays')).toBe('hey @\u200bchannel, @\u200bhere and @\u200bEveryone; me@channel.io stays');
    // A zero-width character typed in by the sender is stripped first, so the break is ours alone.
    expect(slackEscape('@\u200bchannel')).toBe('@\u200bchannel');
    const h = harness([200], HOOK);
    await h.notifier.post('@here look');
    expect(JSON.parse(String(h.calls[0]!.init?.body)).text).toBe('@\u200bhere look');
  });
});

describe('dead-man pinger', () => {
  it('deadman: unset url sends nothing', async () => {
    for (const url of [undefined, '']) {
      const f = fakeFetch([200]);
      expect(await pingDeadman(url, f.fetch)).toBe(false);
      expect(f.calls).toEqual([]);
    }
  });

  it('deadman: a GET that fails once is retried after 5 s; two failures return false', async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    const once = fakeFetch([500, 200]);
    expect(await pingDeadman('https://hc.example/ping/abc', once.fetch, sleep)).toBe(true);
    expect(once.calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([['https://hc.example/ping/abc', 'GET'], ['https://hc.example/ping/abc', 'GET']]);
    expect(once.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal); // the 10 s timeout
    expect(slept).toEqual([DEADMAN_RETRY_DELAY_MS]);
    expect(DEADMAN_RETRY_DELAY_MS).toBe(5_000);
    const twice = fakeFetch([new Error('timeout'), 502]);
    expect(await pingDeadman('https://hc.example/ping/abc', twice.fetch, sleep)).toBe(false);
    expect(twice.calls).toHaveLength(2);
    const ok = fakeFetch([200]);
    expect(await pingDeadman('https://hc.example/ping/abc', ok.fetch, sleep)).toBe(true);
    expect(ok.calls).toHaveLength(1);
    // Every response body is drained (M-10).
    for (const r of [...once.responses, ...twice.responses, ...ok.responses]) expect(r.bodyUsed).toBe(true);
  });
});
