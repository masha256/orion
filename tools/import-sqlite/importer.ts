import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import type { DatabaseConfig } from '../../src/db/connection.js';
import { migrationStatus } from '../../src/db/pg/migrate.js';
import { openPgDb, type PgDb } from '../../src/db/pg/pool.js';
import { OrionError } from '../../src/types.js';
import { carryPlan, TABLES_NOT_CARRIED, type CarryPlan, type CarryTable } from './carry.js';

/** The SQLite schema the importer reads: the last one the SQLite release shipped. */
export const SOURCE_SCHEMA = 8;
const BATCH = 500;

export interface ImportManifest {
  source: { path: string; sha256: string; bytes: number; schema: 8; integrity: 'ok' };
  target: { database: string; schema: string; schemaVersion: number };
  started_at: string;
  ended_at: string;
  tables: { table: string; sqlite_rows: number; carried: number; excluded: { reason: string; count: number; ids: (number | string)[] }[] }[];
  tables_not_carried: { table: string; rows: number }[];
  sequences: { table: string; sqlite_seq: number | null; next_id: number }[];
}

/** Every asset YAML in `dir`, parsed as the release parses it; the file name must match the id. */
export function loadAssetsDir(dir: string): AssetConfig[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const config = parseAssetYaml(readFileSync(join(dir, f), 'utf8')).config;
      if (`${config.id}.yaml` !== f) throw new OrionError('invalid_asset_config', `${join(dir, f)}: id "${config.id}" does not match the file name`);
      return config;
    });
}

/** Opens the source read-only and checks it is a sound schema-8 file (`import_source_schema`). */
export function openSource(path: string): Database.Database {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hasMigrations = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const at = hasMigrations ? (sqlite.prepare('SELECT max(id) AS v FROM schema_migrations').get() as { v: number | null }).v : null;
    if (at !== SOURCE_SCHEMA) {
      throw new OrionError('import_source_schema', `${path} is at SQLite schema ${at ?? 'none'}; the importer needs ${SOURCE_SCHEMA} (the last SQLite release's)`);
    }
    const integrity = (sqlite.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new OrionError('import_source_schema', `${path} fails PRAGMA integrity_check: ${integrity.slice(0, 5).join('; ')}`);
    }
    return sqlite;
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/** A carried table's rows, read once: what is checked is what is written. */
interface TableRows {
  plan: CarryTable;
  rows: unknown[][];
  sqliteRows: number;
}

const pkOf = (plan: CarryTable, row: unknown[]) =>
  plan.primaryKey.map((k) => String(row[plan.columns.findIndex((c) => c.name === k)])).join(', ');

function isCanonicalInstant(v: string): boolean {
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
}
function isCanonicalDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && isCanonicalInstant(`${v}T00:00:00.000Z`);
}

/**
 * Every value as Postgres will hold it, unchanged, or a refusal naming the table, row, column and value. A value
 * Postgres would rewrite (a timestamp that is not the 24-char ISO instant, a date that is not `YYYY-MM-DD`) or cannot
 * hold (a NUL byte in text), or one of the wrong storage class (SQLite's typing is per value), is never carried.
 */
