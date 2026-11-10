-- breaking
-- 0006_provenance_not_null: the contract half of 0004 (Phase 2 Task 10, gate G3; spec 2026-10-28 section 3). Every row
-- carries its provenance (prod and stage: `db backfill-provenance` left 0 null rows), so the columns every writer sets
-- become NOT NULL, and `observations.source` is dropped: the origin a reader needs is derived from the provenance by one
-- function (src/provenance/origin.ts `originOf`). Not expand-only: a release before this one inserts `source` and no
-- longer runs on this schema, so there is no rollback past it (docs/ops/deploy.md, "Phase 2 tail").
-- A disclosed row needs its citation, except history the backfill mapped (R17 rule 2b: pre-v2 seeds with a quote only).
-- latest_levels keeps its `source` (the levels snapshot body publishes it, and the table has no method to derive it from).
-- Schema-unqualified: the migrator runs it with search_path set to the target schema.
ALTER TABLE observations
  ALTER COLUMN method SET NOT NULL,
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN locator SET NOT NULL,
  ALTER COLUMN code_version SET NOT NULL,
  ALTER COLUMN config_hash SET NOT NULL,
  ADD CONSTRAINT observations_disclosure_citation CHECK (source_type <> 'disclosure' OR citation_url IS NOT NULL OR code_version = 'pre-v2'),
  DROP COLUMN source;
ALTER TABLE latest_levels
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN locator SET NOT NULL;
