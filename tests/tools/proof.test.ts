import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DatabaseConfig } from '../../src/db/connection.js';
import { openPgDb, type PgDb } from '../../src/db/pg/pool.js';
import { CARRIED_TABLES } from '../../tools/import-sqlite/carry.js';
import { runCli } from '../../tools/import-sqlite/cli.js';
import { IMPORT_SCHEMA_LEVEL, importSqlite, type ImportManifest } from '../../tools/import-sqlite/importer.js';
import { proveImport } from '../../tools/import-sqlite/proof.js';
import { compareReports } from '../../tools/import-sqlite/reports.js';
import { rowHash } from '../../tools/import-sqlite/rowHash.js';
import { buildSqliteFixture, type SqliteFixture } from '../helpers/sqliteFixture.js';
import { createTestSchema, dropTestSchema } from '../setup/pgGlobal.js';

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('rowHash', () => {
  it("rowHash: equal for the same row read from SQLite and Postgres; differs for 0 vs -0, '1' vs 1, null vs ''", async () => {
    expect(rowHash([0])).not.toBe(rowHash([-0]));
    expect(rowHash(['1'])).not.toBe(rowHash([1]));
    expect(rowHash([null])).not.toBe(rowHash(['']));
    expect(rowHash(['a\u001fb'])).not.toBe(rowHash(['a', 'b'])); // the length prefix keeps a separator in the text apart
    expect(rowHash([1, 'x', null])).toBe(rowHash([1, 'x', null]));
    expect(rowHash([])).toMatch(/^[0-9a-f]{64}$/);
    for (const v of [true, new Date(0), 1n, Buffer.from('x'), undefined, {}]) expect(() => rowHash([v])).toThrow(/cannot encode/);

    const f = buildSqliteFixture();
    dirs.push(f.dir);
    const config = await createTestSchema({ upTo: IMPORT_SCHEMA_LEVEL });
    try {
      await importSqlite({ from: f.path, to: config, assetsDir: f.assetsDir });
      const lite = new Database(f.path, { readonly: true });
      const db = await openDb(config, { checkSchema: false }); // the import schema sits at IMPORT_SCHEMA_LEVEL
      try {
        for (const t of CARRIED_TABLES) {
          const sql = `SELECT ${t.columns.map((c) => c.name).join(', ')} FROM ${t.table} ORDER BY ${t.primaryKey.join(', ')}`;
          const pgRows = (await db.all(sql)).map((r) => t.columns.map((c) => r[c.name]));
          const pgIds = new Set(pgRows.map((r) => JSON.stringify(t.primaryKey.map((k) => r[t.columns.findIndex((c) => c.name === k)]))));
          // The SQLite rows that were carried, each against the Postgres row with its key.
          const liteRows = (lite.prepare(sql).raw().all() as unknown[][]).filter((r) =>
            pgIds.has(JSON.stringify(t.primaryKey.map((k) => r[t.columns.findIndex((c) => c.name === k)]))),
          );
          expect(liteRows.length, t.table).toBeGreaterThan(0);
          expect(pgRows.map(rowHash), t.table).toEqual(liteRows.map(rowHash));
        }
      } finally {
        lite.close();
        await db.close();
      }
    } finally {
      await dropTestSchema(config);
    }
  });
});

