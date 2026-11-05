import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listAssetIds, loadAsset, type LoadedAsset } from '../../src/config/load.js';
import type { MetricDef } from '../../src/config/schema.js';
import type { Db } from '../../src/db/connection.js';
import { findAdapter } from '../../src/ingest/adapters/registry.js';
import { BACKFILL_BATCH_ROWS, backfillProvenance, mapRow } from '../../src/provenance/backfill.js';
import { sourceTypeOf } from '../../src/report/sourceTypes.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ASSETS: LoadedAsset[] = listAssetIds(ROOT).map((id) => loadAsset(ROOT, id));
/** A fake keyed URL a row's source_detail may hold: the backfilled locator must not carry its key. */
const KEYED = 'https://eth-mainnet.g.alchemy.com/v2/fake_key_123456789?apikey=fake_query_key';

/** What the release before 0004 wrote in `source` for a metric's source (an adapter returns its own). */
function sourceOf(def: MetricDef, metrics: Record<string, MetricDef>): 'onchain' | 'api' | 'manual' {
  const s = def.source;
  if (s === undefined) return 'manual';
  if (['transfer_flow', 'contract_read', 'erc20_supply'].includes(s.type)) return 'onchain';
  if (s.type === 'adapter') return findAdapter(s.name)?.needsRpc ? 'onchain' : 'api';
  if (s.type === 'derived') {
    const p = s.params as Record<string, unknown>;
    const ins = [p.metric, p.metrics, p.minus].flat().filter((m): m is string => typeof m === 'string');
    return ins.some((m) => ['defillama', 'adapter'].includes(metrics[m]?.source?.type ?? '')) ? 'api' : 'onchain';
  }
  return 'api';
}

function detailOf(def: MetricDef): string {
  switch (def.source?.type) {
    case 'transfer_flow':
      return JSON.stringify({ day: '2026-10-01', blocks: [100, 200], senders: {} });
    case 'contract_read':
    case 'erc20_supply':
      return 'block 123';
    case 'derived':
      return `derived ${def.source.name}(x, 91d)`;
    default:
      return 'https://api.example.test/x';
  }
}

/** The insert of release orion-2026.11.04.2 (no provenance columns). */
async function oldInsert(db: Db, r: { assetId: string; metricKey: string; source: string; detail: string | null; citation?: string | null; status?: string }): Promise<number> {
  const res = await db.run<{ id: number }>(
    `INSERT INTO observations (asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at)
     VALUES ($1, $2, '2026-10-02T00:00:00.000Z', 1, 1.5, $3, $4, $5, $6, NULL, '2026-10-02T00:00:00.000Z') RETURNING id`,
    [r.assetId, r.metricKey, r.source, r.detail, r.status ?? 'confirmed', r.citation ?? null],
  );
  return Number(res.rows[0]!.id);
}

