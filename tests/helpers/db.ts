import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach } from 'vitest';
import type { CliContext } from '../../src/cli/util.js';
import { openDb, type OrionDb } from '../../src/db/connection.js';

/**
 * The one place tests open a database. Everything else reaches it through the accessors below and queries it through
 * the `Db` interface (`one`/`all`/`run`/`tx`), so the backend can change here alone.
 *
 * SQLite phase: each test gets a new `':memory:'` database, or `<home>/orion.db` once the test has built a CLI context
 * for `home` (that is the file the in-process CLI opens). The database opens on the test's first call to the accessor,
 * so a CLI test must call `testCliContext(home)` before it first touches `db()`.
 */
export interface TestDb {
  (): OrionDb;
  /** Empties the database: the next call returns a fresh one, with ids starting from 1 again. */
  reset(): Promise<void>;
}

/** The CLI home the current test has built a context for, if any. */
let cliHome: string | null = null;

/** Registers a fresh database per test, closed after it. Call at the top level of a test file. */
export function useTestDb(): TestDb {
  let current: { db: OrionDb; home: string | null } | null = null;
  const close = async () => {
    const open = current;
    current = null;
    if (open) await open.db.close();
  };
  beforeEach(async () => {
    await close();
    cliHome = null;
  });
  afterEach(async () => {
    await close();
    cliHome = null;
  });
  afterAll(close);
  const db = (() => {
    if (current && current.home !== cliHome) {
      throw new Error(`this test opened its database before testCliContext(${cliHome ?? ''}): build the CLI context first`);
    }
    if (!current) current = { db: openDb(cliHome ? join(cliHome, 'orion.db') : ':memory:'), home: cliHome };
    return current.db;
  }) as TestDb;
  db.reset = async () => {
    if (current?.home) throw new Error('reset() empties an in-memory test database; this test uses its CLI home');
    await close();
  };
  return db;
}

/** Two connections to one database, as a scheduled run and a manual command have; new per test, closed after it. */
export function testDbPair(): () => [OrionDb, OrionDb] {
  let current: { pair: [OrionDb, OrionDb]; dir: string } | null = null;
  const close = async () => {
    const open = current;
    current = null;
    if (!open) return;
    await open.pair[0].close();
    await open.pair[1].close();
    rmSync(open.dir, { recursive: true, force: true });
  };
  beforeEach(close);
  afterEach(close);
  afterAll(close);
  return () => {
    if (!current) {
      const dir = mkdtempSync(join(tmpdir(), 'orion-pair-'));
      current = { pair: [openDb(join(dir, 'orion.db')), openDb(join(dir, 'orion.db'))], dir };
    }
    return current.pair;
  };
}

/** The in-process CLI context for `home`. Its database is the one the file's `useTestDb()` accessor returns. */
export function testCliContext(home: string, over: Partial<CliContext> = {}): CliContext {
  cliHome = home;
  return { home, stdout: () => undefined, now: () => new Date(), ...over };
}
