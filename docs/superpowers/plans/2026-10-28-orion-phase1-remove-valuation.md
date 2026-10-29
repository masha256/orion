# Orion Phase 1: Remove the Valuation Layer. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orion keeps ingest, anomalies, `report yield`, proposals/inbox and the disclosure run, and loses the engine,
drivers, signals, assumption sets, triggers and every analyst run type but `disclosure`, with every reported number
byte-identical.

**Architecture:** Cut from the outside in so the suite is green after every task. First move the two observation
selectors the kept code needs, then give `tick` its new shape (ingest + report, no valuation, no agent), then reduce the
agent layer to the disclosure run, then delete the valuation code and its commands, and only then strip the config keys
and valuation-only metrics from the schema and the 13 YAMLs (the one task that moves config hashes). Valuation tables
stay in SQLite, unread. No migration in this phase.

**Tech Stack:** TypeScript (Node, ESM), commander CLI, zod schemas, better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-orion-phase1-remove-valuation-design.md` (read its "Plan-time corrections";
they supersede the earlier sections). Umbrella: `docs/superpowers/specs/2026-10-28-orion-coinrevs-core-roadmap.md`.

## Global Constraints

- **No reported number changes:** `report yield <a> --day <D> --json` is byte-identical before and after for all 13
  assets (aero, cake, crv, cvxcrv, hype, link, lit, pump, sdcrv, sky, uni, vvv, ycrv).
- Ingest unchanged except the removed metrics: `data fetch --dry-run` writes the same metric keys from the same sources.
- No schema migration; `max(id)` of `schema_migrations` stays 8. Valuation tables (`assumption_sets`, `assumptions`,
  `assumption_changes`, `assumption_evidence`, `snapshots`, `valuation_runs`, `signals`, `trigger_firings`) are left in
  place, never read or written. `journal` stays live (disclosure runs write it).
- Kept CLI: `init`, `asset`, `data`, `report`, `doc`, `proposals`, `inbox`, `persona`, `agent` (disclosure only), `tick`.
  Removed: `model`, `signal`, `update`.
- `tick` never starts an agent run and never writes `signals.jsonl`; `ticks.jsonl` continues.
- `agent run --type` accepts only `disclosure`; `--out <file>` stays accepted and ignored (the watcher passes it).
- `TOOL_LAYER_VERSION` = `2.0.0`.
- `PROVISIONAL_MOVE_PCT` = 25 (fixed; was `review_triggers.provisional_move_pct`, 25 on every asset).
- Only Task 5 may move an asset config hash. Any other task that moves one: stop and report.
- Tests: `npx vitest run --maxWorkers=2`, then `npm run typecheck`; CLI subprocess files that time out are rerun alone
  with `--maxWorkers=1`. Report both runs' real counts.
- Live-install rules apply to the rollout only (section "Rollout"); every task runs in the worktree and scratch homes.

## Review Focus

1. **An asset whose fetch works but whose report cannot be built** (a new asset with no complete day, or a flow that
   stopped): the tick must still emit its report with ingest, watch and inbox filled in, `holder_yield: null`, a
   `report_error`, and exit 2. Pinned in Task 2, test `tick: report unavailable -> exit 2, report still emitted`.
2. **Stored proposals from the valuation era** (VVV #1 and CAKE #4 are pending `assumption_value` proposals with 6m/12m
   effects): `inbox` and `proposals list` must still parse and show them, `proposals reject` must work, and `approve`
   must refuse with `proposal_kind_retired`, not crash. Pinned in Task 3.
3. **Old `agent_runs` rows** of type weekly/triage/deep/bootstrap: `agent runs list` and `agent runs show` must still
   read them. Pinned in Task 3.
4. **A stale asset YAML** still carrying `modules`/`assumptions`/`review_triggers` (an old branch, a hand edit): loading
   must fail loudly naming the key, and approving a config proposal whose edit path starts at a removed key must be
   refused. Pinned in Task 5.
5. **The disclosure watcher's real-run command line** (`agent run <a> --type disclosure --doc <id> --out <home>/signals.jsonl
   --json`): must exit 0 with the same JSON keys the watcher reads (`run`, `staged`, `committed`), and write no file.
   Pinned in Task 3.

## Candidate metrics: resolved by code search

Readers outside the code this phase deletes, at main 34a9f9d:

| Metric | Assets (YAML line) | Readers | Outcome |
|---|---|---|---|
| `dominance_share`, `dominance_share_1y` | aero:98,100 cake:144,146 crv:150,152 hype:143,145 lit:230,232 pump:124,126 sky:148,150 uni:120,122 (DefiLlama `defillama_share`); link:132 (`dominance_share` only, manual, no rows) | none: `grep -rn dominance src` is empty; read only through the analyst's context pack | **remove** (9 assets; 174 stored rows on 2026-10-28, deleted at rollout per roadmap decision 1). The `defillama_share` source type stays until Phase 3 (no source changes here). |
| `revenue_run_rate_usd` | aero:88 cake:118 crv:110 cvxcrv:117 hype:93 link:100 lit:128 pump:96 sdcrv:120 sky:114 uni:95 ycrv:106 (derived `flow_annualized` of a holder flow) | `src/drivers/compute.ts:137`, `src/app/triggers.ts:59-64`, `src/agent/describe.ts:57`, `src/config/schema.ts:265` (required list); `src/ingest/run.ts:503-512` reads it only when `usage_index` is defined, which only `assets/vvv.yaml` does; `src/report/**` never | **remove on the 12**; VVV's (`assets/vvv.yaml:44`, manual disclosures, `reporting.revenue_disclosed` and its disclosed stream) **stays**, as does `STD_METRICS.revenue` for the stale-revenue check. |
| `staker_emission_share` | all 13 (aero:62 cake:74 crv:81 cvxcrv:79 hype:63 link:64 lit:67 pump:60 sdcrv:82 sky:72 uni:58 vvv:80 ycrv:78); on-chain adapters on VVV and AERO (`src/ingest/adapters/vvv.ts:17`, `aero.ts:86`), manual on HYPE, constant 0 elsewhere | `src/drivers/compute.ts:143`, `src/agent/describe.ts:30,63`, `src/config/schema.ts:268` (required list); `src/report/**` never | **decision D1** (recommend keep for Phase 1). |
| `diem_supply`, `diem_target_supply`, `diem_price_usd`, `diem_locked_yield_share` (VVV) | vvv:143,151,161,168 | `src/engine/modules/utilityClaim.ts:36-37,50-59`; `diem_locked_yield_share` also via `total_return_variants` (`src/engine/run.ts:188`, `src/engine/requirements.ts:31`) | **decision D2** (recommend keep). |
| `usage_index` (VVV) | vvv | `src/ingest/run.ts:495,504-512` (raises `revenue_disclosure_stale`) | **stays** (ingest reads it). |
| `flow_tokens.burn` (VVV) | vvv:116 | none today (informational, matches Venice's burn history) | **stays** (not valuation). |
| `price_usd`, `total_supply`, `circulating_supply`, `staked_supply`, `locked_supply`, `emission_rate_annual` | all | `src/report/load.ts:104-109` | **stay**; the first four non-optional ones stay required by the schema. |

## Decisions owed (Mike) before execution

- **D1 `staker_emission_share`.** (a, recommended) keep on all 13 unchanged and drop it from the schema's required list
  only; Phase 2's dilution line for staked holders decides its future. Costs two on-chain reads a day (VVV, AERO), no
  risk. (b) remove from all 13 plus the `vvv.staker_emission_share` and `aero.staker_emission_share` adapters; 252 rows
  left inert.
- **D2 VVV DIEM levels.** (a, recommended) keep the four as display data for the site (DIEM supply vs target, price,
  locked-yield share; all on-chain or CoinGecko reads already paid for). (b) remove them.
- **D3 Stored rows of removed non-DefiLlama metrics** (2,481 `revenue_run_rate_usd` rows on the 12 assets). (a,
  recommended) leave them, unread, and don't carry undeclared metrics into Postgres in Phase 1.5. (b) delete at rollout
  in the same pinned transaction as the dominance rows.
- **D4 One paid disclosure dry run at rollout** on the stored LIT Q3 post (~$1-3, budget-capped) to see the slimmer pack
  behave on a real model. (a, recommended) yes, with your go at that step. (b) no; the first real post after deploy is
  the live check.
- **D5 Pending `assumption_value` proposals #1 (VVV, 2026-10-22) and #4 (CAKE, 2026-10-26).** (a, recommended) reject
  both at rollout with the note "valuation layer removed (Phase 1)". (b) leave them pending; they show in the inbox
  forever and `approve` refuses them.

The plan below is written for D1(a), D2(a), D3(a); the alternative is one extra step in Task 5 or the rollout, noted
where it applies.

## File structure

- Create `src/observations/select.ts`: `latestLevel`, `buildSchedule`, `ScheduleStep`, moved verbatim from
  `src/drivers/select.ts` (the only selectors kept code needs).
- Rewrite `src/app/tick.ts` and `src/app/tickReport.ts` (report schema v2); edit `src/cli/commands/tick.ts`.
- Edit the agent layer in place: `src/agent/{run,context,describe,ledger,guardrails,prompt}.ts`,
  `src/agent/tools/{index,read,write}.ts`; delete `src/agent/tools/think.ts`.
- Delete `src/engine/**`, `src/signals/**`, `src/drivers/**`, `src/app/{valuation,update,deviation,cadence,triggers,
  assumptions}.ts`, `src/db/{assumptions,assumptionChanges,triggerFirings,runs}.ts`,
  `src/cli/commands/{model,signal,update}.ts`, `calibration/`.
- Edit `src/config/{schema,agentPolicy,edit,personas}.ts`, `src/types.ts`, `src/cli/{program,util}.ts`,
  `src/cli/commands/{agent,asset,data}.ts`, `src/app/{proposals,inbox}.ts`, 13 `assets/*.yaml`, `skills/`, `personas/`.
- Docs: `run-daily.sh` header, `docs/ops/hermes-daily-job.md` (new report and the cron prompt text),
  `README.md`, new followups note `docs/superpowers/notes/2026-10-28-orion-phase1-followups.md`.

---

### Task 0: Worktree and old-dist baselines (no commit)

**Files:** none in the repo; scratch only.

- [ ] **Step 1:** Work in a worktree on `feat/coinrevs-core` (`git worktree add $TMPDIR/orion-p1 feat/coinrevs-core`,
  `git rebase main` if main moved since 34a9f9d; the branch is docs-only so far). `ln -s /home/hermes/git/orion/node_modules node_modules`.
- [ ] **Step 2:** Build the old dist in a detached worktree: `git worktree add --detach $TMPDIR/orion-old <branch base>`,
  symlink `node_modules`, `npm run build`. Record its sha.
- [ ] **Step 3:** Snapshot the live DB once, read-only: `sqlite3 /home/hermes/git/orion/orion.db ".backup '$TMPDIR/p1-snap.db'"`,
  `PRAGMA integrity_check` = ok. Every later report comparison copies this file (`cp`), so old and new read the same bytes.
- [ ] **Step 4:** Old home `$TMPDIR/p1-old`: `assets/` from the old worktree, `orion.db` = copy of the snapshot. Pick
  `D` = the earliest of the 13 assets' default report days (`report yield <a> --json | .day` with no `--day`), and
  record it. For each asset: `ORION_HOME=$TMPDIR/p1-old node $TMPDIR/orion-old/dist/cli/index.js report yield <a> --day $D --json > $TMPDIR/p1-base/report/<a>.json`.
  Expected: 13 files, each a JSON object with `"asset":"<a>"`.
- [ ] **Step 5:** Ingest baseline: a second old home with a `.env` copy whose `ORION_HOME=` line is deleted
  (`sed -i '/^ORION_HOME=/d'`), and a fresh snapshot copy. For each asset:
  `ORION_HOME=<home> node $TMPDIR/orion-old/dist/cli/index.js data fetch <a> --dry-run --json > $TMPDIR/p1-base/fetch/<a>.json`.
  Reduce each to the sorted unique `(metricKey)` list of `written` and the sorted `sourceId` list of `sources` (a small
  Python file under `$TMPDIR`), and keep those lists; values and times are not compared (live data moves).
- [ ] **Step 6:** Disclosure baseline: copy `~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/transcripts/lit/<Q3 post id>.run.json`
  to `$TMPDIR/p1-base/` and run the watcher's unit tests once to record the green count:
  `$(ls -d ~/.hermes/tools/python-3.14*/bin/python3) -m unittest discover -s tests` from the watcher dir.

### Task 1: Move the observation selectors out of `src/drivers`

**Files:**
- Create: `src/observations/select.ts`; `tests/observations/select.test.ts`
- Modify: `src/report/load.ts:4`, `src/ingest/describe.ts:5`, `src/ingest/run.ts:9`, `src/app/eligibility.ts:4`,
  `src/engine/supply.ts:3`, `src/drivers/compute.ts` (import from the new module), `tests/ingest/adapters.crv.test.ts:4`
- Modify: `src/drivers/select.ts` (keeps `obsProvenance`, `worstProvenance`, `trailingFlowAnnualized`, `isStale` until Task 4)

**Interfaces:**
- Produces: `latestLevel(obs: Observation[], asOf: string): Observation | undefined`,
  `buildSchedule(obs: Observation[], asOf: string): { steps: ScheduleStep[]; used: Observation[] }`, `interface ScheduleStep`
  from `src/observations/select.ts`, bodies unchanged.

- [ ] **Step 1:** Move the `latestLevel` and `buildSchedule` cases of `tests/drivers/select.test.ts` into
  `tests/observations/select.test.ts` importing from `../../src/observations/select.js`. Run it: FAIL (module missing).
- [ ] **Step 2:** Create `src/observations/select.ts` by moving the three exports verbatim; repoint every import above.
- [ ] **Step 3:** `npx vitest run --maxWorkers=2` and `npm run typecheck`: green, same test count as before plus 0
  (cases moved, not added). No hash pin moves.
- [ ] **Step 4:** Commit: `git add src/observations tests/observations src/drivers/select.ts src/report/load.ts src/ingest/describe.ts src/ingest/run.ts src/app/eligibility.ts src/engine/supply.ts src/drivers/compute.ts tests/drivers/select.test.ts tests/ingest/adapters.crv.test.ts`,
  `git commit -m "refactor: latestLevel and buildSchedule move to src/observations/select.ts (kept code no longer imports src/drivers)"`.

### Task 2: The new tick: lock, ingest, report, inbox; no valuation, no agent

**Files:**
- Modify: `src/app/tick.ts` (rewrite), `src/app/tickReport.ts`, `src/cli/commands/tick.ts`, `run-daily.sh` (header comment
  and exit-code lines only), `docs/ops/hermes-daily-job.md`
- Test: `tests/app/tick.test.ts` (rewrite), `tests/report/tickReport.test.ts`, `tests/app/tickReport.test.ts`,
  `tests/cli/tick.cli.test.ts`

**Interfaces:**
- Consumes: `fetchAsset` (`src/ingest/run.ts`), `loadHolderYieldReport`, `lastCompleteReportDay` (`src/report/load.ts`),
  `buildInbox`, `emptyInbox` (`src/app/inbox.ts`), `withRunLock`, `lockHolder` (`src/app/lock.ts`).
- Produces:
  - `interface TickDeps { home: string; now: () => Date; fetchDeps: FetchDeps; onFetch?: (f: FetchResult) => void; onProgress?: (line: string) => void }` (no `modelClient`, `reload`, `onSignal`).
  - `tickAsset(db: Db, loaded: LoadedAsset, deps: TickDeps): Promise<{ report: TickReport; exitCode: 0 | 1 | 2 }>`.
  - `TickReportSchema` v2 (`schema_version: z.literal(2)`): `tick_id, asset, started_at, ended_at, outcome
    ('completed'|'run_in_progress'|'error'), lock, ingest` (same shape as v1, `watch` optional), `holder_yield:
    TickHolderYield | null`, `report_error: { code, message } | null`, `inbox: InboxSchema`, `error`. Keys `signal`,
    `triggers_fired`, `triggers_recorded`, `triggers_standing`, `agent`, `agent_would_run` are gone (strict schema refuses them).
  - `summarizeHolderYield(r: HolderYieldReport): TickHolderYield` in `src/app/tickReport.ts`, a field-for-field copy:
    `day ← r.day`, `window_days ← r.windowDays`, `price ← r.price`, `market_cap ← r.marketCap`, `fdv ← r.fdv`,
    `revenue_annualized ← r.revenue?.annualized ?? r.income?.revenue.annualized ?? null`,
    `revenue_growth_annualized ← r.revenue?.growth.annualized ?? r.income?.revenue.growth.annualized ?? null`,
    `payout_ratio ← r.income?.payoutRatio ?? null`, `flows ← r.flows.map({ id, bucket, net, yield })`,
    `yields ← { cash, buyback, shareholder, dilution, net_shareholder: r.yields.netShareholder }`,
    `multiple ← r.yields.multiple`, `holder_flow_growth_annualized ← r.holderFlowGrowth.annualized`. No rounding.

- [ ] **Step 1: Write the failing tests** in `tests/app/tick.test.ts` (fake fetch deps from `tests/helpers/fetchHarness.ts`):
  - `tick: fetch ok -> exit 0, holder_yield equals summarizeHolderYield(loadHolderYieldReport(db, asset))`
  - `tick: ingest throws -> exit 1, error.code set, holder_yield null`
  - `tick: report unavailable -> exit 2, report still emitted` (no complete day stored: `ingest` non-null, `inbox` built,
    `holder_yield` null, `report_error.code === 'report_unavailable'`)
  - `tick: lock held -> outcome run_in_progress, exit 0, lock.holder set`
  - `tick: an open anomaly starts nothing` (`select count(*) from agent_runs` is 0 after; the anomaly is in `inbox.anomalies`)
  - `tick report v2 refuses a signal key` in `tests/report/tickReport.test.ts`: `TickReportSchema.parse({...valid, signal: null})` throws.
  - In `tests/cli/tick.cli.test.ts`: after `tick <a>`, `signals.jsonl` does not exist and `ticks.jsonl` has one line with `schema_version: 2`.
- [ ] **Step 2:** Run them: FAIL.
- [ ] **Step 3:** Implement. Inside the lock: `fetchAsset(db, loaded, started, deps.fetchDeps, { onProgress })`, fill
  `ingest` as today (`src/app/tick.ts:84-92`); then `loadHolderYieldReport(db, asset)` inside a try: a throw sets
  `report_error = { code: 'report_unavailable', message: <capped 300> }`. After the lock, `inbox = buildInbox(...)` as
  today. Exit: `ingest === null` → 1; `holder_yield === null` and outcome completed → 2; else 0;
  `run_in_progress` → 0. An asset without a `reporting` block gives `holder_yield: null`, `report_error: null`, exit 0
  (every live asset has one). CLI: drop `--no-agent`, `onSignal`, `SIGNALS_FILE`; description names the new exit codes.
- [ ] **Step 4:** Suite and typecheck green (valuation code still exists, now unused by tick). No hash moves.
- [ ] **Step 5:** Update `run-daily.sh` header (exit codes; no signals file) and `docs/ops/hermes-daily-job.md`: the v2
  report fields and the cron prompt text for the rollout, which prints in this order: (1) `ORION WATCH <SYM>: ...` lines
  from `ingest.watch`; (2) failed sources from `ingest.sources_failed`; (3) open anomalies from `inbox.anomalies`, then
  pending proposals and provisional observations from `inbox` (the DECISIONS block the watcher points to); (4) a short
  holder-yield block from `holder_yield` (price, market cap, revenue, payout ratio, yields, multiple, growth), or the
  `report_error`; no target, grade or signal lines. `orion-tick.sh` keeps both retries (exit 1, and `run_in_progress`,
  which a disclosure run's lock can still cause).
- [ ] **Step 6:** Commit (explicit paths), message: `feat(tick): tick = lock, ingest, holder-yield report, inbox; no valuation, no agent run, no signals.jsonl; tick report v2; exit 0/1/2 = ok / nothing fetched / report unavailable`.

### Task 3: The agent layer serves the disclosure run only

**Files:**
- Modify: `src/types.ts` (add `RUNNABLE_RUN_TYPES = ['disclosure'] as const`; keep `RUN_TYPES` as the stored enum for
  old `agent_runs` rows), `src/agent/run.ts`, `src/agent/context.ts`, `src/agent/describe.ts`, `src/agent/ledger.ts`,
  `src/agent/guardrails.ts`, `src/agent/prompt.ts`, `src/agent/tools/{index,read,write}.ts`, `src/app/proposals.ts`,
  `src/cli/commands/agent.ts`, `src/config/personas.ts` (skill `run_types` validated against `RUNNABLE_RUN_TYPES`),
  `src/config/agentPolicy.ts` (`DEFAULT_BUDGETS` keyed by runnable type only; `budgetsFor` unchanged otherwise)
- Delete: `src/agent/tools/think.ts`; `skills/{anomaly-triage,assumption-review,bootstrap-research,tokenomics-audit}.md`
- Modify text: `skills/disclosure-research.md` (frontmatter `run_types: [disclosure]`; drop references to assumptions,
  bands and other run types), `skills/disclosure-review.md` (line 14: a proposal cites the document; no `run_whatif`
  effect), `personas/*.md` (drop sentences about assumptions, targets and bands; frontmatter unchanged)
- Test: `tests/agent/{run,context,tools,ledger,guardrails,loop,concurrency,disclosure.e2e}.test.ts`,
  `tests/helpers/agentWorld.ts`, `tests/cli/agent.cli.test.ts`, `tests/app/proposals.test.ts`, `tests/app/inbox.test.ts`,
  `tests/config/personas.test.ts`, `tests/assets/vvv.agent.test.ts` (delete: it exercises weekly runs)

**Interfaces:**
- Produces: `RunAgentResult = { run, staged, committed }` (no `signal`); `toolsForRun(tools, runType: 'disclosure')`
  returns exactly `get_observations, get_anomalies, get_journal, get_flow_total, resolve_anomaly,
  record_provisional_observation, propose_change, write_journal, record_dev_finding` in `AGENT_TOOLS` order;
  `CommitSummary` without `setVersion`; `ProposalEffect` type kept for stored rows, new proposals store `effect: null`;
  `approveProposal` on `assumption_value` throws `OrionError('proposal_kind_retired', ...)`; `TOOL_LAYER_VERSION = '2.0.0'`.
- Context pack keys for a disclosure run, in order: `asset, run` (no `assumption_set_version`), `trigger` (`anomaly`,
  `unverified_note` only), `revenue_streams?`, `observations_in_force, anomalies, proposals, journal, catalysts_due,
  source_failures, document, asset_config_yaml, adapter_params`.

- [ ] **Step 1: Write the failing tests:**
  - `run: a disclosure run needs no assumption set` (world with no set: completes, no `no_assumption_set`).
  - `cli: --type weekly is refused with invalid_run_type`, and the message lists only `disclosure`.
  - `tools: a disclosure run is offered exactly the nine tools` (exact array above).
  - `context: the disclosure pack has exactly these keys` (exact array above).
  - `propose_change: a config proposal stores effect null`; `propose_change: kind assumption_value is invalid input`.
  - `proposals: approving a stored assumption_value proposal throws proposal_kind_retired; rejecting it works`
    (Review Focus 2), and `inbox: a stored proposal with a 6m/12m effect still parses`.
  - `agent runs: list and show read a stored weekly run` (Review Focus 3; insert the row directly).
  - `cli: agent run --out <file> is accepted, writes no file, JSON keys are run, staged, committed` (Review Focus 5).
  - In `disclosure.e2e.test.ts`: drop the `model assumptions import` calls (lines 212, 349); keep `VALUATION_LEVELS`
    as is in this task (Task 5 removes the `revenue_run_rate_usd` row with the metric); the proposal-effect test
    (line 267) asserts `prop.effect === null`; `Object.keys(result)` is `['run','staged','committed']`; the table counts
    drop `assumption_sets`.
- [ ] **Step 2:** Run them: FAIL.
- [ ] **Step 3:** Implement. `runAgent` drops the `startSet` requirement, `runValuation`, `movesSignal` and `signal`;
  `opts.runType` typed `'disclosure'`; triage-only checks (`--anomaly` target, `triage_needs_target`) go, `--anomaly`
  and `--note` stay as pack context. The ledger drops staged assumption changes and `saveAssumptions`. `guardrails.ts`
  drops band and step checks (`agentBand`, `keyBounds`, `maxStepFraction` callers). `describe.ts` keeps
  `describeAnomaly`, `describeProposal`, `structuralNotes` only if still used; delete the rest.
- [ ] **Step 4:** Regenerate the run fixture: `UPDATE_FIXTURES=1 npx vitest run tests/agent/disclosure.e2e.test.ts`, then
  `git diff tests/fixtures/disclosure/lit-q3-run.json`: the only changes allowed are the removed `signal` key, the
  proposal `effect` becoming `null`, `committed`/`staged` keys tied to assumption changes, and the offered tool names in
  the transcript; the proposals' `change`, `citations`, the dev findings and their fingerprints must be unchanged.
  Paste the diff summary in the task report. The watcher keeps its own older copy of this fixture
  (`disclosure-watcher/tests/fixtures/lit-q3-run.json`); it reads only `run`, `staged`, `committed`, so it stays valid.
- [ ] **Step 5:** Suite and typecheck green. No asset hash moves (persona and skill hashes feed only the run's
  `configHash`, which the e2e normalizes).
- [ ] **Step 6:** Commit, message: `feat(agent): disclosure is the only run type; no assumption set needed; valuation tools, drivers and signal history leave the pack and tool list; proposal effect null; tool layer 2.0.0; four run-type-only skills deleted`.

### Task 4: Delete the valuation code and its commands

**Files:**
- Delete: `src/engine/`, `src/signals/`, `src/drivers/`, `src/app/{valuation,update,deviation,cadence,triggers,assumptions}.ts`,
  `src/db/{assumptions,assumptionChanges,triggerFirings,runs}.ts`, `src/cli/commands/{model,signal,update}.ts`,
  `calibration/`
- Delete tests: `tests/engine/`, `tests/signals/`, `tests/drivers/`, `tests/app/{valuation,update,deviation,cadence,triggers,assumptions}.test.ts`,
  `tests/db/{assumptions,triggerFirings}.test.ts`, `tests/assets/{vvv.golden,vvv}.test.ts`,
  `tests/fixtures/{vvv-golden.yaml,vvv-golden-assumptions.yaml,contrast.ts}` and any fixture only these used
- Modify: `src/cli/program.ts` (unregister; description "Token revenue, holder-flow and supply data with provenance"),
  `src/cli/util.ts` (drop `signalSummary`, `Signal`), `src/cli/commands/asset.ts` (`validate`/`show` drop module,
  scenario and supply-basis lines and `validateAssetModules`), `src/cli/commands/data.ts:164` (ack text: "no longer
  listed in the daily report" instead of "affects the signal"), `src/config/agentPolicy.ts` (delete `keyBounds`,
  `agentBand`, `maxStepFraction`, `provisionalMovePct`, `driverDeviationPct`, `calendarEvents`, `cadenceFor`,
  `DEFAULT_CADENCE`, `DEFAULT_MAX_STEP_FRACTION`, `DEFAULT_DRIVER_DEVIATION_PCT`; add `export const PROVISIONAL_MOVE_PCT = 25`
  and point `src/agent/tools/write.ts` at it), `src/app/proposals.ts` (drop `validateAssetModules`/`validateAssumptions`
  from `approveConfig`, `src/app/proposals.ts:193-195`), `tests/cli/cli.test.ts`, `tests/db/agentStores.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/cli/cli.test.ts`: `cli: model, signal and update are unknown commands`
  (each exits non-zero with commander's unknown-command error).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Delete and edit as listed; `grep -rnE "engine/|signals/|drivers/|app/(valuation|update|deviation|cadence|triggers|assumptions)|db/(assumptions|assumptionChanges|triggerFirings|runs)" src tests` returns nothing.
- [ ] **Step 4:** Suite and typecheck green; report the new file and test counts (they drop by the deleted files). No
  asset hash moves (`git grep` the 13 pinned hashes: unchanged).
- [ ] **Step 5:** Re-run the Task 0 report comparison on this commit (build, copy the snapshot, 13 × `cmp`): identical.
- [ ] **Step 6:** Commit, message: `feat!: remove the valuation layer: engine, drivers, signals, assumption sets, triggers, cadence; model, signal and update commands; calibration/`.

### Task 5: Config keys and valuation-only metrics leave the schema and the 13 YAMLs

**Files:**
- Modify: `src/config/schema.ts` (drop `modules`, `scenario_probabilities`, `assumptions`, `review_triggers`, `peer_set`,
  `total_return_variants`, `supply_basis`, `ModuleInstanceSchema`, `BoundSchema`, `ProbabilitiesSchema`,
  `ReviewTriggersSchema`, `CalendarEventSchema`, `revenueStaleMovePct` keeps its default 30 as a constant; agent block =
  `{ budgets: { disclosure } }` only; required standard metrics = `price_usd`, `total_supply`, `staked_supply`,
  `emission_rate_annual`; the monitor-only rule "used by the valuation" becomes "standard metric or holder-flow metric"),
  `src/config/edit.ts:40-42` (drop the `assumptions` and `review_triggers` rules), `src/ingest/run.ts:510` (constant 30),
  `src/types.ts` (`STD_METRICS` keeps `revenue` and `usageIndex` for the stale-revenue check; `stakerEmissionShare`
  stays under D1(a)), 13 `assets/*.yaml`
- YAML edits per asset: delete the removed top-level keys and the comment blocks that only explain them (calibration
  notes, band rationale); delete `agent.budgets.{weekly,triage,deep,bootstrap}`; delete `dominance_share` and
  `dominance_share_1y` (9 assets, lines in the table above) and `revenue_run_rate_usd` (12 assets, not VVV).
  Under D1(b) also `staker_emission_share` on 13 and the two adapters; under D2(b) the four DIEM metrics.
- Test: `tests/config/load.test.ts`, `tests/config/edit.test.ts`, `tests/assets/*.ingest.test.ts` (11 files),
  `tests/agent/disclosure.e2e.test.ts` (`LIT_HASH`, `preApprovalLitYaml`, and the `revenue_run_rate_usd` row of
  `VALUATION_LEVELS` with the observation count at line 319; also `staker_emission_share` under D1(b)),
  `tests/ingest/run.test.ts`, `tests/helpers/assets.ts`

**Hash re-pins (this task only):** every asset's config hash moves. Procedure per asset: record the old hash, build,
compute the new one (`parseAssetYaml(...).hash`), `grep -rl <old> tests` and replace. Expected files: the 11 asset
ingest tests that pin a hash today (aero, cake, crv, hype, link, lit, lockers [cvxcrv and sdcrv], pump, sky, uni, ycrv),
`tests/config/load.test.ts`, `tests/agent/disclosure.e2e.test.ts`. VVV's only pin was in `tests/assets/vvv.golden.test.ts`
(deleted in Task 4): add a hash pin for `assets/vvv.yaml` to `tests/assets/vvv.ingest.test.ts`, as the other assets have.
Any other file holding an old hash: stop and report.

- [ ] **Step 1: Write the failing tests:**
  - `schema: each removed key is refused by name` (for `modules`, `assumptions`, `scenario_probabilities`,
    `review_triggers`, `peer_set`, `total_return_variants`, `supply_basis`, `agent.cadence`, `agent.max_step_fraction`,
    `agent.budgets.weekly`: `parseAssetYaml` throws and the message contains the key) (Review Focus 4).
  - `schema: an asset without revenue_run_rate_usd loads`; `schema: an asset without price_usd is refused`.
  - `proposals: approving a config proposal that edits assumptions is refused (invalid_asset_config)` (Review Focus 4).
  - Each asset ingest test: the expected metric list loses the removed metrics (fails until the YAML changes).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Edit schema, edit.ts, ingest constant and the 13 YAMLs; re-pin hashes as above.
- [ ] **Step 4:** `asset validate <a>` for all 13 with the built CLI in a scratch home: all valid.
- [ ] **Step 5:** Suite and typecheck green.
- [ ] **Step 6: Proof 2 (reports unchanged).** New home `$TMPDIR/p1-new` with the new `assets/` and a fresh copy of the
  Task 0 snapshot; `report yield <a> --day $D --json` with the new dist for all 13; `cmp` against `$TMPDIR/p1-base/report/<a>.json`.
  Expected: 13 identical. Any difference: stop and report the asset and the first differing key.
- [ ] **Step 7: Proof 3 (ingest unchanged).** New dist `data fetch <a> --dry-run --json` on a scratch home with the
  `.env` copy (no `ORION_HOME=` line) and a snapshot copy; reduce as in Task 0 Step 5. Expected per asset: the
  `written` metric list equals the baseline minus exactly the removed metrics of that asset (table above), and the
  `sources` list minus only the sources that fed nothing else (`defillama_share:*` entries; `derived:*` for the run
  rate). Report the per-asset set differences.
- [ ] **Step 8:** Commit, message: `feat!(config): valuation keys and valuation-only metrics leave the schema and all 13 assets (dominance x9, revenue_run_rate_usd x12); hashes re-pinned; report yield byte-identical x13`.

### Task 6: Docs, followups, final branch proof

**Files:**
- Modify: `README.md` (what Orion is now; command list), `docs/ops/hermes-daily-job.md` (final), `docs/ops/disclosure-watcher.md`
  (no assumption set needed; `--out` ignored; the watcher still calls `inbox`)
- Create: `docs/superpowers/notes/2026-10-28-orion-phase1-followups.md`: proof results (per asset), the decisions D1-D5
  as Mike ruled them, measured figures (dominance rows, pending proposals), and the open items: watcher cleanup (stop
  passing `--out`, drop the "catalysts" line if Phase 2 drops the journal), per-metric fields left unread
  (`staleness_days`, `capture_rule`, `valued_per`), `defillama_share` source for Phase 3, persona simplification for
  Phase 2, and the SDD ledger's deferred minors and rulings.

- [ ] **Step 1: Proof 4 (disclosure, free).** `tests/agent/disclosure.e2e.test.ts` green on the branch; the watcher's
  unit tests green with the same count as Task 0 Step 6; and a replay with no model call: a scratch Python file imports
  `bin/disclosure_watch.py` and calls `post_run(run_json, inbox_json, run_show_json, cfg, <scratch queue file>, post_meta)`
  twice: once with the old fixture (`git show <branch base>:tests/fixtures/disclosure/lit-q3-run.json`, old shape with
  `signal`) and once with the regenerated fixture (new shape); both come from the same scripted model. Expected: the same
  `proposals:`, `dev findings` and `catalysts:` lines, apart from the proposals' effect text (the new
  one, where `_effect_text` prints `no target effect`). Also feed it the stored real Q3 `run.json`
  (`transcripts/lit/2113065839352336774.run.json`) to show an old-shape run still renders.
- [ ] **Step 2: Proof 5 (scratch ticks).** For each asset, new dist `tick <a>` in a scratch home (snapshot copy + `.env`
  copy without `ORION_HOME=`). Expected: exit 0, a v2 line in `ticks.jsonl`, `holder_yield` non-null,
  `select count(*) from agent_runs` unchanged, no `signals.jsonl` change. Report per asset: exit, `ingest.outcome`, failed sources.
- [ ] **Step 3:** Full suite and typecheck on the final commit; CLI files alone if they time out. Report both counts.
- [ ] **Step 4:** Delete scratch homes with `python3 -c "import shutil; shutil.rmtree('<dir>')"` (they hold `.env` copies).
- [ ] **Step 5:** Commit docs; stop. Merge is Mike's go.

## Rollout (interactive with Mike; live-install rules)

1. Check nothing is mid-run (`pgrep -af 'dist/cli/index.js|run-daily' | grep -v pgrep | grep -v tirith`) and the next
   cron tick (05:05 PT); start well clear of 05:05-06:05 PT and the 09:40 PT watcher.
2. Tag the last valuation commit `orion-valuation-final` (current `main`) and push the tag over HTTPS.
3. Back up `orion.db` (`.backup 'backups/orion.db.pre-phase1-<UTCstamp>'`), `integrity_check`, row counts
   (observations, proposals, anomalies, agent_runs, journal), `chmod 600`.
4. Old-dist baseline on live (read-only): `report yield <a> --day <D> --json` for 13 assets.
5. `git merge --ff-only feat/coinrevs-core`, `npm run build`, `asset validate` all 13; first read command
   (`data anomalies --all`), `select max(id) from schema_migrations` = 8.
6. Re-run step 4 with the new dist; `cmp` x13: identical.
7. D5: `proposals reject 1 --note "valuation layer removed (Phase 1)"`, same for 4.
8. One pinned transaction: count `observations` where `metric_key in ('dominance_share','dominance_share_1y') and
   asset_id in ('aero','cake','crv','hype','lit','pump','sky','uni')`, `DELETE` with the same predicate, assert
   `changes()` equals the count (174 on 2026-10-28, plus one per asset per day since; AERO stopped on 2026-10-19).
   Under D3(b) the same for `revenue_run_rate_usd` on the 12 assets.
9. Update the 13 `orion-<asset>` cron prompts together (cron-job-administration skill) to the text in
   `docs/ops/hermes-daily-job.md`; fire one asset's job by hand and confirm the Slack layout and `ingest.outcome: ok`.
10. D4 (with Mike's go): one paid disclosure dry run on the stored LIT Q3 post via the watcher's `--dry-run` path.
11. Watch the next morning's 13 runs; push `main` (HTTPS) and report the remote sha.

## Self-review notes

- Spec coverage: what goes (Tasks 3-5), what stays (corrections 1-3 honoured in Tasks 2-3), new tick (Task 2), cron and
  Slack (Task 2 Step 5, rollout 9), proofs 1-5 (Tasks 4-6), rollout (section above).
- Type names used across tasks: `TickDeps`, `TickReport` v2, `summarizeHolderYield`, `RUNNABLE_RUN_TYPES`,
  `PROVISIONAL_MOVE_PCT`, `RunAgentResult` without `signal`, `src/observations/select.ts`.
