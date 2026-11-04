import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../../src/db/connection.js';
import { applyMigrations, loadMigrations } from '../../src/db/pg/migrate.js';
import { openPgDb, type PgDb } from '../../src/db/pg/pool.js';
import { createTestSchema, dropTestSchema } from '../setup/pgGlobal.js';

const opened: { db: PgDb; config: DatabaseConfig }[] = [];

async function emptySchema(): Promise<PgDb> {
  const config = await createTestSchema({ migrate: false });
  const db = await openPgDb(config);
  opened.push({ db, config });
  return db;
}

afterEach(async () => {
  for (const { db, config } of opened.splice(0)) {
    await db.close();
    await dropTestSchema(config);
  }
});

const DAEMON_TABLES = ['asset_registry', 'asset_state_events', 'daemon_heartbeat', 'day_blocks', 'jobs', 'latest_levels', 'snapshots_out', 'watch_state'];

describe('0002_daemon', () => {
  it('schema: 0002 applies after 0001 and records its sha256', async () => {
    const db = await emptySchema();
    const migrations = loadMigrations();
    const daemon = migrations.find((m) => m.id === 2);
    expect(daemon).toMatchObject({ name: 'daemon', breaking: false }); // expand-only
    expect(await applyMigrations(db, {})).toEqual({ applied: [1, 2] });
    const rows = await db.all<{ id: number; name: string; sha256: string }>('SELECT id, name, sha256 FROM schema_migrations ORDER BY id');
    expect(rows.map((r) => [r.id, r.name])).toEqual([[1, 'baseline'], [2, 'daemon']]);
    expect(rows[1]!.sha256).toBe(daemon!.sha256);
    expect(await applyMigrations(db, {})).toEqual({ applied: [] });
  });

  it('schema: every 0002 table exists in schema orion', async () => {
    const db = await emptySchema();
    await applyMigrations(db, {});
    const tables = await db.all<{ name: string }>('SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [db.schema]);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(DAEMON_TABLES));
    // Schema-unqualified: nothing landed in public or another schema.
    const elsewhere = await db.all("SELECT schemaname FROM pg_tables WHERE tablename = 'jobs' AND schemaname <> $1 AND schemaname NOT LIKE 't\\_%'", [db.schema]);
    expect(elsewhere).toEqual([]);
    // Every text column collates "C", as 0001's do.
    const loose = await db.all<{ t: string; c: string }>(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = ANY($2) AND data_type = 'text' AND coalesce(collation_name, '') <> 'C'`,
      [db.schema, DAEMON_TABLES],
    );
    expect(loose).toEqual([]);
  });

  it('schema: the check constraints refuse unknown kinds, statuses and states', async () => {
    const db = await emptySchema();
    await applyMigrations(db, {});
    const now = '2026-11-03T00:45:00.000Z';
    await expect(db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('nope', $1, $1, 1, 'queued', 1)", [now])).rejects.toThrow(/jobs_kind_check/);
    await expect(db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('levels', $1, $1, 1, 'lost', 1)", [now])).rejects.toThrow(/jobs_status_check/);
    await expect(db.run("INSERT INTO asset_registry (asset_id, state, state_since, state_by, config_hash) VALUES ('a', 'retired', $1, 'x', 'h')", [now])).rejects.toThrow(/asset_registry_state_check/);
    await expect(db.run("INSERT INTO daemon_heartbeat (daemon_id, pid, host, started_at, beat_at, state) VALUES ('d', 1, 'h', $1, $1, 'odd')", [now])).rejects.toThrow(/daemon_heartbeat_state_check/);
    await expect(db.run("INSERT INTO snapshots_out (kind, seq, snapshot_id, sha256, body, created_at) VALUES ('half', 1, 's', 'h', '{}', $1)", [now])).rejects.toThrow(/snapshots_out_kind_check/);
  });
});
