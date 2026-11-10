import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DatabaseConfig, type OrionDb } from '../../src/db/connection.js';
import { originCheck } from '../../tools/phase2-proof/origin-check.js';
import { createTestSchema, dropTestSchema } from '../setup/pgGlobal.js';

/** The R10.2a prod-copy check, on a 0005 schema (the column still there): derived origin vs stored `source`, per row. */
let config: DatabaseConfig;
let db: OrionDb;
beforeAll(async () => {
  config = await createTestSchema({ upTo: 5 });
  db = await openDb(config, { checkSchema: false });
});
afterAll(async () => {
  await db?.close();
  if (config) await dropTestSchema(config);
});

const row = (source: string, method: string | null, sourceType: string | null, locator: unknown, formula: string | null = null) =>
  db.run(
    `INSERT INTO observations (asset_id, metric_key, observed_at, value, source, status, fetched_at, method, source_type, locator, formula, code_version, config_hash)
     VALUES ('a', 'm', now(), 1, $1, 'confirmed', now(), $2, $3, $4::jsonb, $5, 'pre-v2', 'pre-v2')`,
    [source, method, sourceType, locator === null ? null : JSON.stringify(locator), formula],
  );

describe('origin-check (tools/phase2-proof)', () => {
  it('counts every row whose derived origin equals the stored source, and names the shape of any that does not', async () => {
    await row('onchain', 'measured', 'log_scan', { contracts: ['0x1'] });
    await row('api', 'measured', 'contract_state', { adapter: 'solana.supply_burn_daily', params: {} });
    await row('onchain', 'measured', 'contract_state', { adapter: 'chain.view_sum', params: {} });
    await row('manual', 'derived', 'derived', { note: 'DefiLlama artifact' }, 'manual_mean_of_neighbours@1');
    await row('api', 'disclosed', 'constant', { config_path: 'metrics.m.source' });
    await row('manual', 'disclosed', 'disclosure', { note: 'seed', legacy_seed: true });
    expect(await originCheck(db)).toEqual({ rows: 6, equal: 6, unmapped: 0, mismatches: {}, mismatchIds: [] });
    await row('onchain', 'measured', 'first_party_api', { endpoint: 'https://x.test' });
    await row('api', null, null, null);
    const r = await originCheck(db);
    expect(r).toMatchObject({ rows: 8, equal: 6, unmapped: 1, mismatches: { 'measured/first_party_api/onchain->api': 1 } });
    expect(r.mismatchIds).toHaveLength(1);
  });
});
