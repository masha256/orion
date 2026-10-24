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

TODO (Task 9): `model whatif <a> --as-of 2026-10-23T12:00:00.000Z --json`, main vs branch, on two `.backup` copies.

## Scratch rehearsal

TODO (Task 9): timings, failed sources, anomalies, watch firings for the backfill and the four level reads.

## Report check

TODO (Task 9): `report yield lit --json` against spec section 2 (revenue ~$40.5M, payout ~80%, volume ~$48.1M; 1%).

## Revision check

TODO (Task 9 records the scratch pull's last 7 days of `flow_usd.fees_core`; the rollout diffs a fresh pull).

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
