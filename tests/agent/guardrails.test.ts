import { describe, expect, it } from 'vitest';
import {
  allowedRange, blockingAnomalies, checkEvidence, checkStep, maxStep, normalizeText, normalizeUrl, placeValue, routeObservation, textBlocks,
  verifyCitation, type EvidenceRef,
} from '../../src/agent/guardrails.js';
import { parseAssetYaml } from '../../src/config/load.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

// rev_growth_y1: key-wide [-0.5, 5]; base band [0, 1] (width 1, so the default step is 0.25); no bull band.
const asset = parseAssetYaml(
  MINI_ASSET_YAML.replace('  rev_growth_y1: { min: -0.5, max: 5 }', '  rev_growth_y1: { min: -0.5, max: 5, base: { min: 0, max: 1 } }'),
).config;

describe('anomaly block', () => {
  it('blocks on open degrading anomalies only, and a staged resolution lifts it', () => {
    const open = [{ id: 1, severity: 'degrading' as const }, { id: 2, severity: 'advisory' as const }, { id: 3, severity: 'degrading' as const }];
    expect(blockingAnomalies(open, new Set())).toEqual([1, 3]);
    expect(blockingAnomalies(open, new Set([1]))).toEqual([3]);
    expect(blockingAnomalies(open, new Set([1, 3]))).toEqual([]);
    expect(blockingAnomalies([{ id: 2, severity: 'advisory' }], new Set())).toEqual([]);
  });
});

describe('evidence', () => {
  const rows = new Map<number, EvidenceRef>([
    [1, { assetId: 'mini', active: true }],
    [2, { assetId: 'mini', active: false }],
    [3, { assetId: 'other', active: true }],
  ]);
  const lookup = (id: number) => rows.get(id) ?? null;

  it('requires at least one id', () => {
    expect(checkEvidence([], 'mini', lookup, new Set())?.refused).toBe('evidence_required');
  });

  it('refuses an id the agent was never shown, before anything else', () => {
    const r = checkEvidence([1, 2], 'mini', lookup, new Set([1]));
    expect(r).toMatchObject({ refused: 'evidence_not_shown', ids: [2] });
  });

  it('refuses inactive, foreign, and unknown ids even when shown', () => {
    const shown = new Set([1, 2, 3, 99]);
    expect(checkEvidence([1, 2], 'mini', lookup, shown)).toMatchObject({ refused: 'evidence_invalid', ids: [2] });
    expect(checkEvidence([3], 'mini', lookup, shown)).toMatchObject({ refused: 'evidence_invalid', ids: [3] });
    expect(checkEvidence([99], 'mini', lookup, shown)).toMatchObject({ refused: 'evidence_invalid', ids: [99] });
    expect(checkEvidence([1], 'mini', lookup, shown)).toBeNull();
  });
});

describe('bounds and bands', () => {
  it('places a value in the band, in the bounds only, or outside both', () => {
    expect(placeValue(asset, 'rev_growth_y1', 'base', 0.5)).toBe('in_band');
    expect(placeValue(asset, 'rev_growth_y1', 'base', 1)).toBe('in_band'); // edges are inside
    expect(placeValue(asset, 'rev_growth_y1', 'base', 1.2)).toBe('out_of_band');
    expect(placeValue(asset, 'rev_growth_y1', 'base', 5.1)).toBe('out_of_bounds');
    expect(placeValue(asset, 'rev_growth_y1', 'bull', 4)).toBe('in_band'); // no band: the key-wide bounds are the band
    expect(placeValue(asset, 'nope', 'base', 0)).toBe('unknown_key');
  });
});

