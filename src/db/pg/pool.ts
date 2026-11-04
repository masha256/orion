import pg from 'pg';
import { OrionError } from '../../types.js';
import { assetLockKey, checkSchemaName, type DatabaseConfig, type DbCore, type RunResult, type SqlParam, type TxOptions } from '../connection.js';

/** Releases a run lock: unlocks and closes its connection. Idempotent. */
export interface AssetRunLock {
  release(): Promise<void>;
}

/** The Postgres `Db`. A tx handle is the same type; only the root handle may be closed. */
export interface PgDb extends DbCore {
  /** The schema the pool's `search_path` names. */
  readonly schema: string;
  /** The database name (from the URL), for messages: the URL itself is never printed. */
  readonly database: string;
  close(): Promise<void>;
  /**
   * The session lock on an asset for a whole run (key space `'run'`), on a dedicated connection outside the pool whose
   * `application_name` is `holder`. Null when another session holds it. The lock goes when released, when this
   * database is closed, or when the holding process dies.
   */
  tryAssetRunLock(assetId: string, holder: string): Promise<AssetRunLock | null>;
  /** Who holds the asset's run lock (its connection's `application_name`) and since when (that connection's start). */
  assetRunLockHolder(assetId: string): Promise<{ holder: string; since: string } | null>;
}

export interface PgOpenOptions {
  /** Pool size (default 1: inside `tx`, a query on the root handle times out instead of running outside the transaction). */
  max?: number;
  /** How long a query waits for a pool connection before `db_pool_timeout` (default 60000). */
  connectionTimeoutMillis?: number;
  applicationName?: string;
}

function parseInt8(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new OrionError('db_int8_overflow', `bigint ${v} is beyond 2^53 and cannot be read as a Number`);
  }
  return n;
}

const pgTimestamptz = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, 'text') as (v: string) => Date;

/**
 * The type parsers (D7), set per pool and never on the global `pg.types`: int8 is a Number (refused above 2^53),
 * timestamptz the 24-char ISO instant, date the raw `YYYY-MM-DD`, json the raw text (callers `JSON.parse` it).
 * float8 keeps pg's default `parseFloat`.
 */
export const PG_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === undefined || format === 'text') {
      switch (oid) {
        case pg.types.builtins.INT8:
          return parseInt8;
        case pg.types.builtins.TIMESTAMPTZ:
          return (v: string) => pgTimestamptz(v).toISOString();
        case pg.types.builtins.DATE:
        case pg.types.builtins.JSON:
          return (v: string) => v;
      }
    }
    return pg.types.getTypeParser(oid, format as 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
};

/** pg sends a number as `String(n)`, which turns -0 into 0; every other double prints exactly. */
function toPgParams(params: readonly SqlParam[]): unknown[] {
  return params.map((p) => (typeof p === 'number' && Object.is(p, -0) ? '-0' : p));
}

