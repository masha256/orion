# LIT: Lighter-API revenue, Robinhood watch and staked LIT — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LIT's revenue comes from Lighter's own fee data (Core + 0.5 × Robinhood). Display-only series watch the
Robinhood fee account and staked LIT. A generic `watch` reports display-series moves in the daily tick, and no
valuation output moves.

**Architecture:**
- Three new LIT adapters: fees, the app's fee split, and the staking pool.
- Two optional schema fields: `watch` on monitor-only metrics, and `share` on revenue streams.
- A watch pass at the end of `fetchAsset`, surfaced in the fetch detail and the tick report.
- Config and tests for LIT.

**Tech Stack:** TypeScript, zod, vitest, better-sqlite3. Run tests with `npx vitest run --maxWorkers=2`.

**Spec:** `docs/superpowers/specs/2026-10-23-orion-lit-lighter-api-design.md`. Every value in this plan comes from the
spec.

## Global Constraints

- Targets unchanged. No change to `holder_flows`, `assumptions`, `modules`, the supply or emission metrics, the engine
  or `ENGINE_VERSION`. 12 assets' `model whatif` output must be byte-identical. LIT's may differ only in its
  config-hash fields.
- Every new field is optional with no default; a config without it keeps its hash. New JSON keys appear only when the
  option is active.
- Only LIT's hash pin (`tests/assets/lit.ingest.test.ts`) may change. Any other pin moving means stop and report.
- `watch` never raises an anomaly, writes a trigger firing, touches the grade, or counts toward a failure streak.
- No live writes: never touch `/home/hermes/git/orion` or its `orion.db`. Work only in the worktree. No network in
  tests (canned replies via `tests/helpers/fakeHttp.ts`). Never call a model.
- Stage explicitly with `git add <paths>`. `node_modules` is a symlink: never stage it.
- Exact values:
  - Core API `https://mainnet.zklighter.elliot.ai/api/v1`; RH API `https://api.rh.lighter.xyz/api/v1`.
  - App `https://app.lighter.xyz/stats`; explorer `https://explorer.elliot.ai/api`.
  - Revenue kinds `maker_fee, taker_fee, transfer_fee, withdraw_fee`.
  - Allowed kinds `maker_fee, taker_fee, transfer_fee, withdraw_fee, liquidation_fee, buyback, buyback_usdc`.
  - Watches:
    - `rh_fee_account_usd` `change_pct: 5`;
    - `flow_usd.rh_buyback` `above: 1000`;
    - `staking_apr` `outside: [0.057, 0.063]`;
    - `rh_revenue_share_app` `outside: [0.5, 0.5]`.
  - RH stream `share: 0.5`, `started: "2026-06-26"`.

## Review Focus

1. **A Lighter API day list with a gap inside a kind's range** (an outage day missing). Expect a refused read, not a
   0 that understates revenue. Task 1 test `refuses a day missing inside a kind's range`.
2. **The app bundle rebuilt with new minified names, or with two `.has(...)?n:1` helpers.** Expect the new names to
   parse and two candidates to be refused. Task 2 tests.
3. **The staking pool account holding a second asset listed before LIT.** Expect the LIT balance by symbol. Task 3
   test.
4. **A revision-window re-read of a flow day already above its watch threshold.** Expect no second report of the
   same day. Task 5 test `reports a flow day once across two fetches`.
5. **A dry-run fetch with a watch.** Expect firings computed and printed, nothing written. Task 5 test.

---

### Task 1: HTTP text reads + `lit.exchange_fees_daily`

**Files:**
- Modify:
  - `src/ingest/transport/http.ts`: optional `getText` on `HttpTransport`, implemented in `createHttpTransport` with
    getJson's retries, timeout and spacing. Add host spacing 400 ms for `api.rh.lighter.xyz`, `explorer.elliot.ai` and
    `app.lighter.xyz`.
  - `tests/helpers/fakeHttp.ts`: `getText` returns the route value when it is a string, and throws when it is not.
  - `src/ingest/adapters/lit.ts`.
- Test: `tests/ingest/adapters.lit.test.ts`.

**Interfaces:**
- Produces:
  - `HttpTransport.getText?(url: string, headers?: Record<string, string>): Promise<string>`.
  - Adapter `lit.exchange_fees_daily`, params `{ api?: string; kinds: string[]; days?: number }`, returning
    `{ kind: 'daily_series', points: {day, value}[], detail }`.
  - Exported `validateExchangeFeesParams(params): string[]`.

