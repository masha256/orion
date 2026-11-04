/**
 * Slack incoming-webhook delivery (spec 6, plan Global Constraints). A post that may succeed later (429, 5xx, a
 * network error or timeout) is retried 3 times (waits 30 s, 1 min, 2 min, or what `Retry-After` asks), never past
 * 5 min in all, so a dead webhook cannot hold the daemon's one worker for long (I-4). Any other status (400, 403, 404,
 * 410: a bad payload or a revoked webhook) fails at once. The caller keeps an undelivered text in `jobs.result_json`
 * and withholds that run's dead-man ping. The webhook URL is a secret: it is never logged and never put in a returned
 * error.
 */

export interface PostResult {
  ok: boolean;
  /** HTTP tries made: 0 when the webhook is unset. */
  attempts: number;
  /** The last failure, when `ok` is false (status or error message, the URL scrubbed). */
  error?: string;
}

export interface Notifier {
  post(text: string): Promise<PostResult>;
}

export const SLACK_RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;
/** One try's limit: a hung webhook counts as a failure, not a stuck job. */
export const SLACK_POST_TIMEOUT_MS = 10_000;
/** The worst case of one post: every try timing out plus every wait. A long `Retry-After` is cut to what is left. */
export const SLACK_MAX_TOTAL_MS = 300_000;

export interface SlackNotifierOptions {
  webhookUrl: string | undefined;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/**
 * The text as Slack should receive it: C0/C1 controls other than newline and tab, and Unicode format characters (zero
 * width, bidi overrides, soft hyphen, BOM) removed, then `&`, `<`, `>` escaped as Slack asks, so no text can form a
 * mention (`<!channel>`, `<@U…>`), a channel link or a disguised link. A bare `@channel`, `@here` or `@everyone` gets a
 * zero-width space after the `@` (M-6), added after the strip, so only ours is there.
 */
export function slackEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/(^|[^\p{L}\p{N}_])@(channel|here|everyone)(?![\p{L}\p{N}_])/giu, '$1@\u200b$2');
}

/** Waits worth retrying after: rate limited or a server-side failure. */
const retryable = (status: number): boolean => status === 429 || status >= 500;

/** `Retry-After` in ms (delta-seconds or an HTTP date); undefined when absent or unreadable. */
function retryAfterMs(res: Response, nowMs: number): number | undefined {
  const v = res.headers.get('retry-after')?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** Reads the body to its end and lets it go, so undici frees the socket now rather than at GC (M-10). */
export async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to free
  }
}

function scrub(s: string, secret: string): string {
  return s.split(secret).join('<webhook>');
}

export function slackNotifier(o: SlackNotifierOptions): Notifier {
  const url = o.webhookUrl?.trim() ?? '';
  return {
    async post(text: string): Promise<PostResult> {
      if (url === '') {
        o.log(`slack disabled: ${text.split('\n', 1)[0]}`);
        return { ok: true, attempts: 0 };
      }
      const body = JSON.stringify({ text: slackEscape(text) });
      const tries = SLACK_RETRY_DELAYS_MS.length + 1;
      let waitBudget = SLACK_MAX_TOTAL_MS - tries * SLACK_POST_TIMEOUT_MS;
      let error = '';
      for (let attempt = 1; attempt <= tries; attempt++) {
        let asked: number | undefined;
        try {
          const res = await o.fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
          });
          await drain(res);
          if (res.ok) return { ok: true, attempts: attempt };
          if (!retryable(res.status)) {
            error = `HTTP ${res.status} (not retried)`;
            o.log(`slack post failed (try ${attempt} of ${tries}): ${error}`);
            return { ok: false, attempts: attempt, error };
          }
          error = `HTTP ${res.status}`;
          asked = retryAfterMs(res, Date.now());
        } catch (err) {
          error = scrub(err instanceof Error ? err.message : String(err), url).slice(0, 300);
        }
        o.log(`slack post failed (try ${attempt} of ${tries}): ${error}`);
        const delay = SLACK_RETRY_DELAYS_MS[attempt - 1];
        if (delay === undefined) break;
        if (waitBudget <= 0) return { ok: false, attempts: attempt, error };
        const wait = Math.min(asked ?? delay, waitBudget);
        waitBudget -= wait;
        await o.sleep(wait);
      }
      return { ok: false, attempts: tries, error };
    },
  };
}
