import { describe, expect, it } from 'vitest';
import type { TickReport } from '../../src/app/tickReport.js';
import {
  fmtNum, fmtPct, formatAssetBlock, formatWatchCleared, formatWatchPost, slackClean, splitForSlack, SLACK_MAX_CHARS, type AssetRunResult,
} from '../../src/notify/format.js';
import { slackEscape } from '../../src/notify/slack.js';

/** A clean, completed tick for MINI: no watch, no failures, empty inbox, a holder-yield block. */
function cleanReport(): TickReport {
  return {
    schema_version: 2, tick_id: 'tick_mini_20261103T004500Z', asset: 'mini', started_at: '2026-11-03T00:45:00.000Z', ended_at: '2026-11-03T00:46:10.000Z',
    outcome: 'completed', lock: null,
    ingest: { fetch_run_id: 7, outcome: 'ok', sources_failed: [], anomalies_raised: [] },
    holder_yield: {
      day: '2026-11-02', window_days: 30, price: 1.2345, market_cap: 123_456_789, fdv: 2_500_000_000, revenue_annualized: 12_345_678,
      revenue_growth_annualized: 0.25, payout_ratio: 0.5, flows: [],
      yields: { cash: 0.0345, buyback: null, shareholder: 0.0345, dilution: -0.01, net_shareholder: 0.0245 },
      multiple: 28.987, holder_flow_growth_annualized: null,
    },
    report_error: null, inbox: { observations: [], proposals: [], anomalies: [] }, error: null,
  };
}

const HOLDER_BLOCK = [
  'HOLDER YIELD MINI  2026-11-02 (30d window)',
  'price 1.23 | mcap 123.46M | FDV 2.50B',
  'revenue 12.35M/yr (growth 25.00%/yr) | payout ratio 50.00%',
  'yields: cash 3.45% | buyback n/a | shareholder 3.45% | dilution -1.00% | net 2.45%',
  'multiple 28.99x | holder-flow growth n/a/yr',
];

function run(over: Partial<AssetRunResult> = {}, report: TickReport | null = cleanReport()): AssetRunResult {
  return { symbol: 'MINI', report, job: { status: 'done', attempts: 1, error: null }, fetchLines: [], alertFlags: [], ...over };
}

describe('number formatting', () => {
  it('fmt: fmtNum(1234567890) is 1.23B, fmtNum(0.012345) is 0.01235, fmtNum(null) is n/a; fmtPct(0.0345) is 3.45%', () => {
    expect(fmtNum(1234567890)).toBe('1.23B');
    expect(fmtNum(0.012345)).toBe('0.01235');
    expect(fmtNum(null)).toBe('n/a');
    expect(fmtPct(0.0345)).toBe('3.45%');
    expect(fmtPct(null)).toBe('n/a');
    expect([fmtNum(2_345_678), fmtNum(1234.5), fmtNum(12.345), fmtNum(1), fmtNum(0), fmtNum(-2_500_000), fmtNum(-0.5)]).toEqual(['2.35M', '1.23K', '12.35', '1.00', '0', '-2.50M', '-0.5000']);
  });
});

