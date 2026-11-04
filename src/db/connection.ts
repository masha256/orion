import { createHash } from 'node:crypto';
import { OrionError } from '../types.js';
import { migrationStatus } from './pg/migrate.js';
import { openPgDb, type PgDb } from './pg/pool.js';

export type SqlParam = string | number | bigint | null | readonly number[] | readonly string[];
export interface RunResult<R> {
  rowCount: number;
  rows: R[];
}
export interface TxOptions {
  lockAsset?: string;
}
/**
 * The database interface. SQL is Postgres-style: `$1..$n`, `RETURNING id`, `rowCount`.
 * A tx handle is the same type; a nested tx is a SAVEPOINT. Inside `tx`, query only through the tx handle: the root
 * handle waits for the transaction to end and fails with `db_pool_timeout` after the connection timeout.
 */
export interface DbCore {
  all<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<R[]>;
  /** The first row, or undefined. */
  one<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<R | undefined>;
  run<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<RunResult<R>>;
  tx<T>(fn: (tx: this) => Promise<T>, opts?: TxOptions): Promise<T>;
}
export type Db = DbCore;

/** The root handle a command opens: the `Db`, plus close and the per-asset run lock. */
export type OrionDb = Db & Pick<PgDb, 'close' | 'schema' | 'database' | 'tryAssetRunLock' | 'assetRunLockHolder'>;

/** A Postgres database and the schema Orion's tables live in. The URL holds credentials: never print it. */
export interface DatabaseConfig {
  url: string;
  schema: string;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Refuses a schema name that is not a plain lower-case identifier (it is interpolated into `search_path` and DDL). */
export function checkSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new OrionError('invalid_db_schema', `schema ${JSON.stringify(schema)} must match ${SCHEMA_NAME.source}`);
  }
  return schema;
}

/**
 * The advisory lock key for an asset, in decimal: the first 8 bytes of `sha256('orion:<schema>:<space>:<assetId>')`
 * read as a signed int64. Two key spaces, so a refresh's session lock never blocks its own writes: `'asset'` is the
 * transaction lock (`db.tx(fn, { lockAsset })`), `'run'` the session lock held for a whole run (`tryAssetRunLock`).
 * Advisory locks are database-wide, so the key names the schema: two schemas in one database (prod and a scratch copy,
 * or two test files) never block each other.
 */
export function assetLockKey(space: 'asset' | 'run', assetId: string, schema: string): string {
  return createHash('sha256').update(`orion:${schema}:${space}:${assetId}`).digest().readBigInt64BE(0).toString();
}

/**
 * The database for this environment: `ORION_DATABASE_URL` (required) and `ORION_DB_SCHEMA` (default `orion`). `env` is
 * the process environment over `<ORION_HOME>/.env` (`loadEnv`).
 */
export function databaseConfig(env: Record<string, string | undefined>): DatabaseConfig {
  const url = env.ORION_DATABASE_URL?.trim();
  if (!url) throw new OrionError('no_database_url', 'ORION_DATABASE_URL is not set (environment or <ORION_HOME>/.env)');
  return { url, schema: checkSchemaName(env.ORION_DB_SCHEMA?.trim() || 'orion') };
}

export interface OpenDbOptions {
  /** Pool size (default 1). */
  max?: number;
  /** Refuse a schema behind the code (default true). `orion db status|migrate` open without the check. */
  checkSchema?: boolean;
  /** How long a query waits for a pool connection before `db_pool_timeout` (default 60000). */
  connectionTimeoutMillis?: number;
}

/**
 * Opens a pool on the database. It never migrates: with `checkSchema`, a schema behind the code (a pending migration,
 * or no schema at all) is refused with `schema_behind`; a schema ahead of the code is allowed (migrations are expand-only).
 */
export async function openDb(config: DatabaseConfig, opts: OpenDbOptions = {}): Promise<OrionDb> {
  const db = await openPgDb(config, { max: opts.max, connectionTimeoutMillis: opts.connectionTimeoutMillis });
  if (opts.checkSchema === false) return db;
  try {
    const status = await migrationStatus(db);
    if (status.pending.length > 0) {
      throw new OrionError(
        'schema_behind',
        `database schema ${config.schema} is at ${status.dbAt}, this build needs ${status.codeRequires}: run orion db migrate`,
      );
    }
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}
