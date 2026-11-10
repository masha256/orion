import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tickAsset, type TickDeps } from '../../src/app/tick.js';
import { summarizeHolderYield, TickHolderYieldSchema, TickReportSchema, type TickReport } from '../../src/app/tickReport.js';
import { reportLines } from '../../src/cli/commands/report.js';
import { parseAssetYaml } from '../../src/config/load.js';
import { insertRegistryRow, listRegistry } from '../../src/db/registry.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { formatAssetBlock, formatNightly, type AssetRunResult } from '../../src/notify/format.js';
import { fullBody } from '../../src/push/body.js';
import { loadHolderYieldReport, yieldReport } from '../../src/report/load.js';
import { MINI_REPORT_YAML, seedMiniReport } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';
import { harness, NOW, type Harness } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { repoAsset, syntheticInput } from '../helpers/syntheticReport.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

/**
 * Task 4 ruling C4: an exception inside incomeStatementV2 never fails the report, the tick or the snapshot. The seam:
 * incomeStatementV2 throws while `boom.on` is set (the real function otherwise). Task 11a: the v1-shaped keys are the
 * statement's (src/report/legacy.ts), so with it they are empty (no flows, null yields), not v1's own figures.
 */
const MESSAGE = 'income statement v2: holders.x reads no series';
const boom = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/report/incomeStatement.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/report/incomeStatement.js')>();
  return {
    ...mod,
    incomeStatementV2: (...args: Parameters<typeof mod.incomeStatementV2>) => {
      if (boom.on) throw new Error(MESSAGE);
      return mod.incomeStatementV2(...args);
    },
  };
});

const testDb = useTestDb();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  boom.on = true;
});

