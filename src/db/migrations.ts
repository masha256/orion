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
  {
    id: 3,
    sql: `
CREATE TABLE coverage (
  asset_id TEXT PRIMARY KEY,
  persona TEXT NOT NULL,
  assigned_at TEXT NOT NULL
);

CREATE TABLE agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  persona TEXT NOT NULL,
  run_type TEXT NOT NULL CHECK (run_type IN ('weekly','triage','deep')),
  trigger_kind TEXT NOT NULL,
  trigger_detail_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('running','completed','budget_exhausted','refused','no_journal','conflict','error')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  config_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  web_fetches INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  summary_json TEXT
);
CREATE INDEX idx_agent_runs_asset ON agent_runs (asset_id, id);

CREATE TABLE agent_transcripts (
  run_id INTEGER PRIMARY KEY REFERENCES agent_runs(id),
  messages_json TEXT NOT NULL
);

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  persona TEXT NOT NULL,
  agent_run_id INTEGER REFERENCES agent_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('assumption_value','config','acknowledge_anomaly','withdraw_acknowledgement','confirm_observation','reject_observation','observation')),
  change_json TEXT NOT NULL,
  filed_against_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  effect_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX idx_proposals_asset ON proposals (asset_id, status);

CREATE TABLE assumption_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES assumption_sets(id),
  key TEXT NOT NULL,
  scenario TEXT NOT NULL CHECK (scenario IN ('bear','base','bull')),
  from_value REAL NOT NULL,
  to_value REAL NOT NULL,
  rationale TEXT NOT NULL
);
CREATE TABLE assumption_evidence (
  change_id INTEGER NOT NULL REFERENCES assumption_changes(id),
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  PRIMARY KEY (change_id, observation_id)
);

CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  persona TEXT NOT NULL,
  agent_run_id INTEGER REFERENCES agent_runs(id),
  created_at TEXT NOT NULL,
  thesis TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX idx_journal_asset ON journal (asset_id, id);

ALTER TABLE anomalies ADD COLUMN decided_by TEXT;
ALTER TABLE valuation_runs ADD COLUMN agent_run_id INTEGER;
`,
  },
  {
    id: 4,
    sql: `
CREATE TABLE run_locks (
  asset_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE trigger_firings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open_anomaly', 'driver_deviation', 'staleness', 'provisional', 'calendar')),
  key TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  agent_run_id INTEGER REFERENCES agent_runs(id),
  detail_json TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_trigger_firings_instance ON trigger_firings (asset_id, kind, key);
`,
  },
];
