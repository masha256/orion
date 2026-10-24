# LIT Lighter-API followups, 2026-10-23

Spec: `docs/superpowers/specs/2026-10-23-orion-lit-lighter-api-design.md`. Plan:
`docs/superpowers/plans/2026-10-23-orion-lit-lighter-api.md`. Branch `feat/lit-lighter-api`.

## Picks (Mike, 2026-10-23: "1: a. 2: a. 3: a"; section 11 decisions as recommended)

1. Holder flow stays the measured Core buys. Display-only watch on the Robinhood (RH) fee account
   (`rh_fee_account_usd`, `change_pct: 5`) and its buybacks (`flow_usd.rh_buyback`, `above: 1000`).
2. Revenue = Lighter Core fees + 0.5 x RH fees, both from Lighter's `exchangeMetrics` (`flow_usd.fees_core`,
   `flow_usd.fees_rh`; RH stream `share: 0.5`, `started: "2026-06-26"`). The split is watched in Lighter's app
   (`rh_revenue_share_app`, `outside: [0.5, 0.5]`). DefiLlama's `flow_usd.fees` / `flow_usd.llama_revenue` stay as
   stored display series and feed no report line.
3. Staked LIT as display only (`staked_tokens_reported`; `staking_apr` with `outside: [0.057, 0.063]`).
   `staked_supply` stays the constant 0.
- Thresholds as written; WATCH lines in all 13 cron prompts; volume = first-party gross fees; 362-day backfill.

## Config hash

LIT `ad683e198b9b97af4d0067e339b89323b1711fe3e689fbb7f9fd404353f926a5` ->
`f2fae2705b68149a7d51fa83178c34c66d1baaba047ad64009d42cf4554a0a53`. LIT's next signal lists "config" as its only
change.

## No value moved (13 assets)

`model whatif <a> --as-of 2026-10-23T12:00:00.000Z --json` with `main`'s dist (642fd3b) and the branch's dist (48a5dc5)
on two `.backup` copies of the live DB (2026-10-24 ~01:05Z): **13/13 byte-identical** (aero, cake, crv, cvxcrv, hype, link,
lit, pump, sdcrv, sky, uni, vvv, ycrv). LIT is identical too: whatif output carries no config hash. `asset validate`: ok
for all 13 with the branch build.

## Scratch rehearsal

Scratch `.backup` home, branch dist, real Lighter reads (2026-10-24 01:12Z):
- Backfill (`flow_usd.fees_core`, `flow_usd.fees_rh`, `flow_usd.rh_buyback`, `--backfill-days 362`): 5.7 s, exit 0, no
  failed source. Rows: fees_core 362 (2025-10-27 .. 2026-10-23), fees_rh 120 (from 2026-06-26), rh_buyback 298 (sum $141).
- Level reads: 5.2 s, exit 0. rh_fee_account_usd $3,489,760.63; rh_revenue_share_app 0.5; staked_tokens_reported
  111,162,089.96 LIT; staking_apr 0.06018.
- anomalies 7 -> 7, trigger_firings 4 -> 4; no watch fired (first readings have no previous).
- Pitfall met: the live `.env` sets `ORION_HOME`; sourcing a copy re-pointed the shell at live. Both commands refused at
  config validation before any fetch; live unchanged (mtime, size, fetch_runs, observations). Rerun with `ORION_HOME`
  inline and the line removed from the scratch copies; the orion skill now carries the rule.

## Report check

`report yield lit --json` in the scratch home (window to 2026-10-22, 91 days):
- revenue $40,490,272/yr = core $32,882,153 + robinhood $7,608,118 (share 0.5 of gross $15,216,237); spec section 2:
  $40.5M (the same figure, recomputed by hand from the API on 2026-10-23).
- holders $32,486,661 (unchanged); protocol income $8,003,610 (was $15.9M); payout 80.23% (was 67%).
- volume $48,098,390 (was $60.2M, DefiLlama dailyFees).
- Growth now computes (a year of history): +343%/yr annualized with the new RH stream, +93%/yr ex streams younger than
  180 days (`robinhood` excluded). Read the ex-new figure.

## Revision check

