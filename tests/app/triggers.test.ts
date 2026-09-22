import { beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_WINDOW_DAYS, currentTriggerInstances, evaluateTriggers } from '../../src/app/triggers.js';
import { finishAgentRun, startAgentRun, ZERO_USAGE } from '../../src/db/agentRuns.js';
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { insertObservation } from '../../src/db/observations.js';
import { attachRun, listFirings } from '../../src/db/triggerFirings.js';
import { AGENT_ASSET_YAML, agentWorld, type AgentWorld } from '../helpers/agentWorld.js';
import { AS_OF } from '../helpers/obs.js';

const T0 = new Date(AS_OF);
const daysLater = (d: number) => new Date(T0.getTime() + d * 86_400_000);
const iso = (d: Date) => d.toISOString();

/** Every metric fresh for a year, so a test that travels in time sees only the condition it set up. */
const RELAXED_YAML = AGENT_ASSET_YAML.replace(/staleness_days: \d+/g, 'staleness_days: 365');
/** Relaxed, except one metric keeps a short window. */
const shortWindow = (metric: string, days: number) => RELAXED_YAML.replace(`${metric}: { type: level, unit: usd, staleness_days: 365`, `${metric}: { type: level, unit: usd, staleness_days: ${days}`);
const REVENUE_60_YAML = shortWindow('revenue_run_rate_usd', 60);
const PRICE_3_YAML = shortWindow('price_usd', 3);
const withCalendar = (yaml: string, date: string) => `${yaml}review_triggers:\n  calendar:\n    - { date: "${date}", note: "Emission cut" }\n`;

let w: AgentWorld;
beforeEach(() => {
  w = agentWorld();
});

const set = (metric: string, value: number, at: Date, extra: { status?: 'confirmed' | 'provisional'; sourceDetail?: string; citationUrl?: string } = {}) =>
  insertObservation(w.db, { assetId: 'mini', metricKey: metric, observedAt: iso(at), value, source: 'manual', fetchedAt: iso(at), ...extra });
const evaluate = (now = T0, record = true) => evaluateTriggers(w.db, w.loaded, now, { record });
const instances = (now = T0) => currentTriggerInstances(w.db, w.loaded, now).map((i) => `${i.kind}:${i.key}`);
const fired = (e: ReturnType<typeof evaluate>) => e.fired.map((f) => `${f.kind}:${f.key}`);

describe('trigger conditions', () => {
  it('holds nothing on a healthy asset', () => {
    expect(instances()).toEqual([]);
    expect(evaluate()).toEqual({ fired: [], standing: [], cleared: [] });
  });

  it('open_anomaly: one instance per open anomaly, either severity, with Orion\'s detail and not the note', () => {
    const a = raiseAnomaly(w.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'advisory', detail: { check: 1 }, seenAt: AS_OF });
    const e = evaluate();
    expect(fired(e)).toEqual([`open_anomaly:${a.id}`]);
    expect(e.fired[0].detail).toEqual({ kind: 'cross_check_mismatch', metric: 'price_usd', severity: 'advisory', first_seen_at: a.firstSeenAt });
    decideAnomaly(w.db, a.id, 'resolved', 'fixed', AS_OF);
    expect(instances()).toEqual([]);
    expect(evaluate()).toMatchObject({ fired: [], standing: [], cleared: [] }); // its row stays; a new anomaly is a new id
  });

  it('staleness: a critical metric past its window, not an advisory one', () => {
    // At +4 days price (3-day window) is stale and critical; staked_supply (7-day window) is not stale yet; share is not critical.
    expect(instances(daysLater(4))).toEqual(['staleness:price_usd']);
    const e = evaluate(daysLater(4));
    expect(e.fired[0].detail).toEqual({ staleness_days: 3, newest_observed_at: '2026-06-29T00:00:00.000Z' });
    expect(instances(daysLater(8)).sort()).toEqual(['staleness:effective_supply', 'staleness:price_usd']);
  });

  it('staleness detail uses eligible observations, ignoring provisional and future-dated rows', () => {
    w = agentWorld(PRICE_3_YAML);
    set('price_usd', 15, daysLater(4), { status: 'provisional', citationUrl: 'https://example.com/p' });
    expect(evaluate(daysLater(4)).fired[0].detail).toEqual({ staleness_days: 3, newest_observed_at: '2026-06-29T00:00:00.000Z' });
  });

  it('provisional: a user-entered provisional row fires; the agent\'s own research rows do not', () => {
    const mine = set('revenue_run_rate_usd', 1100, daysLater(1), { status: 'provisional', citationUrl: 'https://example.com/q' });
    set('revenue_run_rate_usd', 1150, daysLater(2), { status: 'provisional', citationUrl: 'https://example.com/r', sourceDetail: 'research:analyst:run 3' });
    const deck = set('revenue_run_rate_usd', 1120, daysLater(3), { status: 'provisional', citationUrl: 'https://example.com/s', sourceDetail: 'entered from the quarterly deck' });
    const e = evaluate();
    expect(fired(e)).toEqual([`provisional:${mine.id}`, `provisional:${deck.id}`]);
    expect(e.fired[0].detail).toEqual({ metric: 'revenue_run_rate_usd', observed_at: iso(daysLater(1)), value: 1100 });
  });

  it('calendar: from the event date for a week, keyed by the date', () => {
    w = agentWorld(withCalendar(RELAXED_YAML, '2026-07-02'));
    expect(instances(daysLater(1))).toEqual([]);
    expect(instances(daysLater(2))).toEqual(['calendar:2026-07-02']);
    expect(evaluate(daysLater(2)).fired[0].detail).toEqual({ note: 'Emission cut' });
    expect(instances(daysLater(2 + CALENDAR_WINDOW_DAYS - 1))).toEqual(['calendar:2026-07-02']);
    expect(instances(daysLater(2 + CALENDAR_WINDOW_DAYS))).toEqual([]);
  });
});

