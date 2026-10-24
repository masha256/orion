# Orion: LIT revenue, Robinhood share and staked LIT from Lighter's own API (design, 2026-10-23)

Status: design for review. Mike's picks on 2026-10-23 ("1: a. 2: a. 3: a"):
1. Holder flow stays the measured Core buys. A display-only watch on the Robinhood fee account and its buyback series
   shows a payout or catch-up buyback the day it happens.
2. Revenue is two first-party streams: Lighter Core fees, plus 50% of Robinhood-instance fees. DefiLlama stays as a
   display series.
3. Staked LIT becomes a display-only series read by a small adapter. The adapter also checks the 6% reward rate daily.
   `staked_supply` stays a constant 0 in the valuation.

Every new metric is `monitor_only`, so no valuation target moves (section 8). Sources are Lighter's API, its explorer
API and its web app. There is no new DefiLlama dependency.

Queue entries this closes: `workspace/orion/dev-queue-revenue.md`, "LIT — Robinhood revenue share…" items 1 and 2, and
"LIT — Issuer states 109.8M LIT staked…". Item 3 (unlock cadence) is Orion proposal #3, which waits for Mike's
decision and is not part of this work.

## 1. What was measured (2026-10-23, read-only)

Full notes, with the endpoints and tx hashes: `workspace/orion/lit-scoping/robinhood-revenue.md` and `staked-supply.md`.
I re-checked the key figures in this section myself. M = measured, C = claimed by Lighter.

- **The Robinhood instance (RH) is a separate exchange.**
  - API `https://api.rh.lighter.xyz/api/v1`; it settles on Robinhood Chain (4663) and has no LIT market.
  - Its fee account, RH L2 account 0, has never placed an order (`total_order_count` 0). It holds $3.49M of
    collateral, which is about all RH fees to date, both halves (M).
  - One 320,000 USDG withdrawal on 2026-08-25 went to an unlabelled EOA, `0xac71ec13…c357`. Its owner is unknown.
  - RH `exchangeMetrics kind=buyback_usdc` came to $125 for Q3 (M). So Lighter's 50% of RH fees is **not** bought back
    as of 2026-10-23.
  - "100% of trading revenue is used for buybacks" (C, call at 11:27) holds for Core only: Q3 Core buys of $7.46M are
    99.0% of Core fees (M).
- **First-party fees.** `GET <host>/exchangeMetrics?period=all&kind=<k>` on both hosts:
  - one request per kind returns the whole daily history (Core from 2025-01-17, RH from 2026-06-26);
  - `{timestamp: <UTC day start, s>, data: <USD>}`, keyless, and the last point is today's partial day;
  - revenue kinds are `maker_fee`, `taker_fee`, `transfer_fee`, `withdraw_fee`. `liquidation_fee` goes to the LLP and is
    not revenue.
  - Q3 2026: Core $7.540M + 0.5 × RH $2.227M = $8.654M, 87.1% Core (M). The call says $8.5M and 87% (C).
  - DefiLlama reads the same endpoints but counts RH at 100%, which is why it shows $9.85M for Q3.
- **The 50% split exists only in Lighter's web app**, as a client constant. The stats chunk
  (`app.lighter.xyz/assets/exchange-stats-<hash>.js`) contains
  `mt=new Set([`maker_fee`,`taker_fee`,`transfer_fee`,`withdraw_fee`]);…function vt(e){return mt.has(e)?.5:1}` (M).
  - The page's "total revenue" is computed in the browser from the same two series. It therefore always agrees with
    Core + 0.5 × RH and cannot detect a change in the split.
  - **Correction to what I told Mike earlier today:** I offered "check the 0.5 daily against the stats page's lifetime
    total". That check is circular and is dropped. Section 3.3 reads the constant itself.
