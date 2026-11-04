import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../tools/import-sqlite/sqliteMigrations.js';
import { MINI_ASSET_YAML } from './assets.js';

/*
 * A SQLite database at schema 8 (or an older one), built with tools/import-sqlite/sqliteMigrations.ts and seeded with
 * the rows the importer and the proof tests reason about. Raw better-sqlite3: this is the importer's source file, not
 * an Orion database.
 *
 * Two assets have YAML (`mini`, `beta`); `ghost` has rows but no YAML.
 * - observations 1..8 without 6 (an id gap), sqlite_sequence 9: 1 is superseded by 2 (both mini price_usd), 3 is an
 *   undeclared metric (mini dominance_pct), 5 an undeclared asset (ghost), 7 has value -0.
 * - proposals 1..4: 2 is an `assumption_value` (retired), 3 a pending confirm_observation of observation 2.
 * - agent_runs 1 weekly (with a transcript, not carried), 2 disclosure (with a transcript, carried), 3 triage (none).
 * - one row each in run_locks and signals (with the valuation chain under it: config_versions, snapshots, valuation_runs).
 */
/** A second asset with the same metrics as mini. */
export const BETA_ASSET_YAML = MINI_ASSET_YAML.replace('id: mini', 'id: beta').replace('symbol: MINI', 'symbol: BETA').replace('name: Mini Test Asset', 'name: Beta Test Asset');

/** What the fixture holds, per carried table: its rows and the ids the importer must leave out, by reason. */
export const FIXTURE_EXPECTED = {
  agent_runs: { rows: 3, excluded: [] },
  agent_transcripts: { rows: 2, excluded: [{ reason: 'non_disclosure_transcript', ids: [1] }] },
  coverage: { rows: 2, excluded: [] },
  documents: { rows: 1, excluded: [] },
  journal: { rows: 1, excluded: [] },
  proposals: { rows: 4, excluded: [{ reason: 'retired_kind', ids: [2] }] },
  observations: {
    rows: 7,
    excluded: [
      { reason: 'undeclared_metric', ids: [3] },
      { reason: 'undeclared_asset', ids: [5] },
    ],
  },
  fetch_runs: { rows: 3, excluded: [] },
  fetch_cursors: { rows: 1, excluded: [] },
  anomalies: { rows: 2, excluded: [] },
} as const;

/** sqlite_sequence as the fixture leaves it (coverage, fetch_cursors and agent_transcripts have none). */
export const FIXTURE_SEQUENCES: Record<string, number> = {
  observations: 9,
  proposals: 4,
  agent_runs: 3,
  journal: 1,
  documents: 1,
  fetch_runs: 3,
  anomalies: 2,
};

const T = (s: string) => `2026-10-${s}.000Z`;

export interface SqliteFixture {
  dir: string;
  /** The SQLite file. */
  path: string;
  /** An assets directory with mini.yaml and beta.yaml. */
  assetsDir: string;
}

/**
 * Builds the fixture in a fresh temp dir. `schema` stops the migrations early (no seed below 8); `mutate` runs on the
 * open database after the seed, before it is closed.
 */
export function buildSqliteFixture(opts: { schema?: number; seed?: boolean; mutate?: (db: Database.Database) => void } = {}): SqliteFixture {
  const dir = mkdtempSync(join(tmpdir(), 'orion-sqlite-fixture-'));
  const assetsDir = join(dir, 'assets');
  mkdirSync(assetsDir);
  writeFileSync(join(assetsDir, 'mini.yaml'), MINI_ASSET_YAML.trimStart());
  writeFileSync(join(assetsDir, 'beta.yaml'), BETA_ASSET_YAML.trimStart());
  const path = join(dir, 'orion.db');
  const db = new Database(path);
  try {
    migrate(db, opts.schema ?? 8);
    if ((opts.seed ?? true) && (opts.schema ?? 8) === 8) seed(db);
    opts.mutate?.(db);
  } finally {
    db.close();
  }
  return { dir, path, assetsDir };
}

