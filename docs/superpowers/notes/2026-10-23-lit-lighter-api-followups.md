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
