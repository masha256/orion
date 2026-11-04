import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { DatabaseConfig } from '../../src/db/connection.js';
import { applyMigrations } from '../../src/db/pg/migrate.js';
import { openPgDb } from '../../src/db/pg/pool.js';

/**
 * The Postgres test infrastructure (D9): every test file gets its own fresh schema `t_<16 hex>` in the local test
 * database named by ORION_TEST_DATABASE_URL, commented with its creation time. The vitest global setup checks the
 * server and sweeps schemas a crashed run left behind.
 */

export const MISSING_URL_MESSAGE =
  'ORION_TEST_DATABASE_URL is not set: the suite needs the local test Postgres (scripts/provision/dev-postgres.sh); ' +
  'e.g. postgresql://orion_dev@/orion_test?host=/var/run/postgresql';

const STALE_MS = 6 * 60 * 60 * 1000;
const TEST_SCHEMA = /^t_[0-9a-f]{16}$/;

/**
 * The suite runs only on a database whose name ends in `_test`: it creates and drops schemas there and turns off
 * `synchronous_commit` for the whole database, which must never happen to a database holding data that matters.
 */
export function requireTestDatabaseName(name: string): string {
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to run the suite on database ${JSON.stringify(name)}: ORION_TEST_DATABASE_URL must name a database whose name ends in _test`);
  }
  return name;
}

/** The test database URL; refuses (no skip) when it is unset. */
export function requireTestDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.ORION_TEST_DATABASE_URL;
  if (!url) throw new Error(MISSING_URL_MESSAGE);
  return url;
}

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: requireTestDatabaseUrl() });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** vitest globalSetup: the URL is set and names a `_test` database, the server is Postgres 18+, and schemas older than 6 h are dropped. */
export default async function setup(): Promise<void> {
  requireTestDatabaseUrl();
  await withClient(async (c) => {
    const db = requireTestDatabaseName((await c.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d);
    const version = Number((await c.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v);
    if (version < 180000) throw new Error(`the test Postgres is version ${version}; the suite needs 18 or later`);
    // The suite commits tens of thousands of small transactions, and each one waiting for its WAL flush made the ingest
    // tests fsync-bound (4 s for one LINK fetch on this host's disk, past vitest's 5 s timeout under load). A test
    // database needs no durability: new sessions on it skip the flush wait. (The database's owner may set this; the
    // provisioning script makes orion_dev the owner of orion_test.) Production pools never see this setting.
    await c.query(`ALTER DATABASE "${db.replace(/"/g, '""')}" SET synchronous_commit = off`);
    const schemas = await c.query<{ name: string; comment: string | null }>(
      "SELECT nspname AS name, obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace WHERE nspname LIKE 't\\_%'",
    );
    for (const s of schemas.rows) {
      const created = s.comment ? Date.parse(s.comment) : NaN;
      if (TEST_SCHEMA.test(s.name) && Number.isFinite(created) && Date.now() - created > STALE_MS) {
        await c.query(`DROP SCHEMA IF EXISTS ${s.name} CASCADE`);
      }
    }
  });
}

/** A fresh schema for one test file, migrated unless `migrate: false`. Drop it with `dropTestSchema` in `afterAll`. */
export async function createTestSchema(opts: { migrate?: boolean } = {}): Promise<DatabaseConfig> {
  const config: DatabaseConfig = { url: requireTestDatabaseUrl(), schema: `t_${randomBytes(8).toString('hex')}` };
  await withClient(async (c) => {
    await c.query(`CREATE SCHEMA ${config.schema}`);
    await c.query(`COMMENT ON SCHEMA ${config.schema} IS '${new Date().toISOString()}'`);
  });
  if (opts.migrate !== false) {
    const db = await openPgDb(config);
    try {
      await applyMigrations(db, {});
    } finally {
      await db.close();
    }
  }
  return config;
}

export async function dropTestSchema(config: DatabaseConfig): Promise<void> {
  if (!TEST_SCHEMA.test(config.schema)) throw new Error(`refusing to drop ${config.schema}: not a test schema`);
  await withClient(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`);
  });
}
