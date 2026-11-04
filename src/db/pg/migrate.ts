import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { OrionError } from '../../types.js';
import type { PgDb } from './pool.js';

export interface Migration {
  id: number;
  name: string;
  sql: string;
  sha256: string;
  /** The file's first line is `-- breaking`: it is not expand-only, and applying it needs the `breaking` flag. */
  breaking: boolean;
}

export interface MigrationStatus {
  schema: string;
  /** The highest applied id (0 when none). */
  dbAt: number;
  /** The highest id this code ships. */
  codeRequires: number;
  applied: { id: number; name: string; sha256: string; appliedAt: string }[];
  pending: { id: number; name: string; breaking: boolean }[];
  /** Applied ids whose file has changed since. */
  changed: number[];
  state: 'current' | 'behind' | 'ahead' | 'changed';
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATE_LOCK = '__migrate__';

/** The migrations in `dir` (default: the ones shipped beside this module), `NNNN_<name>.sql`, ids contiguous from 1. */
export function loadMigrations(dir: URL = new URL('./migrations/', import.meta.url)): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const migrations = files.map((f): Migration => {
    const m = FILE.exec(f);
    if (!m) throw new OrionError('migration_name', `migration file ${f} is not named NNNN_<name>.sql`);
    const sql = readFileSync(new URL(f, dir), 'utf8');
    return {
      id: Number(m[1]),
      name: m[2]!,
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
      breaking: /^--\s*breaking\s*$/.test(sql.split('\n', 1)[0]!.trim()),
    };
  });
  migrations.forEach((m, i) => {
    if (m.id !== i + 1) {
      throw new OrionError('migration_gap', `migration ids must run 1, 2, 3, ... without a gap: found ${migrations.map((x) => x.id).join(', ')}`);
    }
  });
  return migrations;
}

async function hasMigrationsTable(db: PgDb): Promise<boolean> {
  const row = await db.one(
    "SELECT 1 AS x FROM pg_tables WHERE schemaname = $1 AND tablename = 'schema_migrations'",
    [db.schema],
  );
  return row !== undefined;
}

/** Where the database's schema stands against the code's migrations. Reads only; an absent schema is at 0. */
export async function migrationStatus(db: PgDb, migrations: Migration[] = loadMigrations()): Promise<MigrationStatus> {
  const rows = (await hasMigrationsTable(db))
    ? await db.all<{ id: number; name: string; sha256: string; appliedAt: string }>(
        'SELECT id, name, sha256, applied_at AS "appliedAt" FROM schema_migrations ORDER BY id',
      )
    : [];
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const appliedIds = new Set(rows.map((r) => r.id));
  const changed = rows.filter((r) => byId.has(r.id) && byId.get(r.id)!.sha256 !== r.sha256).map((r) => r.id);
  const pending = migrations.filter((m) => !appliedIds.has(m.id)).map((m) => ({ id: m.id, name: m.name, breaking: m.breaking }));
  const dbAt = rows.reduce((max, r) => Math.max(max, r.id), 0);
  const codeRequires = migrations.reduce((max, m) => Math.max(max, m.id), 0);
  const state = changed.length > 0 ? 'changed' : dbAt > codeRequires ? 'ahead' : pending.length > 0 ? 'behind' : 'current';
  return { schema: db.schema, dbAt, codeRequires, applied: rows, pending, changed, state };
}

/**
 * Brings the schema up to the code: creates it (and `schema_migrations`) if absent, refuses a changed file
 * (`migration_changed`) and, without `breaking`, a breaking one (`migration_breaking`), then applies each pending file
 * in its own transaction under the migration lock. A file another migrator applied meanwhile is skipped.
 */
export async function applyMigrations(
  db: PgDb,
  opts: { breaking?: boolean; migrations?: Migration[] } = {},
): Promise<{ applied: number[] }> {
  const migrations = opts.migrations ?? loadMigrations();
  await db.tx(
    async (t) => {
      await t.run(`CREATE SCHEMA IF NOT EXISTS ${db.schema}`);
      await t.run(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, name text COLLATE "C" NOT NULL, sha256 text COLLATE "C" NOT NULL, applied_at timestamptz NOT NULL)',
      );
    },
    { lockAsset: MIGRATE_LOCK },
  );
  const status = await migrationStatus(db, migrations);
  if (status.changed.length > 0) {
    throw new OrionError(
      'migration_changed',
      `migration(s) ${status.changed.join(', ')} changed after they were applied to schema ${db.schema}; restore the applied file(s)`,
    );
  }
  const breaking = status.pending.filter((p) => p.breaking).map((p) => p.id);
  if (breaking.length > 0 && !opts.breaking) {
    throw new OrionError('migration_breaking', `migration(s) ${breaking.join(', ')} are breaking (not expand-only): rerun with --breaking`);
  }
  const applied: number[] = [];
  for (const p of status.pending) {
    const m = migrations.find((x) => x.id === p.id)!;
    const done = await db.tx(
      async (t) => {
        if (await t.one('SELECT 1 AS x FROM schema_migrations WHERE id = $1', [m.id])) return false;
        await t.run(m.sql);
        await t.run('INSERT INTO schema_migrations (id, name, sha256, applied_at) VALUES ($1, $2, $3, now())', [m.id, m.name, m.sha256]);
        return true;
      },
      { lockAsset: MIGRATE_LOCK },
    );
    if (done) applied.push(m.id);
  }
  return { applied };
}