Baseline saved: `~/.hermes/profiles/raymond/workspace/orion/lit-scoping/revision-baseline-2026-10-24T0112Z.csv`
(fees_core and fees_rh, 2026-10-17 .. 2026-10-23). At rollout, diff a fresh pull against it and record any restated day
here.

### Result (kanban t_3bfa0ba7, 2026-10-24): no restatement

Read-only: the live DB (`mode=ro`) after the first post-baseline tick (fetch_run 272, 2026-10-24T12:50:18Z), and a
fresh `exchangeMetrics?period=all` pull of the four kinds from both instances at 2026-10-24T15:48:26Z. Rows are stamped
at day end, so stamp 2026-10-17 is Lighter day 2026-10-16. Delta = fresh - baseline = stored - baseline, in USD.

| stamp (day end) | Lighter day | core baseline | core stored | core fresh | delta | RH baseline | RH stored | RH fresh | delta |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-10-17 | 10-16 | 100,321.05 | 100,321.05 | 100,321.05 | 0 | 82,360.43 | 82,360.43 | 82,360.43 | 0 |
| 2026-10-18 | 10-17 | 54,065.35 | 54,065.35 | 54,065.35 | 0 | 47,860.78 | 47,860.78 | 47,860.78 | 0 |
| 2026-10-19 | 10-18 | 85,679.30 | 85,679.30 | 85,679.30 | 0 | 55,491.50 | 55,491.50 | 55,491.50 | 0 |
| 2026-10-20 | 10-19 | 122,885.40 | 122,885.40 | 122,885.40 | 0 | 68,924.97 | 68,924.97 | 68,924.97 | 0 |
| 2026-10-21 | 10-20 | 140,415.13 | 140,415.13 | 140,415.13 | 0 | 76,499.49 | 76,499.49 | 76,499.49 | 0 |
| 2026-10-22 | 10-21 | 118,054.92 | 118,054.92 | 118,054.92 | 0 | 92,160.18 | 92,160.18 | 92,160.18 | 0 |
| 2026-10-23 | 10-22 | 123,112.62 | 123,112.62 | 123,112.62 | 0 | 82,623.03 | 82,623.03 | 82,623.03 | 0 |
| 2026-10-24 | 10-23 | 87,065.95 | not stored | 87,065.95 | 0 | 71,007.68 | not stored | 71,007.68 | 0 |

- No day restated, within or beyond 7 days. Wider check: every active stored row (fees_core 361 days from stamp
  2025-10-28, fees_rh 119 days from 2026-06-27) equals the fresh pull to within $0.005; no fees row is superseded.
- Lighter day 2026-10-23 read the same at 01:12Z and 15:48Z: unchanged from 72 min after the day closed.
- Evidence is still thin: the stored rows all come from the 01:28Z backfill, so baseline vs stored spans ~16 min and
  baseline vs fresh ~14.6 h. A restatement days later would not show yet.
- `days` stays 7; no change is warranted.