- **Staked LIT.**
  - The staked total is the LIT balance of the staking pool, L2 account `281474976624800`.
    `/systemConfig.staking_pool_index` returns the same index (M).
  - 110,921,638.79 LIT at 2026-10-23 ~23:40Z (M), 11.3% of total supply.
  - Rewards reach the pool once a day at about 18:00Z as an L2 transfer from account 733613. Since 2026-07-07 each one
    is 6%/365 of the staked amount (M; docs: "fixed 6% APR", C).
  - The 2026-09-30 reward implies 109.76M staked; the call says 109.8M (C).
  - There is no history endpoint for the balance, so a level series starts the day it goes live.

## 2. Report before and after (LIT, 91-day window 2026-07-24 → 2026-10-22, annualized)

Each line gives today's value (`report yield lit --json` on live), then the value after this change (first-party
recomputation, measured 2026-10-23):
- **Revenue:** $48.4M (DefiLlama dailyRevenue) → $40.5M (Core $32.9M + 0.5 × RH $15.2M).
- **Paid to holders (buys):** $32.5M → $32.5M, unchanged. Lighter's own `buyback_usdc` gives $32.66M.
- **"Protocol income" (revenue less buys):** $15.9M, a DefiLlama artifact → about $8.0M. Of that, about $7.6M is the
  retained RH share and the rest is the Core gap.
- **Payout ratio:** 67% → about 80%.
- **Volume line (gross fees):** $60.2M (DefiLlama dailyFees) → $48.1M (Core + RH gross, no liquidation fees).

The income statement then shows the real gap: Lighter keeps the RH share instead of buying LIT with it. No target moves,
because revenue and volume are report lines.

## 3. Revenue: two first-party streams

### 3.1 Adapter `lit.exchange_fees_daily`

- Params:
  - `api` (default the Core host);
  - `kinds` (string[], required, each one of Lighter's exchangeMetrics kinds);
  - `days` (default 7).
- Behaviour:
  - one `exchangeMetrics?period=all&kind=<k>` per kind;
  - sum the kinds per UTC day;
  - drop today's partial day and anything at or after `todayStart`;
  - return a `daily_series` of the last `--backfill-days` (or `days`) completed days.
- Refusals:
  - a missing or non-numeric `data` throws, so the series is never partial;
  - a day before a kind's first day counts as 0 for that kind (Lighter lists every day from a kind's first day,
    zeros included). A day missing inside a kind's own range is refused;
  - no completed day in the window: throw (a failed source, not zeros).
- `validateParams` refuses an empty `kinds`, a duplicate kind, an unknown kind (the allow-list below), and a `days`
  outside 1–30. `paramsDoc` documents all of the params, `api` included.
- Allowed kinds: `maker_fee, taker_fee, transfer_fee, withdraw_fee, liquidation_fee, buyback, buyback_usdc`.
- Revisions: Lighter may restate a recent day (unverified). The writer re-reads `days` (7) on every run and supersedes a
  changed day, as the existing API flows do. The plan's first task diffs two pulls a day apart and records the result.

### 3.2 Schema: a `share` on a revenue stream

- `reporting.revenue[].share`: optional number, `0 < share ≤ 1`, no default. The report multiplies the stream's daily
  values by it before the window sums.
- Absent means the stream counts in full, so every other asset's config hash and report stay the same. It is allowed
  only on `metric` streams.
- The stream line in `report yield --json` gains `share` only when one is set (new key only when active).
- A stream with a share also gets `grossAnnualized` (before the share), so the report shows gross and kept side by side.

### 3.3 Where the 0.5 comes from, and how a change is caught

- The stream carries `share: 0.5` as config, with a YAML comment citing the call (05:20, "a 50-50 ref share") and the app
  constant.
- New monitor-only level `rh_revenue_share_app`, unit ratio, read daily by adapter `lit.app_fee_share`. Its single param
  is `url`, default `https://app.lighter.xyz/stats`. The read takes three requests:
  1. the page HTML;
  2. the `index-<hash>.js` entry bundle it references;
  3. the `exchange-stats-<hash>.js` chunk that the entry bundle names.

  In the chunk it finds the Set literal holding `maker_fee`, `taker_fee`, `transfer_fee` and `withdraw_fee`, then the
  one function of the form `return <set>.has(<arg>)?<n>:1`, and returns `<n>`.
