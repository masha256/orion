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
    expect(row.n).toBe(7);
  });

  it('migration 6 renames effective_supply to total_supply wherever the code reads it back, and nothing else', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((m) => m.id <= 5)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, '2026-10-01T00:00:00.000Z');
    }
    const obs = db.prepare("INSERT INTO observations (asset_id, metric_key, observed_at, value, source, source_detail, status, fetched_at) VALUES (?, ?, '2026-10-01T00:00:00Z', ?, 'onchain', ?, 'confirmed', '2026-10-01T00:00:00Z')");
    obs.run('hype', 'effective_supply', 950_893_077.5, 'spotMetaAndAssetCtxs @107: effective_supply note');
    obs.run('hype', 'price_usd', 40.1, null);
    db.prepare("INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at) VALUES ('hype', 'source_failure_streak', '', 'adapter:hype.effective_supply', 'advisory', 'open', '{}', 3, 'x', 'x')").run();
    db.prepare("INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at) VALUES ('vvv', 'cross_check_mismatch', 'effective_supply', 'http_json:x', 'degrading', 'open', '{}', 1, 'x', 'x')").run();
    db.prepare("INSERT INTO trigger_firings (asset_id, kind, key, fired_at, detail_json) VALUES ('vvv', 'staleness', 'effective_supply', 'x', '{}'), ('vvv', 'calendar', 'effective_supply', 'x', '{}')").run();
    const detail = { sources: [{ sourceId: 'adapter:hype.effective_supply', status: 'ok', metricsWritten: ['effective_supply'], notes: ['effective_supply_note stays'] }] };
    db.prepare("INSERT INTO fetch_runs (asset_id, started_at, ended_at, outcome, detail_json) VALUES ('hype', 'x', 'x', 'ok', ?)").run(JSON.stringify(detail));
    const config = { id: 'hype', metrics: { effective_supply: { type: 'level', source: { type: 'adapter', name: 'hype.effective_supply' } } }, note: 'effective supply prose' };
    db.prepare("INSERT INTO config_versions (hash, asset_id, content_json, created_at) VALUES ('h1', 'hype', ?, 'x')").run(JSON.stringify(config));
    db.prepare("INSERT INTO journal (asset_id, persona, created_at, thesis, open_questions_json, summary) VALUES ('vvv', 'p', 'x', 'effective_supply in prose', '[]', 's')").run();

    migrate(db);

    expect(db.prepare('SELECT metric_key, value, source_detail FROM observations ORDER BY id').all()).toEqual([
      { metric_key: 'total_supply', value: 950_893_077.5, source_detail: 'spotMetaAndAssetCtxs @107: effective_supply note' },
      { metric_key: 'price_usd', value: 40.1, source_detail: null },
    ]);
    expect(db.prepare('SELECT metric_key, dedupe_key FROM anomalies ORDER BY id').all()).toEqual([
      { metric_key: '', dedupe_key: 'adapter:hype.total_supply' },
      { metric_key: 'total_supply', dedupe_key: 'http_json:x' },
    ]);
    expect(db.prepare('SELECT kind, key FROM trigger_firings ORDER BY id').all()).toEqual([{ kind: 'staleness', key: 'total_supply' }, { kind: 'calendar', key: 'effective_supply' }]);
    expect(JSON.parse((db.prepare('SELECT detail_json FROM fetch_runs').get() as { detail_json: string }).detail_json)).toEqual({
      sources: [{ sourceId: 'adapter:hype.total_supply', status: 'ok', metricsWritten: ['total_supply'], notes: ['effective_supply_note stays'] }],
    });
    const row = db.prepare('SELECT hash, content_json FROM config_versions').get() as { hash: string; content_json: string };
    expect(row.hash).toBe('h1');
    expect(JSON.parse(row.content_json)).toEqual({ id: 'hype', metrics: { total_supply: { type: 'level', source: { type: 'adapter', name: 'hype.total_supply' } } }, note: 'effective supply prose' });
    // Model-written prose is history: unchanged.
    expect(db.prepare('SELECT thesis FROM journal').get()).toEqual({ thesis: 'effective_supply in prose' });
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

    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(7);
    expect(db.prepare('SELECT id, run_type FROM agent_runs ORDER BY id').all()).toEqual([{ id: 1, run_type: 'deep' }]);
    expect(db.prepare('SELECT agent_run_id FROM proposals').all()).toEqual([{ agent_run_id: 1 }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runs_asset'").all()).toHaveLength(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    insertRun('bootstrap');
    expect(db.prepare('SELECT MAX(id) AS id FROM agent_runs').get()).toEqual({ id: 3 }); // the sequence carried over the rebuild
    expect(() => db.prepare("INSERT INTO agent_transcripts (run_id, messages_json) VALUES (99, '[]')").run()).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('migration 7 rebuilds anomalies for the revenue_payment kind, keeping rows, ids, the id sequence and both indexes', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((m) => m.id <= 6)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, '2026-10-01T00:00:00.000Z');
    }
    db.pragma('foreign_keys = ON');
    const add = (kind: string, status = 'open', key = 'k') =>
      db.prepare("INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, first_seen_at, last_seen_at, decided_by) VALUES ('hype', ?, 'm', ?, 'advisory', ?, '{}', 't', 't', 'u')").run(kind, key, status);
    add('cross_check_mismatch', 'resolved', 'a');
    add('unlisted_sender', 'open', 'b');
    db.prepare('DELETE FROM anomalies WHERE id = 2').run(); // the sequence runs ahead of the surviving max id
    expect(() => add('revenue_payment')).toThrow(/CHECK constraint failed/);
    migrate(db);
    expect((db.prepare('SELECT MAX(id) AS n FROM schema_migrations').get() as { n: number }).n).toBe(7);
    expect(db.prepare('SELECT id, kind, status, decided_by FROM anomalies').all()).toEqual([{ id: 1, kind: 'cross_check_mismatch', status: 'resolved', decided_by: 'u' }]);
    expect(Number(add('revenue_payment').lastInsertRowid)).toBe(3);
    expect(() => add('revenue_payment')).toThrow(/UNIQUE constraint failed/); // one open per key, as before
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'anomalies' ORDER BY name").all()).toEqual([{ name: 'idx_anomalies_asset' }, { name: 'idx_anomalies_one_open' }]);
  });
});
