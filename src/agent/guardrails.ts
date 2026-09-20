import { agentBand, keyBounds, maxStepFraction, type Range } from '../config/agentPolicy.js';
import type { AssetConfig } from '../config/schema.js';
import type { Scenario } from '../types.js';

/**
 * Every rule the agent's writes must pass. Pure: no database, no clock, no model. The tool layer calls these and turns a
 * refusal into an `is_error` tool result, so nothing here depends on the model obeying its prompt.
 */

export interface Refusal {
  refused: string;
  message: string;
  [detail: string]: unknown;
}

const EPSILON = 1e-9;

// ---- Anomaly block -------------------------------------------------------------------------------------------------

export interface AnomalyRef {
  id: number;
  severity: 'degrading' | 'advisory';
}

/** Ids of the open degrading anomalies that block assumption writes. Advisory anomalies never block. */
export function blockingAnomalies(open: AnomalyRef[], stagedResolvedIds: ReadonlySet<number>): number[] {
  return open.filter((a) => a.severity === 'degrading' && !stagedResolvedIds.has(a.id)).map((a) => a.id);
}

// ---- Evidence ------------------------------------------------------------------------------------------------------

export interface EvidenceRef {
  assetId: string;
  /** Not superseded and not rejected. A row staged in this run counts as active. */
  active: boolean;
}

/**
 * At least one observation id; each must belong to the asset, be active, and have been shown to the agent in this run.
 * "Shown" is what stops the agent from citing ids it never looked at.
 */
export function checkEvidence(
  ids: number[],
  assetId: string,
  lookup: (id: number) => EvidenceRef | null,
  shown: ReadonlySet<number>,
): Refusal | null {
  if (ids.length === 0) return { refused: 'evidence_required', message: 'cite at least one observation id as evidence' };
  const notShown = ids.filter((id) => !shown.has(id));
  if (notShown.length > 0) {
    return {
      refused: 'evidence_not_shown',
      message: `observation ids ${notShown.join(', ')} were not shown to you in this run; read them first with get_observations`,
      ids: notShown,
    };
  }
  const invalid = ids.filter((id) => {
    const ref = lookup(id);
    return ref === null || ref.assetId !== assetId || !ref.active;
  });
  if (invalid.length > 0) {
    return {
      refused: 'evidence_invalid',
      message: `observation ids ${invalid.join(', ')} are not active observations of ${assetId}`,
      ids: invalid,
    };
  }
  return null;
}

// ---- Bounds, bands, and the max step --------------------------------------------------------------------------------

export type ValuePlacement = 'in_band' | 'out_of_band' | 'out_of_bounds' | 'unknown_key';

/** Where a value sits: inside the agent's band, inside the key-wide bounds only, or outside both. */
export function placeValue(asset: AssetConfig, key: string, scenario: Scenario, value: number): ValuePlacement {
  const bounds = keyBounds(asset, key);
  const band = agentBand(asset, key, scenario);
  if (!bounds || !band) return 'unknown_key';
  if (value < bounds.min - EPSILON || value > bounds.max + EPSILON) return 'out_of_bounds';
  if (value < band.min - EPSILON || value > band.max + EPSILON) return 'out_of_band';
  return 'in_band';
}

/** The largest move one run may make: a fraction of the band's width. */
export function maxStep(asset: AssetConfig, key: string, scenario: Scenario): number {
  const band = agentBand(asset, key, scenario);
  return band ? maxStepFraction(asset) * (band.max - band.min) : 0;
}

/**
 * The values the agent may apply this run: the band intersected with one step either side of `start`, the committed
 * value when the run began. Measuring from `start`, not from a staged value, is what stops repeated calls from
 * ratcheting. Null when the two do not meet (the committed value sits more than a step outside the band): the agent can
 * then only propose.
 */
export function allowedRange(asset: AssetConfig, key: string, scenario: Scenario, start: number): Range | null {
  const band = agentBand(asset, key, scenario);
  if (!band) return null;
  const step = maxStep(asset, key, scenario);
  const min = Math.max(band.min, start - step);
  const max = Math.min(band.max, start + step);
  return min <= max + EPSILON ? { min, max: Math.max(min, max) } : null;
}

