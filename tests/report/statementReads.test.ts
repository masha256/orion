import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tickAsset, type TickDeps } from '../../src/app/tick.js';
import { TickReportSchema } from '../../src/app/tickReport.js';
import { parseAssetYaml } from '../../src/config/load.js';
import { insertObservation } from '../../src/db/observations.js';
import { insertRegistryRow, listRegistry } from '../../src/db/registry.js';
import { addDays } from '../../src/ingest/time.js';
import { fullBody } from '../../src/push/body.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { MINI_REPORT_YAML, seedMiniReport } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

/**
 * Final review M3: the v2-only reads (`listCheckResults`, the provenance read) sit inside C4's isolation. A throw there
 * gives `incomeStatement: null` and `incomeStatementError`; the report, the tick's holder_yield and the snapshot never
 * fail because of it (Task 11a: the v1-shaped keys are the statement's, so they are empty then; the header stands). The
 * seams: each read throws while its flag is set (the real function otherwise).
 */
const seam = vi.hoisted(() => ({ checks: false, provenance: false }));
vi.mock('../../src/db/checkResults.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db/checkResults.js')>();
  return {
    ...mod,
    listCheckResults: (...args: Parameters<typeof mod.listCheckResults>) => {
      if (seam.checks) throw new Error('check_results read failed');
      return mod.listCheckResults(...args);
    },
  };
});
vi.mock('../../src/db/observations.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db/observations.js')>();
  return {
    ...mod,
    listActiveProvenance: async (...args: Parameters<typeof mod.listActiveProvenance>) => {
      if (seam.provenance) throw new Error('bad jsonb locator');
      return mod.listActiveProvenance(...args);
    },
  };
});

const testDb = useTestDb();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  seam.checks = false;
  seam.provenance = false;
});

const asset = parseAssetYaml(MINI_REPORT_YAML).config;
const HEADER = ['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'notes'] as const;

describe('a failing v2-only read (M3)', () => {
  for (const which of ['checks', 'provenance'] as const) {
    it(`${which}: the report resolves, the header unchanged, incomeStatement null with the error`, async () => {
      const db = testDb();
      await seedMiniReport(db, '2026-10-10');
      const clean = (await loadHolderYieldReport(db, asset, '2026-10-10', { legacy: true })) as unknown as Record<string, unknown>;
      expect(clean.incomeStatement).toMatchObject({ schema: 2 });
      seam[which] = true;
      const r = (await loadHolderYieldReport(db, asset, '2026-10-10', { legacy: true })) as unknown as Record<string, unknown>;
      expect(r.incomeStatement).toBeNull();
      expect(r.incomeStatementError).toMatch(which === 'checks' ? /check_results read failed/ : /bad jsonb locator/);
      for (const k of HEADER) expect(r[k], k).toEqual(clean[k]);
      expect(r).toMatchObject({ flows: [], income: null });
      // The default (D9) shape too.
      const slim = await loadHolderYieldReport(db, asset, '2026-10-10');
      expect(slim).toMatchObject({ incomeStatement: null, incomeStatementError: r.incomeStatementError });
    });
  }

  it('the tick: holder_yield built with statement_error, no report_error, exit 0', async () => {
    const IS_BLOCK = `income_statement:
  category: dex
  scope: complete
  window_days: 7
  revenue:
    - { id: fees_rev, metric: flow_usd.fees }
  holders:
    - { id: fees, of: fees_rev, bucket: cash, haircut: 0, recipient_base: all, capture_rule: contractual }
`;
    const db = testDb();
    const h = harness(db, { loaded: parseAssetYaml(`${INGEST_ASSET_YAML}${IS_BLOCK}`) });
    for (let i = 0; i < 12; i++) {
      const day = addDays('2026-09-15', -i);
      await insertObservation(h.db, { provenance: testProvenance('onchain'), assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value: 2, fetchedAt: NOW.toISOString() });
    }
    seam.provenance = true;
    const deps: TickDeps = { home: '/nonexistent', now: h.deps.now, fetchDeps: h.deps };
    const { report, exitCode } = await tickAsset(db, h.loaded, deps);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ outcome: 'completed', report_error: null, error: null });
    expect(report.holder_yield).toMatchObject({ day: '2026-09-18', statement_error: expect.stringMatching(/bad jsonb locator/) });
    expect(report.holder_yield!.flows).toEqual([]);
    expect(report.holder_yield!.statement_revenue).toBeUndefined();
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('the snapshot body keeps the report and the error field', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-m3-'));
    dirs.push(root);
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'mini.yaml'), MINI_REPORT_YAML);
    const db = testDb();
    await insertRegistryRow(db, 'mini', 'active', 'h', { at: '2026-09-01T00:00:00.000Z', by: 'test', reason: null, releaseTag: null });
    await seedMiniReport(db, '2026-11-02');
    seam.checks = true;
    const body = (await fullBody(db, root, await listRegistry(db), '2026-11-02')) as { assets: Record<string, { report: Record<string, unknown> | null; report_error: string | null }> };
    const mini = body.assets.mini!;
    expect(mini.report_error).toBeNull();
    expect(mini.report).toMatchObject({ incomeStatement: null, incomeStatementError: expect.stringMatching(/check_results read failed/), day: '2026-11-02' });
  });
});
