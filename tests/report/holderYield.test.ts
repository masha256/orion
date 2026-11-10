import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { addDays } from '../../src/ingest/time.js';
import { growthOf, reportHeader, type ReportLevels } from '../../src/report/holderYield.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const series = (first: string, values: number[]) => new Map(values.map((v, i) => [addDays(first, i), v] as const));
const flat = (first: string, n: number, v: number) => series(first, Array.from({ length: n }, () => v));

describe('growthOf', () => {
  it('compares the latest window with the one before it and annualizes the ratio', () => {
    // 10 days at 1, then 10 days at 2: the latest 10-day window is double the prior one.
    const daily = new Map([['f', series('2026-01-01', [...Array(10).fill(1), ...Array(10).fill(2)])]]);
    const g = growthOf(daily, ['f'], '2026-01-20', 10);
    expect(g.current).toBe(20);
    expect(g.prior).toBe(10);
    expect(g.change).toBeCloseTo(1);
    expect(g.annualized).toBeCloseTo(2 ** 36.5 - 1);
  });
  it('is null until both windows are complete, and n/m when a window is zero', () => {
    const daily = new Map([['f', flat('2026-01-01', 15, 1)]]);
    expect(growthOf(daily, ['f'], '2026-01-15', 10).annualized).toBeNull();
    const zero = new Map([['f', series('2026-01-01', [...Array(10).fill(0), ...Array(10).fill(3)])]]);
    const g = growthOf(zero, ['f'], '2026-01-20', 10);
    expect(g.annualized).toBeNull();
    expect(g.note).toMatch(/not meaningful/);
  });
  it('sums several metrics, each net of its weight', () => {
    const daily = new Map([
      ['a', flat('2026-01-01', 20, 1)],
      ['b', series('2026-01-01', [...Array(10).fill(0), ...Array(10).fill(1)])],
    ]);
    // prior: a 10 + b 0 = 10; current: a 10 + 0.5 * b 10 = 15.
    const g = growthOf(daily, ['a', 'b'], '2026-01-20', 10, [1, 0.5]);
    expect(g.prior).toBe(10);
    expect(g.current).toBe(15);
  });
});

/** The HYPE fixture (one buy-and-hold flow) with an income statement: `holders` and `below` are its sections' YAML. */
const hypeYaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
const withStatement = (holders: string, below = '', revenue = '    - { id: trading, not_measured: "fixture" }\n') => `${hypeYaml.replace('metrics:\n', 'metrics:\n  run_rate_usd: { type: level, unit: usd, staleness_days: 30 }\n  flow_usd.other: { type: flow, unit: usd, staleness_days: 7 }\n')}income_statement:
  category: perp_dex
  scope: complete
  window_days: 10
  revenue:
${revenue}  holders:
${holders}${below ? `  below_line:\n${below}` : ''}`;
const BUYBACK = '    - { id: buyback, metric: flow_usd.buyback, bucket: hold, haircut: 0.05, recipient_base: all, capture_rule: programmatic }\n';