/** The database name from a `postgres[ql]://` URL, for messages. */
function databaseName(url: string): string {
  const m = /^postgres(?:ql)?:\/\/[^/?#]*\/([^?#]*)/.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : '(default)';
}

const POOL_TIMEOUT = /timeout exceeded when trying to connect/;

interface Shared {
  pool: pg.Pool;
  config: DatabaseConfig;
  database: string;
  timeoutMs: number;
  runLocks: Set<AssetRunLock>;
}

/** The tx handle's connection, open until its transaction ends. */
interface TxState {
  client: pg.PoolClient;
  depth: number;
  ended: boolean;
  /** The asset whose transaction lock this transaction holds (from its root or an enclosing savepoint), if any. */
  lockedAsset: string | null;
}

class PgDbImpl implements PgDb {
  constructor(
    private readonly shared: Shared,
    private readonly txState: TxState | null,
  ) {}

  get schema(): string {
    return this.shared.config.schema;
  }
  get database(): string {
    return this.shared.database;
  }

  private poolTimeout(): OrionError {
    return new OrionError(
      'db_pool_timeout',
      `waited ${this.shared.timeoutMs} ms for a connection: inside db.tx, query through the tx handle`,
    );
  }

  private async connect(): Promise<pg.PoolClient> {
    try {
      return await this.shared.pool.connect();
    } catch (err) {
      if (err instanceof Error && POOL_TIMEOUT.test(err.message)) throw this.poolTimeout();
      throw err;
    }
  }

  private async query<R>(sql: string, params: readonly SqlParam[]): Promise<pg.QueryResult & { rows: R[] }> {
    let res: pg.QueryResult | pg.QueryResult[];
    if (this.txState) {
      if (this.txState.ended) throw new Error('this tx handle was used after its transaction has ended');
      res = await this.txState.client.query(sql, toPgParams(params));
    } else {
      try {
        res = await this.shared.pool.query(sql, toPgParams(params));
      } catch (err) {
        if (err instanceof Error && POOL_TIMEOUT.test(err.message)) throw this.poolTimeout();
        throw err;
      }
    }
    // A parameterless multi-statement string (a migration) returns one result per statement: the last one counts.
    const last = Array.isArray(res) ? res[res.length - 1]! : res;
    return last as pg.QueryResult & { rows: R[] };
  }

  async all<R = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<R[]> {
    return (await this.query<R>(sql, params)).rows;
  }

  async one<R = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<R | undefined> {
    return (await this.query<R>(sql, params)).rows[0];
  }

  async run<R = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<RunResult<R>> {
    const res = await this.query<R>(sql, params);
    return { rowCount: res.rowCount ?? 0, rows: res.rows ?? [] };
  }

  /**
   * At the root: a pool connection, `BEGIN`, the asset's transaction lock when `lockAsset` (key space `'asset'`), `fn`,
   * `COMMIT` or `ROLLBACK`. Nested: `SAVEPOINT sp<n>`, taking the lock again if asked (it is re-entrant).
   */
  async tx<T>(fn: (tx: this) => Promise<T>, opts?: TxOptions): Promise<T> {
    if (this.txState) return this.savepoint(this.txState, fn, opts);
    const client = await this.connect();
    const state: TxState = { client, depth: 1, ended: false, lockedAsset: opts?.lockAsset ?? null };
    let broken: Error | undefined;
    try {
      try {
        await client.query('BEGIN');
      } catch (err) {
        broken = err as Error;
        throw err;
      }
      try {
        if (opts?.lockAsset) await client.query('SELECT pg_advisory_xact_lock($1)', [assetLockKey('asset', opts.lockAsset, this.shared.config.schema)]);
        const result = await fn(new PgDbImpl(this.shared, state) as this);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          broken = rollbackErr as Error; // the connection is in an unknown state: destroy it rather than reuse it
        }
        throw err;
      }
    } finally {
      state.ended = true;
      client.release(broken ?? false);
    }
  }

  private async savepoint<T>(outer: TxState, fn: (tx: this) => Promise<T>, opts?: TxOptions): Promise<T> {
    if (outer.ended) throw new Error('this tx handle was used after its transaction has ended');
    // One transaction locks one asset. A nested write that asks for another asset's lock is a row of that asset reached
    // from this one's (a proposal citing another asset's observation, say): refused, rather than taking a second lock
    // mid-transaction, which can deadlock against a writer taking the two in the other order.
    if (opts?.lockAsset && outer.lockedAsset !== null && opts.lockAsset !== outer.lockedAsset) {
      throw new OrionError(
        'tx_asset_mismatch',
        `a write on asset ${opts.lockAsset} was attempted inside a transaction locked on asset ${outer.lockedAsset}`,
      );
    }
    const state: TxState = { client: outer.client, depth: outer.depth + 1, ended: false, lockedAsset: outer.lockedAsset ?? opts?.lockAsset ?? null };
    const sp = `sp${state.depth}`;
    await outer.client.query(`SAVEPOINT ${sp}`);
    try {
      if (opts?.lockAsset) await outer.client.query('SELECT pg_advisory_xact_lock($1)', [assetLockKey('asset', opts.lockAsset, this.shared.config.schema)]);
      const result = await fn(new PgDbImpl(this.shared, state) as this);
      await outer.client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      try {
        await outer.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await outer.client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // the original error is what the caller needs; the outer transaction rolls back on its way out
      }
      throw err;
    } finally {
      state.ended = true;
    }
  }

  async tryAssetRunLock(assetId: string, holder: string): Promise<AssetRunLock | null> {
    const key = assetLockKey('run', assetId, this.shared.config.schema);
    const client = new pg.Client({ ...clientConfig(this.shared.config), application_name: holder });
    let dead = false;
    client.on('error', () => {
      dead = true; // the backend went away (killed or restarted): the session lock went with it
    });
    client.on('end', () => {
      dead = true;
    });
    await connectOrExplain(client, this.shared);
    let ok = false;
    try {
      const row = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]))
        .rows[0];
      ok = row?.ok === true;
    } finally {
      if (!ok) await client.end().catch(() => undefined);
    }
    if (!ok) return null;
    const runLocks = this.shared.runLocks;
    let released = false;
    const lock: AssetRunLock = {
      async release() {
        if (released) return;
        released = true;
        runLocks.delete(lock);
        try {
          if (!dead) await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } catch (err) {
          if (!dead) {
            await client.end().catch(() => undefined);
            throw err;
          }
        }
        await client.end().catch(() => undefined);
      },
    };
    runLocks.add(lock);
    return lock;
  }

  async assetRunLockHolder(assetId: string): Promise<{ holder: string; since: string } | null> {
    const key = BigInt.asUintN(64, BigInt(assetLockKey('run', assetId, this.shared.config.schema)));
    const row = await this.one<{ holder: string; since: string }>(
      `SELECT a.application_name AS holder, a.backend_start AS since
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid = $1::oid AND l.objid = $2::oid
        LIMIT 1`,
      [(key >> 32n).toString(), (key & 0xffffffffn).toString()],
    );
    return row ?? null;
  }

  async close(): Promise<void> {
    if (this.txState) throw new Error('close() on a tx handle; close the root handle');
    for (const lock of [...this.shared.runLocks]) await lock.release().catch(() => undefined);
    await this.shared.pool.end();
  }
}

