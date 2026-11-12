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
    expect(await applyMigrations(db, { breaking: true })).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7] });
    const rows = await db.all<{ id: number; name: string; sha256: string }>('SELECT id, name, sha256 FROM schema_migrations ORDER BY id');
    expect(rows.map((r) => [r.id, r.name])).toEqual([[1, 'baseline'], [2, 'daemon'], [3, 'checks'], [4, 'provenance'], [5, 'tokens_prices'], [6, 'provenance_not_null'], [7, 'job_params']]);
    expect(rows[1]!.sha256).toBe(daemon!.sha256);
    expect(await applyMigrations(db, {})).toEqual({ applied: [] });
  });

  it('schema: every 0002 table exists in schema orion', async () => {
    const db = await emptySchema();
    await applyMigrations(db, { breaking: true });
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
    await applyMigrations(db, { breaking: true });
    const now = '2026-11-03T00:45:00.000Z';
    await expect(db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('nope', $1, $1, 1, 'queued', 1)", [now])).rejects.toThrow(/jobs_kind_check/);
    await expect(db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('levels', $1, $1, 1, 'lost', 1)", [now])).rejects.toThrow(/jobs_status_check/);
    await expect(db.run("INSERT INTO asset_registry (asset_id, state, state_since, state_by, config_hash) VALUES ('a', 'retired', $1, 'x', 'h')", [now])).rejects.toThrow(/asset_registry_state_check/);
    await expect(db.run("INSERT INTO daemon_heartbeat (daemon_id, pid, host, started_at, beat_at, state) VALUES ('d', 1, 'h', $1, $1, 'odd')", [now])).rejects.toThrow(/daemon_heartbeat_state_check/);
    await expect(db.run("INSERT INTO snapshots_out (kind, seq, snapshot_id, sha256, body, created_at) VALUES ('half', 1, 's', 'h', '{}', $1)", [now])).rejects.toThrow(/snapshots_out_kind_check/);
  });
});

describe('0007_job_params', () => {
  it('schema: 0007 is expand-only and applies on a schema at 6: jobs.params_json jsonb, nullable; kind backfill accepted, unknown kinds still refused', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    const m7 = all.find((m) => m.id === 7);
    expect(m7).toMatchObject({ id: 7, name: 'job_params', breaking: false }); // expand-only
    expect(m7!.sql.split('\n', 1)[0]).not.toBe('-- breaking');
    expect(await applyMigrations(db, { migrations: all.slice(0, 6), breaking: true })).toEqual({ applied: [1, 2, 3, 4, 5, 6] });
    const now = '2026-11-03T00:45:00.000Z';
    // A row the release before 0007 wrote stays as it was.
    await db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('levels', $1, $1, 40, 'queued', 1)", [now]);
    await expect(db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('backfill', $1, $1, 70, 'queued', 1)", [now])).rejects.toThrow(/jobs_kind_check/);
    expect(await applyMigrations(db, {})).toEqual({ applied: [7] });
    const col = await db.one<{ t: string; n: string }>(
      "SELECT data_type AS t, is_nullable AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'jobs' AND column_name = 'params_json'",
      [db.schema],
    );
    expect(col).toEqual({ t: 'jsonb', n: 'YES' });
    await db.run(
      "INSERT INTO jobs (kind, asset_id, slot, run_after, priority, status, max_attempts, params_json) VALUES ('backfill', 'mini', $1, $1, 70, 'queued', 1, $2)",
      [now, JSON.stringify({ op: 'fetch', metrics: ['flow_usd.fees'], backfillDays: 30 })],
    );
    // An insert as the release before 0007 makes it (no params_json) still works; its params are null.
    await db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('retention', $1, $1, 60, 'queued', 1)", [now]);
    expect(await db.all('SELECT kind, params_json FROM jobs ORDER BY id')).toEqual([
      { kind: 'levels', params_json: null },
      { kind: 'backfill', params_json: { op: 'fetch', metrics: ['flow_usd.fees'], backfillDays: 30 } },
      { kind: 'retention', params_json: null },
    ]);
    await expect(db.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('nope', $1, $1, 1, 'queued', 1)", [now])).rejects.toThrow(/jobs_kind_check/);
    const checks = await db.all<{ name: string }>(
      `SELECT c.conname AS name FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'jobs' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%kind%'`,
      [db.schema],
    );
    expect(checks.map((c) => c.name)).toEqual(['jobs_kind_check']);
  });
});
