import { beforeEach, describe, expect, it } from 'vitest';
import { startAgentRun } from '../../src/db/agentRuns.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { attachRun, deleteFiring, getFiring, insertFiring, listFirings, TRIGGER_KINDS } from '../../src/db/triggerFirings.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const T0 = '2026-09-21T00:00:00Z';

describe('trigger firings', () => {
  it('records one row per instance, lists oldest first per asset, attaches a run, and deletes', () => {
    const a = insertFiring(db, { assetId: 'mini', kind: 'open_anomaly', key: '7', firedAt: T0, detail: { severity: 'degrading' } });
    const b = insertFiring(db, { assetId: 'mini', kind: 'staleness', key: 'revenue_run_rate_usd', firedAt: T0, detail: {} });
    insertFiring(db, { assetId: 'other', kind: 'calendar', key: '2026-10-01', firedAt: T0, detail: { note: 'x' } });
    expect(a).toEqual({ id: a.id, assetId: 'mini', kind: 'open_anomaly', key: '7', firedAt: '2026-09-21T00:00:00.000Z', agentRunId: null, detail: { severity: 'degrading' } });
    expect(listFirings(db, 'mini').map((f) => f.id)).toEqual([a.id, b.id]);

    const run = startAgentRun(db, { assetId: 'mini', persona: 'p', runType: 'triage', trigger: 'trigger', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: T0 });
    attachRun(db, [a.id, b.id], run);
    expect(listFirings(db, 'mini').map((f) => f.agentRunId)).toEqual([run, run]);

    expect(deleteFiring(db, b.id)).toBe(true);
    expect(deleteFiring(db, b.id)).toBe(false);
    expect(getFiring(db, b.id)).toBeNull();
    expect(listFirings(db, 'mini')).toHaveLength(1);
  });

  it('holds one live row per (asset, kind, key)', () => {
    insertFiring(db, { assetId: 'mini', kind: 'provisional', key: '12', firedAt: T0, detail: {} });
    expect(() => insertFiring(db, { assetId: 'mini', kind: 'provisional', key: '12', firedAt: T0, detail: {} })).toThrow(/UNIQUE/);
    insertFiring(db, { assetId: 'mini', kind: 'open_anomaly', key: '12', firedAt: T0, detail: {} }); // another kind, same key
    expect(listFirings(db, 'mini')).toHaveLength(2);
  });

  it('accepts exactly the five kinds', () => {
    for (const kind of TRIGGER_KINDS) insertFiring(db, { assetId: 'mini', kind, key: 'k', firedAt: T0, detail: {} });
    expect(() => db.prepare("INSERT INTO trigger_firings (asset_id, kind, key, fired_at, detail_json) VALUES ('mini', 'other', 'k', ?, '{}')").run(T0)).toThrow(/CHECK/);
  });
});
