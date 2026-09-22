import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/connection.js';

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
    expect(row.n).toBe(4);
  });
});
