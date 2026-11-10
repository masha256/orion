import { beforeEach, describe, expect, it } from 'vitest';
import { REPORT_STALE_DAYS, tickAsset, type TickDeps, type TickResult } from '../../src/app/tick.js';
import { summarizeHolderYield, TickReportSchema } from '../../src/app/tickReport.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { raiseAnomaly } from '../../src/db/anomalies.js';
import { openDb, type OrionDb } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { testDatabaseConfig, testDbPair, useTestDb } from '../helpers/db.js';
import { GENESIS_TS, harness, NOW, type Harness } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, METRICS_END, POOL } from '../helpers/ingestAsset.js';
import { watchAssetYaml } from '../helpers/watchAsset.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

/** The mini asset's fees as revenue, all paid to holders (cash), reported over a week (Task 11: income_statement). */
const REPORTING = 'income_statement:\n  category: dex\n  scope: complete\n  window_days: 7\n  revenue:\n    - { id: fees_rev, metric: flow_usd.fees }\n  holders:\n    - { id: fees, of: fees_rev, bucket: cash, haircut: 0, recipient_base: all, capture_rule: contractual }\n';
const reportAsset = (yaml = INGEST_ASSET_YAML, extra = ''): LoadedAsset => parseAssetYaml(`${yaml}${REPORTING}${extra}`);

const testDb = useTestDb();
const pair = testDbPair();

let h: Harness;
/** The harness's database, as the root handle a tick takes its run lock on. */
let hdb: OrionDb;
let progress: string[];

function world({ db = testDb(), ...over }: Parameters<typeof harness>[1] & { db?: OrionDb } = {}) {
  h = harness(db, { loaded: reportAsset(), ...over });
  hdb = db;
  progress = [];
}

/** Daily fee rows before the days the fetch backfills (it scans three), so the week and the week before it are complete. */
async function seedFees(lastDay: string, days: number, value: number, metricKey = 'flow_usd.fees') {
  for (let i = 0; i < days; i++) {
    const day = addDays(lastDay, -i);
    await insertObservation(h.db, { provenance: testProvenance('onchain'), assetId: 'mini', metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, fetchedAt: NOW.toISOString() });
  }
}

