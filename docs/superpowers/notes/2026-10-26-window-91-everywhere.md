# One flow window on every asset: 91 days (2026-10-26)

Decision (Mike, 2026-10-26, option 2): every asset uses the same 91-day (13-week) window for the holder flows, the
derived revenue run rate and the report, so the comparison tables are like for like. 91 was introduced with CRV (weekly
payouts: a whole number of weeks keeps the payout count in the window fixed) and used by every asset since; HYPE, AERO
and VVV were onboarded on 90 before that and never moved.

Changed (config only, no engine change):
- HYPE: `revenue_run_rate_usd` flow_annualized days 90 -> 91; holder flow `af_buyback` window_days 90 -> 91; reporting
  window_days 90 -> 91.
- AERO: the same three (run rate on `flow_usd.fees`, holder flow `fees`, reporting); `ingest.backfill_days` and the
  DefiLlama `backfill_days` 90 -> 100 (backfill > window, as on every other asset).
- VVV: holder flow `burn` window_days 90 -> 91; reporting window_days 90 -> 91; `ingest.backfill_days` 90 -> 100. Its
  revenue is the disclosed run rate (no window).
- Not changed: the `HolderFlowSchema.window_days` default (90). Every asset sets the window explicitly; moving the default
  moves engine fixture tests (compute, contrast, revenueStreams) without touching any live asset. `DISCLOSURE_GAP_DAYS`
  (90) is a staleness rule, not a flow window.

Hash re-pins: hype 531b976f…, aero 3109d0d7…, vvv 125526e9… (tests/config/load, tests/app/cadence, the hype/aero ingest
tests). The aero/hype canned-ingest expectations follow the new backfill/window (rows kept, run-rate days, source detail),
and the VVV report literal in tests/report/revenueStreams follows the 91-day window (364 = 4 x 91, needs 182 days).

Proof (scratch homes on a `.backup` of live, as-of 2026-10-27T03:00Z, `model whatif --json`, old main dist vs new):
- 10 assets byte-identical: cake crv cvxcrv link lit pump sdcrv sky uni ycrv.
- HYPE: every target -0.33% (12m expected 124.10 -> 123.70). Run rate 789.13M -> 786.51M.
- AERO: +0.01% (12m expected 0.4854 -> 0.4855). Run rate 76.597M -> 76.604M.
- VVV: -0.04% to -0.09% (12m expected 36.34 -> 36.32).
- Suite 100 files / 1170 tests green; typecheck clean.

Live steps after merge: re-fetch the derived run rate (`data fetch hype --metric revenue_run_rate_usd`, same for aero),
which supersedes the stored 90-day rows with 91-day ones (history kept as superseded). The next signal for each of the
three lists "config" as its change.