- [ ] **Step 1: Write the failing tests.** Fixture shape:
  `GET <api>/exchangeMetrics?period=all&kind=<k>` returns `{ code: 200, metrics: [{ timestamp: <day start, s>, data: <number> }] }`.
  `NOW = '2026-10-23T12:00:00.000Z'`. Tests:
  - `sums the kinds per UTC day and drops today`: two kinds over 5 days plus today. Assert 5 points (today absent),
    with each value the sum of the two.
  - `a day before a kind's first day counts 0 for that kind`: kind B starts 2 days later than kind A. The early days
    equal A alone.
  - `refuses a day missing inside a kind's range`: the rejects message names the kind and the day.
  - `refuses a non-numeric data`: `data: 'x'`.
  - `returns the last --backfill-days completed days`: `ctx.backfillDays = 362` on a 400-day series gives 362 points.
    Default `days` 7 gives 7.
  - `uses params.api`: the calls start with the RH host.
  - Validation, through `getAdapter('lit.exchange_fees_daily').validateParams`:
    - `[]` → one issue;
    - `['maker_fee','maker_fee']` → duplicate;
    - `['volume']` → unknown kind, naming the allow-list;
    - `days: 0` and `days: 31` → issues;
    - a valid set → `[]`.
  - `paramsDoc mentions api, kinds and days`.
- [ ] **Step 2:** `npx vitest run tests/ingest/adapters.lit.test.ts`. Expect FAIL: unknown adapter.
- [ ] **Step 3: Implement.**
  - The adapter does one `getJson` per kind and builds per-kind day maps keyed `YYYY-MM-DD` from `timestamp * 1000`.
  - It skips any point at or after `todayStart`.
  - Over the window `[todayStart - days, todayStart)`, each day is summed across kinds:
    - a kind's missing day counts 0 when the day is before that kind's first day;
    - a kind's missing day inside its own range throws `exchangeMetrics <kind>: <day> missing`.
  - If the window has no completed day, it throws.
  - `detail` reads `lighter exchangeMetrics <host> <kinds joined +> (<n> days)`.
- [ ] **Step 4:** the same command passes, and `npm run typecheck` is clean.
- [ ] **Step 5: Commit.**
  `git add src/ingest/transport/http.ts tests/helpers/fakeHttp.ts src/ingest/adapters/lit.ts tests/ingest/adapters.lit.test.ts`,
  then `git commit -m "feat(lit): lit.exchange_fees_daily reads Lighter's exchangeMetrics fees per UTC day; HTTP getText"`.

### Task 2: `lit.app_fee_share`

**Files:** Modify `src/ingest/adapters/lit.ts`. Test: `tests/ingest/adapters.lit.test.ts`.

**Interfaces:**
- Consumes: `getText` (Task 1).
- Produces: adapter `lit.app_fee_share`, params `{ url?: string }` (default `https://app.lighter.xyz/stats`), returning
  `{ kind: 'level', value: <n>, observedAt: <ctx.nowIso>, source: 'api', detail }`.

- [ ] **Step 1: Failing tests.** The fixtures are three strings:
  - HTML referencing `/assets/index-AAA.js`;
  - the index bundle containing `"exchange-stats-BBB.js"`;
  - a chunk containing `` q=new Set([`maker_fee`,`taker_fee`,`transfer_fee`,`withdraw_fee`]);function zz(e){return q.has(e)?.5:1} ``.

  Tests:
  - `reads the split from the app chunk` returns 0.5.
  - `parses a rebuild with new names` (`Xy`, `k9`) returns 0.5.
  - `refuses two candidate helpers`.
  - `refuses no candidate`.
  - `refuses a value outside (0,1]` (`?1.2:1`).
  - `refuses when the chunk name is missing`.
  - `the Set must hold all four revenue kinds`: a Set of three kinds is refused.
- [ ] **Step 2:** run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Find the `/assets/index-[A-Za-z0-9_-]+\.js` in the HTML, then `exchange-stats-[A-Za-z0-9_-]+\.js` in it.
  - Fetch `<origin>/assets/<chunk>`.
  - Find every `(\w+)=new Set\(\[([^\]]*)\]\)` whose items (quotes or backticks stripped) are exactly the four revenue
    kinds.
  - For each such Set name `S`, find `return S\.has\((\w+)\)\?([0-9.]+):1`.
  - Exactly one match is required; return its number.