export function checkStep(asset: AssetConfig, key: string, scenario: Scenario, start: number, value: number): Refusal | null {
  const step = maxStep(asset, key, scenario);
  if (Math.abs(value - start) <= step + EPSILON) return null;
  const allowed = allowedRange(asset, key, scenario, start);
  return {
    refused: 'max_step',
    message:
      `${key} (${scenario}) may move at most ${step} per run from ${start}. ` +
      (allowed
        ? `Allowed this run: [${allowed.min}, ${allowed.max}]. Apply a value in that range, and propose the rest if you still want it.`
        : 'No value inside the band is reachable this run; use propose_change.'),
    key, scenario, start, max_step: step, allowed,
  };
}

// ---- The move guard ------------------------------------------------------------------------------------------------

export type ObservationRoute = 'inert' | 'proposal' | 'live';

/**
 * Where a researched observation goes. `inert`: stored provisional and out of every signal until the user confirms it.
 * `live`: stored provisional and in the signal at grade C. `proposal`: too large a move on a critical metric to go
 * live unattended. `inForce` is null when nothing is in force (and always for flow and event metrics).
 */
export function routeObservation(input: {
  allowProvisional: boolean;
  critical: boolean;
  inForce: number | null;
  value: number;
  movePct: number;
}): ObservationRoute {
  if (!input.allowProvisional) return 'inert';
  if (!input.critical) return 'live';
  if (input.inForce === null || input.inForce === 0) return 'proposal';
  const move = Math.abs(input.value / input.inForce - 1) * 100;
  return move > input.movePct + EPSILON ? 'proposal' : 'live';
}

// ---- Verified citations --------------------------------------------------------------------------------------------

export interface FetchedPage {
  url: string;
  /** Page content as the web_fetch tool returned it: text, or HTML. */
  text: string;
}

export const MIN_QUOTE_LENGTH = 20;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...',
};

/** Tags out, entities decoded, typographic quotes and dashes made plain, whitespace collapsed. Case is kept. */
export function normalizeText(text: string): string {
  return text
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();
}

const BLOCK_TAG =
  /<\/?(?:address|article|aside|blockquote|br|caption|dd|details|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

/**
 * The page cut into blocks, each normalized: paragraphs, table cells, list items, headings; for plain text, runs separated
 * by a blank line. A quote must sit inside ONE block. Flattening the whole page would let a quote be spliced from two
 * unrelated blocks (a figure from one table row, a claim from the next) and still "occur" in the page.
 */
export function textBlocks(text: string): string[] {
  return text
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '\n\n')
    .replace(BLOCK_TAG, '\n\n')
    .split(/\n[ \t\r]*\n/)
    .map(normalizeText)
    .filter((block) => block !== '');
}

/** Scheme and host lowercased, fragment dropped, one trailing slash dropped. The query string is kept: it can select the page. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** The citation must be a page fetched in this run, and the quote must occur inside one block of it. Catches invented and spliced citations, not misread pages. */
export function verifyCitation(pages: FetchedPage[], citationUrl: string, quotedText: string): Refusal | null {
  const quote = normalizeText(quotedText);
  if (quote.length < MIN_QUOTE_LENGTH) {
    return { refused: 'quote_too_short', message: `quoted_text must be at least ${MIN_QUOTE_LENGTH} characters of the page's own words` };
  }
  const target = normalizeUrl(citationUrl);
  const fetched = pages.filter((p) => normalizeUrl(p.url) === target);
  if (fetched.length === 0) {
    return {
      refused: 'citation_not_fetched',
      message: `${citationUrl} was not fetched with web_fetch in this run; fetch the page you are citing, then record the observation`,
    };
  }
  if (fetched.some((p) => textBlocks(p.text).some((block) => block.includes(quote)))) return null;
  if (fetched.some((p) => normalizeText(p.text).includes(quote))) {
    return {
      refused: 'quote_spans_blocks',
      message: `quoted_text runs across separate blocks of ${citationUrl} (paragraphs, table cells, list items); quote from within one of them`,
    };
  }
  return {
    refused: 'quote_not_found',
    message: `quoted_text does not occur in the fetched text of ${citationUrl}; quote the page verbatim`,
  };
}
