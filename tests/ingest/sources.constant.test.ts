import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { constantSource } from '../../src/ingest/sources/constant.js';
import { obs } from '../helpers/obs.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { req, sourceCtx } from '../helpers/sourceCtx.js';

const SHARE = 'staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }';
const WITH_CONSTANT = INGEST_ASSET_YAML.replace(
  SHARE,
  'staker_emission_share: { type: level, unit: ratio, staleness_days: 7, source: { type: constant, value: 0, note: "all emissions go to LP gauges" } }',
);

describe('the constant source', () => {
  it('returns its value stamped at the fetch time, from the api, with the note as detail', async () => {
    const ctx = sourceCtx();
    const [r] = await constantSource.fetch([req('staker_emission_share', { type: 'constant', value: 0, note: 'all emissions go to LP gauges' })], ctx);
    expect(r).toEqual({ ok: true, value: { kind: 'level', value: 0, observedAt: ctx.nowIso, source: 'api', detail: 'constant: all emissions go to LP gauges' } });
  });

  it('is planned without the chain and batched under one id', () => {
    const loaded = parseAssetYaml(WITH_CONSTANT);
    const plan = buildPlan(loaded.config, { metrics: ['staker_emission_share'] });
    expect(plan.batches).toEqual([{ sourceId: 'constant', requests: [expect.objectContaining({ metricKey: 'staker_emission_share', role: 'primary' })] }]);
    expect(plan.needsRpc).toBe(false);
  });

  it('is written on every run, and its provenance is not manual, so it never caps the grade', async () => {
    const loaded = parseAssetYaml(WITH_CONSTANT);
    const h = harness({ loaded });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(r.sources.find((s) => s.sourceId === 'constant')).toMatchObject({ status: 'ok', metricsWritten: ['staker_emission_share'] });
    const rows = listActiveObservations(h.db, 'mini', 'staker_emission_share');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 0, source: 'api', sourceDetail: 'constant: all emissions go to LP gauges', observedAt: NOW.toISOString() });

    const report = computeDrivers(loaded.config, [rows[0], obs('price_usd', 10, NOW.toISOString())], NOW.toISOString());
    expect(report.manualMetrics).not.toContain('staker_emission_share');
  });
});