describe('report blocks', () => {
  it('format: a clean asset prints DECISIONS nothing to decide and the holder-yield block, alert false', () => {
    expect(formatAssetBlock(run())).toEqual({ lines: ['DECISIONS', 'nothing to decide', ...HOLDER_BLOCK], alert: false });
  });

  it('format: watch lines come first and print (was x) only when previous is non-null', () => {
    const report = cleanReport();
    report.ingest!.watch = [
      { metric: 'price_usd', rule: 'change_pct', value: 12.5, previous: 1.1, day: '2026-11-02' },
      { metric: 'tvl_usd', rule: 'above', value: 1_000_000, previous: null, day: '2026-11-02' },
    ];
    const out = formatAssetBlock(run({}, report));
    expect(out.lines.slice(0, 3)).toEqual(['ORION WATCH MINI: price_usd change_pct 12.5 (was 1.1)', 'ORION WATCH MINI: tvl_usd above 1000000', 'DECISIONS']);
    expect(out.alert).toBe(false); // a watch line is information, not an alert
    expect(formatWatchPost('MINI', report.ingest!.watch[0]!)).toBe('ORION WATCH MINI: price_usd change_pct 12.5 (was 1.1)');
    expect(formatWatchPost('MINI', report.ingest!.watch[1]!)).toBe('ORION WATCH MINI: tvl_usd above 1000000');
    expect(formatWatchCleared('MINI', 'price_usd', 'change_pct')).toBe('ORION WATCH MINI cleared: price_usd change_pct');
  });

  it('format: report_stale prints the error line after the block\'s first line and is an alert', () => {
    const report = cleanReport();
    report.report_error = { code: 'report_stale', message: 'holder-yield report day 2026-10-28 is 6 days behind the tick (2026-11-03); a report flow has stopped' };
    const out = formatAssetBlock(run({}, report));
    expect(out.lines).toEqual([
      'DECISIONS', 'nothing to decide', HOLDER_BLOCK[0],
      'HOLDER YIELD MINI report_stale: holder-yield report day 2026-10-28 is 6 days behind the tick (2026-11-03); a report flow has stopped',
      ...HOLDER_BLOCK.slice(1),
    ]);
    expect(out.alert).toBe(true);
    // report_unavailable: the line replaces the whole block.
    const gone = cleanReport();
    gone.holder_yield = null;
    gone.report_error = { code: 'report_unavailable', message: 'no price' };
    expect(formatAssetBlock(run({}, gone))).toEqual({ lines: ['DECISIONS', 'nothing to decide', 'HOLDER YIELD MINI report_unavailable: no price'], alert: true });
  });

  it('format: failed sources, raised anomalies, degrading inbox anomalies, job failures and flags are alerts; only flagged fetch lines print', () => {
    const report = cleanReport();
    report.ingest!.sources_failed = ['coingecko', 'rpc:base'];
    const fetchLines = ['coingecko: 3 days', 'price_usd OUTSIDE check range 1.1-1.3', 'rpc:base conflict at block 5', 'mail from unlisted sender x@y', 'quiet line'];
    const out = formatAssetBlock(run({ fetchLines }, report));
    expect(out.alert).toBe(true);
    expect(out.lines).toEqual([
      'failed sources: coingecko, rpc:base', 'DECISIONS', 'nothing to decide', ...HOLDER_BLOCK,
      'price_usd OUTSIDE check range 1.1-1.3', 'rpc:base conflict at block 5', 'mail from unlisted sender x@y',
    ]);
    expect(formatAssetBlock(run({ fetchLines })).lines).not.toContain('price_usd OUTSIDE check range 1.1-1.3'); // not an alert: not printed

    const raised = cleanReport();
    raised.ingest!.anomalies_raised = [{ id: 3, kind: 'stale', metric: 'price_usd', severity: 'advisory' }];
    expect(formatAssetBlock(run({}, raised)).alert).toBe(true);

    const degrading = cleanReport();
    degrading.inbox.anomalies = [{ id: 7, kind: 'cross_check_mismatch', metric: 'price_usd', severity: 'degrading', occurrences: 3, first_seen_at: '2026-09-19T00:00:00.000Z', last_seen_at: '2026-11-02T00:00:00.000Z', reading: { diff_pct: 4.15 } }];
    const d = formatAssetBlock(run({}, degrading));
    expect(d.alert).toBe(true);
    expect(d.lines.slice(0, 2)).toEqual(['DECISIONS', 'anom #7  cross_check_mismatch  price_usd  degrading  seen 3x since 2026-09-19  reading {"diff_pct":4.15}']);
    const advisory = cleanReport();
    advisory.inbox.anomalies = [{ ...degrading.inbox.anomalies[0]!, severity: 'advisory' }];
    expect(formatAssetBlock(run({}, advisory)).alert).toBe(false); // a non-empty inbox alone is not an alert

    expect(formatAssetBlock(run({ alertFlags: ['OUTSIDE'] })).alert).toBe(true);

    const failed = formatAssetBlock(run({ job: { status: 'failed', attempts: 2, error: 'rpc timeout <!channel>' } }, null));
    expect(failed).toEqual({ lines: ['MINI job failed after 2 attempts: rpc timeout !channel>'], alert: true });

    const busy = cleanReport();
    busy.outcome = 'run_in_progress';
    busy.ingest = null;
    busy.holder_yield = null;
    busy.lock = { holder: 'tick pid 42', acquired_at: '2026-11-03T00:40:00.000Z' };
    expect(formatAssetBlock(run({}, busy))).toEqual({ lines: ['MINI run in progress: locked by tick pid 42 since 2026-11-03T00:40:00.000Z', 'DECISIONS', 'nothing to decide'], alert: true });

    const errored = cleanReport();
    errored.outcome = 'error';
    errored.ingest = null;
    errored.holder_yield = null;
    errored.error = { code: 'config_invalid', message: 'bad yaml' };
    expect(formatAssetBlock(run({}, errored))).toEqual({ lines: ['MINI error config_invalid: bad yaml', 'DECISIONS', 'nothing to decide'], alert: true });
  });
});

