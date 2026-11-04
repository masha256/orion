import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import type { DatabaseConfig } from '../../src/db/connection.js';
import { openPgDb, type PgDb } from '../../src/db/pg/pool.js';
import { CARRIED_TABLES } from '../../tools/import-sqlite/carry.js';
import { runCli } from '../../tools/import-sqlite/cli.js';
import { importSqlite, type ImportManifest } from '../../tools/import-sqlite/importer.js';
import { devPaths } from '../helpers/db.js';
import { buildSqliteFixture, FIXTURE_EXPECTED, FIXTURE_SEQUENCES, type SqliteFixture } from '../helpers/sqliteFixture.js';
import { createTestSchema, dropTestSchema } from '../setup/pgGlobal.js';

let config: DatabaseConfig;
let pg: PgDb;
const dirs: string[] = [];
const extraSchemas: DatabaseConfig[] = [];

beforeEach(async () => {
  config = await createTestSchema();
  pg = await openPgDb(config);
});
afterEach(async () => {
  await pg.close();
  await dropTestSchema(config);
  for (const c of extraSchemas.splice(0)) await dropTestSchema(c);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(opts: Parameters<typeof buildSqliteFixture>[0] = {}): SqliteFixture {
  const f = buildSqliteFixture(opts);
  dirs.push(f.dir);
  return f;
}

const run = (f: SqliteFixture, to: DatabaseConfig = config) => importSqlite({ from: f.path, to, assetsDir: f.assetsDir });

async function codeOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
  throw new Error('expected a refusal');
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of CARRIED_TABLES) out[t.table] = (await pg.one<{ n: number }>(`SELECT count(*) AS n FROM ${t.table}`))!.n;
  return out;
}
const allEmpty = () => Object.fromEntries(CARRIED_TABLES.map((t) => [t.table, 0]));

