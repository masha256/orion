# Orion Phase 2 (data strategy + income statement v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship income statement v2 (config, computation, report, Slack, snapshot), the internal checks framework, per-observation
provenance, and token amounts stored apart from prices, while every currently published figure stays byte-identical except
the three approved reclassifications (sdCRV, yCRV, LIT).

**Architecture:** A new `income_statement` block sits beside the old `reporting`/`holder_flows` blocks for one release
(decision P1). A new pure module computes v2 from it, and the old code keeps producing the legacy keys. Three expand-only
Postgres migrations add `check_results`, the provenance columns and the tokens/prices tables. Every writer fills the new
columns, and the report keeps reading `observations.value` until Mike signs off the USD comparison (gate G2).

**Tech Stack:** TypeScript (Node 26, TS 7), zod, vitest, Postgres 18 (`pg`), viem, the Orion CLI and daemon on `feat/daemon`.

**Spec:** `docs/superpowers/specs/2026-10-28-orion-data-strategy-income-v2-design.md` (APPROVED 2026-11-04, D1-D9 as
recommended). Umbrella: roadmap on `feat/coinrevs-core` @ e666b87.

**Decisions (Mike, 2026-11-04, #orion-dev "proceed"):** P1 = A (`income_statement` beside the old blocks for one
release, parity test, old keys removed in Task 11). P2 = both (snapshot body carries v2 + legacy keys during the legacy
release). P3 = generic source types built with Phase 3, none here. **P4 (added by Raymond, accepted): no Phase 2 deploy to
staging before the Phase 1.5 prod cutover**, because staging carries the cutover's 3-day parallel run; every proof runs in
local `p2proof_*` schemas. Gate G1's go therefore does not cover a staging deploy until the cutover has landed. Merge
order: `feat/daemon` merges to `main` at the cutover (first prod release); this branch is then rebased onto `main` and
ships as release 2 via staging -> prod. No Phase 2 task changes `feat/daemon` code outside this branch, and no Phase 2
migration may assume it ships in the cutover release.

**Base:** `feat/data-strategy` = `feat/daemon` @ f5f36fa + 3 spec commits (tip fdbbbf3). Never rebase onto `main`, and
never branch from it. `main` has no Postgres code, and Phase 1.5 merges into `main` only at the cutover.

**Baseline (2026-11-04, this worktree @ fdbbbf3, node_modules -> `.worktrees/daemon/node_modules`):**
`npx vitest run --maxWorkers=2` 113 files / 1207 tests passed in 66 s; `npm run typecheck` clean; no `t_*` schemas left
in `orion_test`.

## Spec corrections (the code on this branch vs the spec as written 2026-10-28)

1. **No `config_versions` table.** Phase 1.5b dropped it (decision P1 there, not carried). So §3's history backfill
   maps each row from its `source`/`source_detail` and the asset YAML **in this release**, with `code_version='pre-v2'`
   and `config_hash='pre-v2'`. A row whose metric's source type changed since it was written cannot be told apart, and
   it gets mapped by its `source` column (`api` -> `third_party` if the metric's current source is DefiLlama, else
   `first_party_api`). Every row the rules cannot map is listed in the proof, never guessed.
2. **Migrations are expand-only** (platform spec §3.3, because a rollback runs the previous release on the newer
   schema). So §3's `NOT NULL` provenance columns are added **nullable**, and the TypeScript `NewObservation` type is
   what makes them mandatory. `SET NOT NULL` and `DROP COLUMN source` go in a separate `-- breaking` release (Task 10,
   gate G3). Likewise §4's "`value` is no longer written for flows" becomes: `value` (USD) **keeps being written** next
   to `amount`/`hourly_amounts` until G2 and G3. The previous release reads `value`, and `value` is `NOT NULL` in
   `0001_baseline`.
3. **Column types follow the baseline:** `amount`, `price_usd` and `hourly_amounts` hold `double precision`/`jsonb`,
   not `numeric`. `src/db/pg/pool.ts` has no NUMERIC parser, so a `numeric` would come back as a string, and
   `tests/meta/aggregates.test.ts` polices exactly that. Every existing value is already an IEEE double in token units.
4. **Metric keys stay as they are** (`flow_usd.*`, `flow_tokens.*`). The spec's `flow.fees_core` examples are
   illustrative. Renaming keys would move the agent pack, the ledger and every hash, and that is out of scope.
