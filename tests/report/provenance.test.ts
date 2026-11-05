import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import type { Provenance } from '../../src/provenance/types.js';
import type { IsV2 } from '../../src/report/incomeStatement.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import { MINI_REPORT_YAML } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE } from '../helpers/provenance.js';

const testDb = useTestDb();
const asset = parseAssetYaml(MINI_REPORT_YAML).config;
const DAY = '2026-10-10';
const SCAN: Provenance = { method: 'measured', sourceType: 'log_scan', chain: 'eip155:8453', locator: { contracts: ['0x1111'] }, codeVersion: 'dev', configHash: 'h' };
const CITED: Provenance = { method: 'disclosed', sourceType: 'disclosure', chain: null, locator: { citation_url: 'https://example.com/fix' }, codeVersion: 'dev', configHash: 'h' };

/** flow_usd.fees 100 a day for 10 days to DAY: the two oldest days typed in from a citation, the rest a transfer scan's. */
async function seed(db: Db, opts: { oneUnmapped?: boolean } = {}): Promise<void> {
  const at = `${addDays(DAY, 1)}T00:00:00.000Z`;
  for (let i = 0; i < 10; i++) {
    const day = addDays(DAY, -i);
    const observedAt = `${addDays(day, 1)}T00:00:00.000Z`;
    if (opts.oneUnmapped && i === 3) {
      // A row the previous release wrote (no provenance columns), not backfilled yet.
      await db.run(
        `INSERT INTO observations (asset_id, metric_key, observed_at, period_days, value, source, status, fetched_at) VALUES ('mini', 'flow_usd.fees', $1, 1, 100, 'onchain', 'confirmed', $2)`,
        [observedAt, at],
      );
      continue;
    }
    const cited = i >= 8;
    await insertObservation(db, {
      assetId: 'mini', metricKey: 'flow_usd.fees', observedAt, periodDays: 1, value: 100, source: cited ? 'manual' : 'onchain', fetchedAt: at,
      ...(cited ? { citationUrl: 'https://example.com/fix' } : {}), provenance: cited ? CITED : SCAN,
    });
  }
  await insertObservation(db, { provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: 'price_usd', observedAt: at, value: 2, source: 'api', fetchedAt: at });
  await insertObservation(db, { provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: 'total_supply', observedAt: at, value: 1_000_000, source: 'onchain', fetchedAt: at });
}

const statement = async (db: Db) => (await loadHolderYieldReport(db, asset, DAY)).incomeStatement as IsV2;
const legacyOnly = async (db: Db) => {
  const r = JSON.parse(JSON.stringify(await loadHolderYieldReport(db, asset, DAY, { legacy: true }))) as Record<string, unknown>;
  delete r.incomeStatement;
  return JSON.stringify(r);
};

describe('income statement v2 provenance from observations (Task 6)', () => {
  it('methods are the revenue share by the rows\' method, daysMeasured counts measured days, sources come from the rows', async () => {
    const db = testDb();
    await seed(db);
    const is = await statement(db);
    expect(is.provenance.basis).toBe('observations');
    expect(is.provenance.methods.measured).toBeCloseTo(0.8, 12);
    expect(is.provenance.methods.disclosed).toBeCloseTo(0.2, 12);
    expect(is.provenance.methods.derived).toBe(0);
    expect(is.provenance.sources).toEqual(['disclosure', 'log_scan:eip155:8453']);
    expect(is.revenue.lines[0]).toMatchObject({ id: 'fees', method: 'measured', daysMeasured: 8 });
    expect(is.revenue.annualized).toBeCloseTo((1000 * 365) / 10, 9);
  });

  it('a window row without provenance (history not backfilled): basis config, as before; the numbers and the legacy JSON are the same', async () => {
    const mapped = testDb();
    await seed(mapped);
    const a = await statement(mapped);
    const legacyA = await legacyOnly(mapped);
    await testDb.reset();
    const db = testDb();
    await seed(db, { oneUnmapped: true });
    const b = await statement(db);
    expect(b.provenance.basis).toBe('config');
    expect(b.provenance.methods).toEqual({ measured: 1, derived: 0, disclosed: 0 });
    expect(b.revenue.lines[0]!.daysMeasured).toBeNull();
    expect(await legacyOnly(db)).toBe(legacyA); // values never move with provenance
    const strip = (x: IsV2) => JSON.stringify({ ...x, provenance: null, revenue: { ...x.revenue, lines: x.revenue.lines.map((l) => ({ ...l, daysMeasured: null })) } });
    expect(strip(b)).toBe(strip(a)); // only the provenance fields differ
  });
});
