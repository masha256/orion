# Orion Phase 3 R0b + R1: remote backfill verbs, and the DefiLlama reads with no value behind them

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release that (a) gives `orion-remote` the verbs Phase 3 releases need for backfills, USD comparisons and
history deletion, so no release needs `sudo -iu orion-<env>` from Mike, and (b) removes every DefiLlama/CoinGecko read
that feeds no revenue, holder-flow or price figure (spec §5 R1), deleting their stored rows.

**Architecture:** Backfills become a daemon job kind (`backfill`, params in a new `jobs.params_json` column, migration
0007, expand-only), so they run under the daemon's lease, lock and drain like every other write. Purge and compare-usd
are short synchronous CLI commands behind new `orion-remote` verbs. R1 is config: 12 asset YAMLs lose cross-checks and
display series, LIT/PUMP unlocks move to one generic cited-schedule adapter, and `volume` gets a `not_measured` form.

**Tech Stack:** TypeScript (Node 26, vitest, zod), Postgres 18, Python 3 (`orion-remote` and its tests).

**Spec:** `docs/superpowers/specs/2026-11-09-orion-phase3-third-party-removal-design.md` (§3.4, §4, §5 R1, §7; D5,
D6, D10). Later releases (R2 price swap ... R8 retire) each get their own plan, written just before they are built,
from fresh measurements.

**Base:** `feat/phase3-third-party` at 5370f2c on main 763868e (= prod/stage release `orion-2026.11.11.1` code
1de531d + docs). Branch the code from it; never rebase onto local `main` (the uranus checkout is the cron fallback).

## Global Constraints

- No new live read of CoinGecko or DefiLlama. CoinGecko/DefiLlama in dev-time probes only, labelled "dev-only reference".
- AERO's report is byte-identical (R1 does not touch `assets/aero.yaml`).
- Revenue, cost of revenue, holder flow, yields and grades of all 13 assets are unchanged. The only value moves allowed
  are listed in Task 7's allowlist; anything else is a stop.
- Migration 0007 is expand-only (no `-- breaking` line): `orion-2026.11.11.1` must still run on schema 7 (rollback).
- New options default to "absent changes nothing": an asset that doesn't use them keeps its config hash and its
  report bytes.
- Out of scope here: HYPE `af_buyback`/`revenue_proxy` (R5), PUMP `llama_revenue` and `solana.supply_burn_daily`
  history (R6), CRV `llama.box` (R7), AERO `flow_usd.fees` (R4), every price and circulating primary (R2/R3), the
  `defillama`/`coingecko` source types and `identifiers` (R8).
- Tests: `export ORION_TEST_DATABASE_URL='postgresql://orion_dev@/orion_test?host=/var/run/postgresql'`;
  `npx vitest run --maxWorkers=2`, load-sensitive files rerun alone at `--maxWorkers=1`; `npm run typecheck`;
  `python3 -m unittest scripts/provision/test/test_orion_remote.py`.
- Commit with explicit `git add <paths>`; never `-a`.

## Plan decisions (Mike's go on the plan covers these)

- **P1 Backfills run as a daemon job, not a long SSH session.** `job run-now backfill <a> --metrics ... --backfill-days N`.
  The daemon's single worker runs it at priority 70 (after refresh, nightly, push, levels, watch), with no automatic
  retry. If the env's next nightly slot is less than 4 h away when it starts, it defers to 2 h after that slot. Why not
  a synchronous verb: a multi-hour SSH call dies with the connection, and it races deploys (a switch drains the daemon,
  not a stray CLI process).
- **P2 `data purge` is a remote verb that dry-runs by default.** `--yes` deletes, after writing the rows to one file
  per call, `$ORION_HOME/purged/<asset>-<first metric>[+N]-<UTCstamp>.json`. It refuses (a) the rows of a metric's current source type,
  (b) a metric with an open anomaly, and (c) a kept row that references a deleted row. Prod purges run only on Mike's go.