/** One row per metric of each of the 13 assets, as the old release wrote it, plus the rows the rules cannot map. */
async function seed(db: Db): Promise<{ mappable: Map<number, { assetId: string; metricKey: string }>; unmappable: { id: number; reason: string }[]; changed: number }> {
  const mappable = new Map<number, { assetId: string; metricKey: string }>();
  for (const a of ASSETS) {
    for (const [metricKey, def] of Object.entries(a.config.metrics)) {
      const source = sourceOf(def, a.config.metrics);
      const id = await oldInsert(db, { assetId: a.config.id, metricKey, source, detail: source === 'manual' ? 'typed in' : detailOf(def), citation: source === 'manual' ? 'https://example.com/c' : null });
      mappable.set(id, { assetId: a.config.id, metricKey });
    }
  }
  // Correction 1: an api row on a metric that is now a transfer scan (its source changed): mapped by its source column.
  const crv = ASSETS.find((a) => a.config.id === 'crv')!;
  const scanned = Object.keys(crv.config.metrics).find((k) => crv.config.metrics[k].source?.type === 'transfer_flow')!;
  const changed = await oldInsert(db, { assetId: 'crv', metricKey: scanned, source: 'api', detail: `${KEYED} path.x` });
  mappable.set(changed, { assetId: 'crv', metricKey: scanned });
  const third = ASSETS.flatMap((a) => Object.entries(a.config.metrics).filter(([, d]) => sourceTypeOf(d, a.config.metrics) === 'third_party' && d.source?.type !== 'derived').map(([k]) => [a.config.id, k] as const))[0]!;
  const unmappable = [
    { id: await oldInsert(db, { assetId: 'crv', metricKey: 'flow_usd.retired_metric', source: 'api', detail: null }), reason: 'unknown_metric' },
    { id: await oldInsert(db, { assetId: 'gone', metricKey: 'price_usd', source: 'api', detail: null }), reason: 'unknown_asset' },
    { id: await oldInsert(db, { assetId: 'vvv', metricKey: 'revenue_run_rate_usd', source: 'manual', detail: null }), reason: 'manual_without_citation' },
    { id: await oldInsert(db, { assetId: third[0], metricKey: third[1], source: 'onchain', detail: null }), reason: 'source_changed' },
  ];
  return { mappable, unmappable, changed };
}

const legacyColumns = async (db: Db) =>
  await db.all('SELECT id, asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at, superseded_by FROM observations ORDER BY id');