describe('import', () => {
  it('import: carried and excluded counts per table, and the excluded ids, match the fixture', async () => {
    const f = fixture();
    const m = await run(f);
    expect(m.tables.map((t) => t.table)).toEqual([
      'agent_runs', 'agent_transcripts', 'coverage', 'documents', 'journal', 'proposals', 'observations', 'fetch_runs', 'fetch_cursors', 'anomalies',
    ]);
    for (const t of m.tables) {
      const want = FIXTURE_EXPECTED[t.table as keyof typeof FIXTURE_EXPECTED];
      const excludedIds = want.excluded.reduce((n, e) => n + e.ids.length, 0);
      expect(t, t.table).toEqual({
        table: t.table,
        sqlite_rows: want.rows,
        carried: want.rows - excludedIds,
        excluded: want.excluded.map((e) => ({ reason: e.reason, count: e.ids.length, ids: [...e.ids] })),
      });
    }
    expect(await counts()).toEqual(Object.fromEntries(m.tables.map((t) => [t.table, t.carried])));
    expect((await pg.all<{ id: number }>('SELECT id FROM observations ORDER BY id')).map((r) => r.id)).toEqual([1, 2, 4, 7, 8]);
    expect((await pg.all<{ id: number }>('SELECT id FROM proposals ORDER BY id')).map((r) => r.id)).toEqual([1, 3, 4]);
    expect((await pg.all<{ run_id: number }>('SELECT run_id FROM agent_transcripts')).map((r) => r.run_id)).toEqual([2]);
    // The superseded chain survives (2 supersedes 1), and values come back as stored.
    expect(await pg.one('SELECT superseded_by FROM observations WHERE id = 1')).toEqual({ superseded_by: 2 });
    expect(await pg.one('SELECT value, fetched_at FROM observations WHERE id = 2')).toEqual({ value: 0.1 + 0.2, fetched_at: '2026-10-02T08:30:15.123Z' });
    expect(await pg.one('SELECT published_at FROM documents WHERE id = 1')).toEqual({ published_at: '2026-10-22T16:00:00Z' });
    expect(m.tables_not_carried).toEqual([
      { table: 'run_locks', rows: 1 },
      { table: 'config_versions', rows: 1 },
      { table: 'assumption_sets', rows: 0 },
      { table: 'assumptions', rows: 0 },
      { table: 'assumption_changes', rows: 0 },
      { table: 'assumption_evidence', rows: 0 },
      { table: 'snapshots', rows: 1 },
      { table: 'valuation_runs', rows: 1 },
      { table: 'signals', rows: 1 },
      { table: 'trigger_firings', rows: 0 },
    ]);
    expect(m.source).toMatchObject({ path: f.path, bytes: statSync(f.path).size, schema: 8, integrity: 'ok' });
    expect(m.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.target).toEqual({ database: 'orion_test', schema: config.schema, schemaVersion: 1 });
    expect(Date.parse(m.ended_at)).toBeGreaterThanOrEqual(Date.parse(m.started_at));
  });

  it('import: next id per table is sqlite_sequence + 1', async () => {
    const m = await run(fixture());
    const identity = CARRIED_TABLES.filter((t) => t.identity).map((t) => t.table);
    expect(m.sequences).toEqual(
      CARRIED_TABLES.filter((t) => t.identity).map((t) => ({ table: t.table, sqlite_seq: FIXTURE_SEQUENCES[t.table] ?? null, next_id: (FIXTURE_SEQUENCES[t.table] ?? 0) + 1 })),
    );
    expect(identity).toEqual(['agent_runs', 'documents', 'journal', 'proposals', 'observations', 'fetch_runs', 'anomalies']);
    const inserted = await pg.one<{ id: number }>(
      `INSERT INTO observations (asset_id, metric_key, observed_at, value, source, status, fetched_at)
       VALUES ('mini', 'price_usd', now(), 1, 'manual', 'confirmed', now()) RETURNING id`,
    );
    expect(inserted!.id).toBe(10); // sqlite_sequence 9, past the max carried id 8
    const p = await pg.one<{ id: number }>(
      `INSERT INTO proposals (asset_id, persona, kind, change_json, filed_against_json, rationale, evidence_json, status, created_at)
       VALUES ('mini', 'analyst', 'config', '{}', '{}', 'r', '[]', 'pending', now()) RETURNING id`,
    );
    expect(p!.id).toBe(5); // the excluded assumption_value proposal 2 keeps its id unused
  });

  it('import: a table with no sqlite_sequence row starts at 1', async () => {
    const f = fixture({
      mutate: (db) => {
        db.prepare('DELETE FROM documents').run();
        db.prepare("DELETE FROM sqlite_sequence WHERE name = 'documents'").run();
      },
    });
    const m = await run(f);
    expect(m.sequences.find((s) => s.table === 'documents')).toEqual({ table: 'documents', sqlite_seq: null, next_id: 1 });
    const d = await pg.one<{ id: number }>(
      `INSERT INTO documents (asset_id, kind, source_url, added_at, sha256, bytes, text) VALUES ('mini', 'post', 'u', now(), 'x', 1, 't') RETURNING id`,
    );
    expect(d!.id).toBe(1);
  });

  it('import: refuses a non-empty target and writes nothing', async () => {
    await pg.run("INSERT INTO coverage (asset_id, persona, assigned_at) VALUES ('zeta', 'analyst', now())");
    const r = await codeOf(run(fixture()));
    expect(r.code).toBe('import_target_not_empty');
    expect(r.message).toContain('coverage');
    expect(await counts()).toEqual({ ...allEmpty(), coverage: 1 });
  });

  it('import: refuses a schema-7 source', async () => {
    const r = await codeOf(run(fixture({ schema: 7 })));
    expect(r.code).toBe('import_source_schema');
    expect(r.message).toMatch(/schema 7.*needs 8/);
    expect(await counts()).toEqual(allEmpty());
  });

  it('import: refuses a target not migrated', async () => {
    const bare = await createTestSchema({ migrate: false });
    extraSchemas.push(bare);
    const r = await codeOf(run(fixture(), bare));
    expect(r).toEqual({ code: 'import_target_not_current', message: expect.stringContaining('run orion db migrate') as string });
    expect(await pg.one("SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1", [bare.schema])).toEqual({ n: 0 });
  });

  it('import: refuses a non-canonical timestamp', async () => {
    const f = fixture({ mutate: (db) => db.prepare("UPDATE fetch_runs SET started_at = '2026-10-01T00:00:00Z' WHERE id = 2").run() });
    const r = await codeOf(run(f));
    expect(r.code).toBe('import_bad_timestamp');
    expect(r.message).toContain('fetch_runs');
    expect(r.message).toContain('id 2');
    expect(r.message).toContain('started_at');
    expect(r.message).toContain('2026-10-01T00:00:00Z');
    expect(await counts()).toEqual(allEmpty());
    // An offset or a bare date is refused just the same; documents.published_at is text and carried as given.
    for (const v of ['2026-10-01T00:00:00.000+00:00', '2026-10-01']) {
      const g = fixture({ mutate: (db) => db.prepare('UPDATE anomalies SET decided_at = ? WHERE id = 2').run(v) });
      expect((await codeOf(run(g))).message).toContain(`anomalies id 2 decided_at`);
    }
  });

  it('import: refuses a NUL byte', async () => {
    const f = fixture({ mutate: (db) => db.prepare("UPDATE documents SET text = 'before' || char(0) || 'after' WHERE id = 1").run() });
    const r = await codeOf(run(f));
    expect(r.code).toBe('import_nul_byte');
    expect(r.message).toContain('documents id 1 text');
    expect(await counts()).toEqual(allEmpty());
    const g = fixture({ mutate: (db) => db.prepare("UPDATE fetch_runs SET detail_json = '{\"a\":\"' || char(0) || '\"}' WHERE id = 3").run() });
    expect(await codeOf(run(g))).toMatchObject({ code: 'import_nul_byte', message: expect.stringContaining('fetch_runs id 3 detail_json') as string });
  });

  it('import: refuses a dangling reference', async () => {
    // A pending confirm_observation proposal on observation 3, an undeclared metric (excluded), and a carried
    // observation superseded by an excluded one.
    const f = fixture({
      mutate: (db) => {
        db.prepare(
          `INSERT INTO proposals (id, asset_id, persona, kind, change_json, filed_against_json, rationale, evidence_json, status, created_at)
           VALUES (5, 'mini', 'analyst', 'confirm_observation', '{"kind":"confirm_observation","observationId":3,"note":"n"}', '{}', 'r', '[]', 'pending', '2026-10-01T00:00:00.000Z')`,
        ).run();
        db.prepare('UPDATE observations SET superseded_by = 5 WHERE id = 4').run();
      },
    });
    const r = await codeOf(run(f));
    expect(r.code).toBe('import_dangling_ref');
    expect(r.message).toContain('proposals 5 (observationId 3)');
    expect(r.message).toContain('observations 4 (superseded_by 5)');
    expect(await counts()).toEqual(allEmpty());
    // A decided proposal on an excluded observation is history, not an action: it is carried.
    const g = fixture({
      mutate: (db) =>
        db.prepare(
          `INSERT INTO proposals (id, asset_id, persona, kind, change_json, filed_against_json, rationale, evidence_json, status, created_at)
           VALUES (5, 'mini', 'analyst', 'reject_observation', '{"kind":"reject_observation","observationId":3,"note":"n"}', '{}', 'r', '[]', 'rejected', '2026-10-01T00:00:00.000Z')`,
        ).run(),
    });
    expect((await run(g)).tables.find((t) => t.table === 'proposals')!.carried).toBe(4);
  });

  it('import: a failure mid-copy leaves the target empty', async () => {
    // A kind Postgres' CHECK refuses, in the last table copied (SQLite's own CHECK is switched off to plant it).
    const f = fixture({
      mutate: (db) => {
        db.pragma('ignore_check_constraints = ON');
        db.prepare("UPDATE anomalies SET kind = 'not_a_kind' WHERE id = 2").run();
      },
    });
    await expect(run(f)).rejects.toThrow(/anomalies_kind_check/);
    expect(await counts()).toEqual(allEmpty());
    const seq = await pg.one<{ v: number | null }>("SELECT last_value AS v FROM pg_sequences WHERE schemaname = $1 AND sequencename = 'observations_id_seq'", [config.schema]);
    expect(seq!.v).toBeNull(); // the setvals rolled back with the rows
  });

  it('import: a carried weekly run without transcript still shows', async () => {
    await run(fixture());
    const home = mkdtempSync(join(tmpdir(), 'orion-import-home-'));
    dirs.push(home);
    const lines: string[] = [];
    let exit: number | undefined;
    const orion = async (...args: string[]) => {
      lines.length = 0;
      exit = undefined;
      const program = buildProgram({ ...devPaths(home), stdout: (l) => lines.push(l), now: () => new Date('2026-10-05T00:00:00.000Z'), setExitCode: (c) => (exit = c), database: config });
      await program.parseAsync(args, { from: 'user' });
      return lines.join('\n');
    };
    const shown = JSON.parse(await orion('agent', 'runs', 'show', '1', '--transcript', '--json')) as { id: number; runType: string; transcript: unknown };
    expect(exit).toBeUndefined();
    expect(shown).toMatchObject({ id: 1, runType: 'weekly', transcript: null });
    expect((JSON.parse(await orion('agent', 'runs', 'show', '2', '--transcript', '--json')) as { transcript: unknown }).transcript).toEqual([
      { role: 'user', content: 'disclosure pack' },
    ]);
    const listed = await orion('agent', 'runs', 'list');
    expect(exit).toBeUndefined();
    expect(listed).toMatch(/#1\b.*weekly/);
    expect(listed).toMatch(/#3\b.*triage/);
  });

  it('import: the manifest is on stdout and in the manifest dir, mode 600, and never contains the URL', async () => {
    const f = fixture();
    const manifestDir = mkdtempSync(join(tmpdir(), 'orion-import-manifests-'));
    dirs.push(manifestDir);
    const out: string[] = [];
    const args = ['import', '--from', f.path, '--to', config.url, '--schema', config.schema, '--assets', f.assetsDir];
    expect(await runCli([...args, '--manifest-dir', manifestDir], { stdout: (l) => out.push(l), env: {} })).toBe(0);
    const files = readdirSync(manifestDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^import-\d{8}T\d{6}Z\.json$/);
    const path = join(manifestDir, files[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    expect(text).toBe(`${out.join('\n')}\n`);
    expect((JSON.parse(text) as ImportManifest).tables.find((t) => t.table === 'observations')!.carried).toBe(5);
    expect(text).not.toContain(config.url);
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('/var/run/postgresql');

    // ORION_HOME is the default manifest dir; with neither, the tool refuses before it reads anything.
    const out2: string[] = [];
    expect(await runCli(args, { stdout: (l) => out2.push(l), env: {} })).toBe(1);
    expect(JSON.parse(out2.join('\n'))).toEqual({ error: { code: 'no_manifest_dir', message: expect.any(String) as string } });
    // A refusal is JSON on stdout with exit 1, and names no URL either (the target is now not empty).
    const out3: string[] = [];
    expect(await runCli(args, { stdout: (l) => out3.push(l), env: { ORION_HOME: manifestDir } })).toBe(1);
    const err = JSON.parse(out3.join('\n')) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('import_target_not_empty');
    expect(out3.join('\n')).not.toContain('postgresql://');
    expect(readdirSync(manifestDir)).toHaveLength(1);
  });
});

describe('carry', () => {
  it('carry: the tables, columns and type classes match the Postgres baseline', async () => {
    const cols = await pg.all<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name <> 'schema_migrations'
       ORDER BY table_name, ordinal_position`,
      [config.schema],
    );
    const pgTypeOf: Record<string, string> = {
      bigint: 'int', smallint: 'int', 'double precision': 'real', text: 'text', json: 'json', 'timestamp with time zone': 'timestamptz', date: 'date',
    };
    const fromPg = new Map<string, [string, string][]>();
    for (const c of cols) fromPg.set(c.table_name, [...(fromPg.get(c.table_name) ?? []), [c.column_name, pgTypeOf[c.data_type] ?? c.data_type]]);
    expect([...fromPg.keys()].sort()).toEqual(CARRIED_TABLES.map((t) => t.table).sort());
    for (const t of CARRIED_TABLES) expect(t.columns.map((c) => [c.name, c.type]), t.table).toEqual(fromPg.get(t.table));
  });
});
