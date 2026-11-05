import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../../../src/db/connection.js';
import { applyMigrations, loadMigrations, migrationStatus } from '../../../src/db/pg/migrate.js';
import { openPgDb, type PgDb } from '../../../src/db/pg/pool.js';
import { createTestSchema, dropTestSchema } from '../../setup/pgGlobal.js';

const opened: { db: PgDb; config: DatabaseConfig }[] = [];
const dirs: string[] = [];

async function emptySchema(): Promise<PgDb> {
  const config = await createTestSchema({ migrate: false });
  const db = await openPgDb(config);
  opened.push({ db, config });
  return db;
}

function migrationDir(files: Record<string, string>): URL {
  const dir = mkdtempSync(join(tmpdir(), 'orion-migrations-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return pathToFileURL(dir + '/');
}

afterEach(async () => {
  for (const { db, config } of opened.splice(0)) {
    await db.close();
    await dropTestSchema(config);
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  for (const { db, config } of opened.splice(0)) {
    await db.close();
    await dropTestSchema(config);
  }
});

describe('migrate', () => {
  it('migrate: the shipped migrations apply to an empty schema; a second run applies nothing; status is current', async () => {
    const db = await emptySchema();
    const before = await migrationStatus(db);
    expect(before).toMatchObject({ schema: db.schema, dbAt: 0, codeRequires: 4, applied: [], changed: [], state: 'behind' });
    expect(before.pending).toEqual([
      { id: 1, name: 'baseline', breaking: false }, { id: 2, name: 'daemon', breaking: false }, { id: 3, name: 'checks', breaking: false },
      { id: 4, name: 'provenance', breaking: false },
    ]);

    expect(await applyMigrations(db, {})).toEqual({ applied: [1, 2, 3, 4] });
    expect(await applyMigrations(db, {})).toEqual({ applied: [] });
    const after = await migrationStatus(db);
    const [baseline, daemon, checks, provenance] = loadMigrations();
    expect(after).toMatchObject({ dbAt: 4, codeRequires: 4, pending: [], changed: [], state: 'current' });
    expect(after.applied).toEqual([
      { id: 1, name: 'baseline', sha256: baseline!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 2, name: 'daemon', sha256: daemon!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 3, name: 'checks', sha256: checks!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 4, name: 'provenance', sha256: provenance!.sha256, appliedAt: expect.stringMatching(/Z$/) },
    ]);
    expect((await db.one<{ n: number }>('SELECT count(*) AS n FROM observations'))?.n).toBe(0);
  });

  it('migrate: creates the schema when it is absent', async () => {
    const db = await emptySchema();
    await db.run(`DROP SCHEMA ${db.schema}`);
    expect((await migrationStatus(db)).state).toBe('behind');
    expect(await applyMigrations(db, {})).toEqual({ applied: [1, 2, 3, 4] });
    expect((await migrationStatus(db)).state).toBe('current');
  });

  it('migrate: a changed file is refused with migration_changed; a gap is migration_gap; a breaking file needs the flag', async () => {
    const v1 = { '0001_first.sql': 'CREATE TABLE a (x integer);\n' };
    const db = await emptySchema();
    expect(await applyMigrations(db, { migrations: loadMigrations(migrationDir(v1)) })).toEqual({ applied: [1] });

    // a changed file
    const changed = loadMigrations(migrationDir({ '0001_first.sql': 'CREATE TABLE a (x bigint);\n' }));
    expect(await migrationStatus(db, changed)).toMatchObject({ changed: [1], state: 'changed' });
    await expect(applyMigrations(db, { migrations: changed })).rejects.toMatchObject({
      code: 'migration_changed',
      message: expect.stringContaining('1'),
    });

    // a gap
    expect(() => loadMigrations(migrationDir({ ...v1, '0003_third.sql': 'SELECT 1;' }))).toThrow(
      expect.objectContaining({ code: 'migration_gap' }),
    );
    expect(() => loadMigrations(migrationDir({ '0002_second.sql': 'SELECT 1;' }))).toThrow(
      expect.objectContaining({ code: 'migration_gap' }),
    );

    // a breaking file
    const breaking = loadMigrations(
      migrationDir({ ...v1, '0002_drop_x.sql': '-- breaking\nALTER TABLE a DROP COLUMN x;\n' }),
    );
    expect(breaking.map((m) => [m.id, m.name, m.breaking])).toEqual([
      [1, 'first', false],
      [2, 'drop_x', true],
    ]);
    expect(await migrationStatus(db, breaking)).toMatchObject({
      dbAt: 1,
      codeRequires: 2,
      pending: [{ id: 2, name: 'drop_x', breaking: true }],
      state: 'behind',
    });
    await expect(applyMigrations(db, { migrations: breaking })).rejects.toMatchObject({ code: 'migration_breaking' });
    expect((await migrationStatus(db, breaking)).dbAt).toBe(1);
    expect(await applyMigrations(db, { migrations: breaking, breaking: true })).toEqual({ applied: [2] });

    // the code behind the database
    expect(await migrationStatus(db, loadMigrations(migrationDir(v1)))).toMatchObject({ dbAt: 2, codeRequires: 1, state: 'ahead' });
  });

  it('migrate: a failing file rolls back alone; earlier files stay applied', async () => {
    const db = await emptySchema();
    const files = loadMigrations(
      migrationDir({ '0001_ok.sql': 'CREATE TABLE a (x integer);', '0002_bad.sql': 'CREATE TABLE b (y integer);\nSELECT * FROM nope;' }),
    );
    await expect(applyMigrations(db, { migrations: files })).rejects.toThrow(/nope/);
    const status = await migrationStatus(db, files);
    expect(status).toMatchObject({ dbAt: 1, state: 'behind' });
    expect(await db.one("SELECT 1 AS x FROM pg_tables WHERE schemaname = $1 AND tablename = 'b'", [db.schema])).toBeUndefined();
  });

  it('0003 applies after 0002 and the constraint name anomalies_kind_check exists before it', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    expect(all[2]).toMatchObject({ id: 3, name: 'checks', breaking: false }); // expand-only
    expect(await applyMigrations(db, { migrations: all.slice(0, 2) })).toEqual({ applied: [1, 2] });
    // 0001's kind CHECK is unnamed inline: Postgres named it <table>_<column>_check, which 0003 drops by that name.
    const kindCheck = () => db.all<{ name: string; def: string }>(
      `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'anomalies' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%kind%'`,
      [db.schema],
    );
    const before = await kindCheck();
    expect(before.map((c) => c.name)).toEqual(['anomalies_kind_check']);
    expect(before[0]!.def).not.toContain('check_breach');
    expect(await applyMigrations(db, { migrations: all.slice(0, 3) })).toEqual({ applied: [3] });
    const after = await kindCheck();
    expect(after.map((c) => c.name)).toEqual(['anomalies_kind_check']);
    expect(after[0]!.def).toContain('check_breach');
    const cols = await db.all<{ c: string; t: string; coll: string | null }>(
      `SELECT column_name AS c, data_type AS t, collation_name AS coll FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'check_results' ORDER BY ordinal_position`,
      [db.schema],
    );
    expect(cols.map((x) => [x.c, x.t])).toEqual([
      ['asset_id', 'text'], ['check_id', 'text'], ['day', 'date'], ['type', 'text'], ['lhs', 'double precision'], ['rhs', 'double precision'],
      ['gap_pct', 'double precision'], ['status', 'text'], ['detail_json', 'json'], ['evaluated_at', 'timestamp with time zone'],
    ]);
    expect(cols.filter((x) => x.t === 'text').every((x) => x.coll === 'C')).toBe(true);
  });

  it('0004 applies after 0003: nullable provenance columns on observations, source_type and locator on latest_levels, the method index', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    expect(all[3]).toMatchObject({ id: 4, name: 'provenance', breaking: false }); // expand-only
    expect(await applyMigrations(db, { migrations: all.slice(0, 3) })).toEqual({ applied: [1, 2, 3] });
    expect(await applyMigrations(db, {})).toEqual({ applied: [4] });
    const cols = async (table: string) =>
      await db.all<{ c: string; t: string; n: string; coll: string | null }>(
        `SELECT column_name AS c, data_type AS t, is_nullable AS n, collation_name AS coll FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [db.schema, table],
      );
    const obs = await cols('observations');
    expect(obs.slice(-15).map((x) => [x.c, x.t, x.n])).toEqual([
      ['method', 'text', 'YES'], ['source_type', 'text', 'YES'], ['chain', 'text', 'YES'], ['locator', 'jsonb', 'YES'], ['block_from', 'bigint', 'YES'],
      ['block_to', 'bigint', 'YES'], ['tx_count', 'bigint', 'YES'], ['tx_refs', 'jsonb', 'YES'], ['tx_digest', 'text', 'YES'], ['response_digest', 'text', 'YES'],
      ['inputs', 'jsonb', 'YES'], ['formula', 'text', 'YES'], ['coverage', 'jsonb', 'YES'], ['code_version', 'text', 'YES'], ['config_hash', 'text', 'YES'],
    ]);
    expect(obs.filter((x) => x.t === 'text').every((x) => x.coll === 'C')).toBe(true);
    expect((await cols('latest_levels')).slice(-2).map((x) => [x.c, x.t, x.n])).toEqual([['source_type', 'text', 'YES'], ['locator', 'jsonb', 'YES']]);
    const idx = await db.one<{ def: string }>("SELECT indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_obs_method'", [db.schema]);
    expect(idx?.def).toMatch(/\(asset_id, metric_key, method\)/);
  });

  it('a release-N-1 insert of every old anomaly kind still works on 0003', async () => {
    const db = await emptySchema();
    await applyMigrations(db, {});
    // The insert a release without 0003 makes (src/db/anomalies.ts raiseAnomaly), one per kind it knows.
    const insert = (kind: string, dedupe: string) => db.run(
      `INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at)
       VALUES ('mini', $1, 'm', $2, 'advisory', 'open', '{}', 1, now(), now())`,
      [kind, dedupe],
    );
    for (const kind of ['cross_check_mismatch', 'unlisted_sender', 'source_failure_streak', 'revenue_disclosure_stale', 'revenue_payment']) await insert(kind, kind);
    await insert('check_breach', 'splitter');
    expect((await db.all<{ kind: string }>('SELECT kind FROM anomalies ORDER BY id')).map((r) => r.kind)).toEqual([
      'cross_check_mismatch', 'unlisted_sender', 'source_failure_streak', 'revenue_disclosure_stale', 'revenue_payment', 'check_breach',
    ]);
    await expect(insert('made_up', 'x')).rejects.toThrow(/anomalies_kind_check/);
  });

  it('migrate: the shipped migrations load in order from 1', () => {
    const ms = loadMigrations();
    expect(ms.map((m) => m.id)).toEqual(ms.map((_, i) => i + 1));
    expect(ms[0]).toMatchObject({ id: 1, name: 'baseline', breaking: false });
    expect(ms[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