- [ ] **Step 4:** pass, then typecheck.
- [ ] **Step 5: Commit.** `git commit -m "feat(lit): lit.app_fee_share reads the Robinhood revenue split from Lighter's app bundle"`.

### Task 3: `lit.staking_pool`

**Files:** Modify `src/ingest/adapters/lit.ts`. Test: `tests/ingest/adapters.lit.test.ts`.

**Interfaces:** adapter `lit.staking_pool`, params `{ field: 'staked' | 'apr'; api?: string; explorer?: string }`,
returning `{ kind: 'level', value, observedAt: <ctx.nowIso>, source: 'api', detail }`.

- [ ] **Step 1: Failing tests.** Fixtures:
  - `/systemConfig` → `{ staking_pool_index: 281474976624800 }`.
  - `/account?by=index&value=281474976624800` → `{ accounts: [{ assets: [{symbol:'USDC',balance:'5'}, {symbol:'LIT',balance:'110921638.78926387'}] }] }`.
  - `<explorer>/accounts/281474976624800/logs` → a list of
    `{ pubdata_type: 'L2TransferV2', time, pubdata: { l2_transfer_pubdata_v2: { to_account_index: '281474976624800', asset_index: 'LIT', amount } } }`.

  Tests:
  - `staked reads LIT by symbol` returns 110921638.78926387 with USDC listed first.
  - `refuses no LIT asset`.
  - `refuses two LIT assets`.
  - `refuses a missing staking_pool_index`.
  - `apr is the newest completed day's rewards x 365 / staked`: rewards of 18,328.37 on 2026-10-22 and staked 110.92M
    give ≈0.06031 (`toBeCloseTo(0.0603, 4)`).
  - `apr refuses a newest reward older than 2 days`.
  - `apr ignores transfers to other accounts and other assets`.
  - `validateParams refuses a field other than staked|apr`.
- [ ] **Step 2:** run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - "Newest completed UTC day" means the latest day before today that has at least one reward transfer.
  - That day's rewards are summed and divided by the staked balance from the same run.
- [ ] **Step 4:** pass, then typecheck.
- [ ] **Step 5: Commit.** `git commit -m "feat(lit): lit.staking_pool reads the staked LIT balance and the implied reward rate"`.

### Task 4: Schema — `watch` and revenue `share`

**Files:** Modify `src/config/schema.ts`. Test: `tests/config/load.test.ts` (watch) and `tests/report/revenueStreams.test.ts` (share).

**Interfaces:**
- Produces:
  - `MetricDef.watch?: { above?: number; change_pct?: number; outside?: [number, number] }`, with exactly one key
    set.
  - `ReportingRevenueStream.share?: number`.

- [ ] **Step 1: Failing tests** (via `parseAssetYaml` on a minimal asset):
  - `watch` without `monitor_only` → an issue naming the metric;
  - two rules → issue;
  - `change_pct: 0` → issue;
  - `outside: [0.6, 0.5]` → issue;
  - `above` on a level → issue (`above` is for flows);
  - `change_pct` or `outside` on a flow → issue;
  - a valid watch parses;
  - `share: 0` → issue; `share: 1.5` → issue;
  - `share` on a `disclosed` stream → issue;
  - `share: 0.5` on a metric stream parses;
  - `an asset without watch/share keeps its hash`: the VVV, HYPE and AERO hashes equal their pinned values.
- [ ] **Step 2:** run. Expect FAIL.
- [ ] **Step 3: Implement.** Add the zod fields (optional, no default) and the cross-field checks in the loader's
  issue pass, next to the `monitor_only` checks.
- [ ] **Step 4:** pass, then the full suite. Every existing hash pin must be unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat(config): optional watch on monitor-only metrics and share on revenue streams"`.

### Task 5: Watch evaluation, fetch detail, tick report, CLI

**Files:**
- Create: `src/ingest/watch.ts`.
- Modify:
  - `src/ingest/run.ts` (snapshot before writes, evaluate after);
  - `src/db/fetchRuns.ts` (`FetchRunDetail.watch?`);
  - `src/app/tick.ts` and `src/app/tickReport.ts` (`ingest.watch` optional);
  - `src/cli/commands/data.ts` and/or `src/cli/util.ts` `fetchSummary` (print firings).
