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
    expect(before).toMatchObject({ schema: db.schema, dbAt: 0, codeRequires: 2, applied: [], changed: [], state: 'behind' });
    expect(before.pending).toEqual([{ id: 1, name: 'baseline', breaking: false }, { id: 2, name: 'daemon', breaking: false }]);

    expect(await applyMigrations(db, {})).toEqual({ applied: [1, 2] });
    expect(await applyMigrations(db, {})).toEqual({ applied: [] });
    const after = await migrationStatus(db);
    const [baseline, daemon] = loadMigrations();
    expect(after).toMatchObject({ dbAt: 2, codeRequires: 2, pending: [], changed: [], state: 'current' });
    expect(after.applied).toEqual([
      { id: 1, name: 'baseline', sha256: baseline!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 2, name: 'daemon', sha256: daemon!.sha256, appliedAt: expect.stringMatching(/Z$/) },
    ]);
    expect((await db.one<{ n: number }>('SELECT count(*) AS n FROM observations'))?.n).toBe(0);
  });

  it('migrate: creates the schema when it is absent', async () => {
    const db = await emptySchema();
    await db.run(`DROP SCHEMA ${db.schema}`);
    expect((await migrationStatus(db)).state).toBe('behind');
    expect(await applyMigrations(db, {})).toEqual({ applied: [1, 2] });
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

  it('migrate: the shipped migrations load in order from 1', () => {
    const ms = loadMigrations();
    expect(ms.map((m) => m.id)).toEqual(ms.map((_, i) => i + 1));
    expect(ms[0]).toMatchObject({ id: 1, name: 'baseline', breaking: false });
    expect(ms[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