describe('driver_deviation', () => {
  beforeEach(() => {
    w = agentWorld(RELAXED_YAML);
  });

  it('fires when revenue sits further from the base path than the threshold, with the numbers in the detail', () => {
    // The flat mini assumptions imply no growth, so the path from the 1000 anchor is 1000. 30 percent above it at +10 days.
    set('revenue_run_rate_usd', 1300, daysLater(10));
    expect(instances(daysLater(10))).toEqual(['driver_deviation:revenue_run_rate_usd']);
    const e = evaluate(daysLater(10));
    expect(e.fired[0].detail).toMatchObject({ anchor_value: 1000, anchor_as_of: AS_OF, anchor_from: 'assumption_set', implied: 1000, actual: 1300, threshold_pct: 25 });
    expect(e.fired[0].detail.deviation_pct as number).toBeCloseTo(30, 9);
  });

  it('stays quiet inside the threshold, while the anchor is under a week old, and while revenue itself is stale', () => {
    set('revenue_run_rate_usd', 1200, daysLater(10));
    expect(instances(daysLater(10))).toEqual([]); // 20 percent
    set('revenue_run_rate_usd', 1300, daysLater(3));
    expect(instances(daysLater(3))).toEqual([]); // anchor 3 days old
    w = agentWorld(REVENUE_60_YAML);
    set('revenue_run_rate_usd', 1300, daysLater(10));
    expect(instances(daysLater(70))).toEqual(['driver_deviation:revenue_run_rate_usd']); // 60 days old is not yet stale
    expect(instances(daysLater(71))).toEqual(['staleness:revenue_run_rate_usd']); // now it is: staleness owns the datum
  });

  it('measures from the last completed review, and the threshold comes from the asset', () => {
    set('revenue_run_rate_usd', 1300, daysLater(10));
    const run = startAgentRun(w.db, { assetId: 'mini', persona: 'analyst', runType: 'weekly', trigger: 'schedule', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: iso(daysLater(11)) });
    finishAgentRun(w.db, run, { outcome: 'completed', endedAt: iso(daysLater(11)), usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
    expect(instances(daysLater(20))).toEqual([]); // the review saw 1300; the path now starts there
    set('revenue_run_rate_usd', 1690, daysLater(20));
    expect(instances(daysLater(20))).toEqual(['driver_deviation:revenue_run_rate_usd']); // 30 percent over 1300
    w = agentWorld(`${RELAXED_YAML}review_triggers:\n  driver_deviation_pct: 40\n`);
    set('revenue_run_rate_usd', 1300, daysLater(10));
    expect(instances(daysLater(10))).toEqual([]);
  });
});

describe('evaluateTriggers: firing once, standing, re-arming', () => {
  it('fires an instance once, then reports it standing, and re-arms a re-arming kind when its condition clears', () => {
    w = agentWorld(PRICE_3_YAML);
    const first = evaluate(daysLater(4)); // price stale
    expect(fired(first)).toEqual(['staleness:price_usd']);
    expect(listFirings(w.db, 'mini')).toHaveLength(1);
    const again = evaluate(daysLater(5));
    expect(again.fired).toEqual([]);
    expect(again.standing.map((f) => f.id)).toEqual([first.fired[0].id]);
    set('price_usd', 10, daysLater(5)); // fresh again
    const cleared = evaluate(daysLater(5));
    expect(cleared.cleared.map((f) => f.id)).toEqual([first.fired[0].id]);
    expect(listFirings(w.db, 'mini')).toHaveLength(0);
    const third = evaluate(daysLater(9)); // stale again
    expect(fired(third)).toEqual(['staleness:price_usd']);
    expect(third.fired[0].id).not.toBe(first.fired[0].id);
  });

  it('does not re-arm the kinds whose instance is the id or the date', () => {
    const a = raiseAnomaly(w.db, { assetId: 'mini', kind: 'source_failure_streak', metricKey: '', dedupeKey: 'cg', severity: 'advisory', detail: {}, seenAt: AS_OF });
    evaluate();
    decideAnomaly(w.db, a.id, 'acknowledged', 'known', AS_OF);
    const e = evaluate();
    expect(e).toMatchObject({ fired: [], standing: [], cleared: [] });
    expect(listFirings(w.db, 'mini')).toHaveLength(1);
  });

  it('with record: false computes the same answer, writes nothing, and marks the unrecorded firings with id 0', () => {
    const dry = evaluate(daysLater(4), false);
    expect(fired(dry)).toEqual(['staleness:price_usd']);
    expect(dry.fired[0]).toMatchObject({ id: 0, agentRunId: null, firedAt: iso(daysLater(4)) });
    expect(listFirings(w.db, 'mini')).toHaveLength(0);
    const real = evaluate(daysLater(4));
    expect(real.fired[0].id).toBeGreaterThan(0);
    set('price_usd', 10, daysLater(5));
    const dryClear = evaluate(daysLater(5), false);
    expect(dryClear.cleared).toHaveLength(1);
    expect(listFirings(w.db, 'mini')).toHaveLength(1); // not deleted
  });

  it('attaches the run that handled this tick\'s firings', () => {
    const e = evaluate(daysLater(4));
    const run = startAgentRun(w.db, { assetId: 'mini', persona: 'analyst', runType: 'triage', trigger: 'trigger', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: iso(daysLater(4)) });
    attachRun(w.db, e.fired.map((f) => f.id), run);
    expect(evaluate(daysLater(5)).standing[0].agentRunId).toBe(run);
  });
});
