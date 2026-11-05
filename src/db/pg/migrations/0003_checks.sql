-- 0003_checks: internal reconciliation checks (Phase 2 Task 5, spec 2026-10-28 section 5). Expand-only.
-- Schema-unqualified: the migrator runs it with search_path set to the target schema.
-- check_results: one row per (asset, check, day), rewritten when the day is evaluated again (latest evaluation wins).
CREATE TABLE check_results (asset_id text COLLATE "C" NOT NULL, check_id text COLLATE "C" NOT NULL, day date NOT NULL,
  type text COLLATE "C" NOT NULL, lhs double precision, rhs double precision, gap_pct double precision,
  status text COLLATE "C" NOT NULL CHECK (status IN ('ok','breach','incomplete')), detail_json json NOT NULL,
  evaluated_at timestamptz NOT NULL, PRIMARY KEY (asset_id, check_id, day));
-- A breach opens a check_breach anomaly. 0001's kind CHECK is unnamed inline, so Postgres named it anomalies_kind_check;
-- the new list keeps every old kind, so a release that predates 0003 still inserts all of its own.
ALTER TABLE anomalies DROP CONSTRAINT anomalies_kind_check,
  ADD CONSTRAINT anomalies_kind_check CHECK (kind IN ('cross_check_mismatch','unlisted_sender','source_failure_streak',
    'revenue_disclosure_stale','revenue_payment','check_breach'));