describe('backfillProvenance', () => {
  it('backfill maps every row of a 13-asset fixture by the rules in correction 1, and lists the unmappable ones', async () => {
    expect(ASSETS.length).toBe(13);
    const db = testDb();
    const { mappable, unmappable, changed } = await seed(db);
    const before = await legacyColumns(db);
    const r = await backfillProvenance(db, ASSETS);
    expect(r.dryRun).toBe(false);
    expect(r.alreadySet).toBe(0);
    expect(r.unmapped.map((u) => ({ id: u.id, reason: u.reason })).sort((a, b) => a.id - b.id)).toEqual(unmappable);
    expect(Object.values(r.mapped).reduce((s, n) => s + n, 0)).toBe(mappable.size);
    expect(await legacyColumns(db)).toEqual(before); // value, source, source_detail, status: untouched

    const rows = await db.all<{ id: number; method: string | null; source_type: string | null; chain: string | null; locator: Record<string, unknown> | null; block_from: number | null; block_to: number | null; formula: string | null; code_version: string | null; config_hash: string | null; source: string; metric_key: string; asset_id: string }>(
      'SELECT id, asset_id, metric_key, source, method, source_type, chain, locator, block_from, block_to, formula, code_version, config_hash FROM observations ORDER BY id',
    );
    for (const row of rows) {
      const where = `#${row.id} ${row.asset_id}.${row.metric_key}`;
      if (!mappable.has(row.id)) {
        expect(row.method, where).toBeNull();
        continue;
      }
      expect([row.code_version, row.config_hash], where).toEqual(['pre-v2', 'pre-v2']);
      expect(row.locator, where).not.toBeNull();
      if (row.id === changed) {
        expect([row.method, row.source_type], where).toEqual(['measured', 'first_party_api']);
        expect(JSON.stringify(row.locator)).not.toContain('fake_');
        expect(row.locator).toEqual({ endpoint: 'https://eth-mainnet.g.alchemy.com/v2' });
        continue;
      }
      const a = ASSETS.find((x) => x.config.id === row.asset_id)!;
      const def = a.config.metrics[row.metric_key];
      if (def.source === undefined) {
        expect([row.method, row.source_type, row.locator], where).toEqual(['disclosed', 'disclosure', { citation_url: 'https://example.com/c', approved_by: null, approved_at: null }]);
        continue;
      }
      expect(row.source_type, where).toBe(sourceTypeOf(def, a.config.metrics)); // the report's own mapping, not a fork
      expect(row.method, where).toBe(def.source.type === 'derived' ? 'derived' : def.source.type === 'constant' ? 'disclosed' : 'measured');
      if (def.source.type === 'transfer_flow') expect([row.block_from, row.block_to, row.chain], where).toEqual([100, 200, `eip155:${a.config.ingest!.chain_id}`]);
      if (def.source.type === 'contract_read' || def.source.type === 'erc20_supply') expect([row.block_from, row.block_to], where).toEqual([123, 123]);
      if (def.source.type === 'derived') expect(row.formula, where).toBe(`${def.source.name}@1`);
    }

    // Idempotent: a second run maps nothing and leaves the rest listed.
    const again = await backfillProvenance(db, ASSETS);
    expect(again.mapped).toEqual({});
    expect(again.alreadySet).toBe(mappable.size);
    expect(again.unmapped).toHaveLength(unmappable.length);
  });

  it('backfill --dry-run writes nothing', async () => {
    const db = testDb();
    const { mappable, unmappable } = await seed(db);
    const before = await db.all('SELECT * FROM observations ORDER BY id');
    const r = await backfillProvenance(db, ASSETS, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(Object.values(r.mapped).reduce((s, n) => s + n, 0)).toBe(mappable.size);
    expect(r.unmapped).toHaveLength(unmappable.length);
    expect(await db.all('SELECT * FROM observations ORDER BY id')).toEqual(before);
    expect(await db.one('SELECT count(*)::bigint AS n FROM observations WHERE method IS NOT NULL')).toEqual({ n: 0 });
  });
});

/** 25,000 rows of crv price_usd as the old release wrote them (one per hour), in one statement. */
async function seedMany(db: Db, n: number): Promise<void> {
  await db.run(
    `INSERT INTO observations (asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at)
     SELECT 'crv', 'price_usd', timestamptz '2020-01-01T00:00:00Z' + g * interval '1 hour', NULL, 0.5 + g, 'api',
            'coingecko /coins/markets curve-dao-token.current_price', 'confirmed', NULL, NULL, timestamptz '2026-10-02T00:00:00Z'
     FROM generate_series(1, $1::int) AS g`,
    [n],
  );
}

/** The database, with every transaction counted: rows it mapped, the lock it took; `crashAt` (1-based) throws at that tx's end. */
function countingDb(db: Db, crashAt: number | null = null): { db: Db; txs: { rows: number; lockAsset: string | undefined }[] } {
  const txs: { rows: number; lockAsset: string | undefined }[] = [];
  const set = async (t: Db) => (await t.one<{ n: number }>('SELECT count(*)::bigint AS n FROM observations WHERE method IS NOT NULL'))!.n;
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'tx') {
        return async <T>(fn: (t: Db) => Promise<T>, opts?: { lockAsset?: string }) =>
          await target.tx(async (t) => {
            const before = await set(t);
            const r = await fn(t);
            const rows = (await set(t)) - before;
            txs.push({ rows, lockAsset: opts?.lockAsset });
            if (txs.length === crashAt) throw new Error('crash mid-way');
            return r;
          }, opts);
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: wrapped, txs };
}

