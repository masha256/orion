import { inboxLines } from '../app/inbox.js';
import type { TickHolderYield, TickReport } from '../app/tickReport.js';
import type { JobStatus } from '../db/jobs.js';
import type { WatchFiring } from '../types.js';

/**
 * The deterministic report text (spec 6, option A): the Phase 1 message rules of `docs/ops/hermes-daily-job.md` STEP 3,
 * formatted by code instead of a model. Nothing here decides anything: it prints the run's results and says whether
 * they make the message an ALERT.
 */

/** Below Slack's 4,000-character display cut, so a post is never truncated (plan R18). */
export const SLACK_MAX_CHARS = 3900;
/** The cap on one fragment of outside text (a fetch line, an error message) in a post. */
export const SLACK_FRAGMENT_MAX = 300;

// ---- Numbers --------------------------------------------------------------------------------------------------------

/** null → `n/a`; ≥ 1e9 `1.23B`, ≥ 1e6 `1.23M`, ≥ 1e3 `1.23K` (by magnitude), ≥ 1 two decimals, else 4 significant digits. */
export function fmtNum(x: number | null): string {
  if (x === null) return 'n/a';
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(2)}K`;
  if (a >= 1) return x.toFixed(2);
  return x.toPrecision(4);
}

/** A fraction as a percent with 2 decimals (`0.0345` → `3.45%`); null → `n/a`. */
export function fmtPct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`;
}

/** A number as stored, without float noise (watch values print as the tick report has them). */
const exact = (n: number): string => String(Number(n.toPrecision(10)));

// ---- Outside text ---------------------------------------------------------------------------------------------------

/**
 * Text Orion did not write (a source's error, a fetch line quoting a third-party value) made safe for a Slack post, in
 * this order: control and Unicode format characters go first (so `<\u200b@U1>` or `ht\u0007tps://` cannot slip past the
 * later steps), newlines and tabs become spaces; then `<!--`, and the `<` of `<@`, `<!`, `<#` (mentions, `@channel`,
 * channel links); then URLs become `[url]`; then the result is trimmed and capped at `max` characters.
 */