describe('max step', () => {
  it('is a fraction of the band width, or of the key-wide range when there is no band', () => {
    expect(maxStep(asset, 'rev_growth_y1', 'base')).toBeCloseTo(0.25, 12);
    expect(maxStep(asset, 'rev_growth_y1', 'bull')).toBeCloseTo(1.375, 12);
  });

  it('allows a move of exactly one step and refuses more, returning the allowed range', () => {
    expect(checkStep(asset, 'rev_growth_y1', 'base', 0.5, 0.75)).toBeNull();
    expect(checkStep(asset, 'rev_growth_y1', 'base', 0.5, 0.25)).toBeNull();
    const r = checkStep(asset, 'rev_growth_y1', 'base', 0.5, 0.9);
    expect(r).toMatchObject({ refused: 'max_step', start: 0.5, allowed: { min: 0.25, max: 0.75 } });
  });

  it('clips the allowed range to the band', () => {
    expect(allowedRange(asset, 'rev_growth_y1', 'base', 0.9)).toEqual({ min: 0.65, max: 1 });
    expect(allowedRange(asset, 'rev_growth_y1', 'base', 0.1)).toEqual({ min: 0, max: 0.35 });
  });

  it('measures from the run-start value, so the range does not depend on anything staged', () => {
    // Whatever was staged in between, the second call is judged against 0.5 again.
    expect(checkStep(asset, 'rev_growth_y1', 'base', 0.5, 0.75)).toBeNull();
    expect(checkStep(asset, 'rev_growth_y1', 'base', 0.5, 1.0)?.refused).toBe('max_step');
  });

  it('handles a committed value outside its band: toward the band only, or nothing at all', () => {
    // 1.1 is out of band but within a step of it: the agent may move it to [0.85, 1].
    const toward = allowedRange(asset, 'rev_growth_y1', 'base', 1.1)!;
    expect(toward.min).toBeCloseTo(0.85, 12);
    expect(toward.max).toBe(1);
    // 2.0 is more than a step away: nothing in the band is reachable.
    expect(allowedRange(asset, 'rev_growth_y1', 'base', 2)).toBeNull();
    expect(checkStep(asset, 'rev_growth_y1', 'base', 2, 1)).toMatchObject({ refused: 'max_step', allowed: null });
  });

  it('honours agent.max_step_fraction', () => {
    const tight = parseAssetYaml(`${MINI_ASSET_YAML}agent: { max_step_fraction: 0.1 }\n`).config;
    expect(maxStep(tight, 'discount_rate_base', 'base')).toBeCloseTo(0.045, 12);
  });
});

describe('move guard', () => {
  const base = { allowProvisional: true, critical: true, inForce: 100, movePct: 25 };

  it('keeps a row inert when the metric does not allow provisional data', () => {
    expect(routeObservation({ ...base, allowProvisional: false, value: 1000 })).toBe('inert');
  });

  it('lets any move through on a non-critical metric', () => {
    expect(routeObservation({ ...base, critical: false, value: 1000 })).toBe('live');
  });

  it('turns a large move on a critical metric into a proposal; the threshold itself is allowed', () => {
    expect(routeObservation({ ...base, value: 125 })).toBe('live');
    expect(routeObservation({ ...base, value: 75 })).toBe('live');
    expect(routeObservation({ ...base, value: 126 })).toBe('proposal');
    expect(routeObservation({ ...base, value: 70 })).toBe('proposal');
  });

  it('proposes when nothing is in force to compare against', () => {
    expect(routeObservation({ ...base, inForce: null, value: 100 })).toBe('proposal');
    expect(routeObservation({ ...base, inForce: 0, value: 100 })).toBe('proposal');
  });
});