- **P3 R0b and R1 ship as one release** (0007 is expand-only; R1's value moves are the two below).
- **P4 Unlock citations.** LIT: Lighter's own post (team 26%, investors 24% = 500M; 1-year lock, 3-year vest; the
  monthly tranches from 2027-01-29 stay as approved in proposal #3). The next-365-day figure goes from 138,796,789
  (DefiLlama's 499.67M) to 138,888,889 (+0.066%). PUMP: pump.fun has published no vesting schedule (searched
  2026-11-12). The plan cites the allocation sizes (team 20%, investors 13% = 330B) and the lock/vest terms (12-month
  lock from 2025-07-12, then linear for 3 years). It prefers a pump.fun page if Task 4 finds one, and otherwise uses the
  Blockworks Token Transparency filing (compiled by Blockworks, labelled so). The value is unchanged: 82.5B a year. If
  Mike doesn't accept a non-issuer citation, PUMP's `unlocks` line goes `not_measured` (dilution becomes null), which
  is a value change he would have to approve.
- **P5 R1 drops checks without replacing them.** LIT's buyback check (fills vs the treasury's LIT balance, a
  `two_path`) and VVV's `usage_index` watch are built in R3, not here. Until R3, LIT's buyback and VVV's burn have no
  external check (LIT's and VVV's own reconciliation checks stay).
- **Dropped from §3.4:** `db backfill-provenance` (gone since 0006) and `data backfill-tokens` (one-time Phase 2 fill,
  done on both envs). R2 adds its price-history rebuild as a second `backfill` op (`op: prices`) on this job kind.

## Review Focus

- A `backfill` job queued while the nightly runs: it must wait (priority) and never delay the nightly's refreshes.
  The test is in Task 1.
- A deploy `switch` while a backfill runs: the drain waits for the job or the lease expires. It must never re-run
  automatically under the new release (max_attempts 1). The test is in Task 1.
- `data purge` on a metric that is still configured, without `--source-type`, or with the current source's type:
  refused, nothing written. The test is in Task 2.
- `orion-remote` given `--metrics a,,b`, a metric with uppercase or `/`, or `--backfill-days 0` / `401`: refused with
  exit 64 before Orion runs. The test is in Task 3.
- An unlock schedule whose tranche dates straddle `now + 365d` exactly, or a linear vest that ends inside the window:
  only the part inside (now, now+365d] counts. The test is in Task 4.

---

### Task 1: `backfill` job kind (migration 0007, params, handler, CLI)

**Files:**
- Create: `src/db/pg/migrations/0007_job_params.sql`, `src/daemon/jobs/backfill.ts`, `tests/daemon/backfill.test.ts`,
  `tests/cli/job.cli.test.ts`
- Modify: `src/db/jobs.ts` (JOB_KINDS, JOB_PRIORITY, MAX_ATTEMPTS, NewJob/Job `params`), `src/daemon/daemon.ts`
  (`defaultHandlers`), `src/cli/commands/job.ts`, `src/daemon/schedule.ts` (only if no next-slot helper exists)

**Interfaces:**
- Produces: `JobKind` gains `'backfill'`. `NewJob.params?: BackfillParams | null`, `Job.params: Json | null`.
  `type BackfillParams = { op: 'fetch'; metrics: string[]; backfillDays: number }`.
  `backfillHandler: JobHandler` in `src/daemon/jobs/backfill.ts`. `BACKFILL_CLEARANCE_MS = 4 * 3_600_000`,
  `BACKFILL_DEFER_AFTER_MS = 2 * 3_600_000`, `BACKFILL_MAX_DAYS = 400`.

- [ ] **Step 1: Migration test.** In `tests/db/daemonSchema.test.ts` (and the migration-list pin under `tests/db/pg/`), assert
  0007 applies on a schema at 6, that `jobs.params_json` is `jsonb` and nullable, that an insert with kind
  `'backfill'` succeeds, that kind `'nope'` is rejected, and that 0007 is not marked `-- breaking`.
- [ ] **Step 2: Write 0007.** `ALTER TABLE jobs ADD COLUMN params_json jsonb;`, then drop and re-add the kind CHECK
  with `'backfill'` added (find the constraint name with `\d jobs` on the test DB). Schema-unqualified, with a header
  comment in the style of 0004.
