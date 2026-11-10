import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { emitTickReport, summarizeHolderYield, tickId, TickReportSchema, type TickReport } from '../../src/app/tickReport.js';
import { yieldReport } from '../../src/report/load.js';
import type { IsV2 } from '../../src/report/incomeStatement.js';
import { repoAsset, syntheticInput } from '../helpers/syntheticReport.js';

/** A minimal but schema-valid report: `run_in_progress`, lock set, everything else at its empty/absent value. */
function minimalReport(): TickReport {
  return {
    schema_version: 2, tick_id: 'tick_mini_20260919T120005Z', asset: 'mini', started_at: '2026-09-19T12:00:05.000Z', ended_at: '2026-09-19T12:00:05.000Z',
    outcome: 'run_in_progress', lock: { holder: 'tick pid 1', acquired_at: '2026-09-19T12:00:00.000Z' },
    ingest: null, holder_yield: null, report_error: null, inbox: { observations: [], proposals: [], anomalies: [] }, error: null,
  };
}

describe('emitTickReport', () => {
  it('writes a valid report as one JSON line, and appends it plus a newline to outFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-tickreport-'));
    const outFile = join(dir, 'signals.jsonl');
    const written: string[] = [];
    const report = minimalReport();

    emitTickReport(report, { write: (line) => written.push(line), outFile });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toEqual(report);
    const fileContents = readFileSync(outFile, 'utf8');
    expect(fileContents).toBe(written[0] + '\n');
    expect(fileContents.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('throws on an invalid report, never calling write, and never creating outFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-tickreport-'));
    const outFile = join(dir, 'signals.jsonl');
    const written: string[] = [];
    const invalid = { ...minimalReport(), outcome: 'nope' } as unknown as TickReport;

    expect(() => emitTickReport(invalid, { write: (line) => written.push(line), outFile })).toThrow(ZodError);
    expect(written).toHaveLength(0);
    expect(existsSync(outFile)).toBe(false);
  });

  it('guards its own append: a write failure is reported, not thrown, and write already ran', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-tickreport-'));
    writeFileSync(join(dir, 'file.txt'), 'not a directory');
    const outFile = join(dir, 'file.txt', 'ticks.jsonl');
    const written: string[] = [];
    const appendErrors: unknown[] = [];
    const report = minimalReport();

    expect(() => emitTickReport(report, { write: (line) => written.push(line), outFile, onAppendError: (err) => appendErrors.push(err) })).not.toThrow();

    expect(written).toHaveLength(1);
    expect(appendErrors).toHaveLength(1);
    expect(appendErrors[0]).toBeInstanceOf(Error);
  });

  it('with no outFile, only calls write', () => {
    const written: string[] = [];
    const report = minimalReport();

    emitTickReport(report, { write: (line) => written.push(line) });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toEqual(report);
  });
});

describe('summarizeHolderYield (Task 11b: every figure is the statement\'s)', () => {
  const FIELDS = ['day', 'window_days', 'price', 'market_cap', 'fdv', 'flows', 'yields', 'multiple', 'holder_flow_growth_annualized'];

  it('copies the header and the statement field for field, unrounded; no v1-only field (T4 M2)', () => {
    const input = syntheticInput(repoAsset('lit'));
    const r = yieldReport(input);
    const is: IsV2 = r.incomeStatement!;
    const h = summarizeHolderYield(r);
    expect(Object.keys(h)).toEqual([
      ...FIELDS, 'statement_revenue', 'statement_revenue_growth', 'gross_profit', 'statement_payout_ratio', 'payout_ratio_basis',
      'holder_flow_by_bucket', 'net_holder_yield', 'mcap_to_revenue', 'mcap_to_holder_flow', 'scope', 'flags',
    ]);
    expect(h).toMatchObject({ day: r.day, window_days: r.windowDays, price: r.price, market_cap: r.marketCap, fdv: r.fdv });
    expect(h.flows).toEqual(is.holderFlow.lines.filter((l) => l.bucket !== null && l.notMeasured === undefined).map((l) => ({ id: l.id, bucket: l.bucket, net: l.net, yield: l.yield })));
    expect(h.flows.length).toBeGreaterThan(0);
    const y = is.yields;
    expect(h.yields).toEqual({ cash: y.cash, buyback: y.buyback, shareholder: y.shareholder, dilution: y.dilution, net_shareholder: y.netShareholder });
    expect(h.multiple).toBe(y.multiple);
    expect(h.holder_flow_growth_annualized).toBe(is.holderFlow.growth.annualized);
    expect(h).toMatchObject({
      statement_revenue: is.revenue.annualized, statement_revenue_growth: is.revenue.growth.annualized, gross_profit: is.grossProfit.annualized,
      statement_payout_ratio: is.ratios.payoutRatio, payout_ratio_basis: is.ratios.payoutRatioBasis,
      holder_flow_by_bucket: { burn: is.holderFlow.byBucket.burn!.net, hold: null, cash: null },
      net_holder_yield: is.yields.netShareholder, mcap_to_revenue: is.multiples.mcapToRevenue, mcap_to_holder_flow: is.multiples.mcapToHolderFlow.total,
      scope: is.scope, flags: is.flags,
    });
    expect(h.gross_profit).toEqual(expect.any(Number));
    expect(TickReportSchema.parse({ ...minimalReport(), outcome: 'completed', lock: null, holder_yield: h }).holder_yield).toEqual(h);
  });

  it('a statement that threw: the header, empty flows, null yields and the error (C4)', () => {
    const r = { ...yieldReport(syntheticInput(repoAsset('lit'))), incomeStatement: null, incomeStatementError: 'boom' };
    expect(summarizeHolderYield(r)).toEqual({
      day: r.day, window_days: r.windowDays, price: r.price, market_cap: r.marketCap, fdv: r.fdv, flows: [],
      yields: { cash: null, buyback: null, shareholder: null, dilution: null, net_shareholder: null }, multiple: null, holder_flow_growth_annualized: null,
      statement_error: 'boom',
    });
  });

  it('tick holder_yield from a v1 job row still parses (a release before Task 4: v1 fields only)', () => {
    const row = JSON.parse(readFileSync(new URL('../fixtures/daemon/refresh-result-v1.json', import.meta.url), 'utf8')) as { report: TickReport };
    expect(row.report.holder_yield).not.toHaveProperty('gross_profit');
    expect(TickReportSchema.parse(row.report)).toEqual(row.report);
  });
});

describe('TickReportSchema', () => {
  it('accepts a holder_yield block and a report_error, and refuses an extra key in either', () => {
    const holder_yield = summarizeHolderYield(yieldReport(syntheticInput(repoAsset('lit'))));
    const ok: TickReport = { ...minimalReport(), outcome: 'completed', lock: null, holder_yield };
    expect(TickReportSchema.parse(ok)).toEqual(ok);
    const unavailable: TickReport = { ...minimalReport(), outcome: 'completed', lock: null, report_error: { code: 'report_unavailable', message: 'mini: no stored day' } };
    expect(TickReportSchema.parse(unavailable)).toEqual(unavailable);
    expect(() => TickReportSchema.parse({ ...ok, holder_yield: { ...holder_yield, target: 1 } })).toThrow(ZodError);
    expect(() => TickReportSchema.parse({ ...unavailable, report_error: { code: 'x', message: 'y', detail: 1 } })).toThrow(ZodError);
  });
});

describe('tickId', () => {
  it('formats the asset and started time with no separators, to the second, ending in Z', () => {
    expect(tickId('mini', new Date('2026-09-19T12:00:05.123Z'))).toBe('tick_mini_20260919T120005Z');
  });
});
