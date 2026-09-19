import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listAnomalies } from '../../src/db/anomalies.js';
import type { Db } from '../../src/db/connection.js';
import { listFetchRuns } from '../../src/db/fetchRuns.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset, validateReading, type FetchResult } from '../../src/ingest/run.js';
import type { OrionError } from '../../src/types.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { CG_MARKETS, GENESIS_TS, harness, LATEST, NOW, STATS } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

const source = (r: FetchResult, id: string) => {
  const s = r.sources.find((x) => x.sourceId === id);
  if (!s) throw new Error(`no source outcome for ${id}; have ${r.sources.map((x) => x.sourceId).join(', ')}`);
  return s;
};
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const STATS_ID = `http_json:${STATS}`;

describe('validateReading', () => {
  const def = (type: 'level' | 'flow' | 'schedule', unit: string) => parseAssetYaml(INGEST_ASSET_YAML).config.metrics[type === 'level' ? (unit === 'ratio' ? 'staker_emission_share' : 'price_usd') : type === 'flow' ? 'flow_usd.fees' : 'emission_rate_annual'];
  it('refuses non-finite values, non-positive levels, ratios outside 0..1, and negative flows or schedules', () => {
    expect(validateReading(def('level', 'usd'), 10)).toBeNull();
    expect(validateReading(def('level', 'usd'), 0)).toMatch(/not positive/);
    expect(validateReading(def('level', 'usd'), NaN)).toMatch(/finite/);
    expect(validateReading(def('level', 'ratio'), 0)).toBeNull();
    expect(validateReading(def('level', 'ratio'), 1.2)).toMatch(/outside/);
    expect(validateReading(def('schedule', 'x'), 0)).toBeNull();
    expect(validateReading(def('flow', 'x'), -1)).toMatch(/negative/);
  });
});