function checkValues(tables: TableRows[]): void {
  const bad: Record<'import_bad_timestamp' | 'import_nul_byte' | 'import_bad_value', string[]> = {
    import_bad_timestamp: [],
    import_nul_byte: [],
    import_bad_value: [],
  };
  for (const { plan, rows } of tables) {
    for (const row of rows) {
      plan.columns.forEach((col, i) => {
        const v = row[i];
        if (v === null) return;
        const where = () => `${plan.table} ${plan.primaryKey.length === 1 && plan.primaryKey[0] === 'id' ? 'id ' : `(${plan.primaryKey.join(', ')}) `}${pkOf(plan, row)} ${col.name}`;
        if (col.type === 'int' || col.type === 'real') {
          if (typeof v !== 'number' || (col.type === 'int' && !Number.isSafeInteger(v))) {
            bad.import_bad_value.push(`${where()}: ${JSON.stringify(typeof v === 'string' ? v : String(v))} is not ${col.type === 'int' ? 'an integer' : 'a number'}`);
          }
          return;
        }
        if (typeof v !== 'string') {
          bad.import_bad_value.push(`${where()}: a ${v instanceof Uint8Array ? 'blob' : typeof v} where text is stored`);
          return;
        }
        if (v.includes('\u0000')) bad.import_nul_byte.push(`${where()}: contains a NUL byte at offset ${v.indexOf('\u0000')}`);
        if (col.type === 'timestamptz' && !isCanonicalInstant(v)) {
          bad.import_bad_timestamp.push(`${where()}: ${JSON.stringify(v)} is not a canonical ISO instant (YYYY-MM-DDTHH:MM:SS.sssZ)`);
        }
        if (col.type === 'date' && !isCanonicalDate(v)) bad.import_bad_timestamp.push(`${where()}: ${JSON.stringify(v)} is not a YYYY-MM-DD date`);
      });
    }
  }
  for (const [code, list] of Object.entries(bad)) {
    if (list.length > 0) {
      throw new OrionError(code, `${list.length} value(s) cannot be carried as stored (nothing was written): ${list.slice(0, 20).join('; ')}${list.length > 20 ? '; ...' : ''}`);
    }
  }
}

/**
 * A carried row pointing at an excluded observation would break on use: an observation superseded by an excluded one,
 * or a pending proposal that would confirm or reject one (`import_dangling_ref`, listing them all).
 */
function checkReferences(tables: TableRows[]): void {
  const byName = new Map(tables.map((t) => [t.plan.table, t]));
  const excludedObs = new Set(byName.get('observations')!.plan.excluded.flatMap((e) => e.ids));
  if (excludedObs.size === 0) return;
  const dangling: string[] = [];
  const obs = byName.get('observations')!;
  const supersededBy = obs.plan.columns.findIndex((c) => c.name === 'superseded_by');
  for (const row of obs.rows) {
    if (row[supersededBy] !== null && excludedObs.has(row[supersededBy] as number)) dangling.push(`observations ${String(row[0])} (superseded_by ${String(row[supersededBy])})`);
  }
  const props = byName.get('proposals')!;
  const [status, change] = ['status', 'change_json'].map((n) => props.plan.columns.findIndex((c) => c.name === n)) as [number, number];
  for (const row of props.rows) {
    if (row[status] !== 'pending') continue;
    let observationId: unknown;
    try {
      observationId = (JSON.parse(row[change] as string) as { observationId?: unknown }).observationId;
    } catch {
      continue; // not JSON: Postgres' json type refuses it, and the copy rolls back
    }
    if (typeof observationId === 'number' && excludedObs.has(observationId)) dangling.push(`proposals ${String(row[0])} (observationId ${observationId})`);
  }
  if (dangling.length > 0) {
    throw new OrionError(
      'import_dangling_ref',
      `${dangling.length} carried row(s) point at an excluded observation (nothing was written): ${dangling.join(', ')}; decide or fix them in the SQLite release first`,
    );
  }
}

/**
 * The schema level the import writes into: 0005, the last one whose `observations` takes a row with `source` and no
 * provenance. From 0006 on (Task 10) the column is gone and provenance is NOT NULL, so an import is followed by the
 * release-2 build's `db backfill-provenance` and only then this build's `db migrate --breaking`.
 */
export const IMPORT_SCHEMA_LEVEL = 5;