- [ ] **Step 3: Handler tests** in `tests/daemon/backfill.test.ts`, using the fake fetch deps from
  `tests/daemon/refresh.test.ts`:
  - `runs fetchAsset with the job's metrics and backfillDays under the asset run lock`: the result's `fetchLines`
    equal `fetchSummary(result)`, and `status: 'done'`.
  - `defers when the next nightly slot is under 4 h away`: clock 22:00Z, nightly at 00:45Z, so `deferred` until
    02:45Z.
  - `fails without retry on a fetch error`: `status: 'failed'`, no `retryAfterMs`, and one Slack post naming the
    asset, the metrics and the error's first line.
  - `refuses params that don't parse`: a missing `op`, an unknown metric, a non-flow metric, or `backfillDays` 0 or 401
    each fail with `invalid_backfill_params`, and nothing is fetched.
  - `run_in_progress` (lock held) defers 30 min, like refresh's `REFRESH_LOCKED_RETRY_MS`.
- [ ] **Step 4: Daemon ordering tests** in `tests/daemon/daemon.test.ts`. With a `backfill` and a nightly `refresh`
  job queued at the same slot, `claimNextJob` returns the refresh first. A `backfill` whose lease expires with
  `attempts = max_attempts = 1` is failed by `reapExpired`, not re-queued.
- [ ] **Step 5: Implement.** In `jobs.ts`, `backfill` gets priority 70 and max attempts 1, and `enqueueJob` writes
  `params_json`. The handler validates the params against the loaded asset (each metric configured, `type: flow`),
  runs `withRunLock(db, asset, lockHolder('daemon backfill'), ...)` around
  `fetchAsset(db, loaded, now, deps, { metrics, backfillDays })`, posts one Slack line on done (rows written per metric)
  and on failure, and returns `{ fetchLines, written }` as `result`.
- [ ] **Step 6: CLI.** `job run-now backfill <asset> --metric <k> (repeatable) --backfill-days <n>`. Both are required
  for `backfill` and refused for every other kind (`invalid_option`). Validate the same way as the handler, so a bad
  request never reaches the queue. The asset needs no `active` state, because a backfill is an operator action.
  Test in `tests/cli/job.cli.test.ts`; `tests/db/jobs.test.ts` covers `params` round-tripping.
- [ ] **Step 7: Run** the three test files, then the full suite and typecheck. Expected: green, and no hash pin moves.
- [ ] **Step 8: Commit** `feat(daemon): backfill job kind (0007 jobs.params_json, expand-only); job run-now backfill`.

### Task 2: `data purge` (dry run by default, export before delete)

**Files:**
- Create: `src/db/purge.ts`, `tests/db/purge.test.ts`
- Modify: `src/cli/commands/data.ts`, `tests/cli/cli.test.ts` (or a new `tests/cli/purge.cli.test.ts`)

**Interfaces:**
- Produces: `purgeMetrics(db: Db, loaded: LoadedAsset, opts: { metrics: string[]; sourceType?: SourceType; apply: boolean; exportDir: string; now: Date }): Promise<PurgeResult>`.
  `PurgeResult = { asset; perMetric: { metric; configured: boolean; observations: number; superseded: number; firstDay: string|null; lastDay: string|null; valueSum: number; latestLevels: number; watchState: number; fetchCursors: number }[]; exportFile: string|null; applied: boolean }`.

- [ ] **Step 1: Tests** in `tests/db/purge.test.ts`, seeding observations with provenance on the test DB:
  - `dry run counts and writes nothing`: the counts match the seed, and the row counts are unchanged afterwards.
  - `orphan metric: deletes observations, latest_levels, watch_state and the fetch_cursors whose scan_key names it`.
  - `configured metric needs --source-type`: without it, `purge_configured_metric`.
  - `refuses the current source's type`: unlocks_next_year configured on `schedule.unlocks_next_year` (disclosure)
    with `--source-type disclosure` gives `purge_live_source`.
  - `configured metric + third_party`: deletes only the `source_type = 'third_party'` rows, keeps the disclosure rows,
    and leaves latest_levels/watch_state alone.
  - `open anomaly on the metric`: `purge_open_anomaly`.
  - `a kept row references a deleted row`: `purge_dangling_reference`, rolled back.
  - `apply writes the export first`: one JSON file with every deleted row (all columns) whose sha256 is printed. If
    the export can't be written, nothing is deleted.