- Test: `tests/ingest/watch.test.ts`, `tests/report/tickReport.test.ts`.

**Interfaces:**
- Produces:
  - `interface WatchFiring { metric: string; rule: 'above' | 'change_pct' | 'outside'; value: number; previous: number | null; day: string }`;
  - `evaluateWatches(asset, before: Map<string, Map<string, number>>, written: WrittenObservation[], previousLevel: (metric, observedAt) => number | null): WatchFiring[]`;
  - `FetchResult.watch: WatchFiring[]` (always present, possibly empty);
  - `FetchRunDetail.watch` set only when non-empty;
  - Tick report `ingest.watch` (an array of `{metric, rule, value, previous, day}`) present only when non-empty.

- [ ] **Step 1: Failing tests** (unit tests on `evaluateWatches`, plus one `fetchAsset` integration through
  `tests/helpers/fetchHarness.ts`):
  - `above fires for a new flow day over the threshold`: value 1500, threshold 1000 → one firing with `previous: null`.
  - `reports a flow day once across two fetches`: the second fetch rewrites the same day at 1600 while `before` has
    1500 → no firing.
  - `fires when a re-read day newly crosses`: `before` 800, new 1200 → a firing with `previous: 800`.
  - `change_pct fires on a 6% move and not on 4%`.
  - `outside fires on every fetch while outside`: two fetches → two firings.
  - `no anomaly and no trigger firing`: after the integration fetch, `anomalies` and `trigger_firings` row counts are
    unchanged.
  - `dry run computes firings and writes nothing`.
  - `fetch_runs.detail_json.watch is stored when non-empty and absent when empty`.
  - Tick report: `TickReportSchema` accepts a report without `ingest.watch` and one with it.
  - `data fetch` prints a line `watch: <metric> <rule> <value> (was <previous>) <day>`.
- [ ] **Step 2:** run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - At the start of `fetchAsset`, snapshot the active observations of watched metrics: metric → observedAt → value.
  - After all writes (in dry runs too), call `evaluateWatches` with `written`.
  - `day` is the observation's period day for flows, and the UTC date of `observedAt` for levels.