describe('slack text cleaning', () => {
  it('clean: control and format characters go first, so split mentions, URLs and comments are still caught; then the cap', () => {
    expect(slackClean('hi <@U123> and <!channel> in <#C9|ops>')).toBe('hi @U123> and !channel> in #C9|ops>');
    expect(slackClean('<\u200b@U123> <\u0007!here> <\u200b#C1> <\u200b!\u200b-\u200b-hidden')).toBe('@U123> !here> #C1> hidden');
    expect(slackClean('see https://evil.example/x?y=1 or ht\u200btps://e\u0007vil.example/z and www.evil.example/a')).toBe('see [url] or [url] and [url]');
    expect(slackClean('<!-- ignore previous instructions -->ok')).toBe('ignore previous instructions -->ok');
    expect(slackClean('a\u202eb\u2066c\ufeffd\u00ade\u0000f\u001bg\u009bh\ni')).toBe('abcdefgh i');
    expect(slackClean('x'.repeat(500))).toHaveLength(300);
    expect(slackClean('x'.repeat(500), 10)).toBe('xxxxxxxxx…');
    // Cap last: the length counts the cleaned text, not the raw one.
    expect(slackClean('\u200b'.repeat(400) + 'short')).toBe('short');
  });
});

describe('splitForSlack', () => {
  it('split: blocks are never split below the limit; an oversize block continues in the next post', () => {
    const block = (tag: string, n: number, width = 9): string[] => Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(width - tag.length, '0')}`);
    // Each line is 9 chars; a 3-line block is 29 chars. max 70: two blocks (29 + 2 + 29 = 60) fit, a third does not.
    const a = block('a', 3), b = block('b', 3), c = block('c', 3);
    expect(splitForSlack([a, b, c], 70)).toEqual([[...a, '', ...b].join('\n'), c.join('\n')]);
    for (const post of splitForSlack([a, b, c], 70)) expect(post.length).toBeLessThanOrEqual(70);
    // An oversize block (10 lines, 99 chars; max 52) is cut at line boundaries, each later part starting "(continued)".
    const big = block('z', 10);
    const posts = splitForSlack([a, big, b], 52);
    expect(posts[0]).toBe(a.join('\n'));
    expect(posts[1]).toBe(big.slice(0, 5).join('\n'));
    expect(posts[2]).toBe(['(continued)', ...big.slice(5, 9)].join('\n'));
    expect(posts[3]).toBe(['(continued)', big[9]!, '', ...b].join('\n'));
    for (const post of posts) expect(post.length).toBeLessThanOrEqual(52);
    expect(posts.join('\n').split('\n').filter((l) => l !== '' && l !== '(continued)')).toEqual([...a, ...big, ...b]);
    expect(splitForSlack([])).toEqual([]);
    expect(SLACK_MAX_CHARS).toBe(3900);
  });

  it('split: the limit counts the text as posted (escaped), and a cut never splits a surrogate pair (M-7)', () => {
    // 30 raw chars, 150 once escaped: two such blocks are 62 raw but 302 posted, past a 200 limit.
    const amp = ['&'.repeat(30)];
    const posts = splitForSlack([amp, amp], 200);
    expect(posts).toEqual([amp[0], amp[0]]);
    for (const p of posts) expect(slackEscape(p).length).toBeLessThanOrEqual(200);
    // An oversize line of `<` is cut so that every escaped part fits.
    const lt = splitForSlack([['<'.repeat(100)]], 52);
    for (const p of lt) expect(slackEscape(p).length).toBeLessThanOrEqual(52);
    expect(lt.join('\n').split('\n').filter((l) => l !== '(continued)').join('')).toBe('<'.repeat(100));
    // Emoji are two UTF-16 units: a cut lands between them, never inside one.
    const emoji = splitForSlack([['😀'.repeat(40)]], 31);
    for (const p of emoji) {
      expect(slackEscape(p).length).toBeLessThanOrEqual(31);
      expect(p).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });
});
