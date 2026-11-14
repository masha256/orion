-- 0008_chain_prices: hourly prices read from chains and first-party venues (Phase 3 R2, plan P2/P5/P6). Expand-only:
-- one new table and three nullable `prices` columns, so orion-2026.11.12.1 (schema 7) still inserts and reads its rows
-- (it names its columns); and a new view, flow_usd_chain_v, beside flow_usd_v (left as it is: the rollback reads it).
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

-- The chain-only flow USD view (plan P3): flow_usd_v's columns, but priced only from rows the chain writer stores
-- (source 'chain:<method kind>' or 'first_party:<venue>', src/prices/config.ts methodSource); a CoinGecko row is never
-- read, even when newer. Per hour bucket [H, H+1h) with an amount: the newest chain row at or before H, no more than
-- 6 hours old (equal ts: the newest write, fetched_at, wins; ruling R6); an older one is a gap, never a price. Basis:
--   usd_native        token_ref 'usd' (a first-party API that reports dollars): usd = amount;
--   hourly            hourly buckets and every hour with an amount priced: usd = usd_hourly;
--   legacy_unpriced   hourly buckets, some hour with an amount unpriced: usd = value;
--   daily_mean        no hourly buckets, a day's amount (period 1), and all 24 hours of the day [observed_at - 24 h,
--                     observed_at) carry a chain row at exactly that hour: usd = amount x the mean of the 24 prices
--                     (hours_priced = how many of the 24 do, hours_needed = 24);
--   legacy_no_hourly  no hourly buckets otherwise: usd = value;
--   legacy_no_tokens  no token columns: usd = value.
CREATE VIEW flow_usd_chain_v AS
SELECT o.id, o.asset_id, o.metric_key, o.observed_at, o.period_days, o.token_ref, o.amount,
  o.value AS legacy_usd,
  h.usd_hourly,
  COALESCE(h.hours_priced, d.hours_priced, 0) AS hours_priced,
  COALESCE(h.hours_needed, d.hours_needed, 0) AS hours_needed,
  CASE
    WHEN o.token_ref = 'usd' AND o.amount IS NOT NULL THEN o.amount
    WHEN o.hourly_amounts IS NOT NULL AND h.hours_missing = 0 THEN h.usd_hourly
    WHEN o.hourly_amounts IS NULL AND d.hours_priced = 24 THEN o.amount * d.mean_usd
    ELSE o.value
  END AS usd,
  CASE
    WHEN o.token_ref = 'usd' AND o.amount IS NOT NULL THEN 'usd_native'
    WHEN o.hourly_amounts IS NOT NULL AND h.hours_missing = 0 THEN 'hourly'
    WHEN o.hourly_amounts IS NOT NULL THEN 'legacy_unpriced'
    WHEN d.hours_priced = 24 THEN 'daily_mean'
    WHEN o.amount IS NOT NULL THEN 'legacy_no_hourly'
    ELSE 'legacy_no_tokens'
  END AS usd_basis
FROM observations o
LEFT JOIN LATERAL (
  SELECT
    CASE WHEN count(*) FILTER (WHERE b.amt <> 0 AND p.price_usd IS NULL) = 0
      THEN COALESCE(SUM(CASE WHEN b.amt <> 0 THEN b.amt * p.price_usd END), 0) END AS usd_hourly,
    count(p.price_usd) AS hours_priced,
    count(*) FILTER (WHERE b.amt <> 0) AS hours_needed,
    count(*) FILTER (WHERE b.amt <> 0 AND p.price_usd IS NULL) AS hours_missing
  FROM (
    SELECT e.txt::double precision AS amt,
      o.observed_at - interval '24 hours' + (e.i - 1) * interval '1 hour' AS hour_start
    FROM jsonb_array_elements_text(o.hourly_amounts) WITH ORDINALITY AS e(txt, i)
  ) b
  LEFT JOIN LATERAL (
    SELECT pr.price_usd FROM prices pr
    WHERE pr.token_ref = o.token_ref AND pr.ts <= b.hour_start AND pr.ts >= b.hour_start - interval '6 hours'
      AND (starts_with(pr.source, 'chain:') OR starts_with(pr.source, 'first_party:'))
    ORDER BY pr.ts DESC, pr.fetched_at DESC, pr.source
    LIMIT 1
  ) p ON true
) h ON o.hourly_amounts IS NOT NULL
LEFT JOIN LATERAL (
  SELECT count(*) AS hours_priced, 24 AS hours_needed, avg(q.price_usd) AS mean_usd
  FROM (
    SELECT DISTINCT ON (pr.ts) pr.price_usd FROM prices pr
    WHERE pr.token_ref = o.token_ref AND pr.ts >= o.observed_at - interval '24 hours' AND pr.ts < o.observed_at
      AND (starts_with(pr.source, 'chain:') OR starts_with(pr.source, 'first_party:'))
    ORDER BY pr.ts, pr.fetched_at DESC, pr.source
  ) q
) d ON o.hourly_amounts IS NULL AND o.amount IS NOT NULL AND o.token_ref <> 'usd' AND o.period_days = 1
WHERE o.superseded_by IS NULL AND o.status <> 'rejected' AND o.period_days IS NOT NULL AND starts_with(o.metric_key, 'flow_usd.');
