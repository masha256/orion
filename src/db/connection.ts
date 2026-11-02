import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';
import { SqliteCompatDb } from './sqliteCompat.js';

export type SqlParam = string | number | bigint | null | readonly number[] | readonly string[];
export interface RunResult<R> {
  rowCount: number;
  rows: R[];
}
export interface TxOptions {
  lockAsset?: string;
}
/**
 * The final interface (Task 8 renames it Db). SQL is Postgres-style: `$1..$n`, `RETURNING id`, `rowCount`.
 * A tx handle is the same type; a nested tx is a SAVEPOINT. Inside `tx`, query only through the tx handle: the root
 * handle waits for the transaction to end and fails with `db_pool_timeout` after `txWaitMs`.
 */
export interface DbCore {
  all<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<R[]>;
  /** The first row, or undefined. */
  one<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<R | undefined>;
  run<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<RunResult<R>>;
  tx<T>(fn: (tx: this) => Promise<T>, opts?: TxOptions): Promise<T>;
}
/** @deprecated transition only: removed in Task 8. */
export type LegacySqlite = Pick<Database.Database, 'prepare' | 'exec' | 'pragma' | 'transaction' | 'inTransaction'>;
export type Db = DbCore & LegacySqlite; // Task 8: `export type Db = DbCore`
export type OrionDb = Db & { close(): Promise<void> };

export function migrate(db: LegacySqlite): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // A table rebuild drops a table that other tables reference. Foreign keys go off around it (the pragma is a no-op
    // inside a transaction, so it is set outside), and the rebuilt schema is checked before they come back on.
    if (m.rebuildsTables) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.rebuildsTables) {
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) throw new Error(`migration ${m.id} left ${violations.length} foreign key violation(s); rolled back`);
        }
        db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
      })();
    } finally {
      if (m.rebuildsTables) db.pragma('foreign_keys = ON');
    }
  }
}

export function openDb(path: string, opts?: { txWaitMs?: number }): OrionDb {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // a manual CLI write during a long backfill waits, rather than failing with SQLITE_BUSY
  migrate(db);
  return SqliteCompatDb.open(db, opts);
}