Two findings from the check (no action taken; for Mike):
1. **The routine re-read is 3 written days, not 7.** `writeApiFlow` re-reads `REVISION_DAYS` = 3 for every non-DefiLlama
   API flow (`src/ingest/apiFlow.ts`; `revision_days` exists only on `defillama` sources). The adapter's `days: 7` only
   sets how many days it returns. Run 272 re-read 2026-10-20..10-23 (notes: "no new or revised day in 2026-10-20 to
   2026-10-23"). So raising `days` would not widen revision coverage. If Lighter is ever seen restating older days, the
   fix is a code change (a `revision_days` for adapter flows), not config.
2. **The newest complete day was held back again at the 12:50Z tick.** Run 272 skipped 2026-10-23 ("not in the series,
   skipped: 2026-10-23") for all three exchangeMetrics series. At 15:48Z Lighter still listed no row for 2026-10-24
   (today) on any kind on either instance. The adapter treats a kind with no today row as "newest day may be partial"
   and holds that day back. The spec's scoping (2026-10-23) says the last point is today's partial day; on 2026-10-24
   that was not so at 01:28Z, 12:50Z or 15:48Z. If Lighter now lists completed days only (or lists today late in the
   day), every tick
   holds back D-1 and the series runs one day behind: nothing is lost (the day is written on the next tick, inside the
   3-day re-read), and `staleness_days: 5` covers it. Check run 2026-10-25 12:50Z: stamp 2026-10-24 should be written
   then. If it isn't, the series is stuck rather than lagging, and that goes to Mike.

## Rollout commands (spec section 9, after Mike's merge go)

1. Idle check, verified backup, 13 whatif baselines with the old dist.
2. `git merge --ff-only feat/lit-lighter-api`, `npm run build`, `node dist/cli/index.js asset validate <a>` for all 13
   assets, then the whatif comparison with the new dist.
3. Scoped backfill, rehearsed first on a scratch copy:
   `node dist/cli/index.js data fetch lit --metric flow_usd.fees_core --metric flow_usd.fees_rh --metric flow_usd.rh_buyback --backfill-days 362`
4. First level reads:
   `node dist/cli/index.js data fetch lit --metric rh_fee_account_usd --metric rh_revenue_share_app --metric staked_tokens_reported --metric staking_apr`
5. `node dist/cli/index.js report yield lit --json`: the spec section 2 "after" figures within 1%, re-measured on the day.
6. Add the WATCH rule (`docs/ops/hermes-daily-job.md`, STEP 3) to all 13 `orion-<asset>` cron prompts with
   `cronjob_manage update`; check each in `cron/jobs.json`. Push over HTTPS; mark the dev-queue items built.

## Open items

- If RH buybacks start (`flow_usd.rh_buyback` fires), a second holder-flow member goes to Mike with priced options.
- If `rh_revenue_share_app` fires, Mike decides whether the RH stream's `share` changes.
- Level series (`rh_fee_account_usd`, `rh_revenue_share_app`, `staked_tokens_reported`, `staking_apr`) start on the
  go-live day; there is no level backfill.
- The first `rh_fee_account_usd` reading has no previous, so it never fires.
- Unlock cadence (Orion proposal #3) is not part of this work.
- A drained RH fee account reads 0, which validateReading treats as a failed source (sources_failed), not a WATCH line.
- A watched source that keeps failing shows only in sources_failed; monitor-only metrics have no staleness trigger.
- LIT revenue = flow_usd.fees_core + 0.5 x flow_usd.fees_rh; get_flow_total returns gross series, the pack's revenue_streams carries the share.

## Live rollout (2026-10-24 01:27-01:35Z, Mike: "Merge")

- Idle check clean; backup `backups/orion.db.pre-lit-lighter-api-20261024T0127*Z` (integrity ok, row counts equal).
- `git merge --ff-only feat/lit-lighter-api` (642fd3b -> 961affe), `npm run build`, `asset validate` ok for all 13.
- `model whatif <a> --as-of 2026-10-24T00:00:00.000Z --json`, old dist vs new dist on live: 13/13 identical.
- Live writes (display series only):
  - `data fetch lit --metric flow_usd.fees_core --metric flow_usd.fees_rh --metric flow_usd.rh_buyback --backfill-days 362`:
    5.5 s, exit 0. fees_core 361 days, fees_rh 119, rh_buyback 297 (sum $137). The newest day (2026-10-23) was held back:
    at 01:28Z Lighter had not listed today's row yet (Ruling 20); the next run stores it.
  - `data fetch lit --metric rh_fee_account_usd --metric rh_revenue_share_app --metric staked_tokens_reported --metric staking_apr`:
    5.3 s, exit 0. $3,490,118.56; 0.5; 111,084,324.97 LIT; 0.0602.
  - observations 25,334 -> 26,115; fetch_runs 259 -> 261; anomalies 7 -> 7; trigger_firings 4 -> 4; no watch fired.
- `report yield lit --json`: revenue $40,490,272/yr (core $32,882,153 + robinhood $7,608,118 kept), holders $32,486,661,
  protocol $8,003,610, payout 80.23%, volume $48,098,390 (identical to the rehearsal).
- Revision check: 14 overlapping fee days vs the 01:12Z baseline, none restated (16 minutes apart, so weak evidence);
  re-check after the next tick, which re-reads 7 days.
- Hermes: the WATCH rule and the `ingest.watch` field added to all 13 `orion-<asset>` cron prompts (`hermes cron edit`),
  verified in `cron/jobs.json`; schedules and enabled state unchanged.