async function checkTarget(db: PgDb, plan: CarryPlan): Promise<number> {
  const status = await migrationStatus(db);
  if (status.changed.length > 0 || status.dbAt !== IMPORT_SCHEMA_LEVEL || status.applied.length !== IMPORT_SCHEMA_LEVEL) {
    throw new OrionError(
      'import_target_not_current',
      `target schema ${db.schema} is at ${status.dbAt} (${status.state}); the import needs it at exactly ${IMPORT_SCHEMA_LEVEL}: run orion db migrate with a release-2 build (migrations 0001-0005)`,
    );
  }
  const filled: string[] = [];
  for (const t of plan) if (await db.one(`SELECT 1 AS x FROM ${t.table} LIMIT 1`)) filled.push(t.table);
  if (filled.length > 0) {
    throw new OrionError('import_target_not_empty', `target schema ${db.schema} already holds rows in ${filled.join(', ')}: import only into an empty, migrated schema`);
  }
  return status.dbAt;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Copies a SQLite release's database (schema 8) into an empty, migrated Postgres schema, in one transaction, under
 * the carry rules. Every refusal comes before any write; a failure while copying rolls everything back.
 */
export async function importSqlite(opts: { from: string; to: DatabaseConfig; assetsDir: string }): Promise<ImportManifest> {
  const startedAt = new Date().toISOString();
  const from = resolve(opts.from);
  const assets = loadAssetsDir(opts.assetsDir);
  const sqlite = openSource(from);
  try {
    const source = { path: from, sha256: sha256File(from), bytes: statSync(from).size, schema: SOURCE_SCHEMA, integrity: 'ok' } as const;
    const plan = carryPlan(sqlite, assets);
    const db = await openPgDb(opts.to);
    try {
      const schemaVersion = await checkTarget(db, plan);
      const tables: TableRows[] = plan.map((p) => ({
        plan: p,
        rows: sqlite.prepare(p.select).raw().all() as unknown[][],
        sqliteRows: (sqlite.prepare(`SELECT count(*) AS n FROM ${p.table}`).get() as { n: number }).n,
      }));
      checkValues(tables);
      checkReferences(tables);

      const present = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
      const notCarried = TABLES_NOT_CARRIED.map((t) => ({
        table: t,
        rows: present.has(t) ? (sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n : 0,
      }));
      const seqs = new Map((sqlite.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]).map((r) => [r.name, r.seq]));
      const sequences = tables
        .filter((t) => t.plan.identity)
        .map((t) => {
          const seq = seqs.get(t.plan.table) ?? null;
          const maxId = t.rows.reduce((m, r) => Math.max(m, r[0] as number), 0);
          if ((seq ?? 0) < maxId) {
            throw new OrionError('import_source_schema', `${t.plan.table}: sqlite_sequence is ${seq ?? 'absent'} but the highest carried id is ${maxId}`);
          }
          return { table: t.plan.table, sqlite_seq: seq, next_id: (seq ?? 0) + 1 };
        });

      await db.tx(async (t) => {
        await t.run('SET CONSTRAINTS ALL DEFERRED');
        for (const { plan: p, rows } of tables) {
          const names = p.columns.map((c) => c.name).join(', ');
          for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH);
            const values = batch.map((_, r) => `(${p.columns.map((_c, c) => `$${r * p.columns.length + c + 1}`).join(', ')})`).join(', ');
            await t.run(`INSERT INTO ${p.table} (${names}) VALUES ${values}`, batch.flat() as (string | number | null)[]);
          }
        }
        for (const s of sequences) {
          if (s.sqlite_seq === null || s.sqlite_seq < 1) continue; // no sqlite_sequence row: the identity starts at 1
          await t.run(`SELECT setval(pg_get_serial_sequence($1, 'id'), $2, true)`, [`${db.schema}.${s.table}`, s.sqlite_seq]);
        }
      });

      return {
        source,
        target: { database: db.database, schema: db.schema, schemaVersion },
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        tables: tables.map((t) => ({
          table: t.plan.table,
          sqlite_rows: t.sqliteRows,
          carried: t.rows.length,
          excluded: t.plan.excluded.map((e) => ({ reason: e.reason, count: e.ids.length, ids: e.ids })),
        })),
        tables_not_carried: notCarried,
        sequences,
      };
    } finally {
      await db.close();
    }
  } finally {
    sqlite.close();
  }
}
