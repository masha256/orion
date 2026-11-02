# Orion Phase 1 (remove the valuation layer): followups (2026-10-28)

Spec `docs/superpowers/specs/2026-10-28-orion-phase1-remove-valuation-design.md`, plan
`docs/superpowers/plans/2026-10-28-orion-phase1-remove-valuation.md`, umbrella
`docs/superpowers/specs/2026-10-28-orion-coinrevs-core-roadmap.md`. Branch `feat/coinrevs-core`, built in a worktree by
subagents (one task at a time, each reviewed), not merged, not pushed. Merge and rollout are Mike's go.

Commits (on main 34a9f9d, which has not moved):

| Commit | Task |
|---|---|
| 67e18c7 | 1: `latestLevel` / `buildSchedule` move to `src/observations/select.ts` |
| 3f6cf77, ebe7bba | 2: tick = lock, ingest, holder-yield report, inbox; tick report v2; `report_stale` fix (R8) |
| 009442b | 3: the agent layer serves the disclosure run only (tool layer 2.0.0) |
| 078d7fe | 4: the valuation layer removed (engine, drivers, signals, assumption sets, triggers, cadence; `model`, `signal`, `update`; `calibration/`); `proposals` top level |
| 38f4f92 | 5: valuation keys and valuation-only metrics leave the schema and all 13 assets; hashes re-pinned |
| (this commit) | 6: README, ops docs, this note; stale valuation comments swept (comments only, no hash moved) |

## Decisions (Mike, 2026-10-28, Slack #orion-dev): D1-D5 all (a)

- **D1 `staker_emission_share`: (a) kept** on all 13 unchanged; only dropped from the schema's required list. Phase 2's
  dilution line for staked holders decides its future.
- **D2 VVV DIEM levels: (a) kept** as display data (`diem_supply`, `diem_target_supply`, `diem_price_usd`,
  `diem_locked_yield_share`).
- **D3 stored rows of removed non-DefiLlama metrics: (a) left in place**, unread (2,481 `revenue_run_rate_usd` rows on the
  12 non-VVV assets in the live DB on 2026-10-28), and not carried into Postgres in Phase 1.5.
- **D4 one paid disclosure dry run at rollout: (a) yes**, on the stored LIT Q3 post via the watcher's `--dry-run` path,
  with Mike's go at that step (~$1-3, budget-capped).
- **D5 pending `assumption_value` proposals #1 (VVV) and #4 (CAKE): (a) reject both at rollout** with the note
  "valuation layer removed (Phase 1)". #2 (VVV `confirm_observation`) stays pending: it is not a valuation proposal.

Spec answers (same thread): the Slack report keeps watch alerts, failed sources, open anomalies, a short holder-yield
block, in that order; anomalies are handled by hand (no paid triage run; the `open_anomaly` trigger path is gone); the
persona / coverage machinery stays for now (the disclosure run needs it), simplification revisited in Phase 2.

## Measured figures (live DB, read-only, 2026-10-28)

- `dominance_share` / `dominance_share_1y`: **174 rows on 8 assets** (aero, cake, crv, hype, lit, pump, sky, uni; AERO's
  stopped on 2026-10-19 when DefiLlama failed). LINK's manual `dominance_share` had no rows. Deleted at rollout step 8,
  in one pinned transaction (the count grows by one per asset per day until then).
- `revenue_run_rate_usd`: **2,481 rows on the 12 non-VVV assets**, left in place (D3a). VVV's stays a live metric (its
  cited disclosures).
- Pending proposals: **#1 VVV `assumption_value`**, **#2 VVV `confirm_observation`** (stays), **#4 CAKE
  `assumption_value`**. `approve` of #1 / #4 is refused `proposal_kind_retired`; `reject` works (Review Focus 2, pinned in
  Task 3).

## Proofs

