import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { raiseAnomaly } from '../../src/db/anomalies.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { exportFileName, PRICES_RUN_LOCK, purgeMetrics, purgePrices } from '../../src/db/purge.js';
import { listPrices, upsertPrices, upsertToken } from '../../src/db/prices.js';
import { repriceAsset } from '../../src/db/reprice.js';
import { PRICES_LOCK } from '../../src/daemon/jobs/backfill.js';
import { startAgentRun } from '../../src/db/agentRuns.js';
import type { Provenance } from '../../src/provenance/types.js';
import type { SourceType } from '../../src/report/sourceTypes.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const NOW = new Date('2026-11-12T12:00:00.000Z');

/**
 * Ruling R2: a synthetic asset whose configured metric `unlocks_next_year` sits on a NON-third-party source (a
 * `constant`), so asking to purge its current rung exercises `purge_live_source`. `flow_usd.fees` is entered by hand
 * (disclosure); `flow_usd.llama_fees` is not configured at all (an orphan: its source was removed from the YAML).
 */
const PURGE_ASSET_YAML = `
id: purg
symbol: PURG
name: Purge Test Asset
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  unlocks_next_year:
    type: level
    unit: tokens
    staleness_days: 30
    source: { type: constant, value: 1000, note: "test fixture: a non-third-party current source" }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45 }
`;

const loaded = (): LoadedAsset => {
  const { config, hash } = parseAssetYaml(PURGE_ASSET_YAML);
  return { config, hash };
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'orion-purge-'));
  dirs.push(d);
  return d;
}

function prov(sourceType: SourceType): Provenance {
  const method = sourceType === 'disclosure' || sourceType === 'constant' ? 'disclosed' : sourceType === 'derived' ? 'derived' : 'measured';
  return { method, sourceType, chain: null, locator: { test: sourceType }, ...(method === 'derived' ? { formula: 'test@1' } : {}), codeVersion: 'test', configHash: 'test' };
}

async function seed(d: Db, metricKey: string, sourceType: SourceType, observedAt: string, value: number, assetId = 'purg'): Promise<number> {
  const flow = metricKey.startsWith('flow_');
  const o = await insertObservation(d, {
    assetId, metricKey, observedAt, value, periodDays: flow ? 1 : null, fetchedAt: observedAt,
    citationUrl: sourceType === 'disclosure' ? 'https://example.test/cite' : null,
    provenance: prov(sourceType),
  });
  return o.id;
}

async function seedSide(d: Db, metricKey: string, assetId = 'purg'): Promise<void> {
  await d.run(
    `INSERT INTO latest_levels (asset_id, metric_key, value, observed_at, source, source_type, locator) VALUES ($1, $2, 1, $3, 'api', 'third_party', '{}'::jsonb)`,
    [assetId, metricKey, NOW.toISOString()],
  );
  await d.run(`INSERT INTO watch_state (asset_id, metric_key, rule, firing, since, last_value) VALUES ($1, $2, 'change_pct:5', false, $3, 1)`, [assetId, metricKey, NOW.toISOString()]);
}

async function seedCursor(d: Db, scanKey: string, assetId = 'purg'): Promise<void> {
  await d.run(`INSERT INTO fetch_cursors (asset_id, scan_key, last_block, last_day, updated_at) VALUES ($1, $2, 0, '2026-11-10', $3)`, [assetId, scanKey, NOW.toISOString()]);
}

/** Row counts of every table the purge touches, for "nothing written" assertions. */
async function counts(d: Db): Promise<Record<string, number>> {
  const n = async (sql: string) => Number((await d.one<{ n: number }>(sql))!.n);
  return {
    observations: await n('SELECT count(*)::bigint AS n FROM observations'),
    superseded: await n('SELECT count(*)::bigint AS n FROM observations WHERE superseded_by IS NOT NULL'),
    latestLevels: await n('SELECT count(*)::bigint AS n FROM latest_levels'),
    watchState: await n('SELECT count(*)::bigint AS n FROM watch_state'),
    fetchCursors: await n('SELECT count(*)::bigint AS n FROM fetch_cursors'),
  };
}

