# Revenue definitions (2026-10-12)

Decided with Mike on 2026-10-12. Branch `feat/revenue-streams`. Queue note: `~/.hermes/profiles/raymond/workspace/orion/dev-queue-revenue.md`.

## What changed

1. **Revenue streams (generic).** `reporting.revenue` is a list of streams; revenue = their sum; a new revenue type is config only.
   - A stream is a flow `metric` with `settlement: daily` (a daily series) or `periodic` (lump payments, one row per coverage
     period, spread evenly over the days covered), or a `disclosed` level (the company's own figure).
   - The unpaid days after a periodic stream's last covered period run at that period's daily rate, marked provisional.
     Nothing is stored for them, so the payment replaces them when it lands.
   - A stream younger than the window is annualized over its own days (a run rate). Days before `started` count as 0.
   - Growth is 90d/90d as is, and again without streams younger than 180 days (`growthExNew`).
   - `holder_flow` also counts a stream in the report's holder flow (report only, never the valuation).
   - With streams, the income statement's revenue is their sum, and protocol income is the remainder. Without streams,
     revenue is the income statement's total, as before (AERO, CRV, the wrappers).
2. **HYPE: the USDC reserve yield (AQAv2), option A (Mike, 2026-10-12).**
   - Hyperliquid no longer publishes the daily AQA rate or the balance: `alignedQuoteTokenInfo` now returns 422. The
     truth is each 30-day payment from the system interest address `0x5000…0000` to the Assistance Fund, read from
     `userNonFundingLedgerUpdates`.
   - New adapter `hype.reserve_yield_payments`; new metric `flow_usd.reserve_yield` (monitor_only); one row per paid period.
   - First payment: $14,580,776.69 for 2026-08-26..09-24. The fund received $2 on the 10-03 due day and $14,580,774.69
     on 10-04; the treasury `0x8536…270c` funded it on 10-03 at 02:43 UTC.
   - Alerts (new anomaly kind `revenue_payment`, advisory, migration 7): more than 10 days late; more than 2% off the
     previous period's daily rate; a payer other than `aqa_treasury`.
   - The >25bp daily rate alert is not possible: the rate is not published.
3. **VVV: revenue = disclosed business revenue.**
   - DefiLlama's `dailyRevenue` (the burns, $9.30M) is a cross-check only. Holder flow stays = the burns.
   - A config rule: an asset with `revenue_disclosed` must list it as a disclosed stream.
   - Growth is from the two latest disclosures, flagged when they are < 90 days apart or the latest is > 90 days old.
   - Prior disclosure to enter on live: $70M at 2026-07-01, TechCrunch
     (https://techcrunch.com/2026/07/01/venice-ai-becomes-a-unicorn-with-65m-series-a-as-its-privacy-first-ai-platform-takes-off/):
     "The company is already profitable, with annualized run-rate revenues of over $70 million". Entered at the floor.
4. **UNI:** one daily stream labelled "protocol fees (v2 + selected v3)". No logic change.
5. **DefiLlama series:** every run re-reads the last 30 written days and supersedes changed rows
   (`DEFILLAMA_REVISION_DAYS`; a source may set `revision_days`).
   - A manual row inside those 30 days is a decision already taken and is left alone on routine runs (AERO's 2026-09-09
     artifact, #515). A rescan still refuses it unless `--adopt`.

## Verification (scratch ORION_HOME, a copy of live; live untouched)

- Tests: 86 files, 849 passed; typecheck clean. Each new test failed with its change stashed.
- Targets: the old build (main) and the new build, each on its own copy, all 8 assets at the same as-of
  (2026-10-12T13:00Z): byte-identical engine output. The new copy also had the reserve-yield row and the VVV
  disclosure. The engine reads only the latest `revenue_run_rate_usd` level, and `flow_usd.reserve_yield` is monitor_only.

## Revenue, report day 2026-10-11

- **HYPE:** $904.41M = trading $727.01M + reserve yield $177.40M.
  - The reserve yield runs over 47 days, 17 of them provisional, at $486k a day.
  - Growth: 281.5% annualized as is; 134.6% without the new stream.
  - Holder flow: $904.41M (af_buyback $727.01M plus reserve yield $177.40M); the valuation keeps af_buyback only.
- **VVV:** $100.00M disclosed. Growth +42.9% over 47 days, 1495.7% annualized; flagged because the disclosures are
  < 90 days apart. Cross-check: DefiLlama $9.30M. Protocol income $90.62M after $9.38M of burns.
- **UNI:** $132.05M, "protocol fees (v2 + selected v3)".
- **AERO:** $69.75M (unchanged). DefiLlama's current 90-day figure is $100.82M, but the whole gap is the 2026-09-09 day:
  - $7.92M on DefiLlama against our manual $0.26M (#515; ruled a DefiLlama artifact with Mike on 2026-09-24).
  - Every other day in the window matches DefiLlama to the dollar, so there is no revision to pick up.
  - ≈ $100M needs #515 rejected. That is a decision for Mike, not a fetch.
- **HYPE trading history:** our 90-day sum matches DefiLlama today ($179.26M). The revisions noted in the queue were
  already picked up; five August days differ by under 0.02%.