5. **Old config keys are not refused in Phase 2** (decision P1, recommended A). The spec §12.1 says "old keys refused".
   Instead, `income_statement` is added next to `reporting` and `holder_flows` for one release, the legacy keys stay
   byte-identical for all 13 assets, and a parity test ties the two blocks together. Removal is Task 11 (gate G4,
   together with D9's legacy report keys). If Mike picks B, Tasks 1-2 change as stated under P1.
6. **The schema additions the 13 assets need** (none is a value choice):
   - A use line (holders / protocol / operating_costs / cost_of_revenue) may take `of: <revenue line id>` with `share`
     defaulting to 1. It inherits that line's metric, `settlement`, `started` and run-rate weight (HYPE's periodic
     reserve yield reaches holders; LINK, UNI, SKY, CAKE, CRV, cvxCRV, sdCRV and AERO pay a revenue line on). A use
     line whose own `metric` equals a revenue line's metric is refused (use `of`).
   - `paid_metric` on a holders line: the series measured at the recipients, used for holder flow and yields, while
     `metric`/`of` feeds the statement. It exists for cvxCRV `crv`: the statement uses `convex_rev_cvxcrv` (1.986 $M/yr
     on 2026-10-27) and the yield uses `flow_usd.crv` (1.997). Setting it adds an automatic `two_path` check.
   - `below_line` lines take exactly one of `metric` (a flow), `run_rate` (a level in USD/yr; CRV's
     `vote_incentive_run_rate_usd`, which v1 called `extra_cash`) or `not_measured` (AERO's voter bribes). The growth of
     a `run_rate` line is "no daily series", as today.
   - Holders and below_line-to-holders lines carry `capture_rule` (contractual | programmatic | discretionary) and
     `note`, both display only. The `holder_flows` text in `asset describe` reads them.
   - A disclosed revenue line keeps `cross_check` (VVV's DefiLlama `revenue_proxy`), labelled `third_party`, until
     Phase 3 drops it.
   - Revenue lines may be `estimate` lines (cvxCRV's callers, 5% of `convex_rev_cvxcrv`, are in v1's revenue and become
     an operating cost `of` that line).
7. **v1 revenue basis "income"** (AERO, CAKE, CRV, cvxCRV, sdCRV, yCRV: no `reporting.revenue` list, so revenue is the
   sum of the income lines) converts to revenue lines on **the same metrics v1 summed**, so v2 revenue equals v1
   revenue for AERO, CAKE, CRV and cvxCRV. CRV's measured total `flow_usd.protocol_revenue` stays the `sum` check's
   total and does not become the revenue line (0.00% gap today, but not bit-equal). Making it the revenue line would
   be a later choice.
8. **The Slack holder-yield block is owned by the daemon**, not the Phase 1 cron prompts:
   `src/app/tickReport.ts` (`TickHolderYieldSchema`, `summarizeHolderYield`) and `src/notify/format.ts`
   (`holderYieldLines`, posted by the `nightly_report` job). Prod still runs `main`'s SQLite install, whose Hermes cron
   prompts this plan does not touch.
9. **The snapshot body** (`src/push/body.ts` `fullBody`) is `report yield --json` per asset, so `incomeStatement`
   reaches `masha256/orion-data-staging` without a Phase 5 body change. During the legacy release it carries the legacy
   keys too (decision P2).
10. **The disclosure analyst's pack** reads `reporting.revenue` (`src/agent/context.ts` `revenueStreams`) and
    `holder_flows` (`src/app/eligibility.ts` `narrowToUsable`). Under P1-A both stay untouched until Task 11, so
    `tests/agent/disclosure.e2e.test.ts` and its replay fixture `tests/fixtures/disclosure/lit-q3-run.json` must not
    change. Never regenerate that fixture (it was a paid run).
11. **There is no VVV golden any more** (Phase 1 removed the engine). §12's "VVV golden replaced by a v2 report golden"
    becomes the cross-release proof (Global Constraints) plus per-asset parity tests on fixture data.
12. **Anomalies wake no agent** after Phase 1 (only disclosure runs exist), so a check breach opening an anomaly costs
    nothing. It still makes the nightly block an ALERT (`isAlert` counts `anomalies_raised`).
13. **Hourly prices have a history limit.** CoinGecko returns hourly points only for ranges of 90 days or less, and the
    Demo key reaches back about 365 days. Transfers older than the hourly series were priced at **daily** points, so the
    re-priced USD for those days differs by design. Days the Demo key can't reach keep `value` as their only USD
    (`flow_usd_v` falls back to it and labels it). The Task 7 comparison reports both groups separately.
14. **The payout ratio when the cost of revenue is not measured.** The spec contradicts itself here. §6 says gross
    profit is n/m when a cost line is `not_measured`, but §8 lists unchanged payout ratios for exactly those assets
    (AERO 1.00, CAKE 0.73, CRV 0.90, HYPE, LINK, PUMP, SKY, UNI 1.00, VVV 0.10). Resolution, which keeps D8 and every
    published ratio:
    - `payoutRatio` = holders / gross profit when gross profit is measured.
    - Otherwise `payoutRatio` = holders / revenue, with `payoutRatioBasis: 'revenue'` and the flag "cost of revenue
      not measured".
    - `grossProfit` and `takeRate` stay null, never zero-filled.
15. **The node_modules symlink** for a worktree on this base points at `/home/hermes/git/orion/.worktrees/daemon/node_modules`.
    The live tree's `node_modules` has no `pg`.

## Decisions owed by Mike (plan level; spec D1-D9 are settled)

| # | Question | Options | Recommendation |
|---|---|---|---|
| P1 | How the config moves to v2 | **A.** `income_statement` beside the old blocks for one release, with a parity test. Legacy JSON stays byte-identical for all 13, and old keys are removed in Task 11 / **B.** Convert in place and derive the legacy keys from v2. One config, but the legacy JSON can't stay byte-identical for ~6 assets (line ids and `revenue.basis` differ) without temporary alias keys | **A**: the safest proof. Its cost is two blocks per YAML for one release and two hash moves (now and at removal) |
| P2 | Snapshot body during the legacy release | v2 + legacy keys / v2 only | **Both**: nothing reads staging snapshots yet, and Mike's coinrevs tables read legacy keys |
| P3 | §12.7 generic source types (`state_delta`, `event_sum`, `balance_delta`, `api_series`) | each built with the first Phase 3 asset that needs it / up front in Phase 2 | **With Phase 3** (spec default). This plan builds none |

## Global Constraints

- No live writes: never touch `/home/hermes/git/orion` (tree, `orion.db`, `.env`, `dist/`, `backups/`), prod on venus,
  or `masha256/orion-data`. Read live only as `sqlite3 'file:/home/hermes/git/orion/orion.db?mode=ro'` (its `.backup`
  included). No staging deploys from this plan before the Phase 1.5 cutover (P4); after it, only with Mike's go.
- No analyst spend: never run `agent run`, `tick` with the agent, `bootstrap`, or a disclosure ingest without `--dry-run`.
- Scratch homes: `ORION_HOME=<dir under $TMPDIR>` inline on every command. A `.env` copy has its `ORION_HOME=` line
  deleted, the home is removed with a `.py` `shutil.rmtree` at the end, and the live `.env` is never sourced.
- Postgres: tests use `ORION_TEST_DATABASE_URL=postgresql://orion_dev@/orion_test?host=/var/run/postgresql`, and proofs
  use `orion_dev` schemas named `p2proof_<stamp>`, dropped at the end. Inside `db.tx`, call only `t` and await each
  call before the next. Cast every aggregate (`::float8`).
- Migrations: `src/db/pg/migrations/0003_checks.sql`, `0004_provenance.sql`, `0005_tokens_prices.sql`, all
  expand-only and append-only once a staging release has applied them. `0006` is the only `-- breaking` file (Task 10).
- **Values unchanged.** Each task that touches the report ends with the cross-release proof, run by the controller:
  - The old side is the staging release `orion-2026.11.04.2` (`/home/hermes/orion-releases/orion-2026.11.04.2.tgz`,
    extracted under `$TMPDIR`). The new side is this branch built in its worktree.
  - Both run against one `p2proof_*` schema, imported from a fresh `.backup` of live with `tools/import-sqlite` and
    migrated by the new release (an older release opens a newer schema).
  - They run `report yield <a> --day D --json` (new side with `--legacy`) for all 13 assets, plus
    `data anomalies --all --json` and `proposals list --json`.
  - With `incomeStatement` deleted, every legacy JSON must be **byte-identical** to the old side for all 13 assets. Its
    v2 figures must equal the parity map (Task 3) at rel 1e-12 for AERO, CAKE, CRV, cvxCRV, HYPE, LINK, PUMP, SKY,
    UNI and VVV. For sdCRV, yCRV and LIT they must equal the Reclassification Table below, computed from the old side's
    JSON.
  - Empty or unparseable output on either side fails the proof. Count the assets and refuse fewer than 13.
- Commits: explicit `git add <paths>`, never `-a`; remove the `node_modules` symlink before `git add`; `git grep` for
  the RPC key prefix before each commit; commit, don't push. Pushing the branch for Mike's review is the controller's
  call, per `references/kanban.md` Gates.
- Tests per task: the task's files, then the full `npx vitest run --maxWorkers=2` and `npm run typecheck`. Rerun the
  load-sensitive CLI/e2e files alone with `--maxWorkers=1` before calling a failure real.
- Hash pins: only the assets a task changes may re-pin (`grep -rl <old hash> tests`). Any other pin that moves means
  stop.

### Reclassification Table (the only v2 figures allowed to differ from v1; spec §8, measured 2026-10-27)

| Asset | v2 field | Expected (from the old side's JSON on day D) | 2026-10-27 |
|---|---|---|---|
| sdCRV | revenue | `income.revenue` − the `vote_incentives` line (`flow_usd.bribes`) | 3.60 -> 1.90 |
| sdCRV | belowLine.toHolders | the `vote_incentives` line | 1.70 |
| sdCRV | operatingCosts | the `boost_delegators` line (v1 `cost`) | 0.12 |
| sdCRV | ratios.payoutRatio | (vecrv_fees + crv_fee_share) / revenue | 0.72 -> 0.47 |
| yCRV | revenue | `volume.annualized` (`flow_usd.yearn_gross`), plus `yearn_styc_fee` only if Task 2's probe finds it a separate stream | 2.31 -> 2.20 (or 2.30) |
| yCRV | unreconciled | revenue − holders − protocol | ≈ 0 or −0.10 |
| LIT | revenue | `revenue.annualized` + robinhood (`grossAnnualized` − `annualized`) | 41.19 -> 49.27 |
| LIT | costOfRevenue | robinhood `grossAnnualized` × 0.5 | 8.08 |
| LIT | grossProfit | v1 `revenue.annualized` | 41.19 |

Every holder-flow, yield, bucket, supply and dilution figure is unchanged for all 13, sdCRV included: its bribes stay in
holder flow, now flagged `fromBelowLine`.

## Review Focus

1. **Old and new tick reports in one night.** The nightly reads `refresh` job results that the previous release may
   have written. The new `holder_yield` v2 fields are `.optional()`, so a v1 row still parses (Task 4 test).
2. **A circular check.** A check whose two sides read the same metric, or one side computed from the other, must be
   refused at load. The trap is PUMP `supply`: supply drop vs `flow_tokens.buyback`, where
   `solana.supply_burn_daily` *is* the fall in `solana.token_supply`. Adapters declare this with a registry field
   `computedFrom: string[]` (adapter names), and the check refuses any pair joined by it (Task 5 test).
3. **The token backfill must never change `value` or add rows.** It updates `amount`/`hourly_amounts`/`token_ref` on
   the active row only. It refuses when its token total differs from a stored `flow_tokens.*` twin by > 1e-9 relative,
   or when the day has no active row (Task 7 test).
4. **The provenance locator must never hold a key.** An `http_json`/RPC URL with a key in the path or the query is
   scrubbed. The fake `alch_SECRET` URL from `tests/ingest/rpc.test.ts` is the fixture (Task 6 test).
5. **The importer and staging refresh run on a schema at 0005.** The cutover importer inserts named columns, so the new
   nullable columns stay null and the row-hash proof covers only carried columns. `staging_refresh` refuses a dump
   whose migrations differ, so prod and stage must migrate together after cutover (Task 6 test + the followups note).

---

### Task 0: Proof harness

**Files:**
- Create: `tools/phase2-proof/README.md`, `tools/phase2-proof/snapshot.sh`, `tools/phase2-proof/reports.sh`,
  `tools/phase2-proof/compare.py`, `tools/phase2-proof/expected.py`, `tools/phase2-proof/cleanup.py`
- Test: `tools/phase2-proof/test_compare.py` (stdlib `unittest`)

**Interfaces:**
- Produces: `snapshot.sh <P>` -> `<P>/snap.db` (sqlite `.backup` of live opened `mode=ro`, `integrity_check` ok) and a
  migrated, imported schema `p2proof_<stamp>` in `orion_dev`, written to `<P>/schema`. `reports.sh <old-dist> <new-dist>
  <home-old> <home-new> <D> <out>` writes `<out>/{old,new}/<a>.json` plus `anomalies.json` and `proposals.json`.
  `compare.py <out> [--reclass expected.json]` exits 0 only on a full pass and prints one line per asset.
  `expected.py <out>/old` writes the Reclassification Table's expected values. `cleanup.py <P>` drops the schema and
  deletes the homes.

- [ ] **Step 1:** Write `test_compare.py`, covering: identical JSON passes; a different number fails; deleting
  `incomeStatement` makes a new-side file comparable; an empty file fails; fewer than 13 assets fails; a parity miss
  > 1e-12 rel fails; a reclass value off by more than 1e-12 rel fails.
- [ ] **Step 2:** Run `python3 -m unittest tools/phase2-proof/test_compare.py`. Expected: FAIL (no module).
- [ ] **Step 3:** Implement the scripts. The reducers are `.py` files and never `python3 -c`, and each script writes
  everything to files. `snapshot.sh` reuses the `tools/import-sqlite` recipe from `references/postgres-backend.md`
  steps 1-3.
- [ ] **Step 4:** Run the unittest. Expected: PASS. Dry-run the harness on today's branch (old = new = f5f36fa
  release). Expected: 13/13 identical. Then run `cleanup.py`.
- [ ] **Step 5:** Commit `tools/phase2-proof/`, with the message "tools: Phase 2 cross-release proof harness".

**Stop if:** the import proof (`tools/import-sqlite proof`) shows any table mismatch, or the dry run is not 13/13
identical. Then the harness is wrong, not the code.

### Task 1: `income_statement` config schema

**Files:**
- Create: `src/config/incomeStatement.ts` (zod schema + `incomeStatementIssues(asset): string[]`)
- Modify: `src/config/schema.ts` (optional `income_statement` on `AssetConfigSchema`; call `incomeStatementIssues` in
  `superRefine`)
- Test: `tests/config/incomeStatement.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type IsCategory = 'dex'|'perp_dex'|'launchpad'|'cdp_stablecoin'|'lending'|'oracle'|'ai_platform'|'liquid_locker'|'lst';
  export type IsBucket = 'burn'|'hold'|'cash';
  export type CostTo = 'lps'|'lenders'|'savers'|'builders'|'referrers'|'partners'|'creators'|'deployers'|'node_operators'|'other';
  export interface IsRevenueLine { id; label?; metric?; settlement?: 'daily'|'periodic'; started?; disclosed?; cross_check?;
    estimate?: { of: string; ratio: number }; derived?: { from: string; share: number; share_metric?: string }; not_measured?: string }
  export interface IsUseLine { id; label?; note?; metric?; of?: string; share?: number; share_metric?: string;
    estimate?: { of: string; ratio: number }; not_measured?: string }
  export interface IsHolderLine extends IsUseLine { bucket: IsBucket; haircut: number; recipient_base: 'all'|'staked'|'locked';
    valued_per?: 'supply'|'recipients'; capture_rule: 'contractual'|'programmatic'|'discretionary'; paid_metric?: string }
  export interface IsCostLine extends IsUseLine { to: CostTo }
  export interface IsBelowLine { id; label?; note?; metric?: string; run_rate?: string; to: 'holders'|'protocol';
    bucket?: IsBucket; haircut?: number; recipient_base?: 'all'|'staked'|'locked'; valued_per?: 'supply'|'recipients'; capture_rule?: ... }
  export interface IsCheck { id: string; type: 'sum'|'parameter'|'balance'|'supply'|'two_path'|'price'|'revision'|'coverage';
    tolerance_pct: number; /* per type, Task 5 */ }
  export type IncomeStatementDef = { category: IsCategory; window_days: number; scope: 'complete'|'protocol_share_only'|'partial';
    revenue: IsRevenueLine[]; cost_of_revenue?: IsCostLine[]; holders?: IsHolderLine[]; protocol?: IsUseLine[];
    operating_costs?: IsUseLine[]; remainder?: 'protocol'|'operating_costs'; below_line?: IsBelowLine[];
    checks?: IsCheck[]; volume?: string[]; dilution?: ...; burned_tokens?: string[] };  // dilution/burned_tokens/volume: same shape as reporting's
  ```
  `src/config/schema.ts` exports `IncomeStatementDef` and the line types for Tasks 3-5.

- [ ] **Step 1: Write the failing tests** in `tests/config/incomeStatement.test.ts`, one `it` per spec §6 rule plus the
  correction 6 additions:
  - `refuses a line with two value sources` (`metric` + `of`)
  - `refuses duplicate ids across sections`
  - `refuses a disclosed revenue line next to another revenue line`
  - `refuses remainder naming a section that has lines`
  - `refuses a burn line with haircut > 0`
  - `refuses a below_line metric that is also a revenue metric`
  - `refuses a use line whose metric equals a revenue line metric (use of)`
  - `accepts of + share and resolves inherited settlement/started`
  - `paid_metric only on holders lines; must be a flow`
  - `below_line has exactly one of metric | run_rate | not_measured; run_rate must be a level`
  - `unknown keys refused (strict)`
  - `an asset without income_statement keeps its hash`: assert `parseAssetYaml(MINI_ASSET_YAML).hash` is still
    `c8cc46425acb05d4fd7e211aa648d8c284b29d3ccd9dfdfde6d5cdad4030f830`
- [ ] **Step 2:** Run `npx vitest run tests/config/incomeStatement.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Every node is `z.strictObject`, and `income_statement` is optional with no default (so
  hashes stay put). `share` defaults to 1 only inside the resolver function `resolveUse(def, line)`, never in the
  schema, so the parsed config (and its hash) is what the YAML says.
- [ ] **Step 4:** Run the file, then `tests/config/load.test.ts` and all `tests/assets/*.ingest.test.ts`. Expected: PASS
  with **no hash pin moved**.
- [ ] **Step 5:** Commit `src/config/incomeStatement.ts src/config/schema.ts tests/config/incomeStatement.test.ts`.

**Stop if:** any existing hash moves (a default leaked into the parsed config).

### Task 2: Convert the 13 assets (v2 block beside v1) and the yCRV st-yCRV probe

**Files:**
- Modify: `assets/{aero,cake,crv,cvxcrv,hype,link,lit,pump,sdcrv,sky,uni,vvv,ycrv}.yaml` (add `income_statement`;
  leave `holder_flows` and `reporting` byte-for-byte as they are)
- Modify: `tests/assets/*.ingest.test.ts` (13 hash re-pins + a `v2 block shape` assertion each), the
  `tests/config/load.test.ts` pins (vvv, hype, aero, lit)
- Create: `docs/superpowers/notes/2026-11-04-orion-phase2-followups.md` (the probe result, the mapping table)

**Interfaces:**
- Consumes: Task 1 schema.
- Produces: one `income_statement` per asset, with the line ids below (Tasks 3-5 and the parity map rely on them).

Mapping (window_days 91 everywhere; `of` lines use share 1 unless stated). Categories and scope are as in spec §8:

| Asset | revenue lines | cost_of_revenue | holders (bucket, haircut, base) | protocol / opex / remainder | below_line | checks |
|---|---|---|---|---|---|---|
| aero | `fees` = flow_usd.fees | `not_measured` lp_fees | `voter_fees` of fees (cash 0.02 locked, contractual) | – | `bribes` not_measured (to holders) | – |
| cake | `burn` = flow_usd.burn, `treasury` = flow_usd.treasury | not_measured lp_fees | `burn` of burn (burn 0 all) | protocol `treasury` of treasury | – | – |
| crv | `fees` = flow_usd.fees, `treasury` = flow_usd.curve_treasury | not_measured lp_fees | `vecrv_fees` of fees (cash 0 locked) | protocol of treasury | `vote_incentives` run_rate vote_incentive_run_rate_usd (to holders, cash 0.03 locked) | sum: total [protocol_revenue] parts [vecrv_fees, treasury] tol 2 |
| cvxcrv | `vecrv_fees` = fees, `platform_cvxcrv` = convex_rev_cvxcrv, `platform_cvx` = convex_rev_cvx, `platform_treasury` = convex_rev_treasury, `callers_fee` estimate {of: platform_cvxcrv, ratio 0.05} | – (none, decision 6) | `vecrv_fees` of vecrv_fees (cash 0 staked, recipients); `crv` of platform_cvxcrv + `paid_metric: flow_usd.crv` (cash 0.01 staked, recipients) | protocol `cvx_stakers` of platform_cvx, `treasury` of platform_treasury; opex `callers` of callers_fee | `cvx_rewards` metric flow_usd.cvx (to holders, cash 0.005 staked, recipients, discretionary) | – |
| hype | `trading` = flow_usd.revenue_proxy (third_party), `reserve_yield` = flow_usd.reserve_yield periodic started 2026-08-26, label "reserve yield on user deposits" (D2) | not_measured hlp/builders/deployers/referrers | `af_buyback` = flow_usd.af_buyback (burn 0 all, note D1 footnote); `reserve_yield_paid` of reserve_yield (burn 0 all) | remainder protocol | – | – |
| link | `onchain_fees` = flow_usd.reserve | not_measured node_operators | `reserve` of onchain_fees (hold 0.05 all, discretionary) | – | – | – |
| lit | `core` = flow_usd.fees_core, `robinhood` = flow_usd.fees_rh started 2026-06-26 | `robinhood_partner` to partners of robinhood share 0.5 share_metric rh_revenue_share_app | `buyback` = flow_usd.buyback (burn 0 all, discretionary) | remainder protocol | – | (parameter auto) |
| pump | `protocol` = flow_usd.llama_revenue (third_party) | not_measured creators, lps | `buyback` = flow_usd.buyback (burn 0 all) | remainder protocol | – | – |
| sdcrv | `vecrv_fees` = fees, `crv_fee_share` = crv, `vesdt` = sd_rev_crv_vesdt, `treasury_crv` = sd_rev_crv_treasury, `liquidity_fee` = sd_rev_fees_liquidity, `treasury_fees` = sd_rev_fees_treasury, `boost_delegators` = sd_boost_delegation | – | `vecrv_fees` of vecrv_fees (cash 0 staked, recipients); `crv_fee_share` of crv_fee_share (cash 0.005 staked, recipients) | protocol of vesdt, treasury_crv, liquidity_fee, treasury_fees; opex `boost_delegators` of boost_delegators | `bribes` metric flow_usd.bribes (to holders, cash 0.05 staked, recipients) | sum: total [sd_rev_crv] parts [vesdt, treasury_crv, crv_fee_share, boost_delegators] tol 2 |
| sky | `surplus_usds` = flow_usd.stakers, `surplus_buyback` = flow_usd.buyback | not_measured savers | `stakers` of surplus_usds, `buyback` of surplus_buyback (cash 0 staked) | – | – | – |
| uni | `protocol_fees` = flow_usd.burn | not_measured lps | `burn` of protocol_fees (burn 0 all) | – | – | – |
| vvv | `business` disclosed revenue_run_rate_usd, cross_check flow_usd.revenue_proxy (third_party) | not_measured compute | `burn` = flow_usd.burn (burn 0 all, discretionary) | remainder protocol | – | – |
| ycrv | `yearn_gross` = flow_usd.yearn_gross (+ `styc_fee` = flow_usd.yearn_styc_fee only if the probe says separate) | – | `ybs_payout` = flow_usd.fees (cash 0 staked, recipients) | protocol `treasury` = yearn_revenue, `styc_fee` = yearn_styc_fee (or `of` styc_fee) | – | sum: total [yearn_gross] parts [ybs_payout, treasury] tol 2 |

`volume`, `dilution` and `burned_tokens` are copied from each asset's `reporting` unchanged. Every `capture_rule` and
`recipient_base` is copied from that flow's `holder_flows` entry.

- [ ] **Step 1: st-yCRV probe (read-only).** Load `scripts/onchain_probe.py` (orion skill) in a `.py` file, with
  the RPC URL from a scratch `.env` copy (masked in all output). Over the 91 days to D, trace the transfers behind
  `flow_usd.yearn_styc_fee`: is the fee taken out of what the YBS stakers are paid (the sender is the YBS reward path),
  or is it charged on st-yCRV vault yield outside the splitter? Record the senders, tx refs, the 91-day sums and the
  verdict in the followups note.
- [ ] **Step 2: Write the failing assertions.** In each asset test: `parseAssetYaml(...).config.income_statement`
  has the line ids in the table. The hash pin is set to the new value only after Step 4.
- [ ] **Step 3:** Add the 13 blocks.
- [ ] **Step 4:** Run `tests/assets` and `tests/config`. Re-pin exactly the 13 asset hashes plus the 4 `load.test.ts`
  pins, and confirm with `grep -rl` that no other old hash is referenced.
- [ ] **Step 5:** Run the full suite and typecheck. The proof: `report yield` legacy byte-identical 13/13 (the old code
  ignores the new block), and `tests/agent/disclosure.e2e.test.ts` passes unchanged.
- [ ] **Step 6:** Commit the YAMLs, the tests and the followups note, with the message naming the probe verdict.

**Stop if:** the probe neither shows the fee inside the YBS payouts nor shows it as a separate stream (then yCRV's
revenue line is a decision for Mike: block with the two figures). Also stop if the disclosure e2e test moves.

### Task 3: v2 computation (pure) and the parity map

**Files:**
- Create: `src/report/incomeStatement.ts`, `src/report/sourceTypes.ts`
- Modify: `src/report/holderYield.ts` (export `windowSum`; `growthOf` is already exported), `src/report/load.ts`
  (`reportFlowMetrics` also reads `income_statement` metrics; levels for `run_rate` lines)
- Test: `tests/report/incomeStatement.test.ts`, `tests/report/parity.test.ts`

**Interfaces:**
- Consumes: `IncomeStatementDef` (Task 1); `ReportInput`, `ReportLevels`, `Growth` from `holderYield.ts`.
- Produces:
  ```ts
  export function sourceTypeOf(def: MetricDef): SourceType | null;  // coingecko->market_data, transfer_flow->log_scan,
    // contract_read/erc20_supply->contract_state, adapter: per-adapter map (hype.*, lit.* -> first_party_api;
    // solana.* -> contract_state), defillama*/http_json on llama hosts -> third_party, constant->constant, derived->derived, manual->disclosure
  export interface IsV2 { schema: 2; day; windowDays; category; scope; revenue; costOfRevenue; grossProfit; holders;
    protocol; operatingCosts; unreconciled; belowLine; holderFlow; dilution; ratios; multiples; yields; perToken;
    priceBasis; checks: []; provenance: { methods; thirdParty: string[]; sources: string[]; basis: 'config' | 'observations' } }
  export function incomeStatementV2(input: ReportInput, legacy: HolderYieldReport): IsV2;
  export function listingBar(asset: AssetConfig): { ok: boolean; failing: { line: string; sourceType: SourceType | null }[] };
    // printed by `asset validate` (src/cli/commands/asset.ts) as "listing bar (D6): ok | fails: <lines>"
  export const PARITY: Record<string, (v2: IsV2, v1: HolderYieldReport) => [label: string, a: number|null, b: number|null][]>;
  ```
  `dilution`, `yields` and `supply` are copied from `legacy` (identical by construction; spec §7 "as today").
  `provenance.basis` is `'config'` until Task 6 switches it to `'observations'`.

- [ ] **Step 1: Write the failing tests.** In `incomeStatement.test.ts`, fixtures built with `tests/helpers/assets.ts`
  style mini assets:
  - `revenue - cost = gross profit`
  - `gross profit = holders + protocol + opex + unreconciled`
  - `remainder closes to 0 unreconciled`
  - `a not_measured cost makes grossProfit and takeRate null and lists it in notMeasured, never 0`
  - `payoutRatio = holders / grossProfit when measured` (D8)
  - `payoutRatio falls back to holders / revenue with payoutRatioBasis 'revenue' when a cost is not_measured` (correction 14)
  - `listingBar: revenue, holders and supply lines on an allowed rung pass; a third_party revenue line fails with the line id` (spec §2 deferral, D6; AERO, HYPE and PUMP fail today and are reported, not blocked: the bar gates new listings)
  - `of inherits periodic settlement and the young-stream weight` (HYPE shape)
  - `below_line to holders adds to holderFlow, flagged fromBelowLine, not to revenue`
  - `run_rate below_line line: growth note 'no daily series'`
  - `perToken = annualized / circulatingSupply; perTokenFdv / totalSupply`
  - `priceBasis names the day-end price, its source and day`
  - `thirdParty lists every line whose metric sourceTypeOf is third_party` (HYPE trading, PUMP protocol, AERO fees,
    VVV cross_check, CRV vote_incentives)

  In `parity.test.ts`, for each of the 13 YAMLs with synthetic 182-day series: `PARITY[a]` pairs are equal at rel
  1e-12 for the 10 unchanged assets, and the three reclass assets match the Reclassification Table formulas.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement. Annualizing, window sums and growth reuse `windowSum`/`growthOf` (same day loop, same
  `DAYS_PER_YEAR`), so parity holds by construction rather than by tolerance. The sum order follows the YAML line order.
- [ ] **Step 4:** Run both files, then the full suite. Expected: PASS, legacy unchanged.
- [ ] **Step 5:** Commit.

### Task 4: Report output, Slack block, snapshot body

**Files:**
- Modify: `src/report/holderYield.ts` (the `HolderYieldReport` gets an optional `incomeStatement?: IsV2`),
  `src/report/load.ts` (`loadHolderYieldReport(db, asset, day?, opts?: { legacy?: boolean })`)
- Modify: `src/cli/commands/report.ts` (`--legacy`; the text output prints a v2 statement block first)
- Modify: `src/app/tickReport.ts` (optional v2 fields on `TickHolderYieldSchema`: `gross_profit`, `holder_flow_by_bucket`
  `{burn,hold,cash}`, `net_holder_yield`, `mcap_to_revenue`, `mcap_to_holder_flow`, `scope`, `flags: string[]`)
- Modify: `src/notify/format.ts` (`holderYieldLines` prints revenue, gross profit, holder flow by bucket, net holder
  yield, multiples, scope, and the `third_party`/`not_measured` flags, spec §7)
- Modify: `src/push/body.ts` (`fullBody` asks for `{ legacy: true }`, P2)
- Test: `tests/report/load.test.ts`, `tests/cli/cli.test.ts` (report cases), `tests/app/tickReport.test.ts`,
  `tests/notify/format.test.ts`, `tests/daemon/snapshotPush.test.ts`

**Interfaces:**
- Consumes: `incomeStatementV2` (Task 3).
- Produces: `report yield --json` returns `{asset, day, windowDays, price, marketCap, fdv, incomeStatement, notes}`.
  With `--legacy` it adds `flows, buckets, yields, holderFlowGrowth, supply, income, revenue, volume,
  revenueDisclosed`, in today's key order with `incomeStatement` last. The snapshot body is the `--legacy` object.

- [ ] **Step 1: Write the failing tests:**
  - `report yield --json omits legacy keys; --legacy keeps them in v1 order`
  - `--legacy JSON minus incomeStatement equals the v1 object` (deep equal on fixture data)
  - `tick holder_yield from a v1 job row still parses` (a recorded v1 `result_json` fixture)
  - `nightly block prints gross profit and 'not measured' flags` (exact lines)
  - `nightly block stays under SLACK_MAX_CHARS for 13 assets` (the longest real block × 13)
  - `full snapshot body carries incomeStatement and the legacy keys`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite and typecheck.
- [ ] **Step 5 (controller): the cross-release proof** (Global Constraints) with Task 0's harness. Report 13/13
  legacy identical, 10/10 parity, 3/3 reclass, and paste the v2 summary table per asset (revenue, cost, gross profit,
  holders by bucket, protocol, below line) into the followups note.
- [ ] **Step 6:** Commit.

**Stop if:** any legacy byte differs, or a reclass figure misses its formula. Report the asset, the path and both
values, and change nothing to make it pass.

**Gate G1 (Mike):** the v2 table from Step 5. His go covers continuing to Task 5; a staging deploy waits for the Phase 1.5 cutover (P4) and its own go.

### Task 5: Checks framework

**Files:**
- Create: `src/db/pg/migrations/0003_checks.sql`, `src/db/checkResults.ts`, `src/checks/evaluate.ts`,
  `src/checks/schema.ts`
- Modify: `src/config/incomeStatement.ts` (per-type check shapes; circular refusal), `src/app/tick.ts` (a `---- checks
  ----` step after the holder-yield report, inside the run lock), `src/ingest/adapters/registry.ts` (optional
  `computedFrom` on an adapter entry; set on `solana.supply_burn_daily`), `src/app/tickReport.ts` (optional
  `checks: {id,type,status,gap_pct}[]`), `src/report/incomeStatement.ts` (fills `checks` from stored results),
  `assets/{crv,sdcrv,ycrv,lit,cvxcrv,uni,link,cake}.yaml` (check lines), and the matching asset tests (re-pins)
- Test: `tests/checks/evaluate.test.ts`, `tests/db/checkResults.test.ts`, `tests/db/pg/migrate.test.ts` (0003 cases),
  `tests/app/tick.test.ts`

**Interfaces:**
- Migration 0003:
  ```sql
  CREATE TABLE check_results (asset_id text COLLATE "C" NOT NULL, check_id text COLLATE "C" NOT NULL, day date NOT NULL,
    type text COLLATE "C" NOT NULL, lhs double precision, rhs double precision, gap_pct double precision,
    status text COLLATE "C" NOT NULL CHECK (status IN ('ok','breach','incomplete')), detail_json json NOT NULL,
    evaluated_at timestamptz NOT NULL, PRIMARY KEY (asset_id, check_id, day));
  ALTER TABLE anomalies DROP CONSTRAINT anomalies_kind_check,
    ADD CONSTRAINT anomalies_kind_check CHECK (kind IN ('cross_check_mismatch','unlisted_sender','source_failure_streak',
      'revenue_disclosure_stale','revenue_payment','check_breach'));
  ```
- Check shapes:
  - `sum {total: string[], parts: lineId[]}`
  - `parameter {metric: level, expected: number}`, auto-added for every `share_metric`
  - `balance {level: string, inflows: string[], outflows: string[]}`
  - `supply {level: string, burns: string[], mints?: string[]}`
  - `two_path {a: string, b: string}`, auto-added for every `paid_metric`
  - `price {level: string, against: string}`
  - `revision {metric: string, days: number}`
  - `coverage {listed: string[], total: string}`
- Produces: `evaluateChecks(db, asset, day): Promise<CheckResult[]>`, `upsertCheckResults(t, rows)`, anomaly
  `check_breach` (severity `advisory`, dedupe `check_id`).

- [ ] **Step 1: Write the failing tests:**
  - `0003 applies after 0002 and the constraint name anomalies_kind_check exists before it` (assert via `pg_constraint`)
  - `a release-N-1 insert of every old anomaly kind still works on 0003`
  - `sum: CRV 0.00% gap ok; a missing part breaches`
  - `parameter: LIT rh_revenue_share_app 0.5 vs 0.5 ok; 0.4 breaches`
  - `balance: LINK reserve_link delta vs flow_tokens.reserve`
  - `price: UNI price_usd vs its Chainlink contract_read within tolerance`
  - `revision: a restated LIT fee day breaches`
  - `refuses a circular check: same metric both sides`
  - `refuses a circular check: PUMP supply total_supply vs flow_tokens.buyback (supply_burn_daily computedFrom token_supply)`
  - `incomplete when a side has no row for the day (never a breach)`
  - `a breach opens one check_breach anomaly and a second breach bumps occurrences`
  - `tick report lists checks; no agent run is started`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Wire the checks whose inputs are already stored:
  - CRV, sdCRV and yCRV `sum` (moved from `reporting.income.checks`, which stays for the legacy keys)
  - LIT `parameter` (auto) and `revision` 30 days on `flow_usd.fees_core`
  - cvxCRV `two_path` (auto)
  - UNI, LINK and CAKE `price` (their existing Chainlink/contract_read readings)
  - LINK `balance` (`reserve_link` vs `flow_tokens.reserve`)

  Every other check in spec §5 goes in the followups note, with the metric it lacks and the Phase 3 track that adds it.
  The `coins.llama.fi` cross-checks stay (labelled third_party) until Phase 3.
- [ ] **Step 4:** Run the full suite and typecheck, and re-pin the 8 asset hashes. Then the cross-release proof
  (legacy identical; anomalies file differs only by `check_breach` rows, each listed).
- [ ] **Step 5:** Commit.

**Stop if:** a wired check breaches on the proof copy (that is a data finding: report it to Mike with both sides and do
not loosen the tolerance), or the constraint name differs.

### Task 6: Provenance columns, writers and history backfill

**Files:**
- Create: `src/db/pg/migrations/0004_provenance.sql`, `src/provenance/types.ts`, `src/provenance/locator.ts`
  (build + scrub), `src/provenance/backfill.ts`, `src/cli/commands/db.ts` (`db backfill-provenance [--dry-run] [--json]`)
- Modify: `src/db/observations.ts` (`NewObservation.provenance: Provenance` **required**; read and write the columns),
  every writer: `src/ingest/flow.ts`, `src/ingest/apiFlow.ts`, `src/ingest/periodic.ts`, `src/ingest/run.ts` (levels,
  derived, constant, schedule), `src/cli/commands/data.ts` (manual / disclosure), `src/app/proposals.ts`,
  `src/agent/ledger.ts`, `src/db/latestLevels.ts` + `src/levels/levels.ts` (`source_type`, `locator`)
- Modify: `src/report/incomeStatement.ts` (`provenance` from rows in the window: `methods` as revenue share by
  method, `daysMeasured` per line, `sources`; `basis: 'observations'`)
- Modify: `tools/import-sqlite/importer.ts` only if the named-column insert needs it (Review Focus 5)
- Test: `tests/provenance/locator.test.ts`, `tests/provenance/backfill.test.ts`, `tests/db/observations.test.ts`,
  `tests/tools/importSqlite.test.ts`, `tests/tools/proof.test.ts`, the writer tests under `tests/ingest/`

**Interfaces:**
- Migration 0004 adds the spec §3 columns, all nullable, to `observations`: `method`, `source_type`, `chain`, `locator
  jsonb`, `block_from`, `block_to`, `tx_count`, `tx_refs jsonb`, `tx_digest`, `response_digest`, `inputs jsonb`,
  `formula`, `coverage jsonb`, `code_version`, `config_hash`. The CHECKs on `method`/`source_type` allow NULL. It adds
  nullable `source_type` and `locator jsonb` to `latest_levels`, plus an index `(asset_id, metric_key, method)`.
- Produces:
  ```ts
  export interface Provenance { method: 'measured'|'derived'|'disclosed'; sourceType: SourceType; chain: string|null;
    locator: Locator; blockFrom?; blockTo?; txCount?; txRefs?: string[] /* <= 50 */; txDigest?; responseDigest?;
    inputs?; formula?; coverage?; codeVersion: string; configHash: string }
  export function scrubLocator(l: Locator): Locator;  // drops query keys key|apikey|api_key|token and RPC-key path segments
  export function backfillProvenance(db, assets, opts): Promise<{ mapped: Record<string, number>; unmapped: {id, assetId, metricKey, source}[] }>;
  ```
  `codeVersion` = `RELEASE.commit`, else `'dev'`. `configHash` = the loaded asset hash. Tx refs are capped at 50, and
  `txDigest` = sha256 of the full sorted list.

- [ ] **Step 1: Write the failing tests:**
  - `locator: a keyed Alchemy URL (alch_SECRET fixture) never reaches the row`
  - `locator: ?apikey= and ?token= are stripped`
  - `transfer_flow row: method measured, source_type log_scan, chain eip155:1, block_from/to = detail.blocks, tx_count, tx_digest over all refs, tx_refs capped at 50`
  - `lighter API row: first_party_api, response_digest set`
  - `defillama row: third_party`
  - `disclosure row: method disclosed, citation required`
  - `derived flow_annualized: inputs + formula 'flow_annualized@1'`
  - `TypeScript: NewObservation without provenance does not compile` (a `// @ts-expect-error` case)
  - `backfill maps every row of a 13-asset fixture by the rules in correction 1, and lists the unmappable ones`
  - `backfill --dry-run writes nothing`
  - `a release-N-1 insert without the new columns still succeeds on 0004`
  - `the importer proof still passes on a schema at 0004` (named columns, row hash over carried columns)
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Values never change: `value`, `source` and `source_detail` are written exactly as
  before, next to the new columns.
- [ ] **Step 4:** Run the full suite and typecheck. Then the cross-release proof, plus `db backfill-provenance
  --dry-run --json` on the proof copy. Record the per-metric mapped counts and the full unmapped list in the
  followups note.
- [ ] **Step 5:** Commit.

**Stop if:** the unmapped list is non-empty after the rules. Bring it to Mike with ids and metric keys: the fix is a
rule, never a guess. Also stop if a legacy JSON byte moves.

### Task 7: Tokens and prices stored apart (dual write), token backfill, USD comparison

**Files:**
- Create: `src/db/pg/migrations/0005_tokens_prices.sql`, `src/db/prices.ts`, `src/prices/coingeckoHourly.ts`,
  `src/ingest/tokenBackfill.ts`, `src/cli/commands/data.ts` (`data backfill-tokens <a> [--metric k]... [--days N]
  [--dry-run] [--json]`, `data compare-usd <a> [--days N] [--json]`)
- Modify: `src/ingest/flow.ts` (per member: the day's token total and 24 UTC-hour token sums, written as `amount`,
  `hourly_amounts`, `token_ref`; every CoinGecko point it loaded is upserted into `prices`), `src/ingest/apiFlow.ts` and
  the adapters `lit.ts`, `hype.ts` (USD-native: `token_ref='usd'`, `amount=value`), `src/ingest/adapters/solana.ts`
  (daily supply drop in tokens: `amount`, `hourly_amounts` null)
- Test: `tests/ingest/flow.tokens.test.ts`, `tests/ingest/tokenBackfill.test.ts`, `tests/db/prices.test.ts`,
  `tests/db/pg/migrate.test.ts` (0005)

**Interfaces:**
- Migration 0005 adds `tokens` and `prices` as in spec §4, with `double precision` (correction 3); `ALTER TABLE
  observations ADD COLUMN token_ref text REFERENCES tokens, ADD COLUMN amount double precision, ADD COLUMN
  hourly_amounts jsonb`; and `CREATE VIEW flow_usd_v`, which gives per active flow row `usd_hourly` = Σ hour amount ×
  the newest `prices` row at or before that hour (source priority: coingecko), `hours_priced`, and `legacy_usd` =
  `value`.
- Produces: `backfillTokens(db, loaded, deps, opts): Promise<{ filled: number; skipped: {day, reason}[]; refused: {day, reason}[] }>`,
  which re-scans by day with the existing transfer scanner, never `insertObservation`; an `UPDATE ... WHERE id = <active
  row id> AND amount IS NULL` per row, inside `db.tx` with the asset lock.
  `compareUsd(db, asset, days): Promise<{metric, days, hourlyCovered, sumLegacy, sumHourly, gapPct, p50DayGapPct, p90DayGapPct, beyondHourly: number}[]>`.

- [ ] **Step 1: Write the failing tests:**
  - `hourly_amounts sum to amount (1e-12 rel) and each log lands in its UTC hour`
  - `the value written is unchanged (same fixture, same USD as before Task 7)`
  - `backfill never changes value and never inserts rows`
  - `backfill refuses a day whose re-scanned tokens differ from the stored flow_tokens twin`
  - `backfill skips a day with no active row and says so`
  - `prices: CoinGecko points are floored to the hour; a re-fetch is idempotent (PK)`
  - `flow_usd_v falls back to legacy_usd and labels it when hours lack prices`
  - `compare-usd separates days beyond the hourly series (correction 13)`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite and typecheck, then the cross-release proof (legacy identical: the report still
  reads `value`).
- [ ] **Step 5 (controller): rehearse the backfill on the proof copy** with a scratch `.env` copy (RPC + CoinGecko key,
  `ORION_HOME=` line deleted):
  - Run `data backfill-tokens <a> --days <stored history>` for each chain-flow asset, one at a time, never in
    parallel (keyless spacing).
  - Time each run and count its RPC calls.
  - Then run `data compare-usd <a> --days 91 --json` for all 13.
  - Write the per-metric gap table into the followups note, split into within-hourly and beyond-hourly days.
- [ ] **Step 6:** Commit the code, then run `cleanup.py`.

**Stop if:** any backfill refusal, or a within-hourly 91-day gap > 0.5% on a metric. Report it with the days
responsible. The method only moves sub-hour timing, so a bigger gap means a bug or a data finding.

**Gate G2 (Mike):** sign off the USD comparison table per metric. Until then, nothing reads `flow_usd_v`.

### Task 8 (after G2): the report reads tokens × prices

**Files:** `src/report/load.ts` (`dailyOf` reads `flow_usd_v.usd_hourly` for rows with full hourly coverage, else
`legacy_usd`; per-line `priceBasis` says which), `src/report/incomeStatement.ts`, tests. **This is the plan's only
intended value change beyond the Reclassification Table.** The proof is old vs new with the per-metric deltas
matching the signed-off G2 table at rel 1e-9. The snapshot `schema` stays 1, because field values move but the
shape does not. Staging only, and only after G2.

### Task 9: Templates and the sources register (docs)

**Files:**
- Create: `docs/templates/T1-fee-switch-burn.md` … `docs/templates/T10-staking-lst-fee.md` (one per spec §9 row: a
  YAML skeleton of `income_statement` + `metrics` with the source types available today, the addresses to find, the
  checks, the traps, the scoping checklist), and `docs/ops/sources-register.md`
- Modify: the followups note

- [ ] **Step 1:** Generate the register's rows from the 13 YAMLs (every distinct host / RPC chain / adapter endpoint,
  operator, terms URL, commercial use `unknown` unless the terms page states it, date checked). A row is `unknown` until
  a human reads the terms. Unknown blocks only the Phase 5 export for that asset.
- [ ] **Step 2:** Each template's skeleton must `parseAssetObject` once the placeholders are filled with a test
  asset's values. Add `tests/config/templates.test.ts`, which loads each skeleton with its example values.
- [ ] **Step 3:** Commit.

### Task 10 (gate G3, own `-- breaking` release): contract migration

**Files:** `src/db/pg/migrations/0006_provenance_not_null.sql` (first line `-- breaking`): `SET NOT NULL` on `method`,
`source_type`, `locator`, `code_version`, `config_hash`, then `DROP COLUMN source` and the reader changes. **Do not
build until** one release has run with 0004-0005 on staging, `db backfill-provenance` left 0 null rows there, and Mike
says go. Prod runs it only after the cutover, with `--breaking`.

### Task 11 (gate G4, one release after Task 4 on staging): retire v1

**Files:** `src/config/schema.ts` (delete `holder_flows` and `reporting`, which are then refused by name at load,
proposal filing and approve, per the orion skill's "Retiring a config key"), the 13 YAMLs, `src/app/eligibility.ts`
and `src/agent/context.ts` (read `income_statement`; the pack's flow set = the holders + below_line-to-holders
metrics, equal to today's `holder_flows` metrics), `--legacy` removed, `holderYield.ts` legacy paths deleted. The
disclosure e2e test keeps its fixture config. Proof: v2 JSON identical before and after, and the pack identical for
LIT (`tests/agent/context.test.ts`).

## Execution

- Interactive, in the orion skill's subagent mode (`references/subagent-execution.md`):
  - On Mike's go, archive kanban card t_1697d7dc, record P1-P3 in this plan's header and commit, and move the worktree
    to `.worktrees/data-strategy` (`references/kanban.md`, "Moving a card's work out of kanban").
  - Dispatch one task at a time, then verify each result yourself (git log, the core diff, rerunning the task's tests)
    and run a named-risk review.
  - Task 0, Task 4 Step 5, Task 5 Step 4, Task 6 Step 4 and Task 7 Step 5 are controller steps (they touch the live
    `.backup`, the scratch `.env` copy or the proof schemas).
  - D4's "internal only": the Phase 5 export must drop or flag every `provenance.thirdParty` line. Phase 2 only labels
    them, and the followups note carries this as a Phase 5 requirement.
- Stop points: G1 after Task 4, G2 after Task 7, then G3 and G4. A merge to `main` happens only with the Phase 1.5
  cutover and Mike's go. Any live/prod action stays outside this plan.
- At the end: a followups note with the ledger's minors and rulings, the v2 table, the check and backfill results, and
  the open items for Phase 3 (the gross/cost series per spec §8 "Missing", D4 on-chain vote incentives, and the
  generic source types if P3 stands).