/** The orphan `flow_usd.llama_fees`: three third-party days, one of them superseded by a later read of the same day. */
async function seedOrphan(d: Db): Promise<void> {
  await seed(d, 'flow_usd.llama_fees', 'third_party', '2026-10-01T00:00:00Z', 10);
  await seed(d, 'flow_usd.llama_fees', 'third_party', '2026-10-02T00:00:00Z', 20);
  await seed(d, 'flow_usd.llama_fees', 'third_party', '2026-10-02T00:00:00Z', 21); // supersedes the 20
  await seedSide(d, 'flow_usd.llama_fees');
  await seedCursor(d, 'defillama:purg:fees>flow_usd.llama_fees'); // an API flow's own cursor: names the metric
  await seedCursor(d, '0123456789abcdef'); // a transfer scan's cursor (sha256 of token|sink|allowlist): shared, never named
  // Another asset's row of the same key, and a kept metric of this asset: neither may be touched.
  await seed(d, 'flow_usd.llama_fees', 'third_party', '2026-10-01T00:00:00Z', 99, 'other');
  await seed(d, 'price_usd', 'market_data', '2026-10-01T00:00:00Z', 1.5);
}

const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return 'no error';
};

describe('purgeMetrics', () => {
  it('dry run counts and writes nothing', async () => {
    await seedOrphan(db());
    const before = await counts(db());
    const exportDir = join(scratch(), 'purged');
    const r = await purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: false, exportDir, now: NOW });
    expect(r).toEqual({
      asset: 'purg',
      perMetric: [{
        metric: 'flow_usd.llama_fees', configured: false, observations: 3, superseded: 1, firstDay: '2026-10-01', lastDay: '2026-10-02',
        valueSum: 51, latestLevels: 1, watchState: 1, fetchCursors: 1,
      }],
      exportFile: null,
      exportSha256: null,
      applied: false,
    });
    expect(await counts(db())).toEqual(before);
    expect(() => readdirSync(exportDir)).toThrow(); // not even created
  });

  it('orphan metric: deletes observations, latest_levels, watch_state and the fetch_cursors whose scan_key names it', async () => {
    await seedOrphan(db());
    const exportDir = join(scratch(), 'purged');
    const r = await purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: NOW });
    expect(r.applied).toBe(true);
    expect(r.perMetric[0]).toMatchObject({ observations: 3, latestLevels: 1, watchState: 1, fetchCursors: 1 });
    const left = await db().all<{ asset_id: string; metric_key: string }>('SELECT asset_id, metric_key FROM observations ORDER BY id');
    expect(left).toEqual([{ asset_id: 'other', metric_key: 'flow_usd.llama_fees' }, { asset_id: 'purg', metric_key: 'price_usd' }]);
    expect(await db().all('SELECT * FROM latest_levels')).toEqual([]);
    expect(await db().all('SELECT * FROM watch_state')).toEqual([]);
    // The shared transfer-scan cursor stays: its key is a hash over the scan, never one metric's.
    expect((await db().all<{ scan_key: string }>('SELECT scan_key FROM fetch_cursors')).map((c) => c.scan_key)).toEqual(['0123456789abcdef']);
  });

  it('configured metric needs --source-type: without it, purge_configured_metric', async () => {
    await seed(db(), 'unlocks_next_year', 'third_party', '2026-10-01T00:00:00Z', 5);
    const before = await counts(db());
    const exportDir = join(scratch(), 'purged');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], apply: true, exportDir, now: NOW }))).toBe('purge_configured_metric');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], apply: false, exportDir, now: NOW }))).toBe('purge_configured_metric');
    expect(await counts(db())).toEqual(before);
    expect(() => readdirSync(exportDir)).toThrow();
  });

  it("refuses the current source's type: unlocks_next_year on a constant with --source-type constant gives purge_live_source", async () => {
    await seed(db(), 'unlocks_next_year', 'constant', '2026-10-01T00:00:00Z', 1000);
    await seed(db(), 'flow_usd.fees', 'disclosure', '2026-10-01T00:00:00Z', 7);
    const before = await counts(db());
    const exportDir = join(scratch(), 'purged');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], sourceType: 'constant', apply: true, exportDir, now: NOW }))).toBe('purge_live_source');
    // A metric with no source is entered by hand: its live rung is disclosure.
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['flow_usd.fees'], sourceType: 'disclosure', apply: true, exportDir, now: NOW }))).toBe('purge_live_source');
    // One refused metric refuses the whole request: the orphan beside it is not deleted either.
    await seedOrphan(db());
    const withOrphan = await counts(db());
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees', 'unlocks_next_year'], sourceType: 'constant', apply: true, exportDir, now: NOW })))
      .toBe('purge_live_source');
    expect(await counts(db())).toEqual(withOrphan);
    expect(before.observations).toBeLessThan(withOrphan.observations);
    expect(() => readdirSync(exportDir)).toThrow();
  });

  it('configured metric + third_party: deletes only the third_party rows, keeps the others, leaves latest_levels/watch_state alone', async () => {
    const tp1 = await seed(db(), 'unlocks_next_year', 'third_party', '2026-09-01T00:00:00Z', 100);
    // Superseded by the disclosure read of the same day below (kept row): the deleted row may point at a kept one.
    const tp2 = await seed(db(), 'unlocks_next_year', 'third_party', '2026-09-02T00:00:00Z', 200);
    const keepDisc = await seed(db(), 'unlocks_next_year', 'disclosure', '2026-09-02T00:00:00Z', 210);
    const keepConst = await seed(db(), 'unlocks_next_year', 'constant', '2026-10-01T00:00:00Z', 1000);
    await seedSide(db(), 'unlocks_next_year');
    await seedCursor(db(), 'constant>unlocks_next_year');
    const r = await purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], sourceType: 'third_party', apply: true, exportDir: join(scratch(), 'purged'), now: NOW });
    expect(r.perMetric).toEqual([{
      metric: 'unlocks_next_year', configured: true, observations: 2, superseded: 1, firstDay: '2026-09-01', lastDay: '2026-09-02',
      valueSum: 300, latestLevels: 0, watchState: 0, fetchCursors: 0,
    }]);
    const left = await db().all<{ id: number; source_type: string; superseded_by: number | null }>('SELECT id, source_type, superseded_by FROM observations ORDER BY id');
    expect(left).toEqual([{ id: keepDisc, source_type: 'disclosure', superseded_by: null }, { id: keepConst, source_type: 'constant', superseded_by: null }]);
    expect(left.map((o) => o.id)).not.toContain(tp1);
    expect(left.map((o) => o.id)).not.toContain(tp2);
    expect(await counts(db())).toMatchObject({ latestLevels: 1, watchState: 1, fetchCursors: 1 });
  });

  it('open anomaly on the metric: purge_open_anomaly', async () => {
    await seedOrphan(db());
    await raiseAnomaly(db(), {
      assetId: 'purg', kind: 'cross_check_mismatch', metricKey: 'flow_usd.llama_fees', dedupeKey: 'x', severity: 'advisory', detail: {}, seenAt: NOW.toISOString(),
    });
    const before = await counts(db());
    const exportDir = join(scratch(), 'purged');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: NOW }))).toBe('purge_open_anomaly');
    expect(await counts(db())).toEqual(before);
    expect(() => readdirSync(exportDir)).toThrow();
    // Once decided, it no longer blocks.
    await db().run("UPDATE anomalies SET status = 'resolved'");
    expect((await purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: NOW })).applied).toBe(true);
  });

  it('a kept row references a deleted row: purge_dangling_reference, rolled back', async () => {
    // The disclosure row (kept) is superseded by a later third-party read of the same day (deleted).
    await seed(db(), 'unlocks_next_year', 'disclosure', '2026-09-02T00:00:00Z', 210);
    await seed(db(), 'unlocks_next_year', 'third_party', '2026-09-02T00:00:00Z', 200);
    await seed(db(), 'unlocks_next_year', 'third_party', '2026-09-03T00:00:00Z', 300);
    const before = await counts(db());
    const snapshot = await db().all('SELECT id, superseded_by FROM observations ORDER BY id');
    const exportDir = join(scratch(), 'purged');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], sourceType: 'third_party', apply: true, exportDir, now: NOW }))).toBe('purge_dangling_reference');
    expect(await counts(db())).toEqual(before);
    expect(await db().all('SELECT id, superseded_by FROM observations ORDER BY id')).toEqual(snapshot);
    expect(() => readdirSync(exportDir)).toThrow();
    // The dry run reports the same refusal: it would not get further either.
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], sourceType: 'third_party', apply: false, exportDir, now: NOW }))).toBe('purge_dangling_reference');
  });

  it('apply writes the export first: one JSON file with every deleted row (all columns), its sha256; mode 700/600', async () => {
    await seedOrphan(db());
    const allCols = await db().all<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(o) AS row FROM observations o WHERE asset_id = 'purg' AND metric_key = 'flow_usd.llama_fees' ORDER BY id",
    );
    const exportDir = join(scratch(), 'purged');
    const r = await purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: NOW });
    expect(readdirSync(exportDir)).toEqual(['purg-flow_usd.llama_fees-20261112T120000Z.json']);
    expect(r.exportFile).toBe(join(exportDir, 'purg-flow_usd.llama_fees-20261112T120000Z.json'));
    const bytes = readFileSync(r.exportFile!);
    expect(r.exportSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(statSync(exportDir).mode & 0o777).toBe(0o700);
    expect(statSync(r.exportFile!).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(doc).toMatchObject({ asset: 'purg', metrics: ['flow_usd.llama_fees'], sourceType: null, createdAt: NOW.toISOString() });
    // Every column of every deleted row, as Postgres renders it (superseded_by as it was before the purge cleared it).
    expect(doc.observations).toEqual(allCols.map((c) => c.row));
    expect(Object.keys(doc.observations[0])).toEqual(expect.arrayContaining(['id', 'method', 'source_type', 'locator', 'superseded_by', 'hourly_amounts', 'config_hash']));
    expect(doc.observations.filter((o: { superseded_by: number | null }) => o.superseded_by !== null)).toHaveLength(1);
    expect(doc.latestLevels).toHaveLength(1);
    expect(doc.watchState).toHaveLength(1);
    expect(doc.fetchCursors.map((c: { scan_key: string }) => c.scan_key)).toEqual(['defillama:purg:fees>flow_usd.llama_fees']);
  });

  it("apply: if the export can't be written, nothing is deleted", async () => {
    await seedOrphan(db());
    const before = await counts(db());
    const blocker = join(scratch(), 'not-a-dir');
    writeFileSync(blocker, 'x');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir: join(blocker, 'purged'), now: NOW }))).toBe('purge_export_failed');
    expect(await counts(db())).toEqual(before);
  });

  it('apply fsyncs the export directory, and its parent when the purge created it; a failed directory fsync is purge_export_failed, nothing deleted', async () => {
    await seedOrphan(db());
    const home = scratch();
    const exportDir = join(home, 'purged');
    const synced: string[] = [];
    const r = await purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: NOW, syncDir: (d) => synced.push(d) });
    expect(r.applied).toBe(true);
    // First purge: purged/ was just created, so $ORION_HOME's entry for it is synced too.
    expect(synced).toEqual([exportDir, home]);
    // Later purges: the directory exists, only it is synced (the new file's entry).
    await seed(db(), 'flow_usd.llama_fees', 'third_party', '2026-10-03T00:00:00Z', 30);
    synced.length = 0;
    await purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: new Date('2026-11-12T13:00:00.000Z'), syncDir: (d) => synced.push(d) });
    expect(synced).toEqual([exportDir]);
    // A directory fsync that fails refuses before any delete.
    await seed(db(), 'flow_usd.llama_fees', 'third_party', '2026-10-04T00:00:00Z', 40);
    const before = await counts(db());
    const failing = (): void => {
      throw new Error('EIO: i/o error, fsync');
    };
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: new Date('2026-11-12T14:00:00.000Z'), syncDir: failing })))
      .toBe('purge_export_failed');
    expect(await counts(db())).toEqual(before);
  });

  it("refuses a configured metric whose current source has no known source type (live === null): purge_live_source", async () => {
    const { config, hash } = parseAssetYaml(PURGE_ASSET_YAML);
    const scripted: LoadedAsset = { config: { ...config, metrics: { ...config.metrics, legacy_level: { ...config.metrics.total_supply!, fetcher: 'scripted' } } }, hash };
    await seed(db(), 'legacy_level', 'third_party', '2026-10-01T00:00:00Z', 5);
    const before = await counts(db());
    const exportDir = join(scratch(), 'purged');
    for (const apply of [false, true]) {
      expect(await errCode(purgeMetrics(db(), scripted, { metrics: ['legacy_level'], sourceType: 'third_party', apply, exportDir, now: NOW }))).toBe('purge_live_source');
    }
    expect(await counts(db())).toEqual(before);
    expect(() => readdirSync(exportDir)).toThrow();
  });

  it('config refusals come before the run lock: same code as the dry run while another holder has the lock, and no orphaned run is abandoned', async () => {
    await seed(db(), 'unlocks_next_year', 'constant', '2026-10-01T00:00:00Z', 1000);
    const runId = await startAgentRun(db(), {
      assetId: 'purg', persona: 'analyst', runType: 'weekly', trigger: 'manual', triggerDetail: {}, dryRun: false, configHash: 'abc', model: 'm', startedAt: '2026-11-12T11:00:00.000Z',
    });
    const exportDir = join(scratch(), 'purged');
    const outcome = async (): Promise<string> => (await db().one<{ outcome: string }>('SELECT outcome FROM agent_runs WHERE id = $1', [runId]))!.outcome;
    // No other holder: a refused --yes must not take the lock (which would abandon the orphaned run).
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], apply: true, exportDir, now: NOW }))).toBe('purge_configured_metric');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], sourceType: 'constant', apply: true, exportDir, now: NOW }))).toBe('purge_live_source');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees', 'unlocks_next_year'], sourceType: 'constant', apply: true, exportDir, now: NOW }))).toBe('purge_live_source');
    expect(await outcome()).toBe('running');
    // Another holder (a refresh) has the lock: still the config code, not run_in_progress.
    const held = await db().tryAssetRunLock('purg', 'tick pid 999');
    expect(held).not.toBeNull();
    try {
      for (const apply of [false, true]) {
        expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], apply, exportDir, now: NOW }))).toBe('purge_configured_metric');
        expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['unlocks_next_year'], sourceType: 'constant', apply, exportDir, now: NOW }))).toBe('purge_live_source');
      }
    } finally {
      await held!.release();
    }
    expect(() => readdirSync(exportDir)).toThrow();
  });

  it('run_in_progress: another holder has the asset run lock, so --yes deletes nothing and writes no export', async () => {
    await seedOrphan(db());
    const before = await counts(db());
    const exportDir = join(scratch(), 'purged');
    const held = await db().tryAssetRunLock('purg', 'tick pid 999');
    expect(held).not.toBeNull();
    try {
      expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: true, exportDir, now: NOW }))).toBe('run_in_progress');
      // The dry run takes no lock: it still counts.
      expect((await purgeMetrics(db(), loaded(), { metrics: ['flow_usd.llama_fees'], apply: false, exportDir, now: NOW })).perMetric[0]!.observations).toBe(3);
    } finally {
      await held!.release();
    }
    expect(await counts(db())).toEqual(before);
    expect(() => readdirSync(exportDir)).toThrow();
  });

  it('export file name: the first metric plus +N for the rest, so a long --metric list stays a short name', async () => {
    expect(exportFileName('purg', ['flow_usd.llama_fees'], NOW)).toBe('purg-flow_usd.llama_fees-20261112T120000Z.json');
    expect(exportFileName('purg', ['flow_usd.llama_fees', 'unlocks_next_year'], NOW)).toBe('purg-flow_usd.llama_fees+1-20261112T120000Z.json');
    const many = Array.from({ length: 40 }, (_, i) => `flow_usd.retired_series_number_${i}`);
    expect(exportFileName('purg', many, NOW)).toBe('purg-flow_usd.retired_series_number_0+39-20261112T120000Z.json');
    // Applied with that list: the export is written (no ENAMETOOLONG) and the JSON names every metric.
    for (const m of many.slice(0, 3)) await seed(db(), m, 'third_party', '2026-10-01T00:00:00Z', 1);
    const exportDir = join(scratch(), 'purged');
    mkdirSync(exportDir);
    const r = await purgeMetrics(db(), loaded(), { metrics: many, apply: true, exportDir, now: NOW });
    expect(r.exportFile).toBe(join(exportDir, 'purg-flow_usd.retired_series_number_0+39-20261112T120000Z.json'));
    expect(JSON.parse(readFileSync(r.exportFile!, 'utf8')).metrics).toEqual(many);
  });

  it('refuses an empty metric list and an unknown source type', async () => {
    const exportDir = join(scratch(), 'purged');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: [], apply: false, exportDir, now: NOW }))).toBe('purge_no_metric');
    expect(await errCode(purgeMetrics(db(), loaded(), { metrics: ['x'], sourceType: 'defillama' as SourceType, apply: false, exportDir, now: NOW }))).toBe('invalid_source_type');
  });
});