- [ ] **Step 4:** the tests pass, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "feat(ingest): watch rules on monitor-only metrics, reported in the fetch detail and the tick report"`.

### Task 6: Report — revenue stream `share`

**Files:** Modify `src/report/holderYield.ts`. Test: `tests/report/revenueStreams.test.ts` (and `tests/report/holderYield.test.ts` for the no-share fixtures).

**Interfaces:** `RevenueStreamLine.share?: number` and `RevenueStreamLine.grossAnnualized?: number | null`, present
only when the stream has a share.

- [ ] **Step 1: Failing tests:**
  - `share halves the stream`: two daily streams of $1,000/day each, one with `share: 0.5`. Stream annualized values
    are 365,000 and 182,500; the revenue total is 547,500; the second line has `grossAnnualized` 365,000 and
    `share: 0.5`.
  - `growth uses the kept value`: growth `current` equals the share-weighted window sum.
  - `no share, same JSON`: the existing HYPE and VVV report fixtures are deep-equal to before (no new keys).
  - `started plus share`: a young stream with a share is annualized over its own days and then the share is applied.
- [ ] **Step 2:** run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Apply the share to the stream's daily map before `windowSum` and `growthOf`.
  - Build a per-stream scaled copy keyed by stream id, so the shared `daily` map is untouched for other readers, such
    as income lines on the same metric.
  - `grossAnnualized` comes from the unscaled sum.
- [ ] **Step 4:** pass, then the full suite.
- [ ] **Step 5: Commit.** `git commit -m "feat(report): a revenue stream's share of a gross series (kept vs gross shown)"`.

### Task 7: Analyst pack — structural constants

**Files:** Modify `src/agent/describe.ts` and `src/agent/context.ts`. Test: `tests/agent/context.test.ts`.

**Interfaces:**
- `describeDrivers(report, nowIso, structural?: Record<string, string>)`.
- `structuralNotes(asset: AssetConfig): Record<string, string>` maps driver names to the metric's constant `note`, for
  the pairs `staked_ratio ← staked_supply`, `staker_emission_share ← staker_emission_share` and
  `emission_rate_now ← emission_rate_annual`, when that metric's source is `constant` with a note.

- [ ] **Step 1: Failing tests:**
  - `a constant staked_supply marks staked_ratio structural`: LIT's config gives
    `drivers.staked_ratio.structural` equal to its note.
  - `a fetched staked_supply has no structural key`.
  - `real_staking_yield is unchanged`.
- [ ] **Step 2:** run. Expect FAIL.
- [ ] **Step 3: Implement.** Add the key only when present. `context.ts` passes `structuralNotes(asset)` to both
  `describeDrivers` calls.
- [ ] **Step 4:** pass, then the full suite. Update any pack fixture that deep-equals drivers for an asset with
  constants, and list each file in the report.
- [ ] **Step 5: Commit.** `git commit -m "feat(agent): mark drivers read from config constants as structural in the analyst pack"`.

### Task 8: LIT config, hash re-pin, docs

**Files:**
- Modify: `assets/lit.yaml` (spec §3.4, §4, §6, comments updated), `tests/assets/lit.ingest.test.ts` (canned routes
  for the new sources, re-pin), `docs/ops/hermes-daily-job.md` (the WATCH rule text, spec §5), `README.md` (the LIT
  sources line, if it lists them).
- Create: `docs/superpowers/notes/2026-10-23-lit-lighter-api-followups.md` (skeleton: picks, rollout commands, open
  items).

**Interfaces:** the metrics and streams exactly as in spec §3.4, §4 and §6, with the Global Constraints watch values.

- [ ] **Step 1:** add the metrics and streams. Each new metric is `monitor_only`, with staleness 5 for the flows and 3
  for the levels.
- [ ] **Step 2:** extend `tests/assets/lit.ingest.test.ts`:
  - a canned full fetch writes `flow_usd.fees_core`, `flow_usd.fees_rh`, `flow_usd.rh_buyback`, `rh_fee_account_usd`,
    `rh_revenue_share_app`, `staked_tokens_reported` and `staking_apr`;
  - `report yield lit --json` shows streams `core` and `robinhood` (`share: 0.5`) and volume from the two fee series;
  - `holder_flows` and `flow_usd.buyback` are unchanged.
- [ ] **Step 3:** re-pin LIT's hash (computed via `parseAssetYaml(...).hash`). `asset validate` passes for all 13
  assets with `node dist/cli/index.js` after `npm run build`.
- [ ] **Step 4:** full suite, CLI files alone with `--maxWorkers=1`, and typecheck.
- [ ] **Step 5: Commit.**
  `git commit -m "config(lit): revenue from Lighter's API (Core + 0.5 x Robinhood), Robinhood watch, staked LIT (Mike, 2026-10-23)"`.

### Task 9: Proof and scratch rehearsal (controller-run, read-only on live)

- [ ] **Step 1: whatif comparison.** Build `main` (detached worktree) and the branch. On two `.backup` copies of the
  live DB, run `model whatif <a> --as-of 2026-10-23T12:00:00.000Z --json` for all 13 assets.
  - Expect 12 to `cmp` identical.
  - For LIT, `jq 'del(.. | .config_hash?, .configHash?)'` on both must be identical, and `horizons` equal.
- [ ] **Step 2: scratch rehearsal.** On a scratch `.backup` home with the branch dist, run the spec §9 step 3 commands,
  timed:
  - `data fetch lit --metric flow_usd.fees_core --metric flow_usd.fees_rh --metric flow_usd.rh_buyback --backfill-days 362 --json`;
  - then the 4 level metrics.

  Expect no failed source and no anomaly, plus the watch firings (expected: none, except possibly the first
  `rh_fee_account_usd` reading, which has no previous).
- [ ] **Step 3: report check.** `report yield lit --json` in the scratch home. Revenue annualized ≈ $40.5M, payout
  ≈ 80%, volume ≈ $48.1M, each within 1% of a same-window recomputation done the same day.
- [ ] **Step 4: revision check.** Record the scratch pull's last 7 days of `flow_usd.fees_core`. At rollout, a fresh
  pull is diffed against it and the result goes in the followups note.
- [ ] **Step 5:** fill the followups note with the measured figures, then commit it with an explicit `git add`.

Stop here for Mike's merge go. The merge, live backfill and cron prompt updates follow spec §9.
