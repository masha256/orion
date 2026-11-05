import { beforeEach, describe, expect, it } from 'vitest';
import { listCheckResults, upsertCheckResults, type CheckResult } from '../../src/db/checkResults.js';
import type { Db } from '../../src/db/connection.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();
let db: Db;
beforeEach(() => {
  db = testDb();
});

const row = (over: Partial<CheckResult> = {}): CheckResult => ({
  assetId: 'crv', checkId: 'splitter', day: '2026-11-02', type: 'sum', lhs: 1000, rhs: 999, gapPct: 0.1, status: 'ok',
  detail: { tolerance_pct: 2, lhs: ['flow_usd.protocol_revenue'] }, evaluatedAt: '2026-11-03T00:46:00.000Z', ...over,
});

describe('check_results', () => {
  it('round-trips a row, nulls included; day is the date as written, evaluated_at an ISO instant', async () => {
    await upsertCheckResults(db, [row(), row({ checkId: 'other', status: 'incomplete', lhs: null, rhs: null, gapPct: null, detail: { missing: ['x@2026-11-02'] } })]);
    expect(await listCheckResults(db, 'crv', '2026-11-02')).toEqual([
      row({ checkId: 'other', status: 'incomplete', lhs: null, rhs: null, gapPct: null, detail: { missing: ['x@2026-11-02'] } }),
      row(),
    ]);
    expect(await listCheckResults(db, 'crv', '2026-11-01')).toEqual([]);
    expect(await listCheckResults(db, 'lit')).toEqual([]);
  });

  it('a second evaluation of the same (asset, check, day) replaces the row; other days stay', async () => {
    await upsertCheckResults(db, [row(), row({ day: '2026-11-01' })]);
    await db.tx(async (t) => {
      await upsertCheckResults(t, [row({ status: 'breach', rhs: 900, gapPct: 10, evaluatedAt: '2026-11-03T02:00:00.000Z' })]);
    }, { lockAsset: 'crv' });
    expect((await listCheckResults(db, 'crv')).map((r) => [r.day, r.status, r.rhs, r.evaluatedAt])).toEqual([
      ['2026-11-02', 'breach', 900, '2026-11-03T02:00:00.000Z'],
      ['2026-11-01', 'ok', 999, '2026-11-03T00:46:00.000Z'],
    ]);
  });

  it('refuses a status outside ok, breach, incomplete', async () => {
    await expect(upsertCheckResults(db, [row({ status: 'warn' as CheckResult['status'] })])).rejects.toThrow(/check_results_status_check/);
  });
});
