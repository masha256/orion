import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { tickAsset, type TickDeps, type TickResult } from '../../src/app/tick.js';
import { TickReportSchema } from '../../src/app/tickReport.js';
import { parseAssetYaml } from '../../src/config/load.js';
import { finishAgentRun, getAgentRun, listAgentRuns, startAgentRun, ZERO_USAGE } from '../../src/db/agentRuns.js';
import { raiseAnomaly } from '../../src/db/anomalies.js';
import { createAssumptionSet, getLatestAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { assignPersona } from '../../src/db/coverage.js';
import { insertObservation } from '../../src/db/observations.js';
import { acquireRunLock, getRunLock } from '../../src/db/runLocks.js';
import { listFirings } from '../../src/db/triggerFirings.js';
import type { Signal } from '../../src/signals/schema.js';
import type { RunType } from '../../src/types.js';
import { agentHome, PAGE_TEXT, PAGE_URL, QUOTE } from '../helpers/agentWorld.js';
import { miniAssumptions } from '../helpers/assets.js';
import { calls, journalCall, say, scriptedModel, toolUse, webFetch, type ScriptStep, type ScriptedModel } from '../helpers/fakeModel.js';
import { harness, NOW, type Harness } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

let h: Harness;
let home: string;
let model: ScriptedModel;
let signals: Signal[];
let progress: string[];
let revenueId: number;

/** The two manual metrics, an assumption set, a persona, and a fresh scripted model. */
function world(over: Parameters<typeof harness>[0] = {}) {
  h = harness(over);
  revenueId = insertObservation(h.db, { assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-09-18', value: 1000, source: 'manual', fetchedAt: NOW.toISOString() }).id;
  insertObservation(h.db, { assetId: 'mini', metricKey: 'staker_emission_share', observedAt: '2026-09-18', value: 1, source: 'manual', fetchedAt: NOW.toISOString() });
  createAssumptionSet(h.db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: '2026-09-01T00:00:00Z' });
  home = agentHome(h.db);
  signals = [];
  progress = [];
}

const deps = (over: Partial<TickDeps> = {}): TickDeps => ({
  home, now: h.deps.now, fetchDeps: h.deps, modelClient: () => model, reload: () => h.loaded,
  onSignal: (s) => signals.push(s), onProgress: (l) => progress.push(l), ...over,
});
const tick = (script: ScriptStep[] = [calls(journalCall()), say('Done.')], opts: { noAgent?: boolean } = {}, over: Partial<TickDeps> = {}): Promise<TickResult> => {
  model = scriptedModel(script);
  return tickAsset(h.db, h.loaded, deps(over), opts);
};
/** A run of `runType` that started today, so nothing scheduled is due. */
const attempted = (...runTypes: RunType[]) => {
  for (const runType of runTypes) {
    const id = startAgentRun(h.db, { assetId: 'mini', persona: 'analyst', runType, trigger: 'schedule', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: NOW.toISOString() });
    finishAgentRun(h.db, id, { outcome: 'completed', endedAt: NOW.toISOString(), usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
  }
};
const growth = () => toolUse('apply_assumption_change', { key: 'rev_growth_y1', scenario: 'base', value: 0.2, evidence: [revenueId], rationale: 'usage is accelerating' });

beforeEach(() => world());

describe('tickAsset', () => {
  it('ingests, values, emits the signal, evaluates the triggers, and runs nothing when nothing is due or fired', async () => {
    attempted('deep');
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({
      schema_version: 1, tick_id: 'tick_mini_20260919T120005Z', asset: 'mini', outcome: 'completed', lock: null, error: null,
      ingest: { outcome: 'ok', sources_failed: [], anomalies_raised: [] },
      signal: { status: 'ok', grade: 'B', cause: 'none' },
      triggers_fired: [], triggers_recorded: true, agent: null, agent_would_run: null,
    });
    expect(report.ingest!.fetch_run_id).toBeGreaterThan(0);
    expect(report.signal!.expected_target_12m).toBeGreaterThan(0);
    expect(signals.map((s) => s.signal_id)).toEqual([report.signal!.signal_id]);
    expect(model.requests).toHaveLength(0);
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('runs the bootstrap first on a fresh asset, refuses an assumption change even with a set present, and reports what it committed by count', async () => {
    const { report, exitCode } = await tick([calls(growth()), calls(journalCall()), say('Done.')]);
    expect(exitCode).toBe(0);
    expect(report.agent).toMatchObject({
      run_type: 'bootstrap', trigger_kind: 'schedule', outcome: 'completed', error: null, proposals: [],
      usage: { requests: 3 }, committed: { assumption_set_version: null, observations: 0, anomalies_resolved: 0, journal: 1 },
    });
    expect(getAgentRun(h.db, report.agent!.run_id!)).toMatchObject({ runType: 'bootstrap', trigger: 'schedule', outcome: 'completed' });
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: true, result: { refused: 'unknown_tool' } });
    expect(signals).toHaveLength(1);
    expect(getLatestAssumptionSet(h.db, 'mini')!.version).toBe(1);
    expect(progress.some((l) => l.startsWith('agent bootstrap run (schedule)'))).toBe(true);
  });

  it('puts what awaits the user in the report, including the row that the run of the day just recorded', async () => {
    const record = toolUse('record_provisional_observation', { metric: 'revenue_run_rate_usd', value: 1100, observed_at: '2026-09-19', citation_url: PAGE_URL, quoted_text: QUOTE });
    const { report } = await tick([{ content: [...webFetch(PAGE_URL, PAGE_TEXT), record], stop_reason: 'tool_use' }, calls(journalCall()), say('Done.')]);
    expect(report.agent).toMatchObject({ run_type: 'bootstrap', outcome: 'completed', committed: { observations: 1 } });
    expect(report.inbox.observations).toHaveLength(1);
    expect(report.inbox.observations[0]).toMatchObject({
      metric: 'revenue_run_rate_usd', value: 1100, observed_at: '2026-09-19T00:00:00.000Z', citation_url: PAGE_URL, move_pct: 10, // against the confirmed 1000 of 2026-09-18
      recorded_by: { persona: 'analyst', agent_run_id: report.agent!.run_id },
    });
    expect(report.inbox.proposals).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(QUOTE);
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('launches triage on a firing when nothing is scheduled, hands the firings to the run, and records the run on them', async () => {
    attempted('deep', 'weekly');
    const a = raiseAnomaly(h.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'advisory', detail: { check: 1 }, seenAt: NOW.toISOString() });
    const { report } = await tick();
    expect(report.triggers_fired).toEqual([{ kind: 'open_anomaly', key: String(a.id), detail: { kind: 'cross_check_mismatch', metric: 'price_usd', severity: 'advisory', first_seen_at: a.firstSeenAt } }]);
    expect(report.agent).toMatchObject({ run_type: 'triage', trigger_kind: 'trigger', outcome: 'completed' });
    expect(getAgentRun(h.db, report.agent!.run_id!)!.triggerDetail).toEqual({ firings: [{ kind: 'open_anomaly', key: String(a.id), detail: expect.any(Object) }] });
    expect(listFirings(h.db, 'mini')).toMatchObject([{ kind: 'open_anomaly', key: String(a.id), agentRunId: report.agent!.run_id }]);
    expect(model.requests[0].messages[0].content).toContain('"triggers_this_tick"');
    // The next tick: the anomaly is still open, but it fired already. Nothing runs; it shows up standing.
    const next = await tick();
    expect(next.report.triggers_fired).toEqual([]);
    expect(next.report.triggers_standing).toEqual([{ kind: 'open_anomaly', key: String(a.id), agent_run_id: report.agent!.run_id }]);
    expect(next.report.agent).toBeNull();
  });

  it('retries a firing whose run never got a row', async () => {
    const a = raiseAnomaly(h.db, { assetId: 'mini', kind: 'source_failure_streak', metricKey: '', dedupeKey: 'cg', severity: 'advisory', detail: {}, seenAt: NOW.toISOString() });
    h.db.prepare('DELETE FROM coverage').run();
    const first = await tick();
    expect(first.report.agent).toMatchObject({ run_id: null, error: { code: 'no_persona_assigned' } });
    assignPersona(h.db, 'mini', 'analyst', NOW.toISOString());
    const { report } = await tick([calls(growth()), calls(journalCall()), say('Done.')]);
    expect(report.triggers_fired).toEqual([]);
    expect(report.triggers_standing).toEqual([{ kind: 'open_anomaly', key: String(a.id), agent_run_id: null }]); // still null: this snapshot is from before this tick's run
    expect(report.agent).toMatchObject({ run_type: 'bootstrap', outcome: 'completed' }); // a fresh asset owes the bootstrap
    expect(getAgentRun(h.db, report.agent!.run_id!)!.triggerDetail.firings).toHaveLength(1);
    expect(listFirings(h.db, 'mini')[0].agentRunId).toBe(report.agent!.run_id);
  });

  it('lets a due scheduled run absorb the firings instead of running triage', async () => {
    const a = raiseAnomaly(h.db, { assetId: 'mini', kind: 'source_failure_streak', metricKey: '', dedupeKey: 'cg', severity: 'advisory', detail: {}, seenAt: NOW.toISOString() });
    const { report } = await tick();
    expect(report.agent).toMatchObject({ run_type: 'bootstrap', trigger_kind: 'schedule' });
    expect(report.triggers_fired.map((f) => f.key)).toEqual([String(a.id)]);
    expect(listFirings(h.db, 'mini')[0].agentRunId).toBe(report.agent!.run_id);
    expect(getAgentRun(h.db, report.agent!.run_id!)!.triggerDetail.firings).toHaveLength(1);
  });

  it('records a run that throws at preflight, keeps the data-only signal, and exits 0', async () => {
    h.db.prepare('DELETE FROM coverage').run();
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report.outcome).toBe('completed');
    expect(report.agent).toMatchObject({ run_type: 'bootstrap', run_id: null, outcome: null, error: { code: 'no_persona_assigned' } });
    expect(signals).toHaveLength(1);
    expect(listAgentRuns(h.db)).toHaveLength(0);
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('records a run that ends short of completed, with its outcome as the error code, and exits 0', async () => {
    world({ loaded: parseAssetYaml(`${INGEST_ASSET_YAML}agent:\n  budgets:\n    bootstrap: { requests: 1 }\n`) });
    const { report, exitCode } = await tick([calls(growth()), calls(journalCall()), say('Done.')]);
    expect(exitCode).toBe(0);
    expect(report.agent).toMatchObject({ outcome: 'budget_exhausted', committed: null, signal_id: null, error: { code: 'budget_exhausted' } });
    expect(report.agent!.usage!.requests).toBe(1);
    expect(getLatestAssumptionSet(h.db, 'mini')!.version).toBe(1);
    expect(signals).toHaveLength(1);
  });

  it('reports a revaluation failure after a live commit, without discarding it', async () => {
    // Seed a deep attempt 8 days ago so a weekly is due (not a bootstrap)
    const earlier = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const deepId = startAgentRun(h.db, { assetId: 'mini', persona: 'analyst', runType: 'deep', trigger: 'schedule', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: earlier });
    finishAgentRun(h.db, deepId, { outcome: 'completed', endedAt: earlier, usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
    // deps.now is called during tick and runAgent: tick's started, dueRunType, runAgent's started, commit, valuation (throw here),
    // and finish. With a seeded deep attempt, dueRunType makes one extra DB call. The valuation call is the 6th overall.
    let calledNow = 0;
    const now = () => {
      calledNow += 1;
      if (calledNow === 6) throw new Error('the clock stopped');
      return h.deps.now();
    };
    const { report, exitCode } = await tick([calls(growth()), calls(journalCall()), say('Done.')], {}, { now });
    expect(exitCode).toBe(0);
    expect(report.agent).toMatchObject({
      run_type: 'weekly', outcome: 'completed', committed: { assumption_set_version: 2 }, signal_id: null, error: { code: 'valuation_error' },
    });
    expect(report.agent!.error!.message).toContain('the clock stopped');
    expect(getLatestAssumptionSet(h.db, 'mini')!.version).toBe(2);
    expect(progress.some((l) => l.includes('committed but the revaluation failed: Error: the clock stopped'))).toBe(true);
  });

  it('under --no-agent evaluates without recording and says what would have run', async () => {
    raiseAnomaly(h.db, { assetId: 'mini', kind: 'source_failure_streak', metricKey: '', dedupeKey: 'cg', severity: 'advisory', detail: {}, seenAt: NOW.toISOString() });
    const { report, exitCode } = await tick([], { noAgent: true });
    expect(exitCode).toBe(0);
    expect(report.triggers_fired).toHaveLength(1);
    expect(report).toMatchObject({ triggers_recorded: false, agent: null, agent_would_run: { run_type: 'bootstrap', trigger_kind: 'schedule' } });
    expect(listFirings(h.db, 'mini')).toEqual([]);
    expect(listAgentRuns(h.db)).toHaveLength(0);
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('under agent.cadence.enabled: false does the same, durably', async () => {
    world({ loaded: parseAssetYaml(`${INGEST_ASSET_YAML}agent:\n  cadence: { enabled: false }\n`) });
    const { report } = await tick([]);
    expect(report).toMatchObject({ triggers_recorded: false, agent: null, agent_would_run: { run_type: 'bootstrap', trigger_kind: 'schedule' } });
    expect(listAgentRuns(h.db)).toHaveLength(0);
  });

  it('exits 2 on a blocked signal, and still runs the agent stage', async () => {
    h.db.prepare("DELETE FROM observations WHERE metric_key = 'revenue_run_rate_usd'").run();
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(2);
    expect(report.signal).toMatchObject({ status: 'blocked', expected_target_12m: null });
    expect(report.agent).toMatchObject({ run_type: 'bootstrap', outcome: 'completed' });
  });

  it('exits 1 with outcome error and no signal when the ingest throws, and runs no agent', async () => {
    // A chain with no default RPC URL and no environment variable for it: a configuration error, which is what throws.
    world({ loaded: parseAssetYaml(INGEST_ASSET_YAML.replace('chain_id: 8453', 'chain_id: 999')) });
    const { report, exitCode } = await tick([], {}, { fetchDeps: { ...h.deps, env: {} } });
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ outcome: 'error', error: { code: 'missing_rpc_url' }, ingest: null, signal: null, agent: null, triggers_fired: [] });
    expect(signals).toEqual([]);
    expect(getRunLock(h.db, 'mini')).toBeNull(); // released on the error path too
    expect(TickReportSchema.parse(report)).toEqual(report);
  });

  it('exits 0 with run_in_progress when another holder has the lock, doing nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-tick-'));
    const A = openDb(join(dir, 'orion.db'));
    const B = openDb(join(dir, 'orion.db'));
    world({ db: A });
    acquireRunLock(B, 'mini', 'agent run pid 42', NOW.toISOString());
    const { report, exitCode } = await tick();
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ outcome: 'run_in_progress', lock: { holder: 'agent run pid 42', acquired_at: NOW.toISOString() }, ingest: null, signal: null, agent: null });
    expect(signals).toEqual([]);
    expect(progress).toEqual(['asset mini is locked by agent run pid 42 since 2026-09-19T12:00:00.000Z']);
    expect(getRunLock(A, 'mini')!.holder).toBe('agent run pid 42'); // not ours to release
    expect(TickReportSchema.parse(report)).toEqual(report);
    A.close();
    B.close();
  });

  it('holds the lock while it runs and releases it after', async () => {
    let heldDuringRun: string | null = null;
    const { report } = await tick([calls(journalCall()), say('Done.')], {}, { onProgress: (l) => { if (l.startsWith('agent bootstrap run')) heldDuringRun = getRunLock(h.db, 'mini')?.holder ?? null; } });
    expect(report.agent!.outcome).toBe('completed');
    expect(heldDuringRun).toBe(`tick pid ${process.pid}`);
    expect(getRunLock(h.db, 'mini')).toBeNull();
  });

  it('reports a lock release that fails, and the report is unaffected', async () => {
    const proxy = new Proxy(h.db, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop !== 'prepare') return typeof v === 'function' ? v.bind(target) : v;
        return (sql: string) => {
          if (sql.startsWith('DELETE FROM run_locks')) throw new Error('simulated: database is locked');
          return target.prepare(sql);
        };
      },
    }) as Db;
    model = scriptedModel([calls(journalCall()), say('Done.')]);
    const { report, exitCode } = await tickAsset(proxy, h.loaded, deps(), {});
    expect(report.outcome).toBe('completed');
    expect(exitCode).toBe(0);
    expect(progress.some((l) => l.startsWith('warning: the run lock could not be released (simulated'))).toBe(true);
  });

  it('reports a signal that could not be delivered and goes on', async () => {
    const { report, exitCode } = await tick([calls(journalCall()), say('Done.')], {}, { onSignal: () => { throw new Error('simulated: EACCES'); } });
    expect(report.outcome).toBe('completed');
    expect(exitCode).toBe(0);
    expect(report.signal).not.toBeNull();
    expect(report.agent!.outcome).toBe('completed');
    expect(progress.filter((l) => l.startsWith('warning: the signal could not be delivered (simulated') || l.startsWith("warning: the agent's signal could not be delivered (simulated")).length).toBe(1);
  });

  it('guards the inbox when its schema validation fails, and completes the tick', async () => {
    attempted('deep');
    h.db.prepare("INSERT INTO proposals (asset_id, persona, agent_run_id, kind, change_json, filed_against_json, rationale, evidence_json, effect_json, status, created_at) VALUES ('mini', 'analyst', NULL, 'config', '{}', '{}', 'r', '[]', '{\"weird\": 1}', 'pending', ?)").run(NOW.toISOString());
    const { report, exitCode } = await tick([calls(journalCall()), say('Done.')]);
    expect(report.outcome).toBe('completed');
    expect(exitCode).toBe(0);
    expect(report.inbox).toEqual({ observations: [], proposals: [], anomalies: [] });
    expect(progress.some((l) => l.startsWith('warning: the inbox could not be built'))).toBe(true);
  });
});
