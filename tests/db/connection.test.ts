import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/connection.js';
import { MIGRATIONS } from '../../src/db/migrations.js';

describe('openDb', () => {
  it('applies migrations and creates the sub-project 1 tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['observations', 'assumption_sets', 'assumptions', 'config_versions', 'snapshots', 'valuation_runs', 'signals']) {
      expect(names).toContain(t);
    }
  });

  it('creates the sub-project 2 tables in migration 2', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['fetch_runs', 'fetch_cursors', 'anomalies']) expect(names).toContain(t);
  });

  it('creates the sub-project 3 tables and columns in migration 3', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['coverage', 'agent_runs', 'agent_transcripts', 'proposals', 'assumption_changes', 'assumption_evidence', 'journal']) {
      expect(names).toContain(t);
    }
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('anomalies')).toContain('decided_by');
    expect(columns('valuation_runs')).toContain('agent_run_id');
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(row.n).toBe(5);
  });

  it('migration 5 rebuilds agent_runs for the bootstrap run type, keeping rows, ids, references, and the id sequence', () => {
    // A database as sub-project 4 left it: migrations 1 to 4 applied by hand, with a run, its transcript, and a proposal that references it.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((m) => m.id <= 4)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, '2026-09-21T00:00:00.000Z');
    }
    const insertRun = (runType: string) =>
      db.prepare("INSERT INTO agent_runs (asset_id, persona, run_type, trigger_kind, trigger_detail_json, outcome, config_hash, model, started_at) VALUES ('vvv', 'p', ?, 'schedule', '{}', 'completed', 'h', 'm', '2026-09-21T00:00:00Z')").run(runType);
    insertRun('deep');
    insertRun('weekly');
    db.prepare('DELETE FROM agent_runs WHERE id = 2').run(); // so the sequence is ahead of the surviving max id
    db.prepare("INSERT INTO agent_transcripts (run_id, messages_json) VALUES (1, '[]')").run();
    db.prepare("INSERT INTO proposals (asset_id, persona, agent_run_id, kind, change_json, filed_against_json, rationale, evidence_json, status, created_at) VALUES ('vvv', 'p', 1, 'config', '{}', '{}', 'r', '[]', 'pending', '2026-09-21T00:00:00Z')").run();
    expect(() => insertRun('bootstrap')).toThrow(/CHECK constraint failed/);

    migrate(db);

    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(5);
    expect(db.prepare('SELECT id, run_type FROM agent_runs ORDER BY id').all()).toEqual([{ id: 1, run_type: 'deep' }]);
    expect(db.prepare('SELECT agent_run_id FROM proposals').all()).toEqual([{ agent_run_id: 1 }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runs_asset'").all()).toHaveLength(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    insertRun('bootstrap');
    expect(db.prepare('SELECT MAX(id) AS id FROM agent_runs').get()).toEqual({ id: 3 }); // the sequence carried over the rebuild
    expect(() => db.prepare("INSERT INTO agent_transcripts (run_id, messages_json) VALUES (99, '[]')").run()).toThrow(/FOREIGN KEY constraint failed/);
  });
});
