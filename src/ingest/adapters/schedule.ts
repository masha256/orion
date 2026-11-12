import type { SourceContext, SourceValue } from '../types.js';
import { addMonthsClamped, intIn, isoDate } from './dates.js';
import type { AdapterDef } from './registry.js';

/**
 * Generic cited schedules (Phase 3 R1 Task 4, rung `disclosure`): values computed offline from a schedule the asset YAML
 * states and cites, for figures no contract or first-party API exposes (team and investor vesting held in plain
 * wallets). The adapter reads nothing: `params.citation` is the source, and its url and verbatim quote go onto every row
 * it writes (`citation_url` / `quoted_text`; 0006's observations_disclosure_citation CHECK needs the url). The row's
 * method is `disclosed`, so a figure built from a citation is never presented as measured.
 */

const YEAR_MS = 365 * 86_400_000;
const MAX_QUOTE = 500;
const MAX_YEARS = 50;

const KEYS = ['citation', 'schedules'];
const CITATION_KEYS = ['url', 'quote'];
const SCHEDULE_KEYS = ['label', 'tokens', 'tranches', 'linear'];
const TRANCHE_KEYS = ['first', 'every_months', 'count'];
const LINEAR_KEYS = ['start', 'years'];

interface Tranches {
  first: string;
  every_months: number;
  count: number;
}
interface Linear {
  start: string;
  years: number;
}
interface Schedule {
  label: string;
  tokens: number;
  tranches?: Tranches;
  linear?: Linear;
}
interface Citation {
  url: string;
  quote: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const shown = (v: unknown): string => JSON.stringify(v ?? null);
const unknownKeys = (o: Record<string, unknown>, allowed: string[], where: string): string[] =>
  Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${where}unknown key "${k}" (${allowed.join(', ')})`);

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateSchedule(s: unknown, i: number): string[] {
  const at = `schedules[${i}]`;
  if (!isObject(s)) return [`${at}: an object { label, tokens, tranches | linear }`];
  const issues = unknownKeys(s, SCHEDULE_KEYS, `${at}: `);
  if (typeof s.label !== 'string' || s.label.trim() === '') issues.push(`${at}.label: a non-empty string`);
  if (typeof s.tokens !== 'number' || !Number.isFinite(s.tokens) || s.tokens <= 0) issues.push(`${at}.tokens: a finite number > 0, not ${shown(s.tokens)}`);
  const hasTranches = s.tranches !== undefined;
  const hasLinear = s.linear !== undefined;
  if (hasTranches === hasLinear) {
    issues.push(`${at}: exactly one of tranches or linear`);
    return issues;
  }
  if (hasTranches) {
    const t = s.tranches;
    if (!isObject(t)) return [...issues, `${at}.tranches: an object { first: YYYY-MM-DD, every_months: 1..12, count: 1..120 }`];
    issues.push(...unknownKeys(t, TRANCHE_KEYS, `${at}.tranches: `));
    if (isoDate(t.first) === null) issues.push(`${at}.tranches.first: a calendar date YYYY-MM-DD, not ${shown(t.first)}`);
    if (!intIn(t.every_months, 1, 12)) issues.push(`${at}.tranches.every_months: an integer 1..12, not ${shown(t.every_months)}`);
    if (!intIn(t.count, 1, 120)) issues.push(`${at}.tranches.count: an integer 1..120, not ${shown(t.count)}`);
  } else {
    const l = s.linear;
    if (!isObject(l)) return [...issues, `${at}.linear: an object { start: YYYY-MM-DD, years: > 0 }`];
    issues.push(...unknownKeys(l, LINEAR_KEYS, `${at}.linear: `));
    if (isoDate(l.start) === null) issues.push(`${at}.linear.start: a calendar date YYYY-MM-DD, not ${shown(l.start)}`);
    if (typeof l.years !== 'number' || !Number.isFinite(l.years) || l.years <= 0 || l.years > MAX_YEARS) issues.push(`${at}.linear.years: a number > 0 and <= ${MAX_YEARS}, not ${shown(l.years)}`);
  }
  return issues;
}

export function validateScheduleUnlocksParams(params: Record<string, unknown>): string[] {
  const issues = unknownKeys(params, KEYS, '');
  const c = params.citation;
  if (!isObject(c)) {
    issues.push('citation: an object { url, quote } (the cited source of the schedule)');
  } else {
    issues.push(...unknownKeys(c, CITATION_KEYS, 'citation: '));
    if (!isHttpUrl(c.url)) issues.push(`citation.url: an http(s) URL, not ${shown(c.url)}`);
    if (typeof c.quote !== 'string' || c.quote.trim() === '' || c.quote.length > MAX_QUOTE) issues.push(`citation.quote: the verbatim quote, a non-empty string of at most ${MAX_QUOTE} chars`);
  }
  const list = params.schedules;
  if (!Array.isArray(list) || list.length === 0) issues.push('schedules: a non-empty list of { label, tokens, tranches | linear }');
  else list.forEach((s, i) => issues.push(...validateSchedule(s, i)));
  return issues;
}

/** Tokens of one tranche schedule dated in (now, end]: `tokens / count` per tranche, dates as lit.unlocks_next_year's. */
function tranchesDue(tokens: number, tr: Tranches, nowMs: number, endMs: number): number {
  const [y, m, d] = isoDate(tr.first)!;
  let due = 0;
  for (let k = 0; k < tr.count; k++) {
    const t = addMonthsClamped(y, m, d, k * tr.every_months);
    if (t > nowMs && t <= endMs) due++;
  }
  return (tokens / tr.count) * due;
}

/** Tokens of one linear vest released in (now, end]: `tokens / years` per 365 days over [start, start + years x 365 d]. */
function linearDue(tokens: number, l: Linear, nowMs: number, endMs: number): number {
  const [y, m, d] = isoDate(l.start)!;
  const startMs = Date.UTC(y, m - 1, d);
  const vestEndMs = startMs + l.years * YEAR_MS;
  const overlap = Math.max(0, Math.min(endMs, vestEndMs) - Math.max(nowMs, startMs));
  return (tokens / l.years) * (overlap / YEAR_MS);
}

/**
 * Tokens unlocking in (now, now + 365 d], summed over the cited schedules. Report-only dilution: the tokens are already in
 * total supply. Stamped `api` (a config-stated figure, as a constant is), with the citation carried onto the row.
 */
async function unlocksNextYear(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const issues = validateScheduleUnlocksParams(params);
  if (issues.length > 0) throw new Error(`params: ${issues.join('; ')}`);
  const citation = params.citation as Citation;
  const schedules = params.schedules as Schedule[];
  const nowMs = Date.parse(ctx.nowIso);
  const endMs = nowMs + YEAR_MS;
  let total = 0;
  const parts: string[] = [];
  for (const s of schedules) {
    const due = s.tranches ? tranchesDue(s.tokens, s.tranches, nowMs, endMs) : linearDue(s.tokens, s.linear!, nowMs, endMs);
    total += due;
    parts.push(`${s.label} ${(due / 1e6).toFixed(2)}M`);
  }
  return {
    kind: 'level', value: total, observedAt: ctx.nowIso, source: 'api', detail: `${parts.join(', ')}; cited ${citation.url}`,
    citation: { url: citation.url, quote: citation.quote },
  };
}

export const scheduleAdapters: AdapterDef[] = [
  {
    name: 'schedule.unlocks_next_year',
    needsRpc: false,
    paramsDoc:
      `citation: { url: http(s) URL, quote: the verbatim text, at most ${MAX_QUOTE} chars } (required: written onto every row); ` +
      'schedules: [{ label: string, tokens: > 0, and exactly one of tranches: { first: YYYY-MM-DD, every_months: 1..12, count: 1..120 } ' +
      `(tokens / count on first + k x every_months, day clamped to the month's end) or linear: { start: YYYY-MM-DD, years: > 0 and <= ${MAX_YEARS} } ` +
      '(tokens / years per 365 days from start) }] (required): the value is the tokens due in (now, now + 365 days], summed',
    validateParams: validateScheduleUnlocksParams,
    run: unlocksNextYear,
  },
];