Baselines (Task 0, controller): a verified `.backup` snapshot of the live DB (integrity ok, `schema_migrations` max 8),
the old dist at 34a9f9d, report day D = 2026-10-30 (the earliest default report day: LIT's).

### Proof 1: suite and typecheck (final commit)

See "Final suite" below.

### Proof 2: reports unchanged, 13/13 byte-identical

`report yield <a> --day 2026-10-30 --json`, old dist (34a9f9d) vs new dist, each on its own copy of the snapshot, `cmp`
per asset: **13/13 identical** (aero, cake, crv, cvxcrv, hype, link, lit, pump, sdcrv, sky, uni, vvv, ycrv). Verified by
the implementers in Tasks 4 and 5, and independently by the controller on 078d7fe and on 38f4f92.

### Proof 3: ingest unchanged but for the removed metrics, 13/13 OK

Controller (R11), new dist `data fetch <a> --dry-run --json` x13 vs the old 34a9f9d baseline, reduced to written metric
keys and `sourceId:status`:

- Written metrics differ only by the removed ones: `dominance_share` / `dominance_share_1y` on cake, crv, hype, lit,
  pump, sky, uni (aero's baseline already lacked them: DefiLlama failed that run, R6), and `revenue_run_rate_usd` on the
  12 non-VVV assets. VVV unchanged. No metric added.
- Sources lost: only `defillama_share:*`, and `derived:flow_annualized` where it fed only the run rate.
- 0 failed sources on the new run.

### Proof 4: disclosure path still renders, no model call (Task 6)

1. `tests/agent/disclosure.e2e.test.ts` on the branch: **11/11 passed** (scripted model).
2. Watcher unit tests (`<tools python> -m unittest discover -s tests` in the watcher dir, unchanged code): **110 tests, 1
   failure**, the pre-existing `test_discovery.TestScan.test_new_recording_is_queued_and_marks_the_window`
   (`'irrelevant' != 'queued'`), which fails on unchanged code (R5). Same count and same failure as the Task 0 baseline.
3. `post_run` replay: a scratch script imported the live `bin/disclosure_watch.py` (bytecode writes off) and called
   `post_run(run_json, inbox_json, run_show_json, cfg, <scratch queue>, post_meta)` with minimal inputs (`cfg = {orion_asset:
   lit}`, `run_show_json = {estimated_cost_usd: 1.0}` as a stub, the Q3 post's meta). A sha256 of every file in the
   watcher dir before and after: unchanged (28 files); it wrote only the scratch queue files.

| Input | `proposals:` | `dev findings` | `catalysts:` |
|---|---|---|---|
| old fixture (`git show 34a9f9d:tests/fixtures/disclosure/lit-q3-run.json`, with `signal`) | `config (12m target 0.35 -> 0.35) \| dry run: nothing filed` | 2: `[holder_flow] Q3 buys miss the Robinhood instance \| [revenue] DefiLlama's revenue overstates Lighter's Q3` | 3: CFTC DCM/DCO 2026-11-01..2027-05-29; vanilla options by 2026-12-31; Lighter EVM mainnet by 2026-12-31 |
| new fixture (branch) | `config (no target effect) \| dry run: nothing filed` | same 2 | same 3 |
| real stored Q3 run (`2113065839352336774.run.json`, old shape, committed proposal #3), inbox effect as stored then | `#3 config (12m target 0.39 -> 0.39) \| decide from the next orion-lit DECISIONS block` | 3: revenue (DefiLlama +16%), holder_flow (buys = core only), supply (109.8M staked vs constant 0) | 6 |
| same real run, inbox effect null (what today's inbox returns) | `#3 config (no target effect) \| ...` | same 3 | same 6 |

- Old vs new fixture: the digest differs only in the proposal's effect text, as the plan expects; the dev-findings and
  catalysts lines are identical, and the two scratch queue files are byte-identical (`cmp`). The fixtures' `devFindings`
  and `journal` are identical JSON.
- The old-shape real run (with `signal`, `committed`) still renders; with a null effect it prints `no target effect`.

### Proof 5 (controller)

_Placeholder: run by the controller (R13; needs a `.env` copy and network). Per asset: exit, `ingest.outcome`, failed
sources, `holder_yield` non-null, `agent_runs` count unchanged, no `signals.jsonl` change._

## Final suite (Task 6, on the final commit)

- `npx vitest run --maxWorkers=2`: **76 files / 903 tests passed** (run twice in Task 6, the second after every doc
  edit; no CLI-subprocess timeouts, so no `--maxWorkers=1` rerun was needed). Phase 1 baseline at cc714b4 was 100 files /
  1170 tests; the drop is the deleted valuation code's tests (Tasks 3-5).
- `npm run typecheck`: exit 0.
- After the comment sweep, `tests/assets/*` + `tests/config/load.test.ts`: 13 files / 85 tests passed with no test file
  changed, so every asset and MINI hash pin held (comments do not enter the parsed-config hash, `src/config/load.ts:35`).

## Rulings made during execution (from the SDD ledger, with their cost if wrong)

- **R1** Worktree path is `$TMPDIR/orion-wt-phase1`, not the plan's `$TMPDIR/orion-p1`. Cosmetic. Cost: nothing.
- **R2** Tasks 3-4 kept the config schema accepting `agent.budgets.{weekly,triage,deep,bootstrap}` and the other
  valuation keys (`budgetsFor` ignores non-disclosure types); only Task 5 narrowed the schema, since otherwise T3/T4 would
  have moved or broken all 13 asset loads before the one hash-moving task. Cost if wrong: T5 does slightly more work.
- **R3** If a persona's frontmatter referenced a skill deleted in T3, T3 removes just that reference (the only frontmatter
  edit allowed); persona/skill hashes feed only an agent run's configHash, not asset hashes. Cost if wrong: a persona loses
  a skill it should have kept (none of the four deleted skills served disclosure runs).
- **R4** The cron prompt text in `docs/ops/hermes-daily-job.md` is the interim bridge Mike asked for (2026-10-28): the
  minimum formatting of the v2 report in the plan's order; no new scripts, no per-asset redesign; Phase 1.5 replaces the 13
  jobs. Cost if wrong: a slightly plainer Slack report until 1.5.
- **R5** Proof 4's watcher check = the same 110 tests with exactly the same single pre-existing failure
  (`test_new_recording_is_queued_and_marks_the_window`), which fails on unchanged code. Cost if wrong: a real watcher
  regression could hide behind it (mitigated: the failure is in discovery/state, not `post_run`).
- **R6** Proof 3 compares AERO with failed-source metrics excluded on both sides (its baseline's `defillama_share` 30d and
  1y failed at DefiLlama; dominance is removed anyway). Cost if wrong: one re-run.
- **R7** `proposals` was registered under `model` (src/cli/commands/model.ts:151 -> proposals.ts:78) while the plan removes
  `model` and lists `proposals` as kept top-level. Task 4 re-registered it at top level (`orion proposals
  list|show|approve|reject`, same behaviour) and removed `model` entirely (no alias); docs and the rollout's cron prompts
  use `proposals ...`. Cost if wrong: a hand-typed `model proposals` fails loudly (unknown command), nothing silent.
- **R8** A stopped report flow is handled by a staleness check: `report_stale` when (tick UTC date - `holder_yield.day`) >
  `REPORT_STALE_DAYS` = 4 (measured normal lag 2 days, LIT 3); `holder_yield` kept, exit 2, ALERT, no retry, so "silence
  means broken" holds. Cost if wrong: a false ALERT if a source's normal lag grows past 4 (raise the constant), or a
  missed alert for 1-2 days of stall (caught by the failed-sources lines anyway).
- **R9** `run.summary.signal_id` and `valuation_error` leaving the regenerated fixture count as part of the removed
  `signal` key (both describe the valuation's signal); the live watcher reads neither. Cost if wrong: old consumers see a
  missing key instead of null (none known).
- **R10** `docs/valuation_models/VVV.md` kept as history with a top note (valuation layer removed in Phase 1; the
  commands no longer exist): it is the record of the VVV model Mike may revive as a separate project. Cost if wrong: one
  stale doc file. Done in Task 6.
- **R11** Task 5's Proof 3 (live dry-run fetch diff) was run by the controller after the commit, not the implementer: it
  needs a `.env` copy and network, which subagents should not hold. Cost: none (same proof, different runner).
- **R12** Task 5 review M3 parked: approving a stored no-op proposal at a removed root marks it approved. Filing refuses
  such a proposal (`no_change` / `invalid_asset_config`), the YAML is untouched, and it is reachable only via a hand-edited
  DB row. Cost if wrong: a meaningless row marked approved.
- **R13** Task 6's Proof 5 (scratch ticks with a live fetch) is run by the controller (needs `.env` + network), like R11.
  Cost: none.

## Deferred minors and review findings not fixed

- Task 1: the plan's T1 file list omitted `src/app/valuation.ts` and `tests/signals/build.test.ts` (both repointed in T1,
  both deleted in T4). Plan defect only.
- Task 2 (review of 67e18c7..3f6cf77):
  - M1: any `report yield` throw becomes `report_unavailable`, bugs included (a code bug would read as a data condition).
  - M2: `TickDeps.home` is unused (brief-mandated).
  - M3: `tests/app/tickReport.test.ts` fixtures use `as unknown as`.
  - M4: the `emitTickReport` test in `tests/app/tickReport.test.ts` writes a file named `signals.jsonl` (cosmetic).
  - M5: weak RED for the "refuses every other key" test. Accepted.
  - M6: rollout item (below): the live `orion-tick.sh` header comments are stale.
- Task 3: M3 `RUN_TOOLS` duplicates `AGENT_TOOLS` (accepted). M1 (model-facing "signal" wording), M2 (lost VVV pins) and
  M4 (`lastCompletedRun`) were fixed in Tasks 4 and 5.
- Task 4 minors (stale `eligibility.ts` comments, dead types, dead `agentPolicy.test` keys, `movePct` alias) were fixed in
  Task 5.
- Task 5: M1 (stale YAML comments) and M2 (`src/ingest/run.ts` comment) fixed in Task 6; M3 parked (R12). Task 5's own
  notes: `sourceIssues`'s "http_json cannot be the primary of a required metric" now covers 4 metrics instead of 6 (no
  asset uses http_json as primary for the two dropped); `src/types.ts` keeps `SCENARIOS` / `Scenario` (the stored
  `assumption_value` kind types its scenario); the `defillama_share` source type stays with no asset using it.
- Plan file-list gaps: T1 (above); T5 named `tests/ingest/run.test.ts`, which needed no change (over-broad), and omitted
  test files it had to touch (`tests/helpers/ingestAsset.ts`, `tests/helpers/agentWorld.ts`, `tests/helpers/llamaOverview.ts`
  deleted, `tests/report/holderYield.test.ts`, `tests/config/{edit,sources,agentPolicy}.test.ts`, `tests/agent/tools.test.ts`,
  `tests/app/proposals.test.ts`, `tests/cli/agent.cli.test.ts`, `tests/fixtures/{aero,hype}.yaml`).
- Stale text found in Task 6 and left (code or out of the sweep's list; no behaviour wrong):
  - `orion tick --help` and the `run-daily.sh` header say exit 2 is "the report could not be built" and omit
    `report_stale`.
  - `orion report yield --help` says "90d-over-90d growth" (every asset's window is 91 days).
  - YAML comments that still name the valuation, signal, grade or a bootstrap run where they annotate kept metrics
    (Task 5 note 1; line numbers after the Task 6 sweep): the "a bootstrap run finds nothing to research" headers
    (aero:19, cake:36, crv:26, lit:25, pump:21, uni:20), crv:108, hype:24/62/95/118/134/140, lit:115/173,
    vvv:39/42/90/133. The "never a driver" / "no driver, no grade, no signal" notes on report-only metrics are still
    true and can stay or be shortened.
  - The watcher's dev-queue entry prints "a fix moves targets: <value_direction>"; Orion's `record_dev_finding` still
    takes `value_direction` (`src/agent/tools/write.ts:440`, `src/agent/ledger.ts:66`). Phase 2 or the watcher cleanup.

## Open items

- **Phase 1.5** replaces the 13 per-asset `orion-<asset>` cron jobs with one Orion daemon that posts to Slack itself. The
  rollout's prompt edit is interim only (Mike, 2026-10-28; R4).
- **Rollout items** (interactive, live-install rules; plan section "Rollout"):
  - Update the live `~/.hermes/profiles/raymond/scripts/orion-tick.sh` header comments (still "exit 1 (no signal)",
    "exit 2 (blocked)"; behaviour correct). Task 2 M6.
  - Rollout step 9: use the cron prompt text in `docs/ops/hermes-daily-job.md` **verbatim** for all 13 jobs (its line is
    `HOLDER YIELD <SYM> <code>: <message>`: after the block's first line for `report_stale`, in place of the block for
    `report_unavailable`; decisions are `proposals ...` at top level).
  - D5: `proposals reject 1 --note "valuation layer removed (Phase 1)"`, same for 4.
  - The dominance row delete: one pinned transaction, count, `DELETE` with the same predicate, assert `changes()` equals
    the count (174 on 2026-10-28 plus one per asset per day since).
  - D4: the one paid disclosure dry run on the stored LIT Q3 post, with Mike's go at that step.
  - Tag `orion-valuation-final` on current main and push it over HTTPS before the merge.
- **Watcher cleanup** (the watcher dir is not an orion repo; record changes here and in `docs/ops/disclosure-watcher.md`):
  stop passing `--out <home>/signals.jsonl` to `agent run` (accepted and ignored since Phase 1); `_effect_text` now always
  prints `no target effect`, so the effect part of the `proposals:` line can go; drop the "catalysts" line if Phase 2 drops
  the journal; the "a fix moves targets" queue line (above).
- **Pre-existing watcher test failure**: `test_discovery.TestScan.test_new_recording_is_queued_and_marks_the_window`
  (`'irrelevant' != 'queued'`) fails on unchanged code; not caused by Phase 1. Fix in the watcher.
- **Per-metric fields left unread** since Phase 1: `staleness_days`, `capture_rule`, `valued_per` (no computation reads them; `asset show` prints `capture_rule`). Phase 2 decides.
- **`defillama_share` source type** and handler stay with no asset using it, until Phase 3 removes DefiLlama.
- **Persona simplification** (coverage machinery, persona prose that still talks about valuation) is Phase 2 (Mike's
  answer 3).
- **Valuation-era tables** (`assumption_sets`, `assumptions`, `assumption_changes`, `assumption_evidence`, `snapshots`,
  `valuation_runs`, `signals`, `trigger_firings`) stay in place, unread; not carried into Postgres (Phase 1.5).