- Refusals: zero or two-plus matches, a number outside (0, 1], or any of the three files missing. Each is a failed
  source, never a guessed value. Minified names (`mt`, `vt`) are not matched, because they change with each build.
- `watch: { outside: [0.5, 0.5] }` (section 5): if Lighter's app ever applies another split, the next tick says so. Mike
  then decides whether to change the stream's `share`.
- The quarterly check comes for free. A disclosure run's `get_flow_total` now sums first-party revenue, so the analyst's
  "disclosed vs Orion" comparison tests the split each quarter.
- Why not read the share into the stream daily: the app constant has no history, so backfilled days would need a guess
  anyway. A broken parse would also stop the revenue line, instead of only raising the watch.

### 3.4 LIT config (new and changed lines)

- `flow_usd.fees_core`: flow usd, daily, `monitor_only`. Adapter `lit.exchange_fees_daily`,
  `{ kinds: [maker_fee, taker_fee, transfer_fee, withdraw_fee] }`.
- `flow_usd.fees_rh`: the same with `api: https://api.rh.lighter.xyz/api/v1` (gross RH fees).
- `reporting.revenue` becomes:
  - `{ id: core, label: "Lighter Core fees (Lighter API)", metric: flow_usd.fees_core, settlement: daily }`
  - `{ id: robinhood, label: "Lighter's 50% of Robinhood-instance fees (Lighter API)", metric: flow_usd.fees_rh, settlement: daily, share: 0.5, started: "2026-06-26" }`
- The `started` date keeps the RH stream out of the "ex new streams" growth figure until it has 180 days.
- `reporting.volume` becomes `[flow_usd.fees_core, flow_usd.fees_rh]` (gross fees, first-party). Per Mike's sourcing
  rule, the DefiLlama `flow_usd.fees` leaves the report.
- `flow_usd.fees` and `flow_usd.llama_revenue` stay as stored display series, as Mike picked. Their comments are
  updated to say so; they no longer feed a report line.
- The header comment ("DefiLlama only for the gross fees and revenue") is rewritten to match.

## 4. Robinhood fee account: the watch (pick 1a)

- `rh_fee_account_usd`: level usd, `monitor_only`. `http_json` on
  `https://api.rh.lighter.xyz/api/v1/account?by=index&value=0`, path `accounts.0.total_asset_value`. It holds USDG plus
  a few cents of stock tokens.
  - `watch: { change_pct: 5 }`: any day-over-day move of more than 5% is reported. Fees add about 1.5% a day, so a
    payout of Lighter's half, or a buyback, shows up as a fall.
  - Staleness 3 days.
- `flow_usd.rh_buyback`: flow usd, daily, `monitor_only`. Adapter `lit.exchange_fees_daily` with the RH `api` and
  `kinds: [buyback_usdc]`.
  - `watch: { above: 1000 }`: a day with more than $1k of RH buybacks is reported. Q3's $125 in total is noise.
  - It backfills to 2026-06-26.
- Holder flow, `holder_flows` and every assumption: unchanged.
- If RH buybacks start, the queue item for a second holder-flow member reopens. That is a valuation change, so it goes
  to Mike with priced options and is not done automatically.

## 5. Generic `watch` on monitor-only metrics (new engine option)

What it is for: a display series that should tell someone when it moves, without opening an anomaly. Every open anomaly
fires the `open_anomaly` trigger, which starts a paid triage run, and display data must never wake the analyst.

- **Schema.** `metrics.<key>.watch`: optional strict object, allowed only with `monitor_only: true` (refused otherwise).
  It holds exactly one rule:
  - `above: <number>` (flows): a day written this fetch, whose value is above it.
  - `change_pct: <number > 0>` (levels): a new reading more than that many percent away from the previous active
    observation.
  - `outside: [lo, hi]` with `lo ≤ hi` (levels): a new reading below lo or above hi.

  No default, so configs without it keep their hash.
