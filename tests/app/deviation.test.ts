import { beforeEach, describe, expect, it } from 'vitest';
import { DEVIATION_MIN_ANCHOR_AGE_DAYS, revenueAnchor, revenueDeviation } from '../../src/app/deviation.js';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import { finishAgentRun, startAgentRun, ZERO_USAGE } from '../../src/db/agentRuns.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { revenueAt } from '../../src/engine/paths.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const BASE = { rev_growth_y1: 1, growth_fade_years: 2, terminal_growth: 0.02 };
const at = (iso: string) => new Date(iso);
const days = (n: number) => n * 86_400_000;

describe('revenueDeviation', () => {
  it('measures actual against the base path from the anchor: doubling in a year at 100 percent growth', () => {
    const anchor = { value: 1000, asOf: '2026-01-01T00:00:00.000Z' };
    const now = new Date(Date.parse(anchor.asOf) + 365 * days(1));
    const d = revenueDeviation(anchor, 2500, BASE, now)!;
    expect(d.elapsed_years).toBeCloseTo(1, 9);
    expect(d.implied).toBeCloseTo(2000, 6);
    expect(d.actual).toBe(2500);
    expect(d.deviation_pct).toBeCloseTo(25, 6);
    expect(d).toMatchObject({ anchor_value: 1000, anchor_as_of: anchor.asOf });
  });

  it('uses the engine\'s own path function, fade included, and is negative below the path', () => {
    const anchor = { value: 1000, asOf: '2026-01-01T00:00:00.000Z' };
    const now = new Date(Date.parse(anchor.asOf) + 500 * days(1));
    const d = revenueDeviation(anchor, 1500, BASE, now)!;
    expect(d.implied).toBeCloseTo(revenueAt(500 / 365, 1000, BASE), 9);
    expect(d.deviation_pct).toBeLessThan(0);
  });

  it('does not measure against an anchor younger than a week (half a day of slack), or a path that is not positive', () => {
    const anchor = { value: 1000, asOf: '2026-01-01T00:00:00.000Z' };
    expect(revenueDeviation(anchor, 5000, BASE, new Date(Date.parse(anchor.asOf) + days(DEVIATION_MIN_ANCHOR_AGE_DAYS - 0.5) - 60_000))).toBeNull();
    expect(revenueDeviation(anchor, 5000, BASE, new Date(Date.parse(anchor.asOf) + days(DEVIATION_MIN_ANCHOR_AGE_DAYS - 0.5)))).not.toBeNull();
    expect(revenueDeviation({ value: 0, asOf: anchor.asOf }, 5000, BASE, new Date(Date.parse(anchor.asOf) + days(30)))).toBeNull();
  });
});

describe('revenueAnchor', () => {
  let db: Db;
  let asset: AssetConfig;
  const store = (list: ReturnType<typeof miniObservations>) => {
    for (const o of list) insertObservation(db, { assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt });
  };
  const completedRun = (startedAt: string, dryRun = false) => {
    const id = startAgentRun(db, { assetId: 'mini', persona: 'analyst', runType: 'weekly', trigger: 'schedule', triggerDetail: {}, dryRun, configHash: 'x', model: 'm', startedAt });
    finishAgentRun(db, id, { outcome: 'completed', endedAt: startedAt, usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
  };

  beforeEach(() => {
    db = openDb(':memory:');
    asset = parseAssetYaml(MINI_ASSET_YAML).config;
  });

  it('is null with neither an assumption set nor a completed run', () => {
    store(miniObservations());
    expect(revenueAnchor(db, asset)).toBeNull();
  });

  it('anchors at the assumption set\'s creation before any agent run, on the revenue in force then', () => {
    store(miniObservations({ revenue: 1000 }));
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });
    expect(revenueAnchor(db, asset)).toEqual({ value: 1000, asOf: AS_OF, from: 'assumption_set' });
  });

  it('stays at the assumption set\'s creation whatever agent runs happened since', () => {
    store(miniObservations({ revenue: 1000 }));
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });
    const later = new Date(Date.parse(AS_OF) + days(10)).toISOString();
    const daysLater12 = new Date(Date.parse(AS_OF) + days(12)).toISOString();
    insertObservation(db, { assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: daysLater12, value: 1300, source: 'manual', fetchedAt: later });
    completedRun(later);
    completedRun(new Date(Date.parse(AS_OF) + days(20)).toISOString(), true); // a dry run is not a review
    expect(revenueAnchor(db, asset)).toEqual({ value: 1000, asOf: AS_OF, from: 'assumption_set' }); // completed runs do not move the anchor
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'checked in', values: miniAssumptions(), createdAt: daysLater12 });
    expect(revenueAnchor(db, asset)).toEqual({ value: 1300, asOf: daysLater12, from: 'assumption_set' }); // a new set moves the anchor
  });

  it('is null when the drivers cannot be computed as of the anchor', () => {
    store(miniObservations().filter((o) => o.metricKey !== 'revenue_run_rate_usd'));
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });
    expect(revenueAnchor(db, asset)).toBeNull();
  });

  it('ignores runs on other assets and the dates are read back as stored', () => {
    store(miniObservations());
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });
    const otherId = startAgentRun(db, { assetId: 'other', persona: 'p', runType: 'deep', trigger: 'schedule', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: at('2026-07-15T00:00:00Z').toISOString() });
    finishAgentRun(db, otherId, { outcome: 'completed', endedAt: '2026-07-15T00:00:00Z', usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
    expect(revenueAnchor(db, asset)!.from).toBe('assumption_set');
  });
});