describe('proof', () => {
  let config: DatabaseConfig;
  let pg: PgDb;
  let f: SqliteFixture;
  let manifest: ImportManifest;
  beforeEach(async () => {
    config = await createTestSchema({ upTo: IMPORT_SCHEMA_LEVEL });
    pg = await openPgDb(config);
    f = buildSqliteFixture();
    dirs.push(f.dir);
    manifest = await importSqlite({ from: f.path, to: config, assetsDir: f.assetsDir });
  });
  afterEach(async () => {
    await pg.close();
    await dropTestSchema(config);
  });
  const prove = () => proveImport({ from: f.path, to: config, assetsDir: f.assetsDir, manifest });

  it('proof: an import of the Task 9 fixture proves ok on every table and sequence', async () => {
    const r = await prove();
    expect(r.ok).toBe(true);
    expect(r.tables.map((t) => t.table)).toEqual(CARRIED_TABLES.map((t) => t.table));
    for (const t of r.tables) {
      expect(t.first_mismatch, t.table).toBeNull();
      expect(t.sha256_pg, t.table).toBe(t.sha256_sqlite);
      expect([t.pg_rows, t.manifest_carried], t.table).toEqual([t.sqlite_carried, t.sqlite_carried]);
    }
    expect(r.tables.find((t) => t.table === 'observations')!.pg_rows).toBe(5);
    expect(r.sequences.find((s) => s.table === 'observations')).toEqual({ table: 'observations', expected_next: 10, pg_next: 10, ok: true });
    expect(r.sequences).toHaveLength(7);

    // Through the CLI: the result on stdout, exit 0.
    const manifestPath = join(tempDir('orion-proof-'), 'import.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const out: string[] = [];
    const args = ['proof', '--from', f.path, '--to', config.url, '--schema', config.schema, '--assets', f.assetsDir, '--manifest', manifestPath];
    expect(await runCli(args, { stdout: (l) => out.push(l), env: {} })).toBe(0);
    expect((JSON.parse(out.join('\n')) as { ok: boolean }).ok).toBe(true);
  });

  it('proof: an UPDATE of one Postgres value is reported as that table, pk and column', async () => {
    await pg.run('UPDATE observations SET value = 2.75 WHERE id = 4');
    const r = await prove();
    expect(r.ok).toBe(false);
    const obs = r.tables.find((t) => t.table === 'observations')!;
    expect(obs.first_mismatch).toEqual({ pk: 4, column: 'value', sqlite: 2.5, pg: 2.75 });
    expect(obs.sha256_pg).not.toBe(obs.sha256_sqlite);
    expect(r.tables.filter((t) => t.first_mismatch).map((t) => t.table)).toEqual(['observations']);
    // A composite key names every key column; a missing row names the row, no column.
    await pg.run("UPDATE fetch_cursors SET last_day = '2026-10-02'");
    await pg.run('DELETE FROM journal');
    const r2 = await prove();
    expect(r2.tables.find((t) => t.table === 'fetch_cursors')!.first_mismatch).toEqual({
      pk: ['mini', 'transfers:0xabc'], column: 'last_day', sqlite: '2026-10-01', pg: '2026-10-02',
    });
    expect(r2.tables.find((t) => t.table === 'journal')).toMatchObject({ pg_rows: 0, first_mismatch: { pk: 1, column: null, pg: null } });

    const manifestPath = join(tempDir('orion-proof-'), 'import.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const args = ['proof', '--from', f.path, '--to', config.url, '--schema', config.schema, '--assets', f.assetsDir, '--manifest', manifestPath];
    expect(await runCli(args, { stdout: () => undefined, env: {} })).toBe(1);
  });

  it('proof: a setval that moves a sequence fails sequences', async () => {
    await pg.run("SELECT setval(pg_get_serial_sequence('observations', 'id'), 20, true)");
    const r = await prove();
    expect(r.ok).toBe(false);
    expect(r.tables.every((t) => t.first_mismatch === null)).toBe(true);
    expect(r.sequences.filter((s) => !s.ok)).toEqual([{ table: 'observations', expected_next: 10, pg_next: 21, ok: false }]);
  });

  it('proof: a manifest whose carried count differs fails that table', async () => {
    const edited = { ...manifest, tables: manifest.tables.map((t) => (t.table === 'proposals' ? { ...t, carried: t.carried + 1 } : t)) };
    const r = await proveImport({ from: f.path, to: config, assetsDir: f.assetsDir, manifest: edited });
    expect(r.ok).toBe(false);
    expect(r.tables.find((t) => t.table === 'proposals')).toMatchObject({ sqlite_carried: 3, pg_rows: 3, manifest_carried: 4, first_mismatch: null });
  });
});

describe('reports', () => {
  /** A stand-in for a release's built CLI: prints what `out` gives for its arguments, as the CLI prints JSON. */
  function stubCli(dir: string, name: string, out: Record<string, unknown>): string {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(
      path,
      `const out = ${JSON.stringify(out)};
const args = process.argv.slice(2);
const key = args.join(' ');
if (key === 'report yield --help') { console.log(out[key] ?? 'Usage: orion report yield [options] [asset]\\n  --day <yyyy-mm-dd>\\n  --json'); process.exit(0); }
if (!(key in out)) { console.error('unknown: ' + key); process.exit(2); }
const v = out[key];
console.log(JSON.stringify(v === 'ENV' ? { home: process.env.ORION_HOME === process.cwd(), url: process.env.ORION_DATABASE_URL ?? null } : v, null, 2));
`,
    );
    return path;
  }
  function home(dir: string, name: string): string {
    const h = join(dir, name);
    mkdirSync(join(h, 'assets'), { recursive: true });
    for (const a of ['beta', 'mini']) writeFileSync(join(h, 'assets', `${a}.yaml`), `id: ${a}\n`);
    return h;
  }
  const manifest = { tables: [{ table: 'proposals', sqlite_rows: 3, carried: 2, excluded: [{ reason: 'retired_kind', count: 1, ids: [2] }] }] } as ImportManifest;
  const outputs = (betaValue: number, proposals: unknown[]) => ({
    'report yield mini --day 2026-10-30 --json': 'ENV',
    'report yield beta --day 2026-10-30 --json': { asset: 'beta', yield: betaValue },
    'data anomalies --all --json': [{ id: 1, kind: 'cross_check_mismatch' }],
    'proposals list --all --json': proposals,
  });

  it('reports: identical outputs pass; one differing byte fails naming the file; excluded proposal ids are filtered from the old list', async () => {
    const dir = tempDir('orion-reports-');
    const oldCli = stubCli(dir, 'old', outputs(1.5, [{ id: 3, kind: 'config' }, { id: 2, kind: 'assumption_value' }, { id: 1, kind: 'config' }]));
    const newCli = stubCli(dir, 'new', outputs(1.5, [{ id: 3, kind: 'config' }, { id: 1, kind: 'config' }]));
    const badCli = stubCli(dir, 'bad', outputs(1.6, [{ id: 3, kind: 'config' }, { id: 1, kind: 'config' }]));
    const oldHome = home(dir, 'old-home');
    const newHome = home(dir, 'new-home');
    const saved = process.env.ORION_DATABASE_URL;
    process.env.ORION_DATABASE_URL = 'postgresql://someone@/elsewhere'; // the homes' .env decide, not the caller's environment
    try {
      const out = join(dir, 'out');
      const r = await compareReports({ oldCli, oldHome, newCli, newHome, day: '2026-10-30', manifest, out });
      expect(r).toEqual({
        ok: true, legacy: false,
        files: ['report-yield-beta.json', 'report-yield-mini.json', 'anomalies.json', 'proposals.json'].map((name) => ({ name, identical: true, old_exit: 0, new_exit: 0 })),
      });
      expect(JSON.parse(readFileSync(join(out, 'new', 'report-yield-mini.json'), 'utf8'))).toEqual({ home: true, url: null });
      expect(readFileSync(join(out, 'old', 'proposals.json'), 'utf8')).toBe(`${JSON.stringify([{ id: 3, kind: 'config' }, { id: 1, kind: 'config' }], null, 2)}\n`);

      const out2 = join(dir, 'out2');
      const r2 = await compareReports({ oldCli, oldHome, newCli: badCli, newHome, day: '2026-10-30', manifest, out: out2 });
      expect(r2.ok).toBe(false);
      expect(r2.files.filter((x) => !x.identical).map((x) => x.name)).toEqual(['report-yield-beta.json']);

      // Without the manifest's filter the old list differs: the filter is what makes it pass.
      const r3 = await compareReports({ oldCli, oldHome, newCli, newHome, day: '2026-10-30', manifest: { tables: [] } as unknown as ImportManifest, out: join(dir, 'out3') });
      expect(r3.files.filter((x) => !x.identical).map((x) => x.name)).toEqual(['proposals.json']);

      // Through the CLI: exit 0 iff ok.
      const manifestPath = join(dir, 'import.json');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      // A relative CLI path is the caller's (the CLIs run with the home as their working directory).
      const base = ['reports', '--old-cli', relative(process.cwd(), oldCli), '--old-home', oldHome, '--new-home', newHome, '--day', '2026-10-30', '--manifest', manifestPath];
      const lines: string[] = [];
      expect(await runCli([...base, '--new-cli', newCli, '--out', join(dir, 'out4')], { stdout: (l) => lines.push(l), env: {} })).toBe(0);
      expect((JSON.parse(lines.join('\n')) as { ok: boolean }).ok).toBe(true);
      expect(await runCli([...base, '--new-cli', badCli, '--out', join(dir, 'out5')], { stdout: () => undefined, env: {} })).toBe(1);

      // A CLI that prints nothing (here: a path that does not exist, run by node) proves nothing, even against itself.
      const missing = join(dir, 'missing.mjs');
      const r6 = await compareReports({ oldCli: missing, oldHome, newCli: missing, newHome, day: '2026-10-30', manifest, out: join(dir, 'out6') });
      expect(r6.ok).toBe(false);
      expect(r6.files.every((x) => !x.identical && x.old_exit === 1 && x.new_exit === 1)).toBe(true);
      expect(readFileSync(join(dir, 'out6', 'new', 'anomalies.json.stderr'), 'utf8')).toContain('Cannot find module');
    } finally {
      if (saved === undefined) delete process.env.ORION_DATABASE_URL;
      else process.env.ORION_DATABASE_URL = saved;
    }
  });

  it('reports: a new release whose report yield --help lists --legacy runs with it, compared without its incomeStatement (D9)', async () => {
    const dir = tempDir('orion-reports-legacy-');
    const beta = { asset: 'beta', yield: 1.5 };
    const v2Outputs = (yieldValue: number) => ({
      'report yield --help': 'Usage: orion report yield [options] [asset]\n  --day <yyyy-mm-dd>\n  --json\n  --legacy  also the v1 keys',
      'report yield mini --day 2026-10-30 --json --legacy': { home: true, url: null, incomeStatement: { schema: 2, revenue: 7 } },
      'report yield beta --day 2026-10-30 --json --legacy': { ...beta, yield: yieldValue, incomeStatement: { schema: 2, revenue: 9 } },
      // Without --legacy the release drops the v1 keys: a run without the flag would differ.
      'report yield beta --day 2026-10-30 --json': { asset: 'beta', incomeStatement: { schema: 2 } },
      'report yield mini --day 2026-10-30 --json': { incomeStatement: { schema: 2 } },
      'data anomalies --all --json': [{ id: 1, kind: 'cross_check_mismatch' }],
      'proposals list --all --json': [{ id: 3, kind: 'config' }, { id: 1, kind: 'config' }],
    });
    const oldCli = stubCli(dir, 'old', { ...outputs(1.5, [{ id: 3, kind: 'config' }, { id: 2, kind: 'assumption_value' }, { id: 1, kind: 'config' }]), 'report yield mini --day 2026-10-30 --json': { home: true, url: null } });
    const newCli = stubCli(dir, 'new', v2Outputs(1.5));
    const out = join(dir, 'out');
    const r = await compareReports({ oldCli, oldHome: home(dir, 'old-home'), newCli, newHome: home(dir, 'new-home'), day: '2026-10-30', manifest, out });
    expect(r).toEqual({
      ok: true, legacy: true,
      files: ['report-yield-beta.json', 'report-yield-mini.json', 'anomalies.json', 'proposals.json'].map((name) => ({ name, identical: true, old_exit: 0, new_exit: 0 })),
    });
    // The compared file is the CLI's own serialisation less incomeStatement; the printed output is kept beside it.
    expect(readFileSync(join(out, 'new', 'report-yield-beta.json'), 'utf8')).toBe(`${JSON.stringify(beta, null, 2)}\n`);
    expect(JSON.parse(readFileSync(join(out, 'new', 'report-yield-beta.unstripped.json'), 'utf8'))).toEqual({ ...beta, incomeStatement: { schema: 2, revenue: 9 } });
    // A legacy byte that differs still fails.
    const bad = await compareReports({ oldCli, oldHome: home(dir, 'old-home2'), newCli: stubCli(dir, 'bad', v2Outputs(1.6)), newHome: home(dir, 'new-home2'), day: '2026-10-30', manifest, out: join(dir, 'out2') });
    expect(bad.files.filter((x) => !x.identical).map((x) => x.name)).toEqual(['report-yield-beta.json']);
    // A new CLI whose --help fails runs without the flag, so the comparison fails closed (never a silent pass).
    const missing = join(dir, 'missing.mjs');
    const r3 = await compareReports({ oldCli, oldHome: home(dir, 'old-home3'), newCli: missing, newHome: home(dir, 'new-home3'), day: '2026-10-30', manifest, out: join(dir, 'out3') });
    expect(r3).toMatchObject({ ok: false, legacy: false });
    expect(readFileSync(join(dir, 'out3', 'new', 'report-yield-help.txt.stderr'), 'utf8')).toContain('Cannot find module');
  });
});