export function slackClean(s: string, max = SLACK_FRAGMENT_MAX): string {
  const out = s
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]|\p{Cf}/gu, '')
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(/<!--/g, '')
    .replace(/<(?=[@!#])/g, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[url]')
    .replace(/\bwww\.\S+/gi, '[url]')
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ---- Watch posts ----------------------------------------------------------------------------------------------------

/** `ORION WATCH <SYM>: <metric> <rule> <value>`, plus ` (was <previous>)` when previous is not null. */
export function formatWatchPost(sym: string, firing: WatchFiring): string {
  const was = firing.previous === null ? '' : ` (was ${exact(firing.previous)})`;
  return `ORION WATCH ${sym}: ${firing.metric} ${firing.rule} ${exact(firing.value)}${was}`;
}

export function formatWatchCleared(sym: string, metric: string, rule: string): string {
  return `ORION WATCH ${sym} cleared: ${metric} ${rule}`;
}

// ---- One asset's block ----------------------------------------------------------------------------------------------

/** One asset's `refresh` result, as the nightly report reads it from the job. */
export interface AssetRunResult {
  symbol: string;
  /** Null when the job never produced a tick report (it failed before or inside the tick). */
  report: TickReport | null;
  job: { status: JobStatus; attempts: number; error: string | null };
  /** The fetch's summary lines (stderr's equivalent). */
  fetchLines: string[];
  /** The fetch lines' alert markers (`OUTSIDE`, `conflict`, `unlisted sender`) found by the job. */
  alertFlags: string[];
}

/** Fetch lines that carry these are quoted when the block is an alert (STEP 3: "the relevant stderr lines"). */
const ALERT_LINE = /OUTSIDE|conflict|unlisted sender/;

function holderYieldLines(sym: string, h: TickHolderYield): string[] {
  const y = h.yields;
  return [
    `HOLDER YIELD ${sym}  ${h.day} (${h.window_days}d window)`,
    `price ${fmtNum(h.price)} | mcap ${fmtNum(h.market_cap)} | FDV ${fmtNum(h.fdv)}`,
    `revenue ${fmtNum(h.revenue_annualized)}/yr (growth ${fmtPct(h.revenue_growth_annualized)}/yr) | payout ratio ${fmtPct(h.payout_ratio)}`,
    `yields: cash ${fmtPct(y.cash)} | buyback ${fmtPct(y.buyback)} | shareholder ${fmtPct(y.shareholder)} | dilution ${fmtPct(y.dilution)} | net ${fmtPct(y.net_shareholder)}`,
    `multiple ${h.multiple === null ? 'n/a' : `${fmtNum(h.multiple)}x`} | holder-flow growth ${fmtPct(h.holder_flow_growth_annualized)}/yr`,
  ];
}

function isAlert(r: AssetRunResult): boolean {
  const rep = r.report;
  if (r.job.status === 'failed' || r.alertFlags.length > 0) return true;
  if (!rep) return false;
  return (
    rep.outcome === 'error' ||
    rep.outcome === 'run_in_progress' ||
    rep.report_error !== null ||
    (rep.ingest?.anomalies_raised.length ?? 0) > 0 ||
    (rep.ingest?.sources_failed.length ?? 0) > 0 ||
    rep.inbox.anomalies.some((a) => a.severity === 'degrading')
  );
}

/**
 * One asset's lines in STEP 3 order: watch lines; failed sources; DECISIONS and the inbox lines; the holder-yield block
 * (with the `report_error` line after its first line, or in its place); then, when the block is an alert, the fetch
 * lines that carry `OUTSIDE`, `conflict` or `unlisted sender`. A failed job, a run that found the lock held, and a tick
 * error each print one line right after the watch lines. Outside text goes through `slackClean`.
 */
export function formatAssetBlock(r: AssetRunResult): { lines: string[]; alert: boolean } {
  const sym = r.symbol;
  const rep = r.report;
  const alert = isAlert(r);
  const lines: string[] = [];
  for (const w of rep?.ingest?.watch ?? []) lines.push(formatWatchPost(sym, w));
  if (r.job.status === 'failed') lines.push(`${sym} job failed after ${r.job.attempts} attempts: ${slackClean(r.job.error ?? 'no error recorded')}`);
  if (rep) {
    if (rep.outcome === 'run_in_progress') {
      lines.push(`${sym} run in progress: locked by ${rep.lock ? `${slackClean(rep.lock.holder)} since ${rep.lock.acquired_at}` : 'another run'}`);
    }
    if (rep.error) lines.push(`${sym} error ${rep.error.code}: ${slackClean(rep.error.message)}`);
    const failed = rep.ingest?.sources_failed ?? [];
    if (failed.length > 0) lines.push(`failed sources: ${failed.map((s) => slackClean(s)).join(', ')}`);
    lines.push('DECISIONS', ...inboxLines(rep.inbox));
    const errLine = rep.report_error ? `HOLDER YIELD ${sym} ${rep.report_error.code}: ${slackClean(rep.report_error.message)}` : null;
    if (rep.holder_yield) {
      const [first, ...rest] = holderYieldLines(sym, rep.holder_yield);
      lines.push(first!, ...(errLine ? [errLine] : []), ...rest);
    } else if (errLine) {
      lines.push(errLine);
    }
  }
  if (alert) lines.push(...r.fetchLines.filter((l) => ALERT_LINE.test(l)).map((l) => slackClean(l)));
  return { lines, alert };
}

// ---- Splitting ------------------------------------------------------------------------------------------------------

/** A line longer than `max` on its own is cut by characters (no line should be, but a post must never exceed `max`). */
function cutLine(line: string, max: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
  return parts.length > 0 ? parts : [''];
}

/**
 * Posts of at most `max` characters: blocks joined by a blank line, a new post started only at a block boundary. A
 * block longer than `max` on its own starts a new post and is cut at line boundaries; each later part's first line is
 * `(continued)`. The next block may join the oversize block's last part when it fits.
 */
export function splitForSlack(blocks: string[][], max = SLACK_MAX_CHARS): string[] {
  const posts: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur !== '') posts.push(cur);
    cur = '';
  };
  for (const block of blocks) {
    const text = block.join('\n');
    if (text.length <= max) {
      if (cur === '') cur = text;
      else if (cur.length + 2 + text.length <= max) cur = `${cur}\n\n${text}`;
      else {
        flush();
        cur = text;
      }
      continue;
    }
    flush();
    const marker = '(continued)';
    let part: string[] = [];
    let len = 0;
    for (const line of block.flatMap((l) => cutLine(l, max - marker.length - 1))) {
      const add = part.length === 0 ? line.length : len + 1 + line.length;
      if (part.length > 0 && add > max) {
        posts.push(part.join('\n'));
        part = [marker, line];
        len = marker.length + 1 + line.length;
      } else {
        part.push(line);
        len = add;
      }
    }
    cur = part.join('\n');
  }
  flush();
  return posts;
}
