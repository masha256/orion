import { beforeEach, describe, expect, it } from 'vitest';
import { replayRun, runValuation, whatIf } from '../../src/app/valuation.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation, rejectObservation } from '../../src/db/observations.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const NOW = new Date(AS_OF);
let db: Db;
let loaded: LoadedAsset;

function seedObservations(skip: string[] = []) {
  for (const o of miniObservations()) {
    if (skip.includes(o.metricKey)) continue;
    insertObservation(db, {
      assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays,
      value: o.value, source: o.source, fetchedAt: o.fetchedAt,
    });
  }
}
function seedAssumptions(over: Partial<Record<string, number>> = {}, rationale = 'initial') {
  return createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale, values: miniAssumptions(over), createdAt: AS_OF });
}

beforeEach(() => {
  db = openDb(':memory:');
  loaded = parseAssetYaml(MINI_ASSET_YAML);
});

describe('runValuation', () => {
  it('produces an ok signal and persists the run', () => {
    seedObservations();
    seedAssumptions();
    const { runId, signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('ok');
    expect(signal.signal_id).toBe(`mini-20260630T000000Z-${runId}`);
    expect(signal.horizons!['12m'].expected_target).toBeCloseTo(10, 6);
    expect(signal.provenance.config_hash).toBe(loaded.hash);
    expect(signal.change).toEqual({ prev_signal_id: null, target_delta_pct: null, cause: 'none', rationale: '' });
  });

  it('blocks with reasons when data or assumptions are missing', () => {
    seedObservations(['price_usd']);
    const { signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons).toEqual(['missing_metric:price_usd', 'no_assumption_set']);
    expect(signal.spot).toBeNull();
  });

  it('blocks when the stored assumptions are out of bounds', () => {
    seedObservations();
    seedAssumptions({ discount_rate_base: 0.9 });
    const { signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons[0]).toMatch(/^invalid_assumptions:/);
  });

  it('attributes a target change to assumptions and carries the rationale', () => {
    seedObservations();
    seedAssumptions();
    const first = runValuation(db, loaded, NOW).signal;
    seedAssumptions({ discount_rate_base: 0.2 }, 'higher discount rate');
    const second = runValuation(db, loaded, NOW).signal;
    expect(second.change.prev_signal_id).toBe(first.signal_id);
    expect(second.change.cause).toBe('assumptions');
    expect(second.change.rationale).toBe('higher discount rate');
    expect(second.change.target_delta_pct).toBeCloseTo(-50, 4);
  });

  it('attributes a target change to data', () => {
    seedObservations();
    seedAssumptions();
    runValuation(db, loaded, NOW);
    insertObservation(db, { assetId: 'mini', metricKey: 'effective_supply', observedAt: '2026-06-29T12:00:00Z', value: 200, source: 'onchain', fetchedAt: AS_OF });
    expect(runValuation(db, loaded, NOW).signal.change.cause).toBe('data');
  });

  it('blocks on overlapping flow periods and runs again once the partial row is rejected', () => {
    seedObservations();
    seedAssumptions();
    // The seeded flow row covers the 90 days ending at AS_OF; this one lands inside it.
    const partial = insertObservation(db, {
      assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-06-15', periodDays: 15,
      value: 5, source: 'onchain', fetchedAt: AS_OF,
    });
    const blocked = runValuation(db, loaded, NOW).signal;
    expect(blocked.status).toBe('blocked');
    expect(blocked.status_reasons).toContain('overlapping_flow_periods:flow_usd.fees');

    rejectObservation(db, partial.id);
    expect(runValuation(db, loaded, NOW).signal.status).toBe('ok');
  });

  it('excludes provisional observations unless the metric allows them', () => {
    seedObservations();
    seedAssumptions();
    insertObservation(db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-28', value: 5000, source: 'manual',
      status: 'provisional', citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    expect(runValuation(db, loaded, NOW).signal.data_quality.provisional_metrics).toEqual([]);
    const allowing = parseAssetYaml(
      MINI_ASSET_YAML.replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
        'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }'),
    );
    const s = runValuation(db, allowing, NOW).signal;
    expect(s.data_quality.provisional_metrics).toEqual(['revenue_run_rate_usd']);
    expect(s.data_quality.grade).toBe('C');
  });
});

describe('whatIf', () => {
  it('applies overrides without persisting anything', () => {
    seedObservations();
    seedAssumptions();
    const r = whatIf(db, loaded, NOW, [{ key: 'discount_rate_base', value: 0.05, scenario: 'bull' }]);
    expect('output' in r && r.output.horizons['12m'].scenarios.bull.target).toBeCloseTo(20, 6);
    const n = db.prepare('SELECT COUNT(*) AS n FROM valuation_runs').get() as { n: number };
    expect(n.n).toBe(0);
  });
  it('reports why it cannot run', () => {
    const r = whatIf(db, loaded, NOW, []);
    expect('blocked' in r && r.blocked.length).toBeGreaterThan(0);
  });
});

describe('replayRun', () => {
  it('reproduces a stored run byte for byte, even after data and status changes', () => {
    const allowing = parseAssetYaml(
      MINI_ASSET_YAML.replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
        'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }'),
    );
    seedObservations();
    seedAssumptions();
    const provisional = insertObservation(db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-28', value: 5000, source: 'manual',
      status: 'provisional', citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    const { runId, signal } = runValuation(db, allowing, NOW);
    expect(signal.data_quality.provisional_metrics).toEqual(['revenue_run_rate_usd']);
    // everything below changes live state; none of it may change the replay
    rejectObservation(db, provisional.id);
    insertObservation(db, { assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-06-29T18:00:00Z', value: 99, source: 'onchain', fetchedAt: AS_OF });
    seedAssumptions({ rev_growth_y1: 1 }, 'later change');
    const r = replayRun(db, runId);
    expect(r.identical).toBe(true);
    expect(r.replayed).toBe(r.stored);
  });

  it('refuses to replay a blocked run', () => {
    const { runId } = runValuation(db, loaded, NOW);
    expect(() => replayRun(db, runId)).toThrow(/blocked/);
  });

  it('reproduces a run whose flow metric was backfilled out of chronological order', () => {
    seedObservations(['flow_usd.fees']);
    // A non-zero capture ramp makes the module's cashflow path depend on the *current* capture
    // rate (derived from the driver's annualized flow), not just the terminal assumption, so an
    // order-sensitive driver difference actually reaches the engine output instead of being
    // masked by capture_ramp_years.fees: 0 (mini's usual flat-world default).
    seedAssumptions({ 'capture_ramp_years.fees': 5 });
    // Insert newest-first, then backfill older observations later: ids end up in the REVERSE of
    // observedAt order. getObservationsByIds (ORDER BY id) and listActiveObservations
    // (ORDER BY observed_at, id) would then disagree on order if driver output depended on it.
    // Large, order-sensitive values under IEEE 754 summation: (a+b)+c !== (c+b)+a for these three.
    insertObservation(db, {
      assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-06-29', periodDays: 1, value: 300000.3, source: 'onchain', fetchedAt: AS_OF,
    });
    insertObservation(db, {
      assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-06-28', periodDays: 1, value: 200000.2, source: 'onchain', fetchedAt: AS_OF,
    });
    insertObservation(db, {
      assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-06-27', periodDays: 1, value: 100000.1, source: 'onchain', fetchedAt: AS_OF,
    });
    const { runId } = runValuation(db, loaded, NOW);
    expect(replayRun(db, runId).identical).toBe(true);
  });
});
