/**
 * Slack incoming-webhook delivery (spec 6, plan Global Constraints). A failed post is retried 3 times over 10 min
 * (waits 1, 3, 6 min); the caller keeps an undelivered text in `jobs.result_json` and withholds that run's dead-man
 * ping. The webhook URL is a secret: it is never logged and never put in a returned error.
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

export const SLACK_RETRY_DELAYS_MS = [60_000, 180_000, 360_000] as const;
/** One try's limit: a hung webhook counts as a failure, not a stuck job. */
export const SLACK_POST_TIMEOUT_MS = 10_000;

export interface SlackNotifierOptions {
  webhookUrl: string | undefined;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/**
 * The text as Slack should receive it: C0/C1 controls other than newline and tab, and Unicode format characters (zero
 * width, bidi overrides, soft hyphen, BOM) removed, then `&`, `<`, `>` escaped as Slack asks, so no text can form a
 * mention (`<!channel>`, `<@U…>`), a channel link or a disguised link.
 */
export function slackEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
      let error = '';
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          const res = await o.fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
          });
          if (res.ok) return { ok: true, attempts: attempt };
          error = `HTTP ${res.status}`;
        } catch (err) {
          error = scrub(err instanceof Error ? err.message : String(err), url).slice(0, 300);
        }
        o.log(`slack post failed (try ${attempt} of ${tries}): ${error}`);
        const wait = SLACK_RETRY_DELAYS_MS[attempt - 1];
        if (wait !== undefined) await o.sleep(wait);
      }
      return { ok: false, attempts: tries, error };
    },
  };
}
