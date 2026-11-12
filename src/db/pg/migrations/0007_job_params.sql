-- 0007_job_params: per-job parameters and the `backfill` job kind (Phase 3 R0b Task 1, plan decision P1: a backfill runs
-- as a daemon job, not a long SSH session). Expand-only: params_json is nullable and the kind list keeps every old kind,
-- so a release that predates 0007 still inserts its own jobs (it names its columns and never sets params_json).
-- Schema-unqualified: the migrator runs it with search_path set to the target schema. params_json is jsonb: a backfill's
-- { op, metrics, backfillDays }; null for every scheduled kind.
ALTER TABLE jobs ADD COLUMN params_json jsonb;
-- 0002's kind CHECK is unnamed inline, so Postgres named it jobs_kind_check; it is re-added under the same name.
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check,
  ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('refresh','nightly_report','levels','snapshot_push','disclosure_watch',
    'staging_refresh','retention','backfill'));
