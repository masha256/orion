import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { getAdapter, registerAdapter, type AdapterDef } from '../../src/ingest/adapters/registry.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { harness } from '../helpers/fetchHarness.js';
import { useTestDb } from '../helpers/db.js';

/**
 * Since 0006 a row's origin is derived from its provenance (`originOf`), so a reading whose own stamp would read back
 * differently must not be stored (Task 10): it fails that reading, `origin_mismatch`, and writes nothing.
 */
const testDb = useTestDb();
const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
const YAML = FIXTURE.replace(
  '  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }',
  '  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true, source: { type: adapter, name: hype.total_supply, params: {} } }',
);
const LLAMA_HYPE = 'https://api.llama.fi/summary/fees/hyperliquid';

const original: AdapterDef = getAdapter('hype.total_supply');
afterEach(() => registerAdapter(original));

const stamping = (source: 'onchain' | 'api'): AdapterDef => ({
  ...original,
  run: async (ctx) => ({ kind: 'level', value: 1000, observedAt: ctx.nowIso, source, detail: 'test' }),
});

describe('fetchAsset: the origin guard', () => {
  it('stores a reading whose stamp matches what its provenance reads back as (hype.total_supply: api)', async () => {
    expect(YAML).not.toBe(FIXTURE);
    registerAdapter(stamping('api'));
    const h = harness(testDb(), { loaded: parseAssetYaml(YAML), routes: { [LLAMA_HYPE]: { totalDataChart: [] } } });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { metrics: ['total_supply'] });
    expect(r.written).toEqual([expect.objectContaining({ metricKey: 'total_supply', value: 1000, source: 'api' })]);
    expect((await listActiveObservations(h.db, 'hype', 'total_supply')).map((o) => o.source)).toEqual(['api']);
  });

  it('refuses a reading whose stamp its provenance would read back differently, and writes nothing', async () => {
    registerAdapter(stamping('onchain'));
    const h = harness(testDb(), { loaded: parseAssetYaml(YAML), routes: { [LLAMA_HYPE]: { totalDataChart: [] } } });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { metrics: ['total_supply'] });
    expect(r.written).toEqual([]);
    const s = r.sources.find((x) => x.sourceId.includes('hype.total_supply'))!;
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/total_supply: origin_mismatch: the reading is onchain but its provenance \(measured, first_party_api\) reads back as api/);
    expect(await listActiveObservations(h.db, 'hype', 'total_supply')).toEqual([]);
  });

  // Task 11 (ruling R11.3, the Task 10 re-review): the schedule-steps path has the same guard (src/ingest/run.ts).
  it('refuses schedule steps stamped onchain on a first_party_api rung (origin_mismatch), and writes no step', async () => {
    const yaml = FIXTURE.replace(
      '  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }',
      '  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400, source: { type: adapter, name: hype.total_supply, params: {} } }',
    );
    expect(yaml).not.toBe(FIXTURE);
    registerAdapter({
      ...original,
      run: async (ctx) => ({
        kind: 'schedule_steps', source: 'onchain', detail: 'test',
        steps: [{ observedAt: ctx.nowIso, value: 0 }, { observedAt: '2027-01-01T00:00:00.000Z', value: 5 }],
      }),
    });
    const h = harness(testDb(), { loaded: parseAssetYaml(yaml), routes: { [LLAMA_HYPE]: { totalDataChart: [] } } });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { metrics: ['emission_rate_annual'] });
    expect(r.written).toEqual([]);
    const s = r.sources.find((x) => x.sourceId.includes('hype.total_supply'))!;
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/emission_rate_annual: origin_mismatch: the reading is onchain but its provenance \(measured, first_party_api\) reads back as api/);
    expect(await listActiveObservations(h.db, 'hype', 'emission_rate_annual')).toEqual([]);
  });
});
