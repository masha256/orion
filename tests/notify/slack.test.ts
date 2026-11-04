import { describe, expect, it } from 'vitest';
import { pingDeadman, DEADMAN_RETRY_DELAY_MS } from '../../src/notify/deadman.js';
import { SLACK_RETRY_DELAYS_MS, slackNotifier } from '../../src/notify/slack.js';

const HOOK = 'https://hooks.slack.example/services/T000/B000/SECRETSECRET';

interface Call { url: string; init: RequestInit | undefined }

/** A fake `fetch` answering each call from `answers` in turn (a status, or an Error to throw). No network. */
function fakeFetch(answers: (number | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return new Response(a === 200 ? 'ok' : 'nope', { status: a });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function harness(answers: (number | Error)[], webhookUrl: string | undefined) {
  const f = fakeFetch(answers);
  const slept: number[] = [];
  const logs: string[] = [];
  const notifier = slackNotifier({ webhookUrl, fetch: f.fetch, sleep: async (ms) => { slept.push(ms); }, log: (l) => logs.push(l) });
  return { notifier, calls: f.calls, slept, logs };
}

describe('slack notifier', () => {
  it('slack: three failures then success posts once with attempts 4 and waits 1, 3, 6 min', async () => {
    const h = harness([500, new Error(`connect ECONNREFUSED ${HOOK}`), 429, 200], HOOK);
    expect(await h.notifier.post('ORION nightly\nline 2')).toEqual({ ok: true, attempts: 4 });
    expect(h.slept).toEqual([60_000, 180_000, 360_000]);
    expect(SLACK_RETRY_DELAYS_MS).toEqual([60_000, 180_000, 360_000]);
    expect(h.calls).toHaveLength(4);
    for (const c of h.calls) {
      expect(c.url).toBe(HOOK);
      expect(c.init?.method).toBe('POST');
      expect(new Headers(c.init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(c.init?.body))).toEqual({ text: 'ORION nightly\nline 2' });
    }
  });

  it('slack: four failures returns ok false and never logs the webhook URL', async () => {
    const h = harness([503, new Error(`request to ${HOOK} failed`), 500, new Error(`fetch ${HOOK}`)], HOOK);
    const out = await h.notifier.post('ORION ALERT x');
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(4);
    expect(out.error).toBeTruthy();
    expect(h.calls).toHaveLength(4);
    expect(h.slept).toEqual([60_000, 180_000, 360_000]); // no wait after the last try
    expect(h.logs.length).toBeGreaterThan(0);
    for (const text of [...h.logs, out.error ?? '']) {
      expect(text).not.toContain('SECRETSECRET');
      expect(text).not.toContain('hooks.slack.example');
    }
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
  });
});