describe('verified citations', () => {
  const html =
    '<html><head><style>p { color: red }</style><script>var x = "annualized revenue of $999 million";</script></head>' +
    '<body><p>Venice said it had reached an <b>annualized&nbsp;revenue</b> of\n   $100&#160;million, the company&rsquo;s founder wrote &mdash; &ldquo;up from $70 million&rdquo;.</p></body></html>';
  const pages = [{ url: 'https://News.example.com/venice-revenue/#top', text: html }];

  it('normalizes tags, entities, typographic quotes, dashes, and whitespace, and drops script and style', () => {
    const text = normalizeText('<p>It&#8217;s  \u201Cup\u201D\u00A0&amp;   running \u2014 now</p>');
    expect(text).toBe('It\'s "up" & running - now');
    expect(normalizeText(html)).not.toContain('999');
    expect(normalizeText(html)).not.toContain('color');
  });

  it('normalizes a url: host case, fragment, one trailing slash; keeps the query', () => {
    expect(normalizeUrl('https://News.Example.com/a/b/#frag')).toBe('https://news.example.com/a/b');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com/a?id=2')).toBe('https://example.com/a?id=2');
    expect(normalizeUrl('not a url')).toBe('not a url');
  });

  it('accepts a verbatim quote across inline tags and entity spacing', () => {
    expect(verifyCitation(pages, 'https://news.example.com/venice-revenue', 'annualized revenue of $100 million')).toBeNull();
    expect(verifyCitation(pages, 'https://news.example.com/venice-revenue/', 'founder wrote - "up from $70 million"')).toBeNull();
  });

  it('cuts a page into blocks at block-level tags and blank lines; a single line break continues a block only into a lower-case line', () => {
    expect(textBlocks('<h1>Title</h1><p>One <b>bold</b> line<br>next</p><ul><li>a</li><li>b</li></ul>')).toEqual(['Title', 'One bold line next', 'a', 'b']);
    expect(textBlocks('<p>revenue grew 15 percent<br/>to $90 million</p>')).toEqual(['revenue grew 15 percent to $90 million']);
    expect(textBlocks('<td>Acme Corp<BR>Zenith Inc</td>')).toEqual(['Acme Corp', 'Zenith Inc']);
    // In HTML a source newline is only whitespace, whatever follows it.
    expect(textBlocks('<p>revenue reached\n   $100 million</p>')).toEqual(['revenue reached $100 million']);
    expect(textBlocks('First paragraph,\nwrapped.\n\nSecond paragraph.')).toEqual(['First paragraph, wrapped.', 'Second paragraph.']);
    expect(textBlocks('Acme Corp fell to $12 million\nZenith Inc grew to $90 million')).toEqual(['Acme Corp fell to $12 million', 'Zenith Inc grew to $90 million']);
    expect(textBlocks('<p>kept</p><script>var hidden = 1;</script>')).toEqual(['kept']);
  });

  it('refuses a quote spliced across blocks, though every word of it is on the page', () => {
    const table =
      '<table><tr><td>Acme Corp</td><td>revenue fell 40 percent to $12 million</td></tr>' +
      '<tr><td>Zenith Inc</td><td>revenue grew 15 percent to $90 million</td></tr></table>';
    const t = [{ url: 'https://x.example.com/t', text: table }];
    expect(verifyCitation(t, 'https://x.example.com/t', '$12 million Zenith Inc revenue grew 15 percent')?.refused).toBe('quote_spans_blocks');
    expect(verifyCitation(t, 'https://x.example.com/t', 'revenue grew 15 percent to $90 million')).toBeNull();
    const plain = [{ url: 'https://x.example.com/p', text: 'Acme reported revenue of $12 million.\n\nZenith reported\nrevenue of $90 million.' }];
    expect(verifyCitation(plain, 'https://x.example.com/p', 'of $12 million. Zenith reported revenue')?.refused).toBe('quote_spans_blocks');
    expect(verifyCitation(plain, 'https://x.example.com/p', 'Zenith reported revenue of $90 million')).toBeNull(); // one line break inside a paragraph is fine
  });

  it('accepts a sentence wrapped with a line break, and refuses a splice across single-newline rows of plain text', () => {
    const wrapped = [{ url: 'https://x.example.com/w', text: '<p>The company said revenue grew 15 percent<br>to $90 million in the quarter.</p>' }];
    expect(verifyCitation(wrapped, 'https://x.example.com/w', 'revenue grew 15 percent to $90 million in the quarter')).toBeNull();
    const rows = [{ url: 'https://x.example.com/r', text: 'Acme Corp revenue fell 40 percent to $12 million\nZenith Inc revenue grew 15 percent to $90 million' }];
    expect(verifyCitation(rows, 'https://x.example.com/r', '$12 million Zenith Inc revenue grew 15 percent')?.refused).toBe('quote_spans_blocks');
    expect(verifyCitation(rows, 'https://x.example.com/r', 'Zenith Inc revenue grew 15 percent to $90 million')).toBeNull();
  });

  it('refuses a page that was not fetched, a quote that is not there, and a quote too short to mean anything', () => {
    expect(verifyCitation(pages, 'https://other.example.com/x', 'annualized revenue of $100 million')?.refused).toBe('citation_not_fetched');
    expect(verifyCitation(pages, 'https://news.example.com/venice-revenue', 'annualized revenue of $200 million')?.refused).toBe('quote_not_found');
    expect(verifyCitation(pages, 'https://news.example.com/venice-revenue', 'annualized revenue of $999 million')?.refused).toBe('quote_not_found');
    expect(verifyCitation(pages, 'https://news.example.com/venice-revenue', '$100 million')?.refused).toBe('quote_too_short');
    expect(verifyCitation([], 'https://news.example.com/venice-revenue', 'annualized revenue of $100 million')?.refused).toBe('citation_not_fetched');
  });
});