describe('purgePrices', () => {
  const CRVUSD = 'eip155:1/0xf939e0a03fb07f59a73314e73794be0e57ac1b4e';
  /** A transfer-scan asset whose flows were written under CoinGecko's crvUSD id. */
  const CRV_YAML = `
id: crvp
symbol: CRVP
name: Purge Prices Test
chain: ethereum
contracts:
  crvusd: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"
  sink: "0x00000000000000000000000000000000000000b1"
  sender: "0x00000000000000000000000000000000000000b2"
ingest: { chain_id: 1, rpc_url_env: ORION_ETH_RPC_URL, backfill_days: 100 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 4, source: { type: transfer_flow, token: crvusd, to: sink, from_allowlist: [ sender ], unit: usd } }
`;
  const crv = (): LoadedAsset => {
    const { config, hash } = parseAssetYaml(CRV_YAML);
    return { config, hash };
  };

  /** CoinGecko and chain prices of crvUSD (address ref), a CoinGecko-only id ref, and one flow row under that id. */
  async function seedPrices(d: Db, withFlow = true): Promise<number | null> {
    await upsertToken(d, { tokenRef: 'coingecko:crvusd', symbol: 'crvusd', decimals: null, coingeckoId: 'crvusd' });
    await upsertToken(d, { tokenRef: 'coingecko:spare', symbol: 'spare', decimals: null, coingeckoId: 'spare' });
    await upsertToken(d, { tokenRef: CRVUSD, symbol: 'crvUSD', decimals: 18, coingeckoId: 'crvusd' });
    const hours = Array.from({ length: 24 }, (_, i) => new Date(Date.parse('2026-10-01T00:00:00Z') + i * 3_600_000).toISOString());
    await upsertPrices(d, 'coingecko:crvusd', 'coingecko', hours.map((ts) => ({ ts, priceUsd: 1.001 })), NOW.toISOString());
    await upsertPrices(d, 'coingecko:spare', 'coingecko', hours.slice(0, 2).map((ts) => ({ ts, priceUsd: 3 })), NOW.toISOString());
    await upsertPrices(d, CRVUSD, 'coingecko', hours.map((ts) => ({ ts, priceUsd: 1.002 })), NOW.toISOString());
    await upsertPrices(d, CRVUSD, 'chain:chainlink_feed', hours.map((ts) => ({ ts, priceUsd: 0.999 })), NOW.toISOString());
    if (!withFlow) return null;
    const o = await insertObservation(d, {
      assetId: 'crvp', metricKey: 'flow_usd.fees', observedAt: '2026-10-02T00:00:00.000Z', periodDays: 1, value: 100.1, fetchedAt: NOW.toISOString(),
      provenance: { method: 'measured', sourceType: 'log_scan', chain: 'eip155:1', locator: { event: 'Transfer(address,address,uint256)' }, codeVersion: 'test', configHash: 'test' },
      tokens: { tokenRef: 'coingecko:crvusd', amount: 100, hourlyAmounts: Array.from({ length: 24 }, (_, i) => (i === 3 ? 100 : 0)) },
    });
    return o.id;
  }

  const priceCount = async (d: Db, source?: string): Promise<number> =>
    Number((await d.one<{ n: number }>('SELECT count(*)::bigint AS n FROM prices WHERE $1::text IS NULL OR source = $1', [source ?? null]))!.n);

  it('takes the `job:prices` run lock the prices backfill takes (namespaced: never an asset id)', () => {
    expect(PRICES_RUN_LOCK).toBe(PRICES_LOCK);
    expect(PRICES_RUN_LOCK).toBe('job:prices');
  });

  it('refuses while an active observation still has a coingecko:* ref (dry run and --yes), and succeeds after the reprice remap', async () => {
    const d = db();
    await seedPrices(d);
    const exportDir = join(scratch(), 'purged');
    for (const yes of [false, true]) {
      expect(await errCode(purgePrices(d, { source: 'coingecko', yes, exportDir, now: NOW }))).toBe('purge_prices_coingecko_refs');
    }
    expect(await priceCount(d)).toBe(24 + 2 + 24 + 24);
    expect(() => readdirSync(exportDir)).toThrow();

    // The reprice remaps the flow's ref to the crvUSD address (and prices it there): nothing references coingecko:* now.
    await repriceAsset(d, crv(), { yes: true, now: NOW, exportDir: join(scratch(), 'repriced') });
    const dry = await purgePrices(d, { source: 'coingecko', yes: false, exportDir, now: NOW });
    expect(dry).toMatchObject({
      source: 'coingecko', applied: false, exportFile: null, deletedTokens: ['coingecko:crvusd', 'coingecko:spare'], keptTokens: [],
      prices: [
        { tokenRef: 'coingecko:crvusd', rows: 24, firstTs: '2026-10-01T00:00:00.000Z', lastTs: '2026-10-01T23:00:00.000Z' },
        { tokenRef: 'coingecko:spare', rows: 2, firstTs: '2026-10-01T00:00:00.000Z', lastTs: '2026-10-01T01:00:00.000Z' },
        { tokenRef: CRVUSD, rows: 24, firstTs: '2026-10-01T00:00:00.000Z', lastTs: '2026-10-01T23:00:00.000Z' },
      ],
    });
    expect(await priceCount(d)).toBe(74);

    const before = (await d.all<{ row: unknown }>("SELECT to_jsonb(p) AS row FROM prices p WHERE source = 'coingecko' ORDER BY token_ref, ts")).map((r) => r.row);
    const tokensBefore = (await d.all<{ row: unknown }>("SELECT to_jsonb(t) AS row FROM tokens t WHERE token_ref LIKE 'coingecko:%' ORDER BY token_ref")).map((r) => r.row);
    const r = await purgePrices(d, { source: 'coingecko', yes: true, exportDir, now: NOW });
    expect(r.applied).toBe(true);
    expect(r.exportFile).toBe(join(exportDir, 'prices-coingecko-20261112T120000Z.json'));
    const bytes = readFileSync(r.exportFile!);
    expect(r.exportSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(statSync(r.exportFile!).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(doc.prices).toEqual(before);
    expect(doc.tokens).toEqual(tokensBefore);
    // Only the chain rows are left; the coingecko:* tokens rows nothing references are gone, the address ref stays.
    expect(await priceCount(d, 'coingecko')).toBe(0);
    expect((await listPrices(d, CRVUSD)).map((p) => p.source)).toEqual(Array(24).fill('chain:chainlink_feed'));
    expect((await d.all<{ token_ref: string }>("SELECT token_ref FROM tokens WHERE token_ref <> 'usd' ORDER BY token_ref")).map((t) => t.token_ref)).toEqual([CRVUSD]);
    // A second --yes has nothing to do.
    const again = await purgePrices(d, { source: 'coingecko', yes: true, exportDir, now: new Date('2026-11-12T13:00:00.000Z') });
    expect(again).toMatchObject({ applied: true, exportFile: null, prices: [], deletedTokens: [] });
  });

  it('keeps a coingecko:* tokens row a superseded observation still references (listed), and deletes its prices', async () => {
    const d = db();
    const id = await seedPrices(d);
    // A rejected row keeps the ref (not active: no refusal), so the tokens row cannot go.
    await d.run("UPDATE observations SET status = 'rejected' WHERE id = $1", [id]);
    const r = await purgePrices(d, { source: 'coingecko', yes: true, exportDir: join(scratch(), 'purged'), now: NOW });
    expect(r.deletedTokens).toEqual(['coingecko:spare']);
    expect(r.keptTokens).toEqual([{ tokenRef: 'coingecko:crvusd', reason: '1 observation(s) still reference it' }]);
    expect(await priceCount(d, 'coingecko')).toBe(0);
  });

  it('refuses another source, and run_in_progress while the `prices` lock is held', async () => {
    const d = db();
    await seedPrices(d, false);
    const exportDir = join(scratch(), 'purged');
    expect(await errCode(purgePrices(d, { source: 'defillama' as 'coingecko', yes: false, exportDir, now: NOW }))).toBe('invalid_price_source');
    const held = await d.tryAssetRunLock(PRICES_RUN_LOCK, 'daemon backfill prices pid 1');
    try {
      expect(await errCode(purgePrices(d, { source: 'coingecko', yes: true, exportDir, now: NOW }))).toBe('run_in_progress');
      expect((await purgePrices(d, { source: 'coingecko', yes: false, exportDir, now: NOW })).prices).toHaveLength(3);
    } finally {
      await held!.release();
    }
    expect(await priceCount(d)).toBe(74);
    expect(() => readdirSync(exportDir)).toThrow();
  });
});

describe('Phase 3 R3 (Review Focus 5): a market_data circulating_supply purge', () => {
  const circ = (source: string, extra = '') => {
    const { config, hash } = parseAssetYaml(`
id: circ
symbol: CIRC
name: Circulating Purge Test
contracts:
  token: "0x00000000000000000000000000000000000000c1"
  fund: "0x00000000000000000000000000000000000000a9"
ingest: { chain_id: 56, rpc_url_env: ORION_BNB_RPC_URL, backfill_days: 100 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  circulating_supply: { type: level, unit: tokens, staleness_days: 14, ${extra}source: ${source} }
`);
    return { config, hash } as LoadedAsset;
  };
  const evm = '{ type: erc20_supply, token: token }';
  const api = '{ type: adapter, name: hype.circulating_supply, params: { subtract: [ fund ] } }';
  const purge = async (l: LoadedAsset) => await purgeMetrics(db(), l, { metrics: ['circulating_supply'], sourceType: 'market_data', apply: false, exportDir: scratch(), now: NOW });
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);

  it('refuses a superseded CoinGecko row with no replacement at its observed_at (an EVM source); a contract_state row there replaces it', async () => {
    const d = db();
    const a = await seed(d, 'circulating_supply', 'market_data', '2026-10-04T05:00:00.000Z', 1, 'circ');
    await seed(d, 'circulating_supply', 'market_data', '2026-10-04T05:00:00.000Z', 2, 'circ'); // supersedes a
    expect((await d.one<{ s: number | null }>('SELECT superseded_by AS s FROM observations WHERE id = $1', [a]))!.s).not.toBeNull();
    expect(await code(purge(circ(evm)))).toBe('purge_unreplaced_supply_level');
    await seed(d, 'circulating_supply', 'contract_state', '2026-10-04T05:00:00.000Z', 3, 'circ');
    expect((await purge(circ(evm))).perMetric[0]).toMatchObject({ observations: 2, withoutReplacement: [] });
  });

  it('an API source (no archive) or a row before rebuild_from: deleted without replacement, listed; no other metric or rung is affected', async () => {
    const d = db();
    const a = await seed(d, 'circulating_supply', 'market_data', '2026-10-04T05:00:00.000Z', 1, 'circ');
    expect((await purge(circ(api))).perMetric[0]!.withoutReplacement).toEqual([{ id: a, observedAt: '2026-10-04T05:00:00.000Z', day: '2026-10-04' }]);
    expect((await purge(circ(evm, 'rebuild_from: 2026-10-05, '))).perMetric[0]!.withoutReplacement).toHaveLength(1);
    expect(await code(purge(circ(evm, 'rebuild_from: 2026-10-04, ')))).toBe('purge_unreplaced_supply_level');
  });
});