describe('reportHeader (Task 11: the notes v1 printed, read from income_statement)', () => {
  const levels: ReportLevels = { price: 2, totalSupply: 1000, circulatingSupply: 600, stakedSupply: 400, lockedSupply: null, emissionRateAnnual: 50, extra: {}, disclosed: [] };
  const head = (yaml: string, over: Partial<ReportLevels> = {}, provisional?: Map<string, Set<string>>) =>
    reportHeader({ asset: parseAssetYaml(yaml).config, day: '2026-01-20', daily: new Map(), levels: { ...levels, ...over }, ...(provisional ? { provisional } : {}) });

  it('market cap on circulating supply, FDV on total supply, the statement\'s window', () => {
    expect(head(withStatement(BUYBACK))).toEqual({ windowDays: 10, price: 2, marketCap: 1200, fdv: 2000, notes: [] });
    expect(head(withStatement(BUYBACK), { circulatingSupply: null, price: null })).toMatchObject({ marketCap: null, fdv: null });
  });

  it('notes a run-rate line to holders, and yields per token of a base other than all', () => {
    const below = '    - { id: bribes, to: holders, run_rate: run_rate_usd, bucket: cash, haircut: 0, recipient_base: staked, capture_rule: programmatic }\n';
    expect(head(withStatement(BUYBACK, below)).notes).toEqual([
      'holder-flow growth excludes bribes (a run rate with no daily series)',
      "yields are per token of each flow's recipients (staked or locked supply), i.e. to a holder in every flow's base",
    ]);
    expect(head(withStatement(BUYBACK.replace('recipient_base: all', 'recipient_base: staked'))).notes).toEqual([
      "yields are per token of each flow's recipients (staked or locked supply), i.e. to a holder in every flow's base",
    ]);
  });

  it('notes a periodic line\'s unpaid days in the window, and a single disclosure', () => {
    const periodic = '    - { id: reserve, metric: flow_usd.other, settlement: periodic, started: "2026-01-01" }\n';
    const provisional = new Map([['flow_usd.other', new Set(['2026-01-19', '2026-01-20', '2025-12-01'])]]);
    expect(head(withStatement(BUYBACK, '', periodic), {}, provisional).notes).toEqual(["revenue: reserve has 2 unpaid day(s) at the last period's daily rate (provisional)"]);
    const disclosed = '    - { id: business, disclosed: run_rate_usd }\n';
    expect(head(withStatement(BUYBACK, '', disclosed), { disclosed: [{ observedAt: '2026-01-01T00:00:00.000Z', value: 9 }] }).notes).toEqual([
      'disclosed revenue: one disclosure so far; growth starts at the next one',
    ]);
    expect(head(withStatement(BUYBACK, '', disclosed), { disclosed: [{ observedAt: '2025-10-01T00:00:00.000Z', value: 8 }, { observedAt: '2026-01-01T00:00:00.000Z', value: 9 }] }).notes).toEqual([]);
  });

  it('throws for an asset without an income statement (it has no report)', () => {
    expect(() => reportHeader({ asset: parseAssetYaml(hypeYaml).config, day: '2026-01-20', daily: new Map(), levels })).toThrow(/has no income_statement block/);
  });
});

describe('holder-flow metrics and monitor_only (Task 11)', () => {
  it('accepts a monitor-only flow metric, and still refuses monitor_only on a holder-flow metric', () => {
    const extra = withStatement(BUYBACK).replace('metrics:\n', 'metrics:\n  flow_usd.revenue_proxy: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n');
    expect(() => parseAssetYaml(extra)).not.toThrow();
    const bad = withStatement(BUYBACK).replace('flow_usd.buyback: {', 'flow_usd.buyback: { monitor_only: true,').replace(', critical: true, source', ', source');
    expect(bad).not.toBe(withStatement(BUYBACK));
    expect(() => parseAssetYaml(bad)).toThrow(/"flow_usd\.buyback" is a standard or holder-flow metric and cannot be monitor_only/);
    // A below-line line to holders reads a holder flow too; one to the protocol does not.
    const below = (to: string) => withStatement(BUYBACK, `    - { id: x, to: ${to}, metric: flow_usd.other${to === 'holders' ? ', bucket: cash, haircut: 0, recipient_base: all, capture_rule: programmatic' : ''} }\n`)
      .replace('flow_usd.other: { type: flow, unit: usd, staleness_days: 7 }', 'flow_usd.other: { type: flow, unit: usd, staleness_days: 7, monitor_only: true }');
    expect(() => parseAssetYaml(below('holders'))).toThrow(/"flow_usd\.other" is a standard or holder-flow metric/);
    expect(() => parseAssetYaml(below('protocol'))).not.toThrow();
  });

  it('a protocol that pays its holders nothing loads (no holders line; Lido, template T10)', () => {
    const none = withStatement('').replace('  holders:\n', '  remainder: protocol\n');
    expect(parseAssetYaml(none).config.income_statement!.holders).toBeUndefined();
  });
});
