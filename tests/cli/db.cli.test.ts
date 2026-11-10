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
    const r = await orion({ home: h }, 'db', 'migrate', '--breaking', '--json');
    expect(JSON.parse(r.out)).toMatchObject({ applied: [1, 2, 3, 4, 5, 6], status: { schema: s.schema, state: 'current' } });
  });

  it('db status on a fresh schema: state behind, pending [1 baseline, 2 daemon, 3 checks, 4 provenance, 5 tokens_prices, 6 provenance_not_null (breaking)]', async () => {
    const s = await schema({ migrate: false });
    const r = await orion({ home: home(), database: s }, 'db', 'status', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toEqual({
      schema: s.schema, dbAt: 0, codeRequires: 6, applied: [],
      pending: [
        { id: 1, name: 'baseline', breaking: false }, { id: 2, name: 'daemon', breaking: false }, { id: 3, name: 'checks', breaking: false }, { id: 4, name: 'provenance', breaking: false },
        { id: 5, name: 'tokens_prices', breaking: false }, { id: 6, name: 'provenance_not_null', breaking: true },
      ],
      changed: [], state: 'behind',
    });
    expect((await orion({ home: home(), database: s }, 'db', 'status')).out).toBe(`schema ${s.schema}: behind (database at 0, this build needs 6)\n  pending 0001_baseline\n  pending 0002_daemon\n  pending 0003_checks\n  pending 0004_provenance\n  pending 0005_tokens_prices\n  pending 0006_provenance_not_null (breaking)`);
    expect(await tables(s)).toEqual([]); // status reads only
  });

  it('db migrate refuses the breaking 0006 without --breaking; with it applies 0001 to 0006 once, then nothing', async () => {
    const s = await schema({ migrate: false });
    const refused = await orion({ home: home(), database: s }, 'db', 'migrate', '--json');
    expect(JSON.parse(refused.out)).toMatchObject({ error: { code: 'migration_breaking' } });
    expect(refused.exit).toEqual([1]);
    expect(await tables(s)).not.toContain('observations'); // nothing applied
    const first = JSON.parse((await orion({ home: home(), database: s }, 'db', 'migrate', '--breaking', '--json')).out);
    expect(first.applied).toEqual([1, 2, 3, 4, 5, 6]);
    expect(first.status).toMatchObject({ dbAt: 6, codeRequires: 6, pending: [], state: 'current' });
    expect(first.status.applied).toEqual([
      { id: 1, name: 'baseline', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), appliedAt: expect.stringMatching(/Z$/) },
      { id: 2, name: 'daemon', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), appliedAt: expect.stringMatching(/Z$/) },
      { id: 3, name: 'checks', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), appliedAt: expect.stringMatching(/Z$/) },
      { id: 4, name: 'provenance', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), appliedAt: expect.stringMatching(/Z$/) },
      { id: 5, name: 'tokens_prices', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), appliedAt: expect.stringMatching(/Z$/) },
      { id: 6, name: 'provenance_not_null', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), appliedAt: expect.stringMatching(/Z$/) },
    ]);
    const second = await orion({ home: home(), database: s }, 'db', 'migrate');
    expect(second.out).toBe(`nothing to apply\nschema ${s.schema}: current (database at 6, this build needs 6)`);
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
        error: { code: 'schema_behind', message: `database schema ${s.schema} is at 0, this build needs 6: run orion db migrate` },
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

  it('db query-ro (C-1): one statement in a READ ONLY transaction, as --role, JSON rows; backslashes and a second statement are refused', async () => {
    const s = await schema({ migrate: true });
    const h = home();
    const ok = await orion({ home: h, database: s }, 'db', 'query-ro', "select 1 as one, 'a;b' as \"semi;colon\", current_setting('statement_timeout') as t, current_setting('transaction_read_only') as ro");
    expect(ok.exit).toEqual([]);
    expect(JSON.parse(ok.out)).toEqual({ rows: [{ one: 1, 'semi;colon': 'a;b', t: '30s', ro: 'on' }], rowCount: 1 });
    // a write is refused by the transaction, not by the caller's goodwill
    const write = await orion({ home: h, database: s }, 'db', 'query-ro', "insert into coverage (asset_id) values ('x')");
    expect(write.exit).toEqual([1]);
    expect(JSON.parse(write.out).error.message).toMatch(/read-only transaction/);
    // the role named is the one that signs in (the test database's own role here; orion_prod_ro on venus)
    const role = /^postgres(?:ql)?:\/\/([^@:/?#]+)[@:]/.exec(requireTestDatabaseUrl())?.[1] ?? 'orion_dev';
    expect(JSON.parse((await orion({ home: h, database: s }, 'db', 'query-ro', '--role', role, 'select current_user as u')).out).rows).toEqual([{ u: role }]);
    for (const [q, code] of [
      ['\\! cat ~/shared/.env', 'query_backslash'],
      ["select E'\\x41'", 'query_backslash'],
      ['select 1; select 2', 'query_multiple'],
      ['commit; set transaction read write', 'query_multiple'],
      ['select 1;', 'query_multiple'],
      ["select 'open", 'query_unclosed_quote'],
      ['   ', 'query_empty'],
    ] as const) {
      const r = await orion({ home: h, database: s }, 'db', 'query-ro', q, '--json');
      expect(JSON.parse(r.out).error.code, q).toBe(code);
      expect(r.exit, q).toEqual([1]);
    }
    expect(JSON.parse((await orion({ home: h, database: s }, 'db', 'query-ro', '--role', 'Bad-Role', 'select 1')).out).error.code).toBe('invalid_role');
    expect(JSON.parse((await orion({ home: h, database: s }, 'db', 'query-ro', 'select count(*)::int as n from coverage')).out).rows).toEqual([{ n: 0 }]);
  });

  it('db query-ro: urlForRole swaps only the user (and drops a password)', async () => {
    const { urlForRole } = await import('../../src/db/queryRo.js');
    expect(urlForRole('postgresql://orion_prod@/orion_prod?host=/var/run/postgresql', 'orion_prod_ro')).toBe('postgresql://orion_prod_ro@/orion_prod?host=/var/run/postgresql');
    expect(urlForRole('postgres://u:pw@db:5432/x', 'r')).toBe('postgres://r@db:5432/x');
    expect(urlForRole('postgresql:///x?host=/run', 'r')).toBe('postgresql://r@/x?host=/run');
  });

  it('asset registry diff (I-6) reads the registry on a schema one migration behind (a release that brings a migration), and on an absent schema', async () => {
    const s = await schema({ migrate: true });
    const db = await openDb(s, { checkSchema: false });
    try {
      await db.run('DELETE FROM schema_migrations WHERE id = 2'); // the tables exist, the newest migration is pending
    } finally {
      await db.close();
    }
    const h = home();
    const r = await orion({ home: h, database: s }, 'asset', 'registry', 'diff', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toMatchObject({ added: ['mini'], missing: [], schemaPending: [2] });
    // other commands still refuse the schema behind
    expect(JSON.parse((await orion({ home: h, database: s }, 'asset', 'registry', '--json')).out).error.code).toBe('schema_behind');
    const absent = await schema({ migrate: false });
    const a = await orion({ home: h, database: absent }, 'asset', 'registry', 'diff', '--json');
    expect(a.exit).toEqual([]);
    expect(JSON.parse(a.out)).toMatchObject({ added: ['mini'], schemaPending: [1, 2, 3, 4, 5, 6] });
    expect(await tables(absent)).toEqual([]);
  });

  it('a command on a schema ahead runs', async () => {
    const s = await schema({ migrate: true });
    const db = await openDb(s);
    try {
      await db.run("INSERT INTO schema_migrations (id, name, sha256, applied_at) VALUES (7, 'from_a_newer_build', 'x', now())");
    } finally {
      await db.close();
    }
    const h = home();
    const r = await orion({ home: h, database: s }, 'persona', 'assign', 'mini', 'analyst', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toMatchObject({ assetId: 'mini', persona: 'analyst' });
    expect(JSON.parse((await orion({ home: h, database: s }, 'db', 'status', '--json')).out)).toMatchObject({ dbAt: 7, codeRequires: 6, state: 'ahead' });
  });

  it('db backfill-provenance is gone with 0006 (nothing can be null): an unknown command', async () => {
    await expect(orion({ home: home(), database: await schema({ migrate: true }) }, 'db', 'backfill-provenance', '--json')).rejects.toThrow(/unknown command 'backfill-provenance'/);
  });
});
