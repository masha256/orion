import { beforeEach, describe, expect, it } from 'vitest';
import { replayRun, runValuation, whatIf } from '../../src/app/valuation.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation, rejectObservation } from '../../src/db/observations.js';
import type { OrionError } from '../../src/types.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

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
    expect(signal.change).toEqual({ prev_signal_id: null, target_delta_pct: null, cause: 'none', causes: [], author: null, rationale: '' });
    expect(signal.provenance.agent_run_id).toBeNull();
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

describe('runValuation with a confirmed and a provisional row at the same timestamp', () => {
  const ALLOWING = MINI_ASSET_YAML.replace(
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }',
  );

  beforeEach(() => {
    seedObservations(['revenue_run_rate_usd']);
    seedAssumptions();
    insertObservation(db, { assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-28', value: 2000, source: 'onchain', fetchedAt: AS_OF });
    insertObservation(db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-28', value: 5000, source: 'manual',
      status: 'provisional', citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
  });

  it('uses the confirmed value and does not report the metric provisional', () => {
    const signal = runValuation(db, parseAssetYaml(ALLOWING), NOW).signal;
    expect(signal.status).toBe('ok');
    expect(signal.horizons!['12m'].expected_target).toBeCloseTo(20, 6); // 2000, not the provisional 5000
    expect(signal.data_quality.provisional_metrics).toEqual([]);
  });

  it('is not blocked when the metric does not allow provisional data', () => {
    const signal = runValuation(db, loaded, NOW).signal;
    expect(signal.status).toBe('ok');
    expect(signal.horizons!['12m'].expected_target).toBeCloseTo(20, 6);
  });
});

describe('runValuation config validation', () => {
  const blockedFor = (yaml: string, over: Partial<Record<string, number>> = {}) => {
    seedObservations();
    seedAssumptions(over);
    return runValuation(db, parseAssetYaml(yaml), NOW).signal;
  };

  it('blocks when a module is configured with a kind its type does not allow', () => {
    const yaml = MINI_ASSET_YAML
      .replace('  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }',
        '  - { id: hc, type: holder_cashflow, kind: component }\n  - { id: fm, type: forward_multiple, kind: estimate, weight: 1, params: { basis: revenue } }')
      .replace('assumptions:', 'assumptions:\n  multiple.fm: { min: 0, max: 100 }\n  regime_multiplier: { min: 0.1, max: 3 }');
    const signal = blockedFor(yaml, { 'multiple.fm': 2, regime_multiplier: 1 });
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons).toContain('invalid_config:modules.hc: type holder_cashflow cannot be a component');
  });

  it('blocks when a required assumption key has no bounds', () => {
    const yaml = MINI_ASSET_YAML.replace('  discount_rate_base: { min: 0.05, max: 0.5 }\n', '');
    const signal = blockedFor(yaml);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons).toContain('invalid_config:assumptions: required key "discount_rate_base" has no bounds');
  });

  it('blocks on an unknown module type instead of throwing out of the run', () => {
    const yaml = MINI_ASSET_YAML.replace('type: holder_cashflow', 'type: nope');
    const signal = blockedFor(yaml);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons).toContain('invalid_config:modules.hc: unknown module type "nope"');
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

  const target12m = (r: ReturnType<typeof whatIf>) => ('output' in r ? r.output.horizons['12m'].expectedTarget : null);

  it('previews an observation that is not in the database, displacing the level it would replace', () => {
    seedObservations();
    seedAssumptions();
    // Capture stays at 10 percent of revenue, so doubling revenue doubles the flows and the target.
    const staged = obs('revenue_run_rate_usd', 2000, '2026-06-20', { id: -1, source: 'manual', status: 'provisional' });
    expect(target12m(whatIf(db, loaded, NOW, []))).toBeCloseTo(10, 6);
    expect(target12m(whatIf(db, loaded, NOW, [], { addObservations: [staged] }))).toBeCloseTo(20, 6);
    // Same metric and observed-at as the stored row: the addition wins although its temporary id is lower.
    const sameInstant = obs('revenue_run_rate_usd', 3000, '2026-06-15', { id: -2, source: 'manual' });
    expect(target12m(whatIf(db, loaded, NOW, [], { addObservations: [sameInstant] }))).toBeCloseTo(30, 6);
    const n = db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
    expect(n.n).toBe(7);
  });

  it('previews the removal of an observation', () => {
    seedObservations();
    seedAssumptions();
    const revenue = db.prepare("SELECT id FROM observations WHERE metric_key = 'revenue_run_rate_usd'").get() as { id: number };
    const r = whatIf(db, loaded, NOW, [], { removeObservationIds: [revenue.id] });
    expect('blocked' in r && r.blocked).toEqual(['missing_metric:revenue_run_rate_usd']);
  });

  it('runs under a config override, and reports an override that is invalid', () => {
    seedObservations();
    seedAssumptions({});
    createAssumptionSet(db, {
      assetId: 'mini', author: 'user', rationale: 'bull discounts less', createdAt: AS_OF,
      values: { ...miniAssumptions(), bull: { ...miniAssumptions().bull, discount_rate_base: 0.05 } },
    });
    expect(target12m(whatIf(db, loaded, NOW, []))).toBeCloseTo(12.5, 6); // 0.25 * 10 + 0.5 * 10 + 0.25 * 20
    const allBull = { ...loaded.config, scenario_probabilities: { bear: 0, base: 0, bull: 1 } };
    expect(target12m(whatIf(db, loaded, NOW, [], { config: allBull }))).toBeCloseTo(20, 6);
    const broken = { ...loaded.config, modules: [{ ...loaded.config.modules[0], type: 'no_such_module' }] };
    const r = whatIf(db, loaded, NOW, [], { config: broken });
    expect('blocked' in r && r.blocked[0]).toMatch(/^invalid_config:/);
  });
});

describe('change causes', () => {
  it('reports a config change, which no other field would explain', () => {
    seedObservations();
    seedAssumptions();
    runValuation(db, loaded, NOW);
    const renamed = parseAssetYaml(MINI_ASSET_YAML.replace('name: Mini Test Asset', 'name: Mini Renamed'));
    const { signal } = runValuation(db, renamed, NOW);
    expect(signal.change).toMatchObject({ cause: 'config', causes: ['config'], author: null, rationale: '' });
  });

  it('names the author of an assumption change, and says both when more than one thing changed', () => {
    seedObservations();
    seedAssumptions();
    runValuation(db, loaded, NOW);
    createAssumptionSet(db, { assetId: 'mini', author: 'analyst', rationale: 'growth up', values: miniAssumptions({ rev_growth_y1: 0.1 }), createdAt: AS_OF });
    const second = runValuation(db, loaded, NOW, { agentRunId: 7 }).signal;
    expect(second.change).toMatchObject({ cause: 'assumptions', causes: ['assumptions'], author: 'analyst', rationale: 'growth up' });
    expect(second.provenance.agent_run_id).toBe(7);
    const stored = db.prepare('SELECT agent_run_id FROM valuation_runs WHERE id = ?').get(second.provenance.run_id) as { agent_run_id: number };
    expect(stored.agent_run_id).toBe(7);

    insertObservation(db, { assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-06-29T12:00:00Z', value: 11, source: 'onchain', fetchedAt: AS_OF });
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'back to flat', values: miniAssumptions(), createdAt: AS_OF });
    const renamed = parseAssetYaml(MINI_ASSET_YAML.replace('name: Mini Test Asset', 'name: Mini Renamed'));
    const third = runValuation(db, renamed, NOW).signal;
    expect(third.change).toMatchObject({ cause: 'both', causes: ['data', 'assumptions', 'config'], author: 'user', rationale: 'back to flat' });
    expect(third.provenance.agent_run_id).toBeNull();
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

  it('refuses to replay a run recorded by a different engine version', () => {
    seedObservations();
    seedAssumptions();
    const { runId } = runValuation(db, loaded, NOW);
    db.prepare('UPDATE valuation_runs SET engine_version = ? WHERE id = ?').run('0.0.1-other', runId);
    let code: string | undefined;
    try {
      replayRun(db, runId);
    } catch (err) {
      code = (err as OrionError).code;
    }
    expect(code).toBe('engine_version_mismatch');
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

describe('runValuation and open anomalies', () => {
  const raise = (severity: 'degrading' | 'advisory', metricKey = 'price_usd') =>
    raiseAnomaly(db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey, dedupeKey: 'coingecko', severity, detail: {}, seenAt: AS_OF });

  it('degrades while a degrading anomaly on a critical metric is open, and recovers once it is acknowledged', () => {
    seedObservations();
    seedAssumptions();
    const anomaly = raise('degrading');
    const degraded = runValuation(db, loaded, NOW).signal;
    expect(degraded.status).toBe('degraded');
    expect(degraded.status_reasons).toEqual(['open_anomaly:cross_check_mismatch:price_usd']);
    expect(degraded.data_quality).toMatchObject({ grade: 'D', open_anomalies: 1 });
    expect(degraded.data_quality.anomalies).toEqual([{ id: anomaly.id, kind: 'cross_check_mismatch', metric: 'price_usd', severity: 'degrading' }]);
    expect(degraded.horizons!['12m'].expected_target).toBeCloseTo(10, 6); // the target itself is untouched

    decideAnomaly(db, anomaly.id, 'acknowledged', 'venice api lags by an hour', AS_OF);
    const ok = runValuation(db, loaded, NOW).signal;
    expect(ok.status).toBe('ok');
    expect(ok.data_quality).toMatchObject({ grade: 'A', open_anomalies: 0, anomalies: [] });
  });

  it('ignores anomalies of other assets and leaves advisory ones in the list only', () => {
    seedObservations();
    seedAssumptions();
    raise('advisory');
    raiseAnomaly(db, { assetId: 'other', kind: 'unlisted_sender', metricKey: 'price_usd', dedupeKey: '0x1', severity: 'degrading', detail: {}, seenAt: AS_OF });
    const signal = runValuation(db, loaded, NOW).signal;
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.open_anomalies).toBe(1);
  });

  it('keeps anomalies out of the replayed engine output', () => {
    seedObservations();
    seedAssumptions();
    const { runId } = runValuation(db, loaded, NOW);
    raise('degrading');
    expect(replayRun(db, runId).identical).toBe(true);
  });
});