- [ ] **Step 2: Implement** `purgeMetrics`. One transaction holding the asset run lock. Within the set, clear
  `superseded_by` before the delete (the self-referencing FK). `exportDir` = `$ORION_HOME/purged`, mode 700, file 600.
- [ ] **Step 3: CLI** `data purge <asset> --metric <k> (repeatable) [--source-type <t>] [--yes] [--json]`. Without
  `--yes` it prints the dry run and the line `dry run: nothing deleted; --yes deletes and exports to <dir>`.
- [ ] **Step 4: Run** the tests, the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(data): data purge (dry run by default; exports the rows before deleting)`.

### Task 3: `orion-remote` verbs and the runbook

**Files:**
- Modify: `scripts/provision/files/orion-remote` (docstring verb table, `v_job`, `v_data`, `VERBS`),
  `scripts/provision/test/test_orion_remote.py`, `docs/ops/deploy.md` (new section "Phase 3 R1 release")

**Interfaces:**
- Consumes: Task 1's `job run-now backfill`, Task 2's `data purge`, the existing `data compare-usd`.
- Produces (verbs):
  - `job run-now backfill <asset> --metrics <k1,k2,...> --backfill-days <1..400>`: passes `--metric` once per item.
  - `data compare-usd <asset> [--days <1..400>]`: passthrough, read-only.
  - `data purge <asset> --metrics <list> [--source-type <rung>] [--yes]`.

- [ ] **Step 1: Tests** with the existing fake-node harness (assert the argv Orion receives):
  `backfill_passes_each_metric`, `backfill_refuses_empty_item` (`a,,b`), `backfill_refuses_bad_metric` (`A`, `a/b`,
  65 chars), `backfill_days_range` (0, 401, `1e3`), `purge_dry_run_by_default` (no `--yes` in argv),
  `purge_source_type_is_a_known_rung` (the nine rungs from 0004's CHECK, anything else exit 64),
  `compare_usd_passthrough`, and `backfill_on_kinds_other_than_backfill_refused`. Every refusal exits 64 and logs
  `refused` to remote.log without the argument text.
- [ ] **Step 2: Implement.** Use the existing `METRIC_RE` and `COUNT_RE` and a `RUNG_RE` built from that list. Keep
  `parse()`'s rule against repeated flags, which is why the list is comma-separated.
- [ ] **Step 3: deploy.md.** Add "Phase 3 R1 release" in deploy order: Mike re-runs `orion-host.sh` from a fixed
  `git archive` snapshot of the release sha (installs the new `orion-remote`); then the per-env steps of Task 8's
  release block. Note that the verbs fail with Orion's own "unknown command" on a release older than this one.
- [ ] **Step 4: Run** `python3 -m unittest scripts/provision/test/test_orion_remote.py` (all pass).
- [ ] **Step 5: Commit** `feat(provision): orion-remote verbs for backfill jobs, compare-usd and purge`.

### Task 4: `schedule.unlocks_next_year`, a generic cited unlock schedule

**Files:**
- Create: `src/ingest/adapters/schedule.ts`, `tests/ingest/scheduleUnlocks.test.ts`
- Modify: `src/ingest/types.ts` (level `SourceValue` gains `citation?`), the ingest writer that builds level
  observations (`src/ingest/run.ts`, where an adapter level becomes a `NewObservation`), `src/ingest/adapters/registry.ts`
  (register), `src/report/sourceTypes.ts` (`'schedule.unlocks_next_year': 'disclosure'`),
  `tools/sources-register/generate.ts` (`ADAPTER_ENDPOINTS`: no endpoint, the citation urls instead)

**Interfaces:**
- Produces: adapter `schedule.unlocks_next_year`, `needsRpc: false`, no network. Params (strict, unknown keys refused
  in `validateParams`):
  `{ citation: { url: string; quote: string }; schedules: Array<{ label: string; tokens: number } & ({ tranches: { first: 'YYYY-MM-DD'; every_months: 1..12; count: 1..120 } } | { linear: { start: 'YYYY-MM-DD'; years: number } })> }`.
  Value = the sum, over schedules, of the tokens due in (now, now + 365 d]. Tranches: `tokens / count` per tranche date
  (the dates are `addMonthsClamped`, the same as `lit.ts`). Linear: `tokens / years` per 365 days times the overlap
  in days / 365, clamped to [start, start + years x 365 d]. Returns
  `{ kind: 'level', value, observedAt: now, source: 'api', detail: '<label> <x>M, ...; cited <url>', citation }`.
  `citation` gives the row's `citation_url`/`citation_quote`, with method `disclosed`, rung `disclosure` (0006's
  `observations_disclosure_citation` CHECK needs the url).

- [ ] **Step 1: Find the PUMP citation (P4).** Search pump.fun's own pages (`pump.fun/docs/*`, the ICO terms, the
  `@pumpfun` posts) for the team/investor lock and vest. Record what was found, with url and verbatim quote, in the
  ledger. If no pump.fun page states it, use the Blockworks filing
  (`https://blockworks.com/token-transparency/filing/pump`, quote: "were locked for 12 months from 12 July 2025 and
  then vest linearly over three years to July 2029"), and begin the YAML comment with "compiled by Blockworks, not the
  issuer".
- [ ] **Step 2: Tests** (`ctx.nowIso` fixed):
  - `LIT at 2026-11-12T00:46:15Z`: tranches {first 2027-01-29, every_months 1, count 36}, tokens 260e6 + 240e6, gives
    `500e6 / 36 * 10` = 138,888,888.89 (to 1e-6).
  - `PUMP at 2026-11-12T00:46:41Z`: linear {start 2026-07-12, years 3}, tokens 150e9 (team) + 97.5e9 (investors), gives
    exactly 82.5e9.
  - `tranche on now + 365d counts; one on now does not`.
  - `linear ending inside the window counts only to its end`: start 2026-07-12, years 3, now 2029-01-12: 182 days'
    worth.
  - `before start counts nothing`, and `a schedule wholly past is 0`.
  - `validateParams` refuses an unknown key, a missing citation, a quote longer than 500 chars, `tokens` <= 0, both
    or neither of tranches/linear, and a bad date.
  - Ingest: the written row has `source_type 'disclosure'`, `method 'disclosed'`, and `citation_url` set.
- [ ] **Step 3: Implement**, then register it and add the rung and register lines.
- [ ] **Step 4: Run** the tests, `tests/report/sourceTypes*.test.ts`, the sources-register test, and typecheck.
- [ ] **Step 5: Commit** `feat(ingest): schedule.unlocks_next_year, a cited unlock schedule (disclosure rung)`.

### Task 5: `volume: { not_measured: <reason> }`

**Files:**
- Modify: `src/config/schema.ts` (`VolumeSchema`), `src/config/incomeStatement.ts`, `src/report/incomeStatement.ts`
  (the `volume` output, line ~867), `src/report/load.ts` (the metrics read), `src/report/parity.ts` if it reads
  `volume.metrics`
- Test: `tests/config/incomeStatement.test.ts`, `tests/report/incomeStatement.test.ts`

**Interfaces:**
- Produces: `income_statement.volume` = `string[]` (as today) | `{ not_measured: string }` (1-200 chars). Output, for
  the new form only: `volume: { metrics: [], annualized: null, growth: <the null Growth the report uses for a
  metric-less series>, notMeasured: '<reason>' }`. The list form's output has no `notMeasured` key (byte-identical).

- [ ] **Step 1: Tests.** The list form is unchanged for a fixture asset (deep-equal against the current output). The
  new form produces the shape above. `{ not_measured: '' }` and `{ not_measured: 'x', extra: 1 }` are refused. The
  VVV golden/report hash tests still pass.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the report and config tests, the full suite and typecheck. No hash pin moves.
- [ ] **Step 4: Commit** `feat(report): volume may be not_measured with a reason`.

### Task 6: the R1 config sweep (12 assets)

**Files:**
- Modify: `assets/{cake,crv,cvxcrv,hype,link,lit,pump,sdcrv,sky,uni,vvv,ycrv}.yaml`, their hash pins
  (`grep -rl <old hash> tests`), the asset ingest tests that mock the removed reads (`tests/assets/*.test.ts`),
  `docs/ops/sources-register.md` (regenerated)

**Interfaces:**
- Consumes: Task 4's adapter and Task 5's volume form.

The removals, exactly (spec §5 R1):

- **`coins.llama.fi` price cross-checks** (`cross_checks` items of `price_usd`): CRV, cvxCRV, HYPE, sdCRV, SKY, yCRV.
- **CoinGecko `total_supply` cross-checks:** CRV, cvxCRV, HYPE, LINK, LIT, PUMP, SKY, UNI, VVV.
- **CAKE:** delete the metrics `flow_usd.fees` and `flow_usd.llama_revenue`. Set `volume` to
  `{ not_measured: "gross swap fees: DefiLlama removed (Phase 3 R1); on-chain v2/v3 gross not read yet (Phase 3b)" }`.
- **UNI:** delete `flow_usd.swap_fees`. Set `volume` to
  `{ not_measured: "gross swap fees: DefiLlama removed (Phase 3 R1); v2 x6 derived and v3/v4 scans not built (Phase 3b)" }`.
- **LIT:** delete `flow_usd.fees` and `flow_usd.llama_revenue`, and the `defillama` cross-check on `flow_usd.buyback`.
  `unlocks_next_year` moves to `schedule.unlocks_next_year` with team 260e6 and investors 240e6, the approved
  tranches, and the citation `https://x.com/Lighter_xyz/status/2005862687331303804` (quote: "The team and investors all
  have a 1-year unlock and 3-year linear vesting after. The breakdown is 26% team, 24% investor."). Update the dilution
  line's note to the new source.
- **PUMP:** `unlocks_next_year` moves to `schedule.unlocks_next_year` (linear, start 2026-07-12, years 3; 150e9 team
  and 97.5e9 investors still locked; the citation from Task 4 Step 1). Update the dilution note.
- **VVV:** delete `flow_usd.revenue_proxy` and the `cross_check: flow_usd.revenue_proxy` on the `business` revenue line,
  and the `defillama` cross-check on `flow_usd.burn`.
- Rewrite every YAML comment that names a removed read. Leave `identifiers.coingecko/defillama` (R8).

- [ ] **Step 1:** Make the edits. Run `npx tsx src/cli/index.ts asset validate <a>` for all 13.
- [ ] **Step 2:** Assert in a test (`tests/assets/r1-third-party.test.ts`) that none of the 12 YAMLs has a `defillama`
  source or `coins.llama.fi`/`defillama-datasets` url outside the out-of-scope list in the Global Constraints, and no
  `coingecko` source with `field: total_supply`. Assert also that `lit.unlocks_next_year` is no longer referenced by
  any asset (the adapter stays until R8).
- [ ] **Step 3:** Re-pin the 12 hashes. AERO's must not move, and any other pin moving is a stop. Update the asset
  ingest tests' mocks (the removed endpoints are no longer called, so drop their stubs and assert no call goes to
  them).
- [ ] **Step 4:** Regenerate `docs/ops/sources-register.md`. Run the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(config)!: Phase 3 R1: drop the DefiLlama/CoinGecko cross-checks and display series (12 assets); cited unlock schedules; CAKE/UNI volume not_measured`.

### Task 7: proof on a read-only prod copy

**Files:**
- Create: `tools/phase3-proof/r1-allowlist.json`, `tools/phase3-proof/flatdiff.py`, `tools/phase3-proof/test_flatdiff.py`
- Results to `~/.hermes/profiles/raymond/workspace/orion/phase3-proof/r1/`

- [ ] **Step 1: `flatdiff.py <old.json> <new.json> --allow <allowlist> --asset <a>`.** It flattens both reports to
  `path = value` and prints every differing path. It exits 0 only when each one matches an allowlist glob for that
  asset and the numeric bound the entry carries (`rel` or `abs`). Unit tests cover a match, an out-of-bound value, and
  an unlisted path.
- [ ] **Step 2: Allowlist.** CAKE, UNI: `incomeStatement.volume.*`. LIT: `incomeStatement.dilution.*`, with the
  unlocks line's tokens rel ≤ 0.0007 (the +0.066%). PUMP: the same paths with rel ≤ 1e-12. VVV: the business line's
  cross-check fields. All 12: the provenance/cross-check listing paths that name the removed reads, enumerated from
  the first diff run, each with its reason. Revenue, cost of revenue, holder flow, yields and grades get no entry.
- [ ] **Step 3: Copy.** `tools/phase2-proof/prod_copy.py` into `$TMPDIR/p3r1` (run in the background). The OLD home
  is release `orion-2026.11.11.1`'s dist and assets; the NEW home is the branch's.
- [ ] **Step 4: Fetch on the new home.** `data fetch lit --metric unlocks_next_year` and
  `data fetch pump --metric unlocks_next_year` (no network: the adapter is offline). D = yesterday (UTC).
- [ ] **Step 5: Compare.** For all 13: before = prod's own `ssh orion-prod report yield <a> --day D` for the 12
  changed assets, and the OLD home's report for AERO; after = the NEW home. Run `flatdiff.py` on each. AERO must be
  `cmp`-identical. Write a sign-off table per asset (paths changed, old → new, reason) over both windows (D and D-91).
- [ ] **Step 6: Purge rehearsal on the copy.** Dry-run `data purge` for each pair below and check its counts against
  prod's (the 2026-11-12 counts are cake fees 398 / llama_revenue 398, lit fees 191 / llama_revenue 191, uni swap_fees
  191, vvv revenue_proxy 345, lit and pump unlocks_next_year third_party 31 / 29; re-read them, since they grow daily).
  Then run `--yes` and re-run Step 5: the reports must be byte-identical to Step 5's NEW output.
- [ ] **Step 7: Backfill job rehearsal.** In the NEW home (ORION_ENV unset = dev), queue `orion job run-now backfill
  vvv --metric flow_usd.burn --backfill-days 3`, start `orion daemon` in the background, poll `orion job list --kind
  backfill --json` (sleeps <= 60 s) until the job is `done`, then stop the daemon (SIGTERM). The job's result lists
  the rows written; rows are superseded only where the source changed. There is no `--once` mode; don't add one.
- [ ] **Step 8:** Copy the results to `workspace/orion/phase3-proof/r1/` and run `tools/phase2-proof/cleanup.py`.
  Commit the tools: `test(proof): Phase 3 R1 flatdiff + allowlist`.

### Task 8: soak expectations and the release record

**Files:**
- Modify: `~/.hermes/profiles/raymond/scripts/orion-phase2-parity.json` (outside the repo; back it up first to
  `.pre-p3r1`), `docs/superpowers/notes/2026-11-12-orion-phase3-followups.md` (create), the spec's Status line

- [ ] **Step 1: Soak parity.** Stage (on R1) vs prod (on 2026.11.11.1) will differ on Task 7's allowlist paths. Add
  them to the parity file as expected for this soak only, and write the "known queue" line of the soak cron
  (e2fb64f34263) prompt. Dry-run `orion-stage-soak.py` against the current envs to show it still passes.
- [ ] **Step 2: Release block** for deploy.md (Task 3's section), per env, in this order: `deploy.sh <env> <tag>` →
  `status`, `logs 30`, `db status` current 7 → `job run-now refresh lit` and `pump` → `data purge` dry runs (paste the
  counts) → on Mike's go, `--yes` for each pair → `report yield` for the 12, through `flatdiff` against the
  pre-deploy report. Stage first, then soak one scheduled nightly, then prod on Mike's go. Before deploying, check that
  no Sunday 10:30Z `staging_refresh` falls between the stage and prod switches (it refuses on schema 6 vs 7 and
  alerts). If one does, deploy stage after it.
- [ ] **Step 3: Followups note.** Carry: P5's two replacements (R3), R2's `op: prices` on the backfill job, ledger
  minors, and the purge export files' location per env.
- [ ] **Step 4: Commit** `docs: Phase 3 R1 release block, followups note`. Push the branch.

**Stop point:** after Task 8, before any tag, merge to main or deploy. The release itself (tag, build, stage, purge,
soak, prod) follows the standing release-day steps, and each env's purge `--yes` needs Mike's go.