describe('fetchAsset: levels', () => {
  it('writes every primary with the source own timestamp, and logs the run', async () => {
    const h = harness();
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);

    const obs = Object.fromEntries(listActiveObservations(h.db, 'mini').map((o) => [o.metricKey, o]));
    expect(obs.price_usd).toMatchObject({ value: 10, source: 'api', observedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), status: 'confirmed' });
    expect(obs.circulating_supply.value).toBe(60);
    const blockTime = new Date((GENESIS_TS + Number(LATEST) * 2) * 1000).toISOString();
    expect(obs.effective_supply).toMatchObject({ value: 100, source: 'onchain', observedAt: blockTime, sourceDetail: `block ${LATEST}` });
    expect(obs.staked_supply.value).toBe(50);
    expect(obs.emission_rate_annual.value).toBe(0);
    expect(h.rpc.stats.multicall).toBeGreaterThanOrEqual(1);

    expect(source(r, 'coingecko')).toMatchObject({ status: 'ok', metricsWritten: ['price_usd', 'circulating_supply'] });
    expect(source(r, 'chain_levels').metricsWritten).toEqual(['effective_supply', 'staked_supply', 'emission_rate_annual']);
    expect(source(r, STATS_ID).crossChecks).toEqual([
      { metricKey: 'price_usd', sourceId: STATS_ID, label: 'level', primary: 10, check: 10.1, diffPct: expect.closeTo(1, 9), tolerancePct: 2, ok: true },
      { metricKey: 'effective_supply', sourceId: STATS_ID, label: 'level', primary: 100, check: 100, diffPct: 0, tolerancePct: 0.1, ok: true },
    ]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    expect(r.startedAt).toBe(NOW.toISOString());
    expect(r.endedAt).toBe(new Date(NOW.getTime() + 5000).toISOString());

    const [logged] = listFetchRuns(h.db, 'mini', 5);
    expect(logged.id).toBe(r.fetchRunId);
    expect(logged.outcome).toBe('ok');
    expect(logged.detail.sources).toEqual(r.sources);
  });

  it('never stores a cross-check reading as an observation', async () => {
    const h = harness();
    await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(listActiveObservations(h.db, 'mini', 'price_usd').map((o) => o.value)).toEqual([10]);
  });

  it('raises a degrading anomaly for a mismatch on a critical metric, and counts repeats', async () => {
    const h = harness({ routes: { [STATS]: { price: 11, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({ kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: STATS_ID, severity: 'degrading' });
    expect(r.anomalies[0].detail).toMatchObject({ primary: 10, check: 11, tolerance_pct: 2, primary_source: 'coingecko', check_source: STATS_ID });
    expect(listActiveObservations(h.db, 'mini', 'price_usd')[0].value).toBe(10); // the primary value is still stored

    await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + 86_400_000), h.deps);
    const [open] = listAnomalies(h.db, { assetId: 'mini' });
    expect(open.occurrences).toBe(2);
    expect(open.id).toBe(r.anomalies[0].id);
  });

  it('raises an advisory anomaly when the metric is not critical', async () => {
    const loaded = parseAssetYaml(INGEST_ASSET_YAML.replace('    staleness_days: 3\n    critical: true\n', '    staleness_days: 3\n'));
    const h = harness({ loaded, routes: { [STATS]: { price: 11, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    expect((await fetchAsset(h.db, h.loaded, NOW, h.deps)).anomalies[0].severity).toBe('advisory');
  });

  it('lets one source fail without touching the others', async () => {
    const h = harness({ routes: { [CG_MARKETS]: new Error('HTTP 429') } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, 'coingecko')).toMatchObject({ status: 'failed', metricsWritten: [] });
    expect(source(r, 'coingecko').error).toMatch(/price_usd: HTTP 429/);
    expect(source(r, 'chain_levels').status).toBe('ok');
    expect(listActiveObservations(h.db, 'mini', 'price_usd')).toEqual([]);
    expect(listActiveObservations(h.db, 'mini', 'effective_supply')).toHaveLength(1);
    expect(source(r, STATS_ID).notes).toContain('price_usd: cross-check skipped, the primary source gave no reading this run');
    expect(r.outcome).toBe('partial');
    expect(r.anomalies).toEqual([]);
  });

  it('treats an implausible reading as a source failure, never as an observation', async () => {
    const h = harness({ routes: { [CG_MARKETS]: [{ id: 'mini-token', current_price: 0, circulating_supply: 60 }] } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, 'coingecko')).toMatchObject({ status: 'failed', metricsWritten: ['circulating_supply'] });
    expect(source(r, 'coingecko').error).toMatch(/price_usd: 0 is not positive/);
    expect(listActiveObservations(h.db, 'mini', 'price_usd')).toEqual([]);
  });

  it('treats an implausible cross-check reading as a source failure, not as a mismatch', async () => {
    const h = harness({ routes: { [STATS]: { price: '0', supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, STATS_ID).status).toBe('failed');
    expect(source(r, STATS_ID).error).toMatch(/price_usd: 0 is not positive/);
    expect(r.anomalies).toEqual([]);
  });

  it('fails every chain source, and only those, when the latest block cannot be read', async () => {
    const h = harness();
    h.rpc.latestBlock = async () => {
      throw new Error('connection refused');
    };
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, 'chain_levels').error).toMatch(/could not read the latest block: connection refused/);
    expect(source(r, 'coingecko').status).toBe('ok');
  });

  it('raises an advisory streak anomaly on the third consecutive failure of one source', async () => {
    const h = harness({ routes: { [CG_MARKETS]: new Error('HTTP 429') } });
    for (const day of [0, 1]) expect((await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + day * 86_400_000), h.deps)).anomalies).toEqual([]);
    const third = await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + 2 * 86_400_000), h.deps);
    expect(third.anomalies).toHaveLength(1);
    expect(third.anomalies[0]).toMatchObject({ kind: 'source_failure_streak', metricKey: '', dedupeKey: 'coingecko', severity: 'advisory' });
  });

  it('narrows to the requested metrics', async () => {
    const h = harness();
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['price_usd'] });
    expect(r.sources.map((s) => s.sourceId)).toEqual(['coingecko', STATS_ID]);
    expect(r.written.map((w) => w.metricKey)).toEqual(['price_usd']);
  });

  it('writes nothing at all on a dry run, and still reports what it would do', async () => {
    const h = harness({ routes: { [STATS]: { price: 11, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true });
    for (const table of ['observations', 'fetch_runs', 'anomalies', 'fetch_cursors']) expect(count(h.db, table)).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(r.fetchRunId).toBeNull();
    expect(r.written.find((w) => w.metricKey === 'price_usd')).toMatchObject({ value: 10, observationId: null });
    expect(r.anomalies[0]).toMatchObject({ id: null, kind: 'cross_check_mismatch' });
  });

  it('throws only for configuration errors', async () => {
    const codeOf = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e as OrionError).code);
    const plain = harness({ loaded: parseAssetYaml(MINI_ASSET_YAML) });
    expect(await codeOf(fetchAsset(plain.db, plain.loaded, NOW, plain.deps))).toBe('no_sources');
    const otherChain = harness({ loaded: parseAssetYaml(INGEST_ASSET_YAML.replace('chain_id: 8453', 'chain_id: 1')), env: {} });
    expect(await codeOf(fetchAsset(otherChain.db, otherChain.loaded, NOW, otherChain.deps))).toBe('missing_rpc_url');
    const fallback = harness({ env: {} }); // Base has a default public RPC URL
    expect((await fetchAsset(fallback.db, fallback.loaded, NOW, fallback.deps)).outcome).toBe('ok');
  });
});
