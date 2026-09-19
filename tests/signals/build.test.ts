import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { latestLevel } from '../../src/drivers/select.js';
import { runEngine } from '../../src/engine/run.js';
import { buildSignal, type BuildSignalInput } from '../../src/signals/build.js';
import { emitSignal } from '../../src/signals/emit.js';
import { gradeDataQuality } from '../../src/signals/quality.js';
import { SignalSchema } from '../../src/signals/schema.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

function input(list = miniObservations()): BuildSignalInput {
  const asset = miniAsset();
  const report = computeDrivers(asset, list, AS_OF);
  const engine = report.drivers ? runEngine({ asset, drivers: report.drivers, assumptions: miniAssumptions() }) : null;
  const p = latestLevel(list.filter((o) => o.metricKey === 'price_usd'), AS_OF);
  return {
    spotFallback: p ? { price: p.value, ts: p.observedAt } : null,
    signalId: 'mini-test-1', asset, generatedAt: AS_OF, report, engine,
    blockedReasons: engine ? [] : report.missing.map((m) => `missing_metric:${m}`),
    change: { prev_signal_id: null, target_delta_pct: null, cause: 'none', rationale: '' },
    provenance: { run_id: 1, snapshot_id: 1, assumption_set_version: 1, engine_version: '1.0.0', config_hash: 'abc' },
  };
}

describe('gradeDataQuality', () => {
  const asset = miniAsset();
  it('grades A for fresh on-chain data', () => {
    expect(gradeDataQuality(computeDrivers(asset, miniObservations(), AS_OF))).toBe('A');
  });
  it('grades B when a manual metric is used', () => {
    const list = [...miniObservations(), obs('staked_supply', 50, '2026-06-29T12:00:00Z', { source: 'manual' })];
    expect(gradeDataQuality(computeDrivers(asset, list, AS_OF))).toBe('B');
  });
  it('grades C for provisional data', () => {
    const list = [...miniObservations(), obs('revenue_run_rate_usd', 1000, '2026-06-20', { status: 'provisional' })];
    expect(gradeDataQuality(computeDrivers(asset, list, AS_OF))).toBe('C');
  });
  it('grades D when a critical metric is stale', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd');
    list.push(obs('price_usd', 10, '2026-06-01'));
    expect(gradeDataQuality(computeDrivers(asset, list, AS_OF))).toBe('D');
  });
});

describe('buildSignal', () => {
  it('builds a schema-valid ok signal', () => {
    const s = buildSignal(input());
    expect(SignalSchema.safeParse(s).success).toBe(true);
    expect(s.status).toBe('ok');
    expect(s.schema_version).toBe(1);
    expect(s.horizons!['12m'].expected_target).toBeCloseTo(10, 6);
    expect(s.horizons!['12m'].scenarios.base.probability).toBe(0.5);
    expect(s.horizons!['12m'].modules.hc.breakdown.by_scenario).toEqual({ bear: expect.any(Number), base: expect.any(Number), bull: expect.any(Number) });
    expect(s.horizons!['12m'].modules.hc.breakdown.breakdown_scenario).toBe('base');
    expect(s.data_quality.grade).toBe('A');
    expect(s.spot).toEqual({ price: 10, ts: '2026-06-29T00:00:00.000Z' });
  });

  it('emits a blocked signal without horizons when a driver is missing', () => {
    const s = buildSignal(input(miniObservations().filter((o) => o.metricKey !== 'effective_supply')));
    expect(s.status).toBe('blocked');
    expect(s.horizons).toBeUndefined();
    expect(s.status_reasons).toEqual(['missing_metric:effective_supply']);
    expect(s.spot).not.toBeNull();
  });

  it('degrades when a critical metric is stale', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd');
    list.push(obs('price_usd', 10, '2026-06-01'));
    const s = buildSignal(input(list));
    expect(s.status).toBe('degraded');
    expect(s.status_reasons).toContain('stale_critical:price_usd');
    expect(s.horizons).toBeDefined();
  });
});

describe('emitSignal', () => {
  it('writes one JSON line and appends to the JSONL file', () => {
    const lines: string[] = [];
    const out = join(mkdtempSync(join(tmpdir(), 'orion-')), 'signals.jsonl');
    const s = buildSignal(input());
    emitSignal(s, { write: (l) => lines.push(l), outFile: out });
    emitSignal(s, { write: (l) => lines.push(l), outFile: out });
    expect(JSON.parse(lines[0]).signal_id).toBe('mini-test-1');
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('buildSignal with open anomalies', () => {
  const degrading = { id: 7, kind: 'cross_check_mismatch', metricKey: 'price_usd', severity: 'degrading' as const };

  it('reports no anomalies by default', () => {
    const s = buildSignal(input());
    expect(s.data_quality.open_anomalies).toBe(0);
    expect(s.data_quality.anomalies).toEqual([]);
  });

  it('degrades to grade D for an open degrading anomaly on a critical metric', () => {
    const s = buildSignal({ ...input(), openAnomalies: [degrading] });
    expect(s.status).toBe('degraded');
    expect(s.status_reasons).toEqual(['open_anomaly:cross_check_mismatch:price_usd']);
    expect(s.data_quality).toMatchObject({ grade: 'D', open_anomalies: 1, anomalies: [{ id: 7, kind: 'cross_check_mismatch', metric: 'price_usd', severity: 'degrading' }] });
    expect(s.horizons).toBeDefined();
    expect(SignalSchema.safeParse(s).success).toBe(true);
  });

  it('lists advisory anomalies, and degrading ones on non-critical metrics, without changing grade or status', () => {
    const s = buildSignal({
      ...input(),
      openAnomalies: [
        { id: 1, kind: 'revenue_disclosure_stale', metricKey: 'revenue_run_rate_usd', severity: 'advisory' },
        { id: 2, kind: 'cross_check_mismatch', metricKey: 'staked_supply', severity: 'degrading' }, // staked_supply is not critical
        { id: 3, kind: 'source_failure_streak', metricKey: '', severity: 'advisory' },
      ],
    });
    expect(s.status).toBe('ok');
    expect(s.data_quality.grade).toBe('A');
    expect(s.data_quality.open_anomalies).toBe(3);
    expect(s.data_quality.anomalies.map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it('keeps a blocked signal blocked with its own reasons, and still reports the anomalies', () => {
    const s = buildSignal({ ...input(miniObservations().filter((o) => o.metricKey !== 'effective_supply')), openAnomalies: [degrading] });
    expect(s.status).toBe('blocked');
    expect(s.status_reasons).toEqual(['missing_metric:effective_supply']);
    expect(s.data_quality.grade).toBe('D');
    expect(s.data_quality.open_anomalies).toBe(1);
  });
});
