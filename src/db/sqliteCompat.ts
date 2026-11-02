import type Database from 'better-sqlite3';
import { OrionError } from '../types.js';
import type { DbCore, LegacySqlite, RunResult, SqlParam, TxOptions } from './connection.js';

/**
 * Rewrites Postgres-style `$n` placeholders to SQLite `?`, outside quoted text and comments, and returns the params
 * in occurrence order (so `$2, $1, $1` binds `[p2, p1, p1]`).
 */
export function toSqlite(sql: string, params: readonly SqlParam[]): { sql: string; params: unknown[] } {
  let out = '';
  const bound: unknown[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2; // doubled quote is an escaped quote
          else break;
        } else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const j = end === -1 ? sql.length : end;
      out += sql.slice(i, j);
      i = j;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, j);
      i = j;
    } else if (c === '$' && /[0-9]/.test(sql[i + 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j]!)) j++;
      const n = Number(sql.slice(i + 1, j));
      if (n < 1 || n > params.length) throw new Error(`placeholder $${n} has no parameter (${params.length} given)`);
      const p = params[n - 1];
      if (Array.isArray(p)) throw new Error(`placeholder $${n}: array parameters are not supported on SQLite`);
      bound.push(p);
      out += '?';
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return { sql: out, params: bound };
}

/** One shared mutex per database: an open transaction holds it, mirroring a pg pool of one connection. */
class ConnectionGate {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly waitMs: number) {}

  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const k = this.waiters.indexOf(grant);
        if (k !== -1) this.waiters.splice(k, 1);
        reject(new OrionError('db_pool_timeout', `waited ${this.waitMs} ms for a connection: inside db.tx, query through the tx handle`));
      }, this.waitMs);
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand over directly; `held` stays true
    else this.held = false;
  }
}

/**
 * The async `Db` over better-sqlite3. The root handle (depth 0) queries through the gate; a tx handle (depth >= 1)
 * queries directly, since it is the transaction's holder of the gate. Legacy sync members are forwarded and bypass the gate.
 */
export class SqliteCompatDb implements DbCore, LegacySqlite {
  private constructor(
    private readonly raw: Database.Database,
    private readonly gate: ConnectionGate,
    private readonly depth: number,
  ) {}

  static open(raw: Database.Database, opts?: { txWaitMs?: number }): SqliteCompatDb {
    return new SqliteCompatDb(raw, new ConnectionGate(opts?.txWaitMs ?? 5000), 0);
  }

  private async onConnection<T>(fn: () => T): Promise<T> {
    if (this.depth > 0) return fn();
    await this.gate.acquire();
    try {
      return fn();
    } finally {
      this.gate.release();
    }
  }

  private statement(sql: string, params: readonly SqlParam[]) {
    const q = toSqlite(sql, params);
    return { stmt: this.raw.prepare(q.sql), params: q.params };
  }

  all<R = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<R[]> {
    return this.onConnection(() => {
      const q = this.statement(sql, params);
      return q.stmt.all(...q.params) as R[];
    });
  }

  one<R = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<R | undefined> {
    return this.onConnection(() => {
      const q = this.statement(sql, params);
      return q.stmt.get(...q.params) as R | undefined;
    });
  }

  run<R = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<RunResult<R>> {
    return this.onConnection(() => {
      const q = this.statement(sql, params);
      if (q.stmt.reader) {
        const rows = q.stmt.all(...q.params) as R[];
        return { rowCount: rows.length, rows };
      }
      return { rowCount: q.stmt.run(...q.params).changes, rows: [] };
    });
  }

  /** `BEGIN IMMEDIATE` at the root, `SAVEPOINT sp<n>` when nested. `lockAsset` is a no-op on SQLite. */
  async tx<T>(fn: (tx: this) => Promise<T>, _opts?: TxOptions): Promise<T> {
    if (this.depth === 0) await this.gate.acquire();
    try {
      const inner = this.depth + 1;
      const sp = `sp${inner}`;
      this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      let result: T;
      try {
        result = await fn(new SqliteCompatDb(this.raw, this.gate, inner) as this);
      } catch (err) {
        try {
          if (this.depth === 0) {
            if (this.raw.inTransaction) this.raw.exec('ROLLBACK');
          } else this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        } catch {
          // the original error is what the caller needs; a failed rollback leaves SQLite to abort the transaction
        }
        throw err;
      }
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } finally {
      if (this.depth === 0) this.gate.release();
    }
  }

  async close(): Promise<void> {
    if (this.depth > 0) throw new Error('close() on a tx handle; close the root handle');
    this.raw.close();
  }

  // Legacy sync members (removed in Task 8).
  get prepare(): Database.Database['prepare'] {
    return this.raw.prepare.bind(this.raw) as Database.Database['prepare'];
  }
  get transaction(): Database.Database['transaction'] {
    return this.raw.transaction.bind(this.raw) as Database.Database['transaction'];
  }
  get pragma(): Database.Database['pragma'] {
    return this.raw.pragma.bind(this.raw) as Database.Database['pragma'];
  }
  exec(source: string): Database.Database {
    return this.raw.exec(source);
  }
  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }
}
