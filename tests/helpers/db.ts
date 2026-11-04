import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { CliContext } from '../../src/cli/util.js';
import { openDb, type DatabaseConfig, type OrionDb } from '../../src/db/connection.js';
import { createTestSchema, dropTestSchema } from '../setup/pgGlobal.js';

/**
 * The one place tests open a database. Everything else reaches it through the accessors below and queries it through
 * the `Db` interface (`one`/`all`/`run`/`tx`).
 *
 * Postgres (D9): each test FILE gets one fresh, migrated schema `t_<16 hex>`, created in `beforeAll` and dropped in
 * `afterAll`. Before each test every table but `schema_migrations` is emptied with `TRUNCATE ... RESTART IDENTITY
 * CASCADE`, so every test starts on empty tables with ids from 1. The in-process CLI (`testCliContext`) opens its own
 * pool on the same schema, so a test sees what a command wrote and vice versa.
 */
export interface TestDb {
  (): OrionDb;
  /** Empties every table (ids start from 1 again). The handle stays open. */
  reset(): Promise<void>;
}

/** The file's schema and its main pool (`max: 1`); null until the file's `beforeAll` has run. */
let file: { config: DatabaseConfig; db: OrionDb } | null = null;
let registered = false;

/** Registers the file's schema hooks once, whichever accessor asks first. */
function useFileSchema(): void {
  if (registered) return;
  registered = true;
  beforeAll(async () => {
    const config = await createTestSchema();
    file = { config, db: await openDb(config) };
  });
  beforeEach(truncateAll);
  afterAll(async () => {
    const open = file;
    file = null;
    if (!open) return;
    await open.db.close();
    await dropTestSchema(open.config);
  });
}

function requireFile(): { config: DatabaseConfig; db: OrionDb } {
  if (!file) throw new Error('the test schema is not ready: call useTestDb() or testDbPair() at the top level, and use it inside a test or hook');
  return file;
}

async function truncateAll(): Promise<void> {
  const { db } = requireFile();
  const tables = await db.all<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 AND tablename <> 'schema_migrations' ORDER BY tablename",
    [db.schema],
  );
  if (tables.length > 0) await db.run(`TRUNCATE ${tables.map((t) => t.name).join(', ')} RESTART IDENTITY CASCADE`);
}

/** The file's database, emptied before each test. Call at the top level of a test file. */
export function useTestDb(): TestDb {
  useFileSchema();
  const db = (() => requireFile().db) as TestDb;
  db.reset = truncateAll;
  return db;
}

/** Two more pools on the file's schema, as a scheduled run and a manual command have. Emptied before each test. */
export function testDbPair(): () => [OrionDb, OrionDb] {
  useFileSchema();
  let current: [OrionDb, OrionDb] | null = null;
  beforeAll(async () => {
    const { config } = requireFile();
    current = [await openDb(config), await openDb(config)];
  });
  afterAll(async () => {
    const open = current;
    current = null;
    if (open) {
      await open[0].close();
      await open[1].close();
    }
  });
  return () => {
    if (!current) throw new Error('the test database pair is not open yet: use it inside a test or a hook');
    return current;
  };
}

/** The file's schema, for a test that opens (and closes) its own handle on it. */
export function testDatabaseConfig(): DatabaseConfig {
  return requireFile().config;
}

/**
 * The variables a CLI subprocess needs to reach the file's schema (the URL names the test role and database). Add
 * `ORION_HOME` / `ORION_ENV_FILE` pointing at a scratch dir, so no real `.env` is read.
 */
export function subprocessDbEnv(): { ORION_DATABASE_URL: string; ORION_DB_SCHEMA: string } {
  const { config } = requireFile();
  return { ORION_DATABASE_URL: config.url, ORION_DB_SCHEMA: config.schema };
}

/**
 * The in-process CLI context for `home`, on the file's schema: a dev checkout, so `home` is also the config root and
 * `<home>/.env` the env file (override any of them in `over`). The file must call `useTestDb()` or `testDbPair()`.
 */
export function testCliContext(home: string, over: Partial<CliContext> = {}): CliContext {
  return { ...devPaths(home), stdout: () => undefined, now: () => new Date(), database: requireFile().config, ...over };
}

/** A dev checkout's paths for `home` (no release): what `resolvePaths` gives with only `ORION_HOME` set. */
export function devPaths(home: string): Pick<CliContext, 'home' | 'configRoot' | 'envFile' | 'release'> {
  return { home, configRoot: home, envFile: join(home, '.env'), release: null };
}
