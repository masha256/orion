-- 0008_chain_prices: hourly prices read from chains and first-party venues (Phase 3 R2, plan P2/P5/P6). Expand-only:
-- one new table and three nullable `prices` columns, so orion-2026.11.12.1 (schema 7) still inserts and reads its rows
-- (it names its columns). Task 5 appends the chain-only flow view to this same file before the release.
-- Schema-unqualified: the migrator runs it with search_path set to the target schema.

-- B(H) per chain: the first block at or after the top of a UTC hour (block_ts in unix seconds). The price writer reads
-- every method at B(H+1h) and a cumulative TWAP from B(H); a stored hour is a fact of the chain and never rewritten.
CREATE TABLE hour_blocks (
  chain_id bigint,
  hour timestamptz,
  block bigint NOT NULL,
  block_ts bigint NOT NULL,
  PRIMARY KEY (chain_id, hour)
);

-- Each chain/first-party price row carries its check's outcome (plan P5): check_gap_pct = (check - primary) / primary
-- x 100 (for a `bound` check the distance outside its band; null when the check could not be read that hour), "check"
-- the check's label (its source, plus its config label: same_venue, no_independent_check), detail what was read (blocks,
-- raw answers, feed ages, the quote used). Null on CoinGecko rows.
ALTER TABLE prices
  ADD COLUMN check_gap_pct double precision,
  ADD COLUMN "check" text COLLATE "C",
  ADD COLUMN detail jsonb;