function seed(db: Database.Database): void {
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  };
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON'); // observation 1 is superseded by 2, inserted after it
    const obs = (id: number, asset: string, metric: string, value: number, over: Record<string, unknown> = {}) =>
      insert('observations', {
        id, asset_id: asset, metric_key: metric, observed_at: T('01T00:00:00'), period_days: null, value, source: 'manual', source_detail: null,
        status: 'confirmed', citation_url: null, quoted_text: null, fetched_at: T('01T12:00:00'), superseded_by: null, ...over,
      });
    obs(1, 'mini', 'price_usd', 10, { superseded_by: 2 });
    obs(2, 'mini', 'price_usd', 0.1 + 0.2, { fetched_at: '2026-10-02T08:30:15.123Z', source_detail: 'manual: corrected' });
    obs(3, 'mini', 'dominance_pct', 0.4);
    obs(4, 'beta', 'price_usd', 2.5, { source: 'api', source_detail: 'coingecko:beta', quoted_text: 'Beta — “quoted” ✓ 🚀' });
    obs(5, 'ghost', 'price_usd', 1);
    obs(7, 'beta', 'total_supply', -0, { status: 'provisional', citation_url: 'doc:1' });
    obs(8, 'mini', 'flow_usd.fees', 123456789.123456789, { period_days: 90, source: 'onchain' });
    db.prepare("UPDATE sqlite_sequence SET seq = 9 WHERE name = 'observations'").run();

    const run = (id: number, asset: string, type: string, over: Record<string, unknown> = {}) =>
      insert('agent_runs', {
        id, asset_id: asset, persona: 'analyst', run_type: type, trigger_kind: 'manual', trigger_detail_json: '{"by":"cli"}', outcome: 'completed',
        dry_run: 0, config_hash: `hash${id}`, model: 'claude-opus-5-5', started_at: T(`0${id}T10:00:00`), ended_at: T(`0${id}T10:05:00`),
        requests: 3, input_tokens: 12000, cache_read_tokens: 500, cache_write_tokens: 100, output_tokens: 900, web_searches: 1, web_fetches: 2,
        error: null, summary_json: '{"proposals":0}', ...over,
      });
    run(1, 'mini', 'weekly');
    run(2, 'mini', 'disclosure', { trigger_kind: 'document', trigger_detail_json: '{"documentId":1}' });
    run(3, 'beta', 'triage', { outcome: 'error', error: 'model refused', summary_json: null, dry_run: 1 });
    insert('agent_transcripts', { run_id: 1, messages_json: '[{"role":"user","content":"weekly pack"}]' });
    insert('agent_transcripts', { run_id: 2, messages_json: '[{"role":"user","content":"disclosure pack"}]' });

    insert('coverage', { asset_id: 'mini', persona: 'analyst', assigned_at: T('01T00:00:00') });
    insert('coverage', { asset_id: 'beta', persona: 'analyst', assigned_at: T('01T00:00:01') });
    insert('documents', {
      id: 1, asset_id: 'mini', kind: 'post', source_url: 'https://x.com/mini/status/1', source_id: 'x:1', title: 'Mini update',
      published_at: '2026-10-22T16:00:00Z', added_at: T('22T17:00:00'), sha256: 'ab'.repeat(32), bytes: 42, text: 'Mini said revenue grew.\n',
      meta_json: '{}',
    });
    insert('journal', {
      id: 1, asset_id: 'mini', persona: 'analyst', agent_run_id: 2, created_at: T('02T10:05:00'), thesis: 'Revenue is real.',
      open_questions_json: '["is it durable?"]', summary: 'Read the post.', catalysts_json: null,
    });

    const proposal = (id: number, kind: string, change: unknown, over: Record<string, unknown> = {}) =>
      insert('proposals', {
        id, asset_id: 'mini', persona: 'analyst', agent_run_id: 1, kind, change_json: JSON.stringify(change), filed_against_json: '{}',
        rationale: 'because', evidence_json: '[2]', effect_json: null, status: 'pending', created_at: T('01T10:05:00'), decided_at: null,
        decision_note: null, citations_json: null, ...over,
      });
    proposal(1, 'config', { kind: 'config', edits: [] }, { status: 'approved', decided_at: T('03T09:00:00'), decision_note: 'ok' });
    proposal(2, 'assumption_value', { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 1.8 });
    proposal(3, 'confirm_observation', { kind: 'confirm_observation', observationId: 2, note: 'n' }, { agent_run_id: 2 });
    proposal(4, 'acknowledge_anomaly', { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'n' }, { asset_id: 'beta', agent_run_id: null });

    const fetchRun = (id: number, asset: string, outcome: string) =>
      insert('fetch_runs', { id, asset_id: asset, started_at: T(`0${id}T06:00:00`), ended_at: T(`0${id}T06:00:30`), outcome, detail_json: '{"sources":[]}' });
    fetchRun(1, 'mini', 'ok');
    fetchRun(2, 'beta', 'partial');
    fetchRun(3, 'mini', 'failed');
    insert('fetch_cursors', { asset_id: 'mini', scan_key: 'transfers:0xabc', last_block: 23456789, last_day: '2026-10-01', updated_at: T('01T06:00:30') });

    const anomaly = (id: number, asset: string, status: string, over: Record<string, unknown> = {}) =>
      insert('anomalies', {
        id, asset_id: asset, kind: 'cross_check_mismatch', metric_key: 'price_usd', dedupe_key: 'coingecko', severity: 'advisory', status,
        detail_json: '{"diff_pct":3.2}', occurrences: 2, first_seen_at: T('01T06:00:00'), last_seen_at: T('02T06:00:00'), note: null,
        decided_at: null, decided_by: null, ...over,
      });
    anomaly(1, 'beta', 'open');
    anomaly(2, 'mini', 'resolved', { note: 'fixed', decided_at: T('03T00:00:00'), decided_by: 'mike' });

    insert('run_locks', { asset_id: 'mini', holder: 'tick:123', acquired_at: T('03T00:00:00'), expires_at: T('03T01:00:00') });
    insert('config_versions', { hash: 'hash1', asset_id: 'mini', content_json: '{}', created_at: T('01T00:00:00') });
    insert('snapshots', { id: 1, asset_id: 'mini', as_of: T('01T00:00:00'), observation_ids: '[1]', created_at: T('01T00:00:00') });
    insert('valuation_runs', {
      id: 1, asset_id: 'mini', snapshot_id: 1, assumption_set_id: null, engine_version: '1', config_hash: 'hash1', status: 'ok', output_json: '{}',
      created_at: T('01T00:00:00'),
    });
    insert('signals', { id: 1, signal_id: 'sig-1', run_id: 1, asset_id: 'mini', schema_version: 1, status: 'emitted', payload_json: '{}', emitted_at: T('01T00:00:00') });
  })();
}