const deps = (over: Partial<TickDeps> = {}): TickDeps => ({ home: '/nonexistent', now: h.deps.now, fetchDeps: h.deps, onProgress: (l) => progress.push(l), ...over });
const tick = (over: Partial<TickDeps> = {}, db: OrionDb = hdb): Promise<TickResult> => tickAsset(db, h.loaded, deps(over));
const agentRuns = async (): Promise<number> => (await h.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM agent_runs'))!.n;

beforeEach(() => world());

describe('tickAsset', () => {
  it('tick: fetch ok -> exit 0, holder_yield equals summarizeHolderYield(loadHolderYieldReport(db, asset, { legacy: true }))', async () => {
    await seedFees('2026-09-15', 12, 2);
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({
      schema_version: 2, tick_id: 'tick_mini_20260919T120005Z', asset: 'mini', outcome: 'completed', lock: null, error: null, report_error: null,
      ingest: { outcome: 'ok', sources_failed: [], anomalies_raised: [] },
    });
    expect(report.ingest!.fetch_run_id).toBeGreaterThan(0);
    expect(report.holder_yield).toEqual(summarizeHolderYield(await loadHolderYieldReport(h.db, h.loaded.config, undefined, { legacy: true })));
    expect(report.holder_yield).toMatchObject({ day: '2026-09-18', window_days: 7, price: 10, market_cap: 600, fdv: 1000 });
    expect(report.holder_yield!.flows).toEqual([{ id: 'fees', bucket: 'cash', net: expect.any(Number), yield: expect.any(Number) }]);
    expect(TickReportSchema.parse(report)).toEqual(report);
    for (const gone of ['signal', 'triggers_fired', 'triggers_recorded', 'triggers_standing', 'agent', 'agent_would_run']) expect(Object.keys(report)).not.toContain(gone);
    expect(Object.keys(report.ingest!)).not.toContain('watch'); // no firing, no key
    expect(await agentRuns()).toBe(0);
  });

  it('tick report lists checks; no agent run is started', async () => {
    // The mini asset with a statement and two checks: a two_path the fetch's own rows satisfy, a parameter that breaches.
    const statement = [
      '  checks:',
      '    - { id: two_ways, type: two_path, a: flow_usd.fees, b: flow_usd.fees_programmatic, tolerance_pct: 1 }',
      '    - { id: staker_share, type: parameter, metric: staker_emission_share, expected: 0.5, tolerance_pct: 0 }',
      '',
    ].join('\n');
    world({ loaded: reportAsset(INGEST_ASSET_YAML, statement) });
    await seedFees('2026-09-15', 12, 2);
    await insertObservation(h.db, { provenance: testProvenance('onchain'), assetId: 'mini', metricKey: 'staker_emission_share', observedAt: '2026-09-19T00:45:00.000Z', value: 0.3, fetchedAt: '2026-09-19T00:45:00.000Z' });
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report.holder_yield!.day).toBe('2026-09-18');
    expect(report.checks).toEqual([
      { id: 'two_ways', type: 'two_path', status: 'ok', gap_pct: 0 },
      { id: 'staker_share', type: 'parameter', status: 'breach', gap_pct: expect.closeTo(40, 9) },
    ]);
    expect(TickReportSchema.parse(report)).toEqual(report);
    // Stored for the report day, and the breach is an open advisory anomaly in the inbox: nothing else happens.
    const stored = await h.db.all<{ check_id: string; day: string; status: string }>('SELECT check_id, day, status FROM check_results ORDER BY check_id');
    expect(stored).toEqual([{ check_id: 'staker_share', day: '2026-09-18', status: 'breach' }, { check_id: 'two_ways', day: '2026-09-18', status: 'ok' }]);
    expect(report.inbox.anomalies).toEqual([expect.objectContaining({ kind: 'check_breach', metric: '', severity: 'advisory', occurrences: 1, reading: expect.objectContaining({ check_id: 'staker_share', check_type: 'parameter', day: '2026-09-18', lhs: 0.3, rhs: 0.5 }) })]);
    // I1 (plan correction 12): the breach's anomaly is one the tick raised, so the nightly block is an ALERT.
    const breachId = report.inbox.anomalies[0]!.id;
    expect(report.ingest!.anomalies_raised).toEqual([{ id: breachId, kind: 'check_breach', metric: '', severity: 'advisory' }]);
    expect(await agentRuns()).toBe(0);
    // The report reads the stored results back.
    const yr = await loadHolderYieldReport(h.db, h.loaded.config, undefined, { legacy: true });
    expect(yr.incomeStatement!.checks.map((c) => [c.id, c.status])).toEqual([['staker_share', 'breach'], ['two_ways', 'ok']]);

    // An asset with no checks: no `checks` key, nothing stored.
    await testDb.reset();
    world();
    await seedFees('2026-09-15', 12, 2);
    const plain = (await tick()).report;
    expect(Object.keys(plain)).not.toContain('checks');
    expect(await h.db.all('SELECT * FROM check_results')).toEqual([]);
  });

  it('tick: ingest throws -> exit 1, error.code set, holder_yield null', async () => {
    // A chain with no default RPC URL and no environment variable for it: a configuration error, which is what throws.
    world({ loaded: reportAsset(INGEST_ASSET_YAML.replace('chain_id: 8453', 'chain_id: 999')) });
    const { report, exitCode } = await tick({ fetchDeps: { ...h.deps, env: {} } });
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ outcome: 'error', error: { code: 'missing_rpc_url' }, ingest: null, holder_yield: null, report_error: null });
    expect(await hdb.assetRunLockHolder('mini')).toBeNull(); // released on the error path too
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('tick: report unavailable -> exit 2, report still emitted', async () => {
    // A report flow with no stored day (a new asset): the fetch works, the report cannot be built.
    const volume = '  flow_usd.volume: { type: flow, unit: usd, staleness_days: 45, monitor_only: true }\n' + METRICS_END;
    const yaml = watchAssetYaml({ above: 20, levels: false }).replace(METRICS_END, volume);
    const logs = [{ blockNumber: BigInt(Math.ceil((Date.parse('2026-09-17T12:00:00Z') / 1000 - GENESIS_TS) / 2)), logIndex: 0, txHash: '0xa', from: POOL, value: 3n * 10n ** 18n }];
    world({ loaded: reportAsset(yaml, '  volume: [flow_usd.volume]\n'), logs });
    const a = await raiseAnomaly(h.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'advisory', detail: { check: 1 }, seenAt: NOW.toISOString() });
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(2);
    expect(report).toMatchObject({ outcome: 'completed', error: null, holder_yield: null, report_error: { code: 'report_unavailable' }, ingest: { outcome: 'ok' } });
    expect(report.report_error!.message).toContain('no stored day for every report flow yet');
    expect(report.ingest!.watch).toEqual([{ metric: 'flow_usd.revenue', rule: 'above', value: 30, previous: null, day: '2026-09-17' }]);
    expect(report.inbox.anomalies.map((x) => x.id)).toEqual([a.id]);
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  /** The mini asset plus a monitor-only report flow (volume) the fetch never writes: the flow that can stop. */
  function volumeWorld() {
    const volume = '  flow_usd.volume: { type: flow, unit: usd, staleness_days: 45, monitor_only: true }\n' + METRICS_END;
    world({ loaded: reportAsset(watchAssetYaml({ above: 1000, levels: false }).replace(METRICS_END, volume), '  volume: [flow_usd.volume]\n') });
  }

  it('tick: a report flow that stopped -> exit 2, report_stale, holder_yield still filled', async () => {
    volumeWorld();
    await seedFees('2026-09-15', 12, 2);
    await seedFees(addDays('2026-09-19', -6), 12, 5, 'flow_usd.volume'); // the volume flow stopped six days before the tick
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(2);
    expect(report).toMatchObject({ outcome: 'completed', error: null, ingest: { outcome: 'ok' }, report_error: { code: 'report_stale' } });
    expect(report.holder_yield).toEqual(summarizeHolderYield(await loadHolderYieldReport(h.db, h.loaded.config, undefined, { legacy: true })));
    expect(report.holder_yield!.day).toBe('2026-09-13');
    expect(report.report_error!.message).toBe('holder-yield report day 2026-09-13 is 6 days behind the tick (2026-09-19); a report flow has stopped');
    expect(progress).toContain(`report stale: ${report.report_error!.message}`);
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('tick: a report day exactly REPORT_STALE_DAYS (3) behind the tick is not stale -> exit 0, report_error null', async () => {
    expect(REPORT_STALE_DAYS).toBe(3);
    volumeWorld();
    await seedFees('2026-09-16', 12, 2);
    await seedFees(addDays('2026-09-19', -3), 12, 5, 'flow_usd.volume');
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ outcome: 'completed', report_error: null, holder_yield: { day: '2026-09-16' } });
  });

  it('tick: a report day one past REPORT_STALE_DAYS (4) behind the tick is stale -> exit 2, report_stale', async () => {
    volumeWorld();
    await seedFees('2026-09-15', 12, 2);
    await seedFees(addDays('2026-09-19', -4), 12, 5, 'flow_usd.volume');
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(2);
    expect(report).toMatchObject({ outcome: 'completed', report_error: { code: 'report_stale' }, holder_yield: { day: '2026-09-15' } });
    expect(report.report_error!.message).toBe('holder-yield report day 2026-09-15 is 4 days behind the tick (2026-09-19); a report flow has stopped');
  });

  it('tick: lock held -> outcome run_in_progress, exit 0, lock.holder set', async () => {
    const [A, B] = pair();
    world({ db: A });
    const held = await B.tryAssetRunLock('mini', 'agent run pid 42');
    try {
      const since = (await A.assetRunLockHolder('mini'))!.since;
      const { report, exitCode } = await tick();
      expect(exitCode).toBe(0);
      expect(report).toMatchObject({ outcome: 'run_in_progress', lock: { holder: 'agent run pid 42', acquired_at: since }, ingest: null, holder_yield: null, report_error: null, error: null });
      expect(progress).toEqual([`asset mini is locked by agent run pid 42 since ${since}`]);
      expect((await A.assetRunLockHolder('mini'))!.holder).toBe('agent run pid 42'); // not ours to release
      expect(TickReportSchema.parse(report)).toEqual(report);
    } finally {
      await held!.release();
    }
  });

  it('tick: after a killed holder, the next tick takes the lock and marks its orphaned agent run abandoned', async () => {
    const run = await hdb.one<{ id: number }>(
      "INSERT INTO agent_runs (asset_id, persona, run_type, trigger_kind, trigger_detail_json, outcome, config_hash, model, started_at) VALUES ('mini', 'p', 'deep', 'schedule', '{}', 'running', 'x', 'm', $1) RETURNING id",
      [NOW.toISOString()],
    );
    const dying = await openDb(testDatabaseConfig());
    await dying.tryAssetRunLock('mini', 'agent run pid 42');
    await dying.close(); // the holder's process is gone: its connection, and the lock with it
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report.outcome).toBe('completed');
    expect(progress).toContain('1 orphaned run(s) of a process that is gone marked abandoned');
    expect(await hdb.one('SELECT outcome, error FROM agent_runs WHERE id = $1', [run!.id])).toEqual({ outcome: 'error', error: 'abandoned' });
  });

  it('tick: an open anomaly starts nothing', async () => {
    const a = await raiseAnomaly(h.db, { assetId: 'mini', kind: 'source_failure_streak', metricKey: '', dedupeKey: 'cg', severity: 'degrading', detail: {}, seenAt: NOW.toISOString() });
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(await agentRuns()).toBe(0);
    expect(report.inbox.anomalies).toMatchObject([{ id: a.id, kind: 'source_failure_streak', severity: 'degrading' }]);
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('gives an asset without an income_statement block holder_yield null, report_error null, and exit 0', async () => {
    world({ loaded: parseAssetYaml(INGEST_ASSET_YAML) });
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ outcome: 'completed', holder_yield: null, report_error: null, ingest: { outcome: 'ok' } });
  });

  it('holds the lock while it ingests and releases it after', async () => {
    let heldDuringFetch: string | null = null;
    const { report } = await tick({ onFetch: async () => { heldDuringFetch = (await hdb.assetRunLockHolder('mini'))?.holder ?? null; } });
    expect(report.outcome).toBe('completed');
    expect(heldDuringFetch).toBe(`tick pid ${process.pid}`);
    expect(await hdb.assetRunLockHolder('mini')).toBeNull();
  });

  it('reports a lock release that fails, and the report is unaffected', async () => {
    // The run lock's release fails (the unlock query errors on a live connection).
    const proxy = new Proxy(hdb, {
      get(target, prop) {
        if (prop === 'tryAssetRunLock') {
          return async (assetId: string, holder: string) => {
            const lock = await target.tryAssetRunLock(assetId, holder);
            return lock && { ping: () => lock.ping(), release: async () => { await lock.release(); throw new Error('simulated: the unlock failed'); } };
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const { report, exitCode } = await tick({}, proxy);
    expect(report.outcome).toBe('completed');
    expect(exitCode).toBe(0);
    expect(progress.some((l) => l.startsWith('warning: the run lock could not be released (simulated'))).toBe(true);
  });

  it('guards the inbox when its schema validation fails, and completes the tick', async () => {
    await h.db.run("INSERT INTO proposals (asset_id, persona, agent_run_id, kind, change_json, filed_against_json, rationale, evidence_json, effect_json, status, created_at) VALUES ('mini', 'analyst', NULL, 'config', '{}', '{}', 'r', '[]', '{\"weird\": 1}', 'pending', $1)", [NOW.toISOString()]);
    const { report, exitCode } = await tick();
    expect(report.outcome).toBe('completed');
    expect(exitCode).toBe(0);
    expect(report.inbox).toEqual({ observations: [], proposals: [], anomalies: [] });
    expect(progress.some((l) => l.startsWith('warning: the inbox could not be built'))).toBe(true);
  });
});
