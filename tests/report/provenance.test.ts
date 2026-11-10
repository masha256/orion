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
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

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
      // A row the previous release wrote (it inserts `source`, no provenance): refused on 0006, so the day is missing.
      await expect(
        db.run(
          `INSERT INTO observations (asset_id, metric_key, observed_at, period_days, value, source, status, fetched_at) VALUES ('mini', 'flow_usd.fees', $1, 1, 100, 'onchain', 'confirmed', $2)`,
          [observedAt, at],
        ),
      ).rejects.toThrow(/column "source"/);
      continue;
    }
    const cited = i >= 8;
    await insertObservation(db, {
      assetId: 'mini', metricKey: 'flow_usd.fees', observedAt, periodDays: 1, value: 100, fetchedAt: at,
      ...(cited ? { citationUrl: 'https://example.com/fix' } : {}), provenance: cited ? CITED : SCAN,
    });
  }
  await insertObservation(db, { provenance: testProvenance('api'), assetId: 'mini', metricKey: 'price_usd', observedAt: at, value: 2, fetchedAt: at });
  await insertObservation(db, { provenance: testProvenance('onchain'), assetId: 'mini', metricKey: 'total_supply', observedAt: at, value: 1_000_000, fetchedAt: at });
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

  it('a window row without provenance cannot exist since 0006 (the basis-config fallback for unbackfilled history is moot)', async () => {
    const db = testDb();
    await seed(db, { oneUnmapped: true }); // the previous release's insert (source, no provenance) is refused
    const is = await statement(db);
    expect(is.provenance.basis).toBe('observations');
  });
});
