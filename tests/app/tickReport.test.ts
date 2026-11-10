import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { emitTickReport, summarizeHolderYield, tickId, TickReportSchema, type TickReport } from '../../src/app/tickReport.js';
import type { Growth } from '../../src/report/holderYield.js';
import type { HolderYieldReport, IncomeStatement, RevenueReport } from '../../src/report/legacy.js';
import { yieldReport } from '../../src/report/load.js';
import { incomeStatementV2, type IsV2 } from '../../src/report/incomeStatement.js';
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

const growth = (annualized: number | null): Growth => ({ current: null, prior: null, change: null, annualized });

/** A report with every field summarizeHolderYield reads set to a distinct, unrounded value. */
function holderYieldReport(over: Partial<HolderYieldReport> = {}): HolderYieldReport {
  return {
    asset: 'mini', day: '2026-09-18', windowDays: 30, price: 1.2345678, marketCap: 600.123, fdv: 1000.987,
    flows: [
      { id: 'fees', metric: 'flow_usd.fees', bucket: 'cash', recipientBase: 'all', haircut: 0.01, gross: 120, net: 118.8, yield: 0.0123456789, growth: growth(0.5) },
      { id: 'burn', metric: 'flow_usd.burn', bucket: 'burn', recipientBase: 'all', haircut: 0, gross: null, net: null, yield: null, growth: growth(null) },
    ],
    buckets: { burn: null, hold: null, cash: null },
    yields: { cash: 0.011, buyback: 0.022, shareholder: 0.033, dilution: 0.004, netShareholder: 0.029, multiple: 30.303, pegTrailing: null },
    holderFlowGrowth: growth(0.4567),
    supply: null, income: null, revenue: null, volume: null, revenueDisclosed: null, notes: [],
    ...over,
  };
}
const income = (annualized: number, growthAnnualized: number, payoutRatio: number): IncomeStatement =>
  ({ revenue: { annualized, growth: growth(growthAnnualized) }, payoutRatio } as unknown as IncomeStatement);
const revenue = (annualized: number | null, growthAnnualized: number | null): RevenueReport =>
  ({ basis: 'streams', streams: [], annualized, growth: growth(growthAnnualized), growthExNew: null, excludedFromExNew: [] } as unknown as RevenueReport);

describe('summarizeHolderYield', () => {
  it('copies field for field, unrounded, and reads revenue from the income statement when there are no streams', () => {
    expect(summarizeHolderYield(holderYieldReport({ income: income(5000.5, 0.25, 0.75) }))).toEqual({
      day: '2026-09-18', window_days: 30, price: 1.2345678, market_cap: 600.123, fdv: 1000.987,
      revenue_annualized: 5000.5, revenue_growth_annualized: 0.25, payout_ratio: 0.75,
      flows: [{ id: 'fees', bucket: 'cash', net: 118.8, yield: 0.0123456789 }, { id: 'burn', bucket: 'burn', net: null, yield: null }],
      yields: { cash: 0.011, buyback: 0.022, shareholder: 0.033, dilution: 0.004, net_shareholder: 0.029 },
      multiple: 30.303, holder_flow_growth_annualized: 0.4567,
    });
  });

  it('prefers the revenue streams over the income statement, and gives null without either', () => {
    const both = summarizeHolderYield(holderYieldReport({ income: income(5000.5, 0.25, 0.75), revenue: revenue(7000, 0.1) }));
    expect(both).toMatchObject({ revenue_annualized: 7000, revenue_growth_annualized: 0.1, payout_ratio: 0.75 });
    expect(summarizeHolderYield(holderYieldReport())).toMatchObject({ revenue_annualized: null, revenue_growth_annualized: null, payout_ratio: null });
  });
});

describe('summarizeHolderYield: income statement v2 (Task 4)', () => {
  const V1_FIELDS = ['day', 'window_days', 'price', 'market_cap', 'fdv', 'revenue_annualized', 'revenue_growth_annualized', 'payout_ratio', 'flows', 'yields', 'multiple', 'holder_flow_growth_annualized'];

  it('adds the v2 fields after the v1 ones, copied from incomeStatement; the v1 fields do not move', () => {
    const input = syntheticInput(repoAsset('lit'));
    const { incomeStatement: _is, ...v1 } = yieldReport(input, { legacy: true });
    const is: IsV2 = incomeStatementV2(input);
    const before = summarizeHolderYield(v1);
    const after = summarizeHolderYield({ ...v1, incomeStatement: is });
    expect(Object.keys(before)).toEqual(V1_FIELDS);
    expect(Object.keys(after)).toEqual([
      ...V1_FIELDS, 'statement_revenue', 'statement_revenue_growth', 'gross_profit', 'statement_payout_ratio', 'payout_ratio_basis',
      'holder_flow_by_bucket', 'net_holder_yield', 'mcap_to_revenue', 'mcap_to_holder_flow', 'scope', 'flags',
    ]);
    for (const k of V1_FIELDS) expect(after[k as keyof typeof after]).toEqual(before[k as keyof typeof before]);
    expect(after).toMatchObject({
      statement_revenue: is.revenue.annualized, statement_revenue_growth: is.revenue.growth.annualized, gross_profit: is.grossProfit.annualized,
      statement_payout_ratio: is.ratios.payoutRatio, payout_ratio_basis: is.ratios.payoutRatioBasis,
      holder_flow_by_bucket: { burn: is.holderFlow.byBucket.burn!.net, hold: null, cash: null },
      net_holder_yield: is.yields.netShareholder, mcap_to_revenue: is.multiples.mcapToRevenue, mcap_to_holder_flow: is.multiples.mcapToHolderFlow.total,
      scope: is.scope, flags: is.flags,
    });
    expect(after.gross_profit).toEqual(expect.any(Number));
    expect(TickReportSchema.parse({ ...minimalReport(), outcome: 'completed', lock: null, holder_yield: after }).holder_yield).toEqual(after);
  });

  it('tick holder_yield from a v1 job row still parses', () => {
    const row = JSON.parse(readFileSync(new URL('../fixtures/daemon/refresh-result-v1.json', import.meta.url), 'utf8')) as { report: TickReport };
    expect(row.report.holder_yield).not.toHaveProperty('gross_profit');
    expect(TickReportSchema.parse(row.report)).toEqual(row.report);
  });
});

describe('TickReportSchema', () => {
  it('accepts a holder_yield block and a report_error, and refuses an extra key in either', () => {
    const holder_yield = summarizeHolderYield(holderYieldReport());
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
