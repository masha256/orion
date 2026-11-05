-- 0005_tokens_prices: token amounts and prices stored apart (Phase 2 Task 7, spec 2026-10-28 section 4). Expand-only:
-- every new column is nullable and `value` (USD) keeps being written next to them (plan correction 2), so a release that
-- predates 0005 still inserts and reads its rows. Types follow the baseline (correction 3): double precision and jsonb,
-- not numeric (the pool has no NUMERIC parser).
-- Schema-unqualified: the migrator runs it with search_path set to the target schema.

-- One row per priced token. token_ref: 'eip155:<chain>/<address lowercased>', 'solana:mainnet/<mint>', 'usd' (a dollar
-- amount a first-party API reports), or 'coingecko:<id>' (a vault share's underlying, valued shares x pricePerShare,
-- whose address the config does not name).
CREATE TABLE tokens (
  token_ref text COLLATE "C" PRIMARY KEY,
  symbol text COLLATE "C" NOT NULL,
  decimals bigint,
  -- Stablecoins are priced from market data like any token; peg only labels them.
  peg text COLLATE "C" CHECK (peg IN ('usd')),
  coingecko_id text COLLATE "C"
);
INSERT INTO tokens (token_ref, symbol, decimals, peg, coingecko_id) VALUES ('usd', 'USD', NULL, 'usd', NULL);

-- Deletable as a unit if a licence lapses. ts is the top of the UTC hour the point was floored to.
CREATE TABLE prices (
  token_ref text COLLATE "C" NOT NULL REFERENCES tokens,
  ts timestamptz NOT NULL,
  price_usd double precision NOT NULL CHECK (price_usd > 0),
  -- 'coingecko' | 'chainlink:<feed>' | 'pool:<addr>'
  source text COLLATE "C" NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (token_ref, ts, source)
);

-- Flows: what the amount is in, the day's total in token units, and (transfer scans) the 24 UTC-hour sub-totals.
ALTER TABLE observations
  ADD COLUMN token_ref text COLLATE "C" REFERENCES tokens,
  ADD COLUMN amount double precision,
  ADD COLUMN hourly_amounts jsonb;

-- Per active USD flow row (a `flow_usd.*` metric with period_days set; every USD flow metric is named so, and only
-- they are: tests/db/prices.test.ts pins the rule, so legacy_usd is always dollars and a `flow_tokens.*` count never
-- appears): the USD re-priced from the hourly token buckets, beside `value` (legacy_usd).
-- Hour h (1-based in the jsonb array) starts at observed_at - 24 hours + (h - 1) hours: fixed-length intervals, never
-- calendar-day arithmetic, so the buckets do not depend on the session TimeZone (a `- 1 day` in America/Los_Angeles is
-- 25 hours on 2026-11-01).
-- An hour's price is the newest `prices` row of the token at or before the hour's start, by source priority (coingecko
-- first), and no more than 6 hours old: an older row is a gap in the series, never a price. An hour with a zero amount
-- needs no price. `usd` is what a reader would use and `usd_basis` labels it:
--   hourly            every hour with an amount is priced: usd = usd_hourly;
--   usd_native        token_ref 'usd' (a first-party API that reports dollars): usd = amount;
--   legacy_unpriced   some hour with an amount has no price (beyond the hourly price history, plan correction 13): usd = value;
--   legacy_no_hourly  tokens but no hourly buckets (Solana's supply drop): usd = value;
--   legacy_no_tokens  no tokens stored (history not backfilled, DefiLlama rows): usd = value.
-- No report reads this view before gate G2.
CREATE VIEW flow_usd_v AS
SELECT o.id, o.asset_id, o.metric_key, o.observed_at, o.period_days, o.token_ref, o.amount,
  o.value AS legacy_usd,
  h.usd_hourly,
  COALESCE(h.hours_priced, 0) AS hours_priced,
  COALESCE(h.hours_needed, 0) AS hours_needed,
  CASE
    WHEN o.token_ref = 'usd' AND o.amount IS NOT NULL THEN o.amount
    WHEN o.hourly_amounts IS NOT NULL AND h.hours_missing = 0 THEN h.usd_hourly
    ELSE o.value
  END AS usd,
  CASE
    WHEN o.token_ref = 'usd' AND o.amount IS NOT NULL THEN 'usd_native'
    WHEN o.hourly_amounts IS NOT NULL AND h.hours_missing = 0 THEN 'hourly'
    WHEN o.hourly_amounts IS NOT NULL THEN 'legacy_unpriced'
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
    ORDER BY CASE WHEN pr.source = 'coingecko' THEN 0 ELSE 1 END, pr.ts DESC
    LIMIT 1
  ) p ON true
) h ON o.hourly_amounts IS NOT NULL
WHERE o.superseded_by IS NULL AND o.status <> 'rejected' AND o.period_days IS NOT NULL AND starts_with(o.metric_key, 'flow_usd.');
