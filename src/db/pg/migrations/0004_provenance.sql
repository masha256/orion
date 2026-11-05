-- 0004_provenance: structured provenance on every observation (Phase 2 Task 6, spec 2026-10-28 section 3). Expand-only:
-- every column is nullable, so a release that predates 0004 still inserts its rows (they carry no provenance until
-- `orion db backfill-provenance` maps them). The TypeScript NewObservation type is what makes provenance mandatory for
-- this release's writers; SET NOT NULL waits for the breaking release (plan Task 10, gate G3).
-- Schema-unqualified: the migrator runs it with search_path set to the target schema. tx_count is bigint (baseline 7.1:
-- no integer columns); locator, tx_refs, inputs and coverage are jsonb (queried by key in later phases).
ALTER TABLE observations
  ADD COLUMN method text COLLATE "C" CHECK (method IN ('measured','derived','disclosed')),
  ADD COLUMN source_type text COLLATE "C" CHECK (source_type IN ('contract_state','log_scan','first_party_api','pool_scan',
    'disclosure','derived','constant','market_data','third_party')),
  -- CAIP-2 ('eip155:1', 'solana:mainnet', 'hyperliquid:core'); null off chain.
  ADD COLUMN chain text COLLATE "C",
  -- Where the value was read: contracts and call, event and senders, an API endpoint (never a key), a citation, a formula.
  ADD COLUMN locator jsonb,
  ADD COLUMN block_from bigint,
  ADD COLUMN block_to bigint,
  ADD COLUMN tx_count bigint,
  -- At most 50 "txhash:logIndex" refs; tx_digest is the sha256 of the full sorted list.
  ADD COLUMN tx_refs jsonb,
  ADD COLUMN tx_digest text COLLATE "C",
  ADD COLUMN response_digest text COLLATE "C",
  ADD COLUMN inputs jsonb,
  ADD COLUMN formula text COLLATE "C",
  ADD COLUMN coverage jsonb,
  ADD COLUMN code_version text COLLATE "C",
  ADD COLUMN config_hash text COLLATE "C";
CREATE INDEX idx_obs_method ON observations (asset_id, metric_key, method);
-- The hourly levels' newest reading carries its rung and locator too (latest-only, no history).
ALTER TABLE latest_levels
  ADD COLUMN source_type text COLLATE "C",
  ADD COLUMN locator jsonb;