- **Ingest.** After the writer runs, each watched metric is checked against what this fetch wrote. A firing is
  `{metric, rule, value, previous?, day}`.
  - Firings are stored in the fetch run's `detail_json.watch` (no new table, no migration) and printed by `data fetch`.
  - A flow day re-read in the revision window fires only when the value newly crosses the threshold, so the same day is
    reported once.
  - A level under `outside` fires on every fetch while it stays outside. That is deliberate: a persistent state is
    restated daily until someone acts.
- **Tick report.** `ingest.watch` becomes an optional array of `{metric, rule, value, previous, day}`. It is present
  only when non-empty, `schema_version` stays 1, and it contains ids and numbers only, no fetched text.
- **Never:** an anomaly, a trigger firing, a grade input, or a failure streak. Monitor-only sources are already exempt
  from streaks.
- **Hermes side:** the 13 `orion-<asset>` cron prompts gain one rule: "If `report.ingest.watch` is non-empty, start the
  report with one `ORION WATCH <asset>: <metric> <rule> <value> (was <previous>)` line per entry."
  - All 13 change now, so a watch added to another asset later is not silent.
  - This is applied at merge with `cronjob_manage update`, and each prompt is checked afterwards in `cron/jobs.json`.

## 6. Staked LIT (pick 3a)

- **Adapter `lit.staking_pool`**, params `field` (`staked` | `apr`) and `api` (default the Core host).
  - Pool index from `/systemConfig.staking_pool_index`. Refuse it when missing.
  - `staked`: `/account?by=index&value=<pool>`, the asset whose `symbol` is `LIT`, as a decimal-string balance in LIT.
    It is matched by symbol, never by position. Refuse zero or two-plus LIT assets.
  - `apr`: the newest completed UTC day's reward transfers into the pool, from
    `https://explorer.elliot.ai/api/accounts/<pool>/logs` (`L2TransferV2` to the pool, asset LIT), multiplied by 365 and
    divided by the staked balance read in the same run. Refuse when the newest reward is more than 2 days old.
- **Metrics** (both `monitor_only`, staleness 3 days):
  - `staked_tokens_reported`: level tokens, from `lit.staking_pool {field: staked}`.
  - `staking_apr`: level ratio, from `lit.staking_pool {field: apr}`, with `watch: { outside: [0.057, 0.063] }`.
    That band is 6% ± 5%: stakes and unstakes between the reward and the read move the ratio by up to ~1%.
- **`staked_supply` stays `constant 0`**, with its note. To keep the analyst from reading "staked 0" as a measurement,
  `src/agent/describe.ts` marks a driver whose metric is a `constant` source with `structural: "<the constant's note>"`.
  That is the analyst's pack only: no valuation or report reads it.