const V1_KEYS = ['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'flows', 'buckets', 'yields', 'holderFlowGrowth', 'supply', 'income', 'revenue', 'volume', 'revenueDisclosed', 'notes'];

describe('a throwing income statement v2 (C4)', () => {
  it('the report: incomeStatement null and incomeStatementError; the header stands (legacy and default)', () => {
    const input = syntheticInput(repoAsset('lit'));
    boom.on = false;
    const ok = yieldReport(input);
    boom.on = true;
    const legacy = JSON.parse(JSON.stringify(yieldReport(input, { legacy: true }))) as Record<string, unknown>;
    expect(Object.keys(legacy)).toEqual([...V1_KEYS, 'incomeStatement', 'incomeStatementError']);
    expect(legacy).toMatchObject({ incomeStatement: null, incomeStatementError: MESSAGE, flows: [], income: null, yields: { cash: null, multiple: null } });
    for (const k of ['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'notes'] as const) expect(legacy[k]).toEqual(ok[k]);
    const slim = yieldReport(input);
    expect(Object.keys(slim)).toEqual(['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'incomeStatement', 'incomeStatementError', 'notes']);
    expect(slim).toMatchObject({ incomeStatement: null, incomeStatementError: MESSAGE });
  });

  it('without the throw: no incomeStatementError key', () => {
    boom.on = false;
    const input = syntheticInput(repoAsset('lit'));
    const legacy = yieldReport(input, { legacy: true });
    expect(Object.keys(legacy)).toEqual([...V1_KEYS, 'incomeStatement']);
    expect(legacy.incomeStatement).toMatchObject({ schema: 2 });
  });

  it('loadHolderYieldReport (DB) resolves with the error; report yield text prints it', async () => {
    const asset = parseAssetYaml(MINI_REPORT_YAML).config;
    const db = testDb();
    await seedMiniReport(db, '2026-10-10');
    const r = await loadHolderYieldReport(db, asset, '2026-10-10', { legacy: true });
    expect(r).toMatchObject({ incomeStatement: null, incomeStatementError: MESSAGE, day: '2026-10-10' });
    expect(reportLines(r)).toContain(`  income statement unavailable: ${MESSAGE}`);
  });

  it('the tick holder_yield: the header fields, empty flows and null yields, statement_error set, schema valid', () => {
    const input = syntheticInput(repoAsset('lit'));
    const h = summarizeHolderYield(yieldReport(input, { legacy: true }));
    expect(h).toMatchObject({ day: input.day, flows: [], revenue_annualized: null, multiple: null, statement_error: MESSAGE });
    expect(h.statement_revenue).toBeUndefined();
    expect(TickHolderYieldSchema.parse(h)).toEqual(h);
  });

  it('the nightly block: one ALERT line for the asset, and the asset counts as an alert', () => {
    const holder_yield = summarizeHolderYield(yieldReport(syntheticInput(repoAsset('lit')), { legacy: true }));
    const report: TickReport = {
      schema_version: 2, tick_id: 'tick_lit_20261103T004500Z', asset: 'lit', started_at: '2026-11-03T00:45:00.000Z', ended_at: '2026-11-03T00:46:10.000Z',
      outcome: 'completed', lock: null, ingest: { fetch_run_id: 7, outcome: 'ok', sources_failed: [], anomalies_raised: [] },
      holder_yield, report_error: null, inbox: { observations: [], proposals: [], anomalies: [] }, error: null,
    };
    const run: AssetRunResult = { symbol: 'LIT', report, job: { status: 'done', attempts: 1, error: null }, fetchLines: [], alertFlags: [] };
    const block = formatAssetBlock(run);
    expect(block.alert).toBe(true);
    const alerts = block.lines.filter((l) => l.startsWith('ALERT'));
    expect(alerts).toEqual([`ALERT LIT income statement unavailable: ${MESSAGE}`]);
    // Right after the block's first line; the price line is still printed.
    expect(block.lines[block.lines.indexOf('nothing to decide') + 2]).toBe(alerts[0]);
    expect(block.lines.some((l) => l.startsWith('price '))).toBe(true);
    const posts = formatNightly({
      env: 'stage', day: '2026-11-02', releaseTag: null, results: [{ ...run, assetId: 'lit' }], notRun: [], symbols: { lit: 'LIT' }, configChanged: [],
      resumedShort: [], firingWatches: [], refreshesMissing: [], slot: '01:00',
    });
    expect(posts[0]).toMatch(/^ORION ALERT stage nightly 2026-11-02: 1 alert\(s\)/);
  });

  it('the full snapshot body keeps the report and the error field', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-c4-'));
    dirs.push(root);
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'mini.yaml'), MINI_REPORT_YAML);
    const db = testDb();
    await insertRegistryRow(db, 'mini', 'active', 'h', { at: '2026-09-01T00:00:00.000Z', by: 'test', reason: null, releaseTag: null });
    await seedMiniReport(db, '2026-11-02');
    const body = (await fullBody(db, root, await listRegistry(db), '2026-11-02')) as { assets: Record<string, { report: Record<string, unknown>; report_error: string | null }> };
    const mini = body.assets.mini!;
    expect(mini.report_error).toBeNull();
    expect(Object.keys(mini.report)).toEqual([...V1_KEYS, 'incomeStatement', 'incomeStatementError']);
    expect(mini.report).toMatchObject({ incomeStatement: null, incomeStatementError: MESSAGE, day: '2026-11-02' });
  });
});

describe('a throwing income statement v2 in a tick (C4)', () => {
  const IS_BLOCK = `income_statement:
  category: dex
  scope: complete
  window_days: 7
  revenue:
    - { id: fees_rev, metric: flow_usd.fees }
  holders:
    - { id: fees, of: fees_rev, bucket: cash, haircut: 0, recipient_base: all, capture_rule: contractual }
`;
  let h: Harness;

  it('the tick completes with exit 0, no report_error, and holder_yield.statement_error', async () => {
    const db = testDb();
    h = harness(db, { loaded: parseAssetYaml(`${INGEST_ASSET_YAML}${IS_BLOCK}`) });
    for (let i = 0; i < 12; i++) {
      const day = addDays('2026-09-15', -i);
      await insertObservation(h.db, { provenance: testProvenance('onchain'), assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value: 2, fetchedAt: NOW.toISOString() });
    }
    const deps: TickDeps = { home: '/nonexistent', now: h.deps.now, fetchDeps: h.deps };
    const { report, exitCode } = await tickAsset(db, h.loaded, deps);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ outcome: 'completed', report_error: null, error: null });
    expect(report.holder_yield).toMatchObject({ day: '2026-09-18', statement_error: MESSAGE });
    expect(report.holder_yield!.flows).toEqual([]);
    expect(report.holder_yield!.statement_revenue).toBeUndefined();
    expect(TickReportSchema.parse(report)).toEqual(report);
  });
});