describe('backfillProvenance: bounded transactions', () => {
  it('writes at most 1,000 rows per transaction, each under the asset lock (25k rows: 25 batches)', async () => {
    expect(BACKFILL_BATCH_ROWS).toBe(1000);
    const base = testDb();
    await seedMany(base, 25_000);
    const { db, txs } = countingDb(base);
    const r = await backfillProvenance(db, ASSETS);
    expect(r.mapped).toEqual({ 'crv:price_usd': 25_000 });
    expect(txs).toHaveLength(25);
    expect(txs.every((t) => t.rows === 1000 && t.lockAsset === 'crv')).toBe(true);
    expect(await base.one('SELECT count(*)::bigint AS n FROM observations WHERE method IS NULL')).toEqual({ n: 0 });
  }, 60_000);

  it('a crash mid-way leaves only whole batches, and a re-run maps the rest', async () => {
    const base = testDb();
    await seedMany(base, 25_000);
    const { db } = countingDb(base, 3);
    await expect(backfillProvenance(db, ASSETS)).rejects.toThrow('crash mid-way');
    expect(await base.one('SELECT count(*)::bigint AS n FROM observations WHERE method IS NOT NULL')).toEqual({ n: 2000 });
    const again = countingDb(base);
    const r = await backfillProvenance(again.db, ASSETS);
    expect(r.alreadySet).toBe(2000);
    expect(r.mapped).toEqual({ 'crv:price_usd': 23_000 });
    expect(again.txs.map((t) => t.rows)).toEqual(Array.from({ length: 23 }, () => 1000));
    expect(await base.one('SELECT count(*)::bigint AS n FROM observations WHERE method IS NULL')).toEqual({ n: 0 });
  }, 60_000);
});

describe('mapRow', () => {
  const crv = ASSETS.find((a) => a.config.id === 'crv')!;
  const row = (over: Partial<Parameters<typeof mapRow>[0]>) => ({ id: 1, asset_id: 'crv', metric_key: 'price_usd', source: 'api', source_detail: null, citation_url: null, ...over });

  it('a chain level written as "block N: <detail>" (an RPC adapter) gets block_from = block_to = N', () => {
    expect(mapRow(row({ metric_key: 'emission_rate_annual', source: 'onchain', source_detail: 'block 456: rate 1.5 CRV/s' }), crv)).toMatchObject({ blockFrom: 456, blockTo: 456 });
    expect(mapRow(row({ metric_key: 'total_supply', source: 'onchain', source_detail: 'block 789' }), crv)).toMatchObject({ blockFrom: 789, blockTo: 789 });
    expect(mapRow(row({ metric_key: 'total_supply', source: 'onchain', source_detail: 'block 789x' }), crv)).toMatchObject({ blockFrom: null, blockTo: null });
  });

  it('an api row whose source_detail names a DefiLlama host is third_party, whatever the metric reads now', () => {
    const scanned = Object.keys(crv.config.metrics).find((k) => crv.config.metrics[k].source?.type === 'transfer_flow')!;
    for (const url of [
      'https://api.llama.fi/summary/fees/curve-dex?dataType=dailyRevenue',
      'https://coins.llama.fi/prices/current/ethereum:0xd533a949740bb3306d119cc777fa900ba034cd52',
      'https://pro-api.llama.fi/0123456789abcdef0123456789abcdef/api/fees',
      'https://yields.llama.fi/pools',
    ]) {
      const m = mapRow(row({ metric_key: scanned, source_detail: `${url} path.x` }), crv);
      expect(m, url).toMatchObject({ method: 'measured', sourceType: 'third_party', chain: null });
      expect(JSON.stringify(m)).not.toContain('0123456789abcdef0123456789abcdef');
    }
    // An api row on a metric that is first party now (Lighter's own API adapter), written from DefiLlama.
    const lit = ASSETS.find((a) => a.config.id === 'lit')!;
    expect(sourceTypeOf(lit.config.metrics['flow_usd.fees_core'], lit.config.metrics)).toBe('first_party_api');
    expect(mapRow(row({ asset_id: 'lit', metric_key: 'flow_usd.fees_core', source_detail: 'https://api.llama.fi/summary/fees/lighter?dataType=dailyFees' }), lit)).toMatchObject({
      method: 'measured', sourceType: 'third_party', locator: { endpoint: 'https://api.llama.fi/summary/fees/lighter?dataType=dailyFees' },
    });
    // Another host: labelled by the current source, as before.
    expect(mapRow(row({ metric_key: scanned, source_detail: 'https://api.example.test/x path.x' }), crv)).toMatchObject({ sourceType: 'first_party_api' });
  });
});