- History starts on the go-live day (levels don't backfill). An estimate reconstructed from rewards since 2026-07-07 was
  considered and is not stored, because it would be a model, not a reading.

## 7. Files

- **Orion:**
  - `src/ingest/adapters/lit.ts`: the three new adapters, with validation and paramsDoc.
  - `src/config/schema.ts`: `watch`, stream `share`.
  - `src/ingest/run.ts`: watch evaluation; `detail_json.watch`.
  - `src/app/tick.ts` and `tickReport.ts`: optional `ingest.watch`.
  - `src/report/holderYield.ts`: `share`, `grossAnnualized`.
  - `src/cli/commands/data.ts`: print firings.
  - `src/agent/describe.ts`: `structural`.
  - `assets/lit.yaml`.
  - Tests: adapters with canned replies, schema refusals, watch rules, report share, the LIT hash re-pin, and a VVV
    golden check.
  - Docs: `docs/ops/hermes-daily-job.md` (the WATCH line); a followups note.
- **Hermes:** the 13 cron prompts (section 5); the orion skill (the watch, the LIT sources); the dev queue (mark items
  1, 2 and the staked entry built).

## 8. Targets unchanged: the proof

- No `holder_flows`, `assumptions`, `modules`, supply or emission metric changes. Every new metric is `monitor_only`,
  which the schema already refuses on anything the valuation reads. `watch` and `share` are optional with no default.
  No `ENGINE_VERSION` bump.
- LIT's config hash moves: re-pin `tests/assets/lit.ingest.test.ts`. Its next signal lists "config" as its only change,
  with the same targets. No other asset's hash moves; any other pin moving means stop.
- Proof before merge, scratch only:
  - build `main` and the branch;
  - on two `.backup` copies of the live DB, `model whatif <a> --as-of <fixed ISO> --json` for all 13 assets;
  - 12 assets byte-identical;
  - LIT identical after deleting only the config-hash and provenance keys that carry it;
  - `horizons.*` equal to the last digit.

## 9. Live rollout (after Mike approves the merge)

1. Idle check, then a verified backup, then the 13 whatif baselines with the old dist.
2. ff-merge, build, `asset validate` for all assets, then the whatif comparison with the new dist (section 8).
3. Scoped backfills, rehearsed first on a scratch copy:
   - `data fetch lit --metric flow_usd.fees_core --metric flow_usd.fees_rh --metric flow_usd.rh_buyback --backfill-days 362`
     (about 4 + 4 + 1 requests: each kind's full history comes back in one reply).
   - Then the first level reads: `data fetch lit --metric rh_fee_account_usd --metric rh_revenue_share_app --metric staked_tokens_reported --metric staking_apr`.
4. `report yield lit --json`. The section 2 "after" figures must hold within 1%, re-measured on the day.
5. Update the cron prompts, push over HTTPS, and mark the queue items.

## 10. Testing

- Adapters, with canned replies:
  - kinds summed per day; today dropped; a missing `data` refused; a kind missing a day refused;
  - the Set+function found across a renamed minified build; two matches refused; a value of 1.2 refused;
  - the staking pool LIT asset found by symbol when it is not first; the reward-day freshness refusal.
- Schema: `watch` without `monitor_only` refused; two rules refused; `outside` with lo > hi refused; `share` on a
  disclosed stream refused; `share` 0 refused.
- Watch: a flow day above the threshold fires once across two fetches; a level `change_pct` fires on a 6% move and not
  on 4%; an `outside` level fires on every fetch while outside; firings never create an anomaly or a trigger firing.
- Report: a share of 0.5 halves the stream and shows `grossAnnualized`; an asset without `share` has the same JSON as
  before (VVV and HYPE golden checks).
- Tick report: `ingest.watch` absent when empty and present when not. Old reports still validate.
- Full suite with `--maxWorkers=2`, the CLI files alone, and typecheck.

## 11. Decisions Mike owes

1. **Watch thresholds.** RH fee account move > 5% a day; RH buybacks > $1k a day; staking APR outside 5.7–6.3%; app
   split ≠ 0.5. Recommendation: as written.
2. **Where watch lines go.** (a) All 13 cron prompts now, recommended. (b) The LIT prompt only, adding the others with
   their first watch.
3. **Volume line.** First-party gross fees, $48.1M/yr against DefiLlama's $60.2M. DefiLlama's dailyFees also counts
   fees that Lighter's fee kinds don't, liquidation fees most likely; unverified. Recommendation: first-party, per the
   sourcing rule. The alternative is to keep DefiLlama's figure as volume.
4. **Backfill depth for Core fees.** 362 days, recommended: 90d/90d growth needs 182 days and the history is there. The
   alternative is 182 days.

## 12. Out of scope

- A second holder-flow member for RH buybacks. It is built only if buybacks start (section 4).
- Treasury cash as a balance-sheet item (option 1c).
- Unlock tranches (proposal #3).
- Stake/unstake flows: there is no first-party daily source; the pool log has only rewards.
