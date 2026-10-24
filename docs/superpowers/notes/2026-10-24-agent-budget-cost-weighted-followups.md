# Agent budget: weighted input units + reserve journal request: followups (2026-10-24)

Spec `docs/superpowers/specs/2026-10-24-orion-agent-budget-cost-weighted-design.md`. Plan
`docs/superpowers/plans/2026-10-24-orion-agent-budget-cost-weighted.md`. Branch `feat/agent-budget-cost-weighted`
(224c197..d1ceaf6 plus this note), based on `main` 08ab5f6. Not merged, not pushed.

## Decisions (Mike, 2026-10-24, "All recs", orion-dev)

1. **Counting: A1.** Weighted input units, uncached ×1, cache write ×1.25, cache read ×0.1, counted in place under the
   existing `input_tokens` YAML key (in tenths, so the arithmetic is exact). No asset hash moves.
2. **Defaults kept.** Weekly 600,000, triage 500,000, deep 2,000,000, bootstrap 3,000,000, disclosure 1,200,000, now
   read as units.
3. **The 13 weekly `input_tokens: 2000000` overrides are left as they are** for now.
4. **Reserve request R on every exhaustion.** One last request in which only `write_journal` may run (no
   `tool_choice`: Opus 5.5 returns 400 on forced tools with thinking on), with the new operating-rule line.
5. **AERO #44's lost `rev_growth_y1` 0.30 → 0.25 waits** for AERO's next scheduled deep. No paid re-run, no manual
   proposal.

Versions: `TOOL_LAYER_VERSION` 1.1.0 → **1.2.0** (Task 3). `ENGINE_VERSION` stays 1.3.0. No DB migration; a run
finished on the reserve is `completed`, with `summary_json.reserve` (and tick report `agent.reserve`) only when R ran.

## Verification (Task 5, on d1ceaf6)

- Full suite `npx vitest run --maxWorkers=2`: **100 files / 1158 tests passed** (baseline before the plan 100 / 1133;
  +25 from Tasks 1-4; Task 5 adds no tests). `npm run typecheck` clean. CLI-subprocess files rerun alone with
  `--maxWorkers=1` (`agent.cli`, `ingest.cli`, `tick.cli`): 3 files / 40 tests passed; no timeouts in either run.
- Hash pins: `git diff main --stat -- tests/assets` lists only `tests/assets/vvv.agent.test.ts` (2+/2-, the
  `inputUnits` rename); no added/removed line carries a 12+ hex pin; `tests/assets/vvv.golden.test.ts` unedited and
  passing (6/6). `assets/`, `personas/`, `skills/`, `src/config/schema.ts` and `tests/fixtures/disclosure/` identical
  to `main`.
- Targets unchanged: all 13 assets' `model whatif <a> --as-of 2026-10-24T00:00:00.000Z --json` are **13/13
  byte-identical** (`cmp`) between `main`'s dist (08ab5f6, detached worktree) and this branch's dist (d1ceaf6), each run
  on its own `.backup` copy of the live DB in a scratch `ORION_HOME` without `.env`: aero, cake, crv, cvxcrv, hype,
  link, lit, pump, sdcrv, sky, uni, vvv, ycrv. Repeat at merge time with the merge commit.

## First live use

AERO's next scheduled deep, ~2026-11-23. It is also where the lost `rev_growth_y1` 0.30 → 0.25 gets redone, by Mike's
pick (decision 5). Watch for `finished on reserve after ...` / `reserve request used after ...; nothing committed` in
the CLI and `agent.reserve` in the tick report.

## Open items

- The 13 weekly 2M overrides: remove them with the next change that touches all 13 YAMLs (13 re-pins). Weekly worst
  case $8.85 → $3.25 (E).
- No R after `pause_turn` (that exhaustion ends `budget_exhausted` as before). Revisit if a live stop lands there.
- The cron prompts do not yet print `agent.reserve`.
- The projected pre-request check (spec §11): stop when units so far plus the last request's size would cross the cap.
  Revisit if the one-request overshoot shows up again.

## Rulings (SDD ledger)

- Ruling: branch rebased onto main 08ab5f6 (loadEnv fix landed after the spec branch point) before Task 1 — implementation must sit on current main for a ff merge — costs nothing if wrong (docs-only commits rebased, branch never pushed).
- Ruling: the context pack's run.budgets now shows `inputUnits` to the model (follows from the rename; pack unpinned) — accepted, consistent with Task 3's rule text naming input units — costs one analyst confusion at worst, fixed by Task 3 text.
- Ruling: accept the reserve's test edits in run.test.ts ('writes nothing when a budget runs out' gets a say('ok') reserve step) and tick.test.ts ('ends short of completed' script -> [growth, say('ok')], requests 2) in Task 2's commit — R's existence forces them; Tasks 3/4 add their own tests on top — costs nothing if wrong (test-only).
- Ruling: the reserve text goes as a separate user message after the tool_result user message (two consecutive user turns), as the brief's test requires; the Messages API documents that consecutive same-role turns are combined into one — if wrong, R gets a 400, which the loop already maps to budget_exhausted 'reserve request failed' (today's outcome), so the cost is only a lost rescue, visible in the first live use.

## Deferred minors (SDD ledger; none blocks the merge)

- Task 1: minor (deferred): INPUT_UNIT_WEIGHTS exported but unread; inputUnitsTenths hard-codes 10/12.5/1 with no test tying them
- Task 1: minor (deferred): no test for odd cache-write count (half tenth) or input_units_left floor at 0.75
- Task 1: minor (deferred): incident regression (b) could also assert final usage sums
- Task 1: minor (deferred): config/agentPolicy.ts type-only import of AgentUsage from db/agentRuns (layering)
- Task 2: minor (deferred): reserve request always follows a user message -> two consecutive user turns (API documents merge; untested live). Fallback if a live 400: append reserve text as a text block to the previous user message
- Task 2: minor (deferred): R runs write_journal regardless of stop_reason (main path gates on tool_use); brief-compliant but uncommented
- Task 2: minor (deferred): test 'runs no reserve after pause_turn, refusal, error, max_tokens or no_journal' only exercises pause_turn; others via reserve:null in existing tests
- Task 3: minor (deferred): conflict-on-reserve test does not assert summary.reserve
- Task 3: minor (deferred): run.ts spread uses truthiness (reserve ?) not reserve !== null (equivalent; budget strings non-empty)
- Task 3: minor (deferred): reserve tests' reason string tied to weekly default cap
- Task 4: minor (deferred): no test for malformed summary.reserve ({} or {reason: 5}); guarded by typeof
- Task 4: minor (deferred): summary.reserve.reason read duplicated in tick.ts and cli agent.ts (could share a helper)

## At merge (Mike's go)

Backup, `whatif` baseline with the old dist, ff-merge, build, `cmp` of the 13 `whatif`s, push over HTTPS. No
migration to apply.