/** Connection settings shared by the pool and the run-lock connections. */
function clientConfig(config: DatabaseConfig): pg.ClientConfig {
  return {
    connectionString: config.url,
    options: `-c search_path=${config.schema} -c TimeZone=UTC -c idle_in_transaction_session_timeout=300000`,
    types: PG_TYPES,
  };
}

async function connectOrExplain(client: pg.Client, shared: Pick<Shared, 'database' | 'config'>): Promise<void> {
  try {
    await client.connect();
  } catch (err) {
    throw connectFailed(shared, err);
  }
}

function connectFailed(shared: Pick<Shared, 'database' | 'config'>, err: unknown): OrionError {
  const reason = err instanceof Error ? err.message : String(err);
  return new OrionError(
    'db_connect_failed',
    `cannot connect to database ${shared.database} (schema ${shared.config.schema}): ${reason}`,
  );
}

/**
 * Opens a pool on `config` (`search_path` = its schema, UTC, idle-in-transaction sessions ended after 5 min) and
 * checks that it connects. It does not migrate: that is `applyMigrations`.
 */
export async function openPgDb(config: DatabaseConfig, opts: PgOpenOptions = {}): Promise<PgDb> {
  checkSchemaName(config.schema);
  const timeoutMs = opts.connectionTimeoutMillis ?? 60_000;
  const pool = new pg.Pool({
    ...clientConfig(config),
    max: opts.max ?? 1,
    connectionTimeoutMillis: timeoutMs,
    ...(opts.applicationName ? { application_name: opts.applicationName } : {}),
  });
  // An idle client whose backend goes away emits here; without a listener that would crash the process. The pool
  // drops the client, and the next query opens a fresh one.
  pool.on('error', () => undefined);
  const shared: Shared = { pool, config, database: databaseName(config.url), timeoutMs, runLocks: new Set() };
  try {
    const probe = await pool.connect();
    probe.release();
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw connectFailed(shared, err);
  }
  return new PgDbImpl(shared, null);
}
