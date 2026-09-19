export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  period_days REAL,
  value REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('onchain','api','manual')),
  source_detail TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed','provisional','rejected')),
  citation_url TEXT,
  quoted_text TEXT,
  fetched_at TEXT NOT NULL,
  superseded_by INTEGER REFERENCES observations(id)
);
CREATE INDEX idx_obs_lookup ON observations (asset_id, metric_key, observed_at);

CREATE TABLE assumption_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  author TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version)
);
CREATE TABLE assumptions (
  set_id INTEGER NOT NULL REFERENCES assumption_sets(id),
  key TEXT NOT NULL,
  scenario TEXT NOT NULL CHECK (scenario IN ('bear','base','bull')),
  value REAL NOT NULL,
  PRIMARY KEY (set_id, key, scenario)
);

CREATE TABLE config_versions (
  hash TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  observation_ids TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE valuation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  assumption_set_id INTEGER REFERENCES assumption_sets(id),
  engine_version TEXT NOT NULL,
  config_hash TEXT NOT NULL REFERENCES config_versions(hash),
  status TEXT NOT NULL,
  output_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL UNIQUE,
  run_id INTEGER NOT NULL REFERENCES valuation_runs(id),
  asset_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    sql: `
CREATE TABLE fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','partial','failed')),
  detail_json TEXT NOT NULL
);
CREATE INDEX idx_fetch_runs_asset ON fetch_runs (asset_id, id);

CREATE TABLE fetch_cursors (
  asset_id TEXT NOT NULL,
  scan_key TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  last_day TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, scan_key)
);

CREATE TABLE anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cross_check_mismatch','unlisted_sender','source_failure_streak','revenue_disclosure_stale')),
  metric_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('degrading','advisory')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','acknowledged')),
  detail_json TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  note TEXT,
  decided_at TEXT
);
CREATE INDEX idx_anomalies_asset ON anomalies (asset_id, status);
CREATE UNIQUE INDEX idx_anomalies_one_open ON anomalies (asset_id, kind, metric_key, dedupe_key) WHERE status = 'open';
`,
  },
];
