/**
 * The dead-man's switch (spec 5.6, plan R5): a GET to a healthchecks-style URL after each successful `levels` job
 * (`ORION_DEADMAN_URL`, prod only) and each delivered `nightly_report` (`ORION_DEADMAN_NIGHTLY_URL`). An unset or blank
 * URL means "no ping" and is not an error. The URL is never logged.
 */

export const DEADMAN_TIMEOUT_MS = 10_000;
export const DEADMAN_RETRY_DELAY_MS = 5_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True when a ping got a 2xx; false when the URL is unset (no request) or both tries failed. Never throws. */
export async function pingDeadman(url: string | undefined, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void> = realSleep): Promise<boolean> {
  const target = url?.trim() ?? '';
  if (target === '') return false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchFn(target, { method: 'GET', signal: AbortSignal.timeout(DEADMAN_TIMEOUT_MS) });
      if (res.ok) return true;
    } catch {
      // a timeout or a refused connection: the retry below, then false
    }
    if (attempt === 1) await sleep(DEADMAN_RETRY_DELAY_MS);
  }
  return false;
}
