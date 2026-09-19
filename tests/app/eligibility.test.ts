import { beforeEach, describe, expect, it } from 'vitest';
import { eligibleObservations, narrowToUsable } from '../../src/app/eligibility.js';
import { replayRun, runValuation } from '../../src/app/valuation.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { getLatestSignal, getSnapshot, listSignals } from '../../src/db/runs.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { runEngine } from '../../src/engine/run.js';
import { canonicalJson } from '../../src/util/canonical.js';
import { MINI_ASSET_YAML, miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

const DAY = 86_400_000;
const NOW = new Date(AS_OF);
const dayBefore = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

/** 200 daily flow rows ending at AS_OF, 100 USD per year, plus 200 daily prices. */
function dailyHistory() {
  const list = miniObservations().filter((o) => o.metricKey !== 'flow_usd.fees' && o.metricKey !== 'price_usd');
  for (let n = 199; n >= 0; n--) {
    list.push(obs('flow_usd.fees', 100 / 365, dayBefore(n), { periodDays: 1 }));
    list.push(obs('price_usd', 10 + n / 1000, dayBefore(n + 0.5)));
  }
  return list;
}

describe('narrowToUsable', () => {
  const asset = miniAsset();

  it('keeps the newest level, the flow window plus a day, the schedule in force and later, and future events', () => {
    const list = [
      ...dailyHistory(),
      obs('emission_rate_annual', 5, '2025-01-01'),
      obs('emission_rate_annual', 3, '2026-08-01'),
      obs('scheduled_unlock_tokens', 7, '2026-05-01'),
      obs('scheduled_unlock_tokens', 9, '2026-12-01'),
    ];
    const withEvents = parseAssetYaml(MINI_ASSET_YAML.replace('holder_flows:', '  scheduled_unlock_tokens: { type: event, unit: tokens, staleness_days: 400 }\nholder_flows:')).config;
    const kept = narrowToUsable(withEvents, list, AS_OF);
    const of = (key: string) => kept.filter((o) => o.metricKey === key);
    expect(of('price_usd')).toHaveLength(1);
    expect(of('price_usd')[0].observedAt).toBe(dayBefore(0.5));
    expect(of('flow_usd.fees')).toHaveLength(91); // the 90-day window plus one day of margin
    expect(of('emission_rate_annual').map((o) => o.value)).toEqual([0, 3]); // in force since 2026-01-01, and the later step
    expect(of('scheduled_unlock_tokens').map((o) => o.value)).toEqual([9]);
    expect(kept.length).toBeLessThan(110);
    expect(kept.map((o) => [o.observedAt, o.id])).toEqual([...kept].sort((a, b) => (a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1)).map((o) => [o.observedAt, o.id]));
  });

  it('gives byte-identical engine output to the full set', () => {
    const full = dailyHistory();
    const run = (list: typeof full) => canonicalJson(runEngine({ asset, drivers: computeDrivers(asset, list, AS_OF).drivers!, assumptions: miniAssumptions({ 'capture_ramp_years.fees': 5 }) }));
    expect(run(narrowToUsable(asset, full, AS_OF))).toBe(run(full));
    expect(computeDrivers(asset, narrowToUsable(asset, full, AS_OF), AS_OF)).toEqual(computeDrivers(asset, full, AS_OF));
  });

  it('drops flow metrics that no holder flow uses, and metrics the asset does not define', () => {
    const withInfo = parseAssetYaml(MINI_ASSET_YAML.replace('holder_flows:', '  flow_tokens.fees: { type: flow, unit: tokens, staleness_days: 45 }\nholder_flows:')).config;
    const list = [...miniObservations(), obs('flow_tokens.fees', 5, AS_OF, { periodDays: 1 }), obs('not_defined', 1, AS_OF)];
    const keys = new Set(narrowToUsable(withInfo, list, AS_OF).map((o) => o.metricKey));
    expect(keys.has('flow_tokens.fees')).toBe(false);
    expect(keys.has('not_defined')).toBe(false);
    expect(keys.has('flow_usd.fees')).toBe(true);
  });

  it('ignores observations after as_of, except schedule steps and events', () => {
    const list = [...miniObservations(), obs('price_usd', 99, '2026-07-05'), obs('flow_usd.fees', 50, '2026-07-05', { periodDays: 1 })];
    const kept = narrowToUsable(asset, list, AS_OF);
    expect(kept.some((o) => o.value === 99)).toBe(false);
    expect(kept.filter((o) => o.metricKey === 'flow_usd.fees')).toHaveLength(1);
  });
});

describe('runValuation on a narrowed snapshot', () => {
  let db: Db;
  let loaded: LoadedAsset;
  const store = (list: ReturnType<typeof miniObservations>) => {
    for (const o of list) insertObservation(db, { assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt });
  };

  beforeEach(() => {
    db = openDb(':memory:');
    loaded = parseAssetYaml(MINI_ASSET_YAML);
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });
  });

  it('freezes only usable observations, and replays identically', () => {
    store(dailyHistory());
    const { runId, signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('ok');
    expect(getSnapshot(db, signal.provenance.snapshot_id)!.observationIds.length).toBeLessThan(110);
    expect(eligibleObservations(db, loaded.config, AS_OF)).toHaveLength(getSnapshot(db, signal.provenance.snapshot_id)!.observationIds.length);
    expect(replayRun(db, runId).identical).toBe(true);
  });

  it('is no longer blocked by an overlap far in the past', () => {
    store(miniObservations());
    store([obs('flow_usd.fees', 10, dayBefore(300), { periodDays: 30 }), obs('flow_usd.fees', 4, dayBefore(310), { periodDays: 10 })]);
    expect(runValuation(db, loaded, NOW).signal.status).toBe('ok');
  });

  it('is still blocked by an overlap inside the window', () => {
    store(miniObservations());
    store([obs('flow_usd.fees', 4, dayBefore(10), { periodDays: 5 })]);
    expect(runValuation(db, loaded, NOW).signal.status_reasons).toContain('overlapping_flow_periods:flow_usd.fees');
  });
});

describe('latest signal ordering', () => {
  it('never lets a backfilled --as-of run become the latest signal', () => {
    const db = openDb(':memory:');
    const loaded = parseAssetYaml(MINI_ASSET_YAML);
    for (const o of miniObservations()) insertObservation(db, { assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt });
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });

    const today = runValuation(db, loaded, NOW).signal;
    const backfilled = runValuation(db, loaded, new Date(NOW.getTime() - 60_000)).signal; // stored later, generated earlier
    expect(getLatestSignal(db, 'mini')!.signal_id).toBe(today.signal_id);
    expect(listSignals(db, 'mini', 10).map((s) => s.signal_id)).toEqual([today.signal_id, backfilled.signal_id]);
    expect(backfilled.change.prev_signal_id).toBe(today.signal_id);

    const next = runValuation(db, loaded, new Date(NOW.getTime() + 60_000)).signal;
    expect(next.change.prev_signal_id).toBe(today.signal_id); // compared against the latest by time, not by insertion
  });

  it('breaks a tie on generated_at by the greater id', () => {
    const db = openDb(':memory:');
    const loaded = parseAssetYaml(MINI_ASSET_YAML);
    const first = runValuation(db, loaded, NOW).signal;
    const second = runValuation(db, loaded, NOW).signal;
    expect(first.generated_at).toBe(second.generated_at);
    expect(getLatestSignal(db, 'mini')!.signal_id).toBe(second.signal_id);
  });
});
