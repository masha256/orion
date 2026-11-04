import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, type DatabaseConfig } from '../../../src/db/connection.js';
import { openPgDb, type PgDb } from '../../../src/db/pg/pool.js';
import { createTestSchema, dropTestSchema, MISSING_URL_MESSAGE, requireTestDatabaseUrl } from '../../setup/pgGlobal.js';

const CARRIED = [
  'agent_runs',
  'agent_transcripts',
  'anomalies',
  'coverage',
  'documents',
  'fetch_cursors',
  'fetch_runs',
  'journal',
  'observations',
  'proposals',
];
const NOT_CARRIED = [
  'run_locks',
  'trigger_firings',
  'assumption_sets',
  'assumptions',
  'assumption_changes',
  'assumption_evidence',
  'config_versions',
  'snapshots',
  'valuation_runs',
  'signals',
];

let config: DatabaseConfig;
let db: PgDb;

beforeAll(async () => {
  config = await createTestSchema();
  db = await openPgDb(config);
});
afterAll(async () => {
  await db?.close();
  if (config) await dropTestSchema(config);
});

describe('baseline', () => {
  it('baseline: every table\'s columns match the SQLite schema 8 in name and order', async () => {
    // SQLite at schema 8, built from src/db/migrations.ts (raw better-sqlite3: this is a schema comparison, not app data)
    const lite = new Database(':memory:');
    try {
      migrate(lite);
      expect((lite.prepare('SELECT max(id) AS v FROM schema_migrations').get() as { v: number }).v).toBe(8);
      const liteTables = (
        lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(liteTables).toEqual(expect.arrayContaining([...CARRIED, ...NOT_CARRIED]));

      const pgTables = (
        await db.all<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
          [config.schema],
        )
      ).map((r) => r.table_name);
      expect(pgTables).toEqual([...CARRIED, 'schema_migrations'].sort());
      for (const t of NOT_CARRIED) expect(pgTables).not.toContain(t);

      for (const table of CARRIED) {
        const liteCols = (lite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        const pgCols = (
          await db.all<{ column_name: string }>(
            'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
            [config.schema, table],
          )
        ).map((c) => c.column_name);
        expect(pgCols, table).toEqual(liteCols);
      }
    } finally {
      lite.close();
    }
  });

  it('baseline: column types follow section 7.1 (bigint ids, double precision, text COLLATE "C", json, smallint dry_run)', async () => {
    const cols = await db.all<{ table_name: string; column_name: string; data_type: string; collation_name: string | null }>(
      `SELECT table_name, column_name, data_type, collation_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name <> 'schema_migrations'`,
      [config.schema],
    );
    expect(cols.length).toBeGreaterThanOrEqual(100);
    for (const c of cols) {
      const where = `${c.table_name}.${c.column_name}`;
      if (c.column_name.endsWith('_json')) expect(c.data_type, where).toBe('json');
      if (c.data_type === 'text') expect(c.collation_name, where).toBe('C');
      expect(['jsonb', 'integer', 'real', 'character varying', 'timestamp without time zone'], where).not.toContain(c.data_type);
      if (c.column_name === 'id' || c.column_name.endsWith('_id') && !['asset_id', 'source_id'].includes(c.column_name)) {
        expect(c.data_type, where).toBe('bigint');
      }
    }
    const typeOf = (t: string, c: string) => cols.find((x) => x.table_name === t && x.column_name === c)?.data_type;
    expect(typeOf('agent_runs', 'dry_run')).toBe('smallint');
    expect(typeOf('observations', 'value')).toBe('double precision');
    expect(typeOf('fetch_cursors', 'last_day')).toBe('date');
    expect(typeOf('documents', 'published_at')).toBe('text');
    expect(typeOf('observations', 'observed_at')).toBe('timestamp with time zone');
  });
});

describe('setup', () => {
  it('setup: an unset ORION_TEST_DATABASE_URL fails with the message above', () => {
    expect(MISSING_URL_MESSAGE).toBe(
      'ORION_TEST_DATABASE_URL is not set: the suite needs the local test Postgres (scripts/provision/dev-postgres.sh); ' +
        'e.g. postgresql:///orion_test?host=/var/run/postgresql',
    );
    expect(() => requireTestDatabaseUrl({})).toThrow(MISSING_URL_MESSAGE);
    expect(() => requireTestDatabaseUrl({ ORION_TEST_DATABASE_URL: '' })).toThrow(MISSING_URL_MESSAGE);
    expect(requireTestDatabaseUrl({ ORION_TEST_DATABASE_URL: 'postgresql://u@/d' })).toBe('postgresql://u@/d');
  });

  it('setup: a test schema is t_<16 hex>, carries its creation time, and is dropped', async () => {
    const c = await createTestSchema({ migrate: false });
    expect(c.schema).toMatch(/^t_[0-9a-f]{16}$/);
    const row = await db.one<{ c: string }>("SELECT obj_description(oid, 'pg_namespace') AS c FROM pg_namespace WHERE nspname = $1", [
      c.schema,
    ]);
    expect(Date.now() - Date.parse(row!.c)).toBeLessThan(60_000);
    await dropTestSchema(c);
    expect(await db.one('SELECT 1 AS x FROM pg_namespace WHERE nspname = $1', [c.schema])).toBeUndefined();
  });
});
