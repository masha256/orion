import { inboxLines } from '../app/inbox.js';
import type { TickHolderYield, TickReport } from '../app/tickReport.js';
import type { JobStatus } from '../db/jobs.js';
import type { RegistryRow } from '../db/registry.js';
import type { WatchStateRow } from '../db/watchState.js';
import type { WatchFiring } from '../types.js';
import { slackEscape } from './slack.js';

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

const multipleOf = (x: number | null): string => (x === null ? 'n/a' : `${fmtNum(x)}x`);

/**
 * The holder-yield block. With the income statement v2 fields (spec 7): revenue, gross profit, holder flow by bucket, net
 * holder yield, multiples, scope and the statement's flags (`third_party`, not measured). A `refresh` row of the previous
 * release has none of them and prints the v1 block.
 */
function holderYieldLines(sym: string, h: TickHolderYield): string[] {
  const y = h.yields;
  if (h.scope !== undefined) {
    const byBucket = h.holder_flow_by_bucket ?? { burn: null, hold: null, cash: null };
    const buckets = (['burn', 'hold', 'cash'] as const).filter((b) => byBucket[b] !== null).map((b) => `${b} ${fmtNum(byBucket[b])}`);
    const lines = [
      `HOLDER YIELD ${sym}  ${h.day} (${h.window_days}d window, scope ${h.scope})`,
      `price ${fmtNum(h.price)} | mcap ${fmtNum(h.market_cap)} | FDV ${fmtNum(h.fdv)}`,
      `revenue ${fmtNum(h.statement_revenue ?? null)}/yr (growth ${fmtPct(h.statement_revenue_growth ?? null)}/yr) | gross profit ${h.gross_profit == null ? 'n/a' : `${fmtNum(h.gross_profit)}/yr`} | payout ratio ${fmtPct(h.statement_payout_ratio ?? null)}${h.payout_ratio_basis === 'revenue' ? ' of revenue' : ''}`,
      `holder flow/yr: ${buckets.length > 0 ? buckets.join(' | ') : 'n/a'}`,
      `yields: cash ${fmtPct(y.cash)} | buyback ${fmtPct(y.buyback)} | shareholder ${fmtPct(y.shareholder)} | dilution ${fmtPct(y.dilution)} | net holder yield ${fmtPct(h.net_holder_yield ?? null)}`,
      `multiples: mcap/revenue ${multipleOf(h.mcap_to_revenue ?? null)} | mcap/holder flow ${multipleOf(h.mcap_to_holder_flow ?? null)} | holder-flow growth ${fmtPct(h.holder_flow_growth_annualized)}/yr`,
    ];
    if (h.flags && h.flags.length > 0) lines.push(`flags: ${h.flags.join('; ')}`);
    return lines;
  }
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

/** The length a text has once posted: `slackEscape` turns `&` into five characters, `<` and `>` into four (M-7). */
const postedLength = (text: string): number => slackEscape(text).length;

/**
 * A line whose posted length is over `max` on its own is cut by code points (never inside a surrogate pair), each part
 * at most `max` once escaped. An `@` is counted as two, for the zero-width space a mention word gets.
 */
function cutLine(line: string, max: number): string[] {
  const parts: string[] = [];
  let part = '';
  let len = 0;
  for (const cp of line) {
    const cost = cp === '@' ? 2 : postedLength(cp);
    if (part !== '' && len + cost > max) {
      parts.push(part);
      part = '';
      len = 0;
    }
    part += cp;
    len += cost;
  }
  if (part !== '' || parts.length === 0) parts.push(part);
  return parts;
}

/**
 * Posts of at most `max` characters as posted (escaped): blocks joined by a blank line, a new post started only at a
 * block boundary. A block longer than `max` on its own starts a new post and is cut at line boundaries; each later
 * part's first line is `(continued)`. The next block may join the oversize block's last part when it fits.
 */
export function splitForSlack(blocks: string[][], max = SLACK_MAX_CHARS): string[] {
  const posts: string[] = [];
  let cur = '';
  let curLen = 0;
  const flush = (): void => {
    if (cur !== '') posts.push(cur);
    cur = '';
    curLen = 0;
  };
  for (const block of blocks) {
    const text = block.join('\n');
    const textLen = postedLength(text);
    if (textLen <= max) {
      if (cur === '') {
        cur = text;
        curLen = textLen;
      } else if (curLen + 2 + textLen <= max) {
        cur = `${cur}\n\n${text}`;
        curLen += 2 + textLen;
      } else {
        flush();
        cur = text;
        curLen = textLen;
      }
      continue;
    }
    flush();
    const marker = '(continued)';
    let part: string[] = [];
    let len = 0;
    for (const line of block.flatMap((l) => (postedLength(l) > max - marker.length - 1 ? cutLine(l, max - marker.length - 1) : [l]))) {
      const lineLen = postedLength(line);
      const add = part.length === 0 ? lineLen : len + 1 + lineLen;
      if (part.length > 0 && add > max) {
        posts.push(part.join('\n'));
        part = [marker, line];
        len = marker.length + 1 + lineLen;
      } else {
        part.push(line);
        len = add;
      }
    }
    cur = part.join('\n');
    curLen = len;
  }
  flush();
  return posts;
}

// ---- The nightly report ---------------------------------------------------------------------------------------------

/** What the nightly report prints (spec 6): everything comes from jobs and the registry; nothing is decided here. */
export interface NightlyInput {
  env: string;
  /** The UTC day the slot reports on (`reportDay`). */
  day: string;
  releaseTag: string | null;
  /** The slot's finished refreshes of assets that ran (skipped ones are in `notRun`), by asset id. */
  results: (AssetRunResult & { assetId: string })[];
  /** Paused, inactive and missing assets. */
  notRun: RegistryRow[];
  /** Symbols by asset id, for the lines of assets with no result (a missing asset has no YAML: its id upper-cased). */
  symbols: Record<string, string>;
  /** Assets whose registry `config_hash` changed since the previous delivered nightly. */
  configChanged: string[];
  /** Assets resumed since the last slot after a pause longer than their API series can refill. */
  resumedShort: { assetId: string; pausedDays: number; backfillDays: number }[];
  firingWatches: WatchStateRow[];
  /** Active assets with no finished refresh at the 3 h cut. */
  refreshesMissing: string[];
  /** The slot, for the REFRESH MISSING line. */
  slot: string;
  /** I-2: publishing off (`ORION_PUBLISH` off or unset), and unpushed snapshots over 1 h old (an alert). */
  publish?: { off: boolean; pending: number; oldest: string | null };
  /** I-7: active assets whose report lags the day; a LAG line for 2 days or more. */
  lags?: { assetId: string; lagDays: number }[];
}

/** The lag from which an asset gets a LAG line (LIT runs one day behind by design). */
export const LAG_LINE_DAYS = 2;

const publishPending = (input: NightlyInput): number => (input.publish && !input.publish.off && input.publish.pending > 0 ? 1 : 0);

export const NIGHTLY_REPLY_LINE = 'reply to Raymond: confirm <id> | reject <id> | approve <id> [note] | decline <id> <note> | ack <id> <note> | resolve <id> <note>';

/** How many alerts the report carries: each alerting asset block, and each refresh missing at the cut. */
export function nightlyAlerts(input: NightlyInput): number {
  return input.results.filter((r) => formatAssetBlock(r).alert).length + input.refreshesMissing.length + publishPending(input);
}

/**
 * The nightly posts: a head block (`ORION ALERT <env> nightly <day>: <n> alert(s)` when any asset block alerts or a
 * refresh is missing, else `ORION NIGHTLY <env> <day>: <n> assets ok`; the release; PAUSED, INACTIVE and MISSING lines;
 * CONFIG CHANGED; RESUMED; WATCH FIRING; REFRESH MISSING), then one block per asset headed `== <SYM> ==`, then the
 * reply line; split for Slack at asset boundaries. Registry text (by, reason) is outside text: cleaned.
 */
export function formatNightly(input: NightlyInput): string[] {
  const sym = (id: string): string => input.symbols[id] ?? id.toUpperCase();
  const results = [...input.results].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  const blocks = results.map((r) => formatAssetBlock(r));
  const alerts = blocks.filter((b) => b.alert).length + input.refreshesMissing.length + publishPending(input);
  const head = [
    alerts > 0 ? `ORION ALERT ${input.env} nightly ${input.day}: ${alerts} alert(s)` : `ORION NIGHTLY ${input.env} ${input.day}: ${results.length} assets ok`,
    `release ${input.releaseTag ?? '(dev checkout)'}`,
  ];
  const order: Record<string, number> = { paused: 0, inactive: 1, missing: 2 };
  const notRun = [...input.notRun].sort((a, b) => (order[a.state]! - order[b.state]!) || (a.assetId < b.assetId ? -1 : 1));
  for (const r of notRun) {
    const reason = r.stateReason ? `: ${slackClean(r.stateReason)}` : '';
    head.push(`${r.state.toUpperCase()} ${sym(r.assetId)} since ${r.stateSince.slice(0, 10)} by ${slackClean(r.stateBy, 80)}${reason}`);
  }
  for (const id of [...input.configChanged].sort()) head.push(`CONFIG CHANGED ${sym(id)}`);
  for (const r of [...input.resumedShort].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))) {
    head.push(`RESUMED ${sym(r.assetId)} after ${r.pausedDays} days; API series refill only ${r.backfillDays} days back`);
  }
  for (const w of input.firingWatches) {
    head.push(`WATCH FIRING ${sym(w.assetId)}: ${w.metricKey} ${w.rule} ${w.lastValue === null ? 'n/a' : exact(w.lastValue)} since ${w.since.slice(0, 10)}`);
  }
  for (const id of [...input.refreshesMissing].sort()) head.push(`REFRESH MISSING ${sym(id)}: no finished refresh 3 h after the ${input.slot} slot`);
  for (const l of [...(input.lags ?? [])].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))) {
    if (l.lagDays >= LAG_LINE_DAYS) head.push(`LAG ${sym(l.assetId)} ${l.lagDays}d`);
  }
  if (input.publish?.off) head.push('PUBLISH OFF');
  else if (publishPending(input) > 0) head.push(`PUBLISH PENDING ${input.publish!.pending} snapshot(s), oldest ${input.publish!.oldest}`);
  const assetBlocks = results.map((r, i) => [`== ${r.symbol} ==`, ...blocks[i]!.lines]);
  return splitForSlack([head, ...assetBlocks, [NIGHTLY_REPLY_LINE]]);
}
