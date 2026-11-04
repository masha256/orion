import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { databaseConfig, openDb, type DatabaseConfig } from '../../src/db/connection.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { devPaths } from '../helpers/db.js';
import { AS_OF } from '../helpers/obs.js';
import { createTestSchema, dropTestSchema, requireTestDatabaseUrl } from '../setup/pgGlobal.js';

/** Each case makes its own schema(s) in a state of its choosing; all are dropped after it. */
const schemas: DatabaseConfig[] = [];
afterEach(async () => {
  for (const s of schemas.splice(0)) await dropTestSchema(s);
});
async function schema(opts: { migrate: boolean }): Promise<DatabaseConfig> {
  const s = await createTestSchema(opts);
  schemas.push(s);
  return s;
}

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'orion-db-cli-'));
  for (const d of ['assets', 'personas', 'skills']) mkdirSync(join(h, d));
  writeFileSync(join(h, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  writeFileSync(join(h, 'personas', 'analyst.md'), '---\nname: analyst\n---\nAn analyst.\n');
  return h;
}

async function orion(ctx: { home: string; database?: DatabaseConfig }, ...args: string[]): Promise<{ out: string; exit: number[] }> {
  const lines: string[] = [];
  const exit: number[] = [];
  const program = buildProgram({ ...devPaths(ctx.home), database: ctx.database, stdout: (l) => lines.push(l), now: () => new Date(AS_OF), setExitCode: (c) => exit.push(c) });
  await program.parseAsync(args, { from: 'user' });
  return { out: lines.join('\n'), exit };
}

async function tables(config: DatabaseConfig): Promise<string[]> {
  const db = await openDb(config, { checkSchema: false });
  try {
    return (await db.all<{ t: string }>('SELECT tablename AS t FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [config.schema])).map((r) => r.t);
  } finally {
    await db.close();
  }
}

describe('orion db', () => {
  it('db: no ORION_DATABASE_URL → no_database_url', async () => {
    vi.stubEnv('ORION_DATABASE_URL', undefined);
    try {
      expect(() => databaseConfig({})).toThrow(expect.objectContaining({ code: 'no_database_url', message: 'ORION_DATABASE_URL is not set (environment or <ORION_HOME>/.env)' }));
      const r = await orion({ home: home() }, 'db', 'status', '--json');
      expect(JSON.parse(r.out)).toEqual({ error: { code: 'no_database_url', message: 'ORION_DATABASE_URL is not set (environment or <ORION_HOME>/.env)' } });
      expect(r.exit).toEqual([1]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('db: the database comes from ORION_DATABASE_URL and ORION_DB_SCHEMA in <home>/.env; the schema defaults to orion', async () => {
    expect(databaseConfig({ ORION_DATABASE_URL: 'postgresql://u@/d' })).toEqual({ url: 'postgresql://u@/d', schema: 'orion' });
    expect(() => databaseConfig({ ORION_DATABASE_URL: 'postgresql://u@/d', ORION_DB_SCHEMA: 'Bad-Name' })).toThrow(expect.objectContaining({ code: 'invalid_db_schema' }));
    const s = await schema({ migrate: false });
    const h = home();
    writeFileSync(join(h, '.env'), `ORION_DATABASE_URL=${requireTestDatabaseUrl()}\nORION_DB_SCHEMA=${s.schema}\n`);
    const r = await orion({ home: h }, 'db', 'migrate', '--json');
    expect(JSON.parse(r.out)).toMatchObject({ applied: [1], status: { schema: s.schema, state: 'current' } });
  });

  it('db status on a fresh schema: state behind, pending [1 baseline]', async () => {
    const s = await schema({ migrate: false });
    const r = await orion({ home: home(), database: s }, 'db', 'status', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toEqual({
      schema: s.schema, dbAt: 0, codeRequires: 1, applied: [], pending: [{ id: 1, name: 'baseline', breaking: false }], changed: [], state: 'behind',
    });
    expect((await orion({ home: home(), database: s }, 'db', 'status')).out).toBe(`schema ${s.schema}: behind (database at 0, this build needs 1)\n  pending 0001_baseline`);
    expect(await tables(s)).toEqual([]); // status reads only
  });

  it('db migrate applies 0001 once, then nothing', async () => {
    const s = await schema({ migrate: false });
    const first = JSON.parse((await orion({ home: home(), database: s }, 'db', 'migrate', '--json')).out);
    expect(first.applied).toEqual([1]);
    expect(first.status).toMatchObject({ dbAt: 1, codeRequires: 1, pending: [], state: 'current' });
    expect(first.status.applied).toEqual([{ id: 1, name: 'baseline', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), appliedAt: expect.stringMatching(/Z$/) }]);
    const second = await orion({ home: home(), database: s }, 'db', 'migrate');
    expect(second.out).toBe(`nothing to apply\nschema ${s.schema}: current (database at 1, this build needs 1)`);
    expect(JSON.parse((await orion({ home: home(), database: s }, 'db', 'status', '--json')).out).state).toBe('current');
    expect(await tables(s)).toContain('observations');
  });

  it('a command on a schema behind refuses schema_behind and writes nothing', async () => {
    const s = await schema({ migrate: true });
    const db = await openDb(s, { checkSchema: false });
    try {
      await db.run('DELETE FROM schema_migrations'); // the tables exist, but the schema records nothing applied: behind
      const h = home();
      const r = await orion({ home: h, database: s }, 'persona', 'assign', 'mini', 'analyst', '--json');
      expect(JSON.parse(r.out)).toEqual({
        error: { code: 'schema_behind', message: `database schema ${s.schema} is at 0, this build needs 1: run orion db migrate` },
      });
      expect(r.exit).toEqual([1]);
      expect(await db.all('SELECT * FROM coverage')).toEqual([]);
      expect(await db.all('SELECT * FROM schema_migrations')).toEqual([]); // and opening never migrates
      await expect(openDb(s)).rejects.toMatchObject({ code: 'schema_behind' });
    } finally {
      await db.close();
    }
    const absent = await schema({ migrate: false }); // no tables at all: also behind, and still nothing is created
    expect(JSON.parse((await orion({ home: home(), database: absent }, 'agent', 'runs', 'list', '--json')).out).error.code).toBe('schema_behind');
    expect(await tables(absent)).toEqual([]);
  });

  it('a command on a schema ahead runs', async () => {
    const s = await schema({ migrate: true });
    const db = await openDb(s);
    try {
      await db.run("INSERT INTO schema_migrations (id, name, sha256, applied_at) VALUES (2, 'from_a_newer_build', 'x', now())");
    } finally {
      await db.close();
    }
    const h = home();
    const r = await orion({ home: h, database: s }, 'persona', 'assign', 'mini', 'analyst', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toMatchObject({ assetId: 'mini', persona: 'analyst' });
    expect(JSON.parse((await orion({ home: h, database: s }, 'db', 'status', '--json')).out)).toMatchObject({ dbAt: 2, codeRequires: 1, state: 'ahead' });
  });
});
