# Agent budget: weighted input units and a reserve journal request — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent's input cap counts weighted units: uncached ×1, cache write ×1.25, cache read ×0.1. When any
budget runs out, the loop sends one more request (the reserve, R), in which only `write_journal` may run, so staged
work commits instead of being lost.

**Architecture:**
- `agentPolicy.ts` gets the weights and an `inputUnitsTenths(usage)` helper. `RunBudgets.inputTokens` is renamed to
  `inputUnits` internally; the YAML key `input_tokens` is unchanged.
- `loop.ts` checks the cap in units, reports `input_units_left`, and adds the reserve path. `LoopResult` gains
  `reserve`.
- `run.ts` records `summary_json.reserve` (only when R ran). It bumps `TOOL_LAYER_VERSION` and updates the
  operating-rule text.
- The tick report and `agent runs show` print the reserve.

**Tech Stack:** TypeScript, zod, vitest, better-sqlite3. Tests: `npx vitest run --maxWorkers=2`, then
`npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-10-24-orion-agent-budget-cost-weighted-design.md` (decisions recorded in its
Status line). Every value below comes from the spec or from the live DB, read-only, on 2026-10-24.

## Global Constraints

- Decisions (Mike, 2026-10-24, "All recs"):
  - A1 weighted units, counted in place;
  - default numbers kept;
  - the 13 weekly `input_tokens: 2000000` overrides left as they are;
  - R on every exhaustion;
  - AERO #44 waits for its next scheduled deep.
- **No asset config hash moves.** No change to `src/config/schema.ts`, `assets/*.yaml`, personas or skills. All 13
  asset hash pins and the VVV golden hash stay as they are on `main`. Any pin moving means stop and report.
- `ENGINE_VERSION` stays `1.3.0`. `TOOL_LAYER_VERSION` goes `1.1.0` → `1.2.0`, once, in Task 3. No DB migration:
  `agent_runs.outcome` keeps its CHECK values, and a run finished on reserve is `completed`.
- Weights: uncached 1, cache write 1.25, cache read 0.1. They are fixed in code, the same for every model, and
  `cost.ts` is never read.
- The default numbers are unchanged: weekly 600,000, triage 500,000, deep 2,000,000, bootstrap 3,000,000,
  disclosure 1,200,000, now read as units.
- Integer arithmetic: count in tenths of a unit (`10·uncached + 12.5·cacheWrite + 1·cacheRead`; 12.5 × an integer is
  exact in a double). A cap of N units is crossed at `tenths >= 10·N`.
- `usage` (`AgentUsage`, `agent_runs` columns, the tick report's `usage.input_tokens`) stays the raw token count.
  It is reporting, not the budget.
- Do not send `tool_choice` in R. On Claude Opus 5.5 a forced `any`/`tool` returns 400 with thinking on (checked
  against platform.claude.com, "Define tools" and "API primer", 2026-10-24). Keep the same `system` and `tools` so
  the prefix stays cached.
- `RESERVE_MAX_TOKENS = 16_000`.
- R runs at most once per run, and never after `refused`, `error`, `max_tokens`, `model_context_window_exceeded`,
  `no_journal`, or an exhaustion found right after a `pause_turn` (that ends `budget_exhausted` as today).
- New JSON keys appear only when R ran (`summary_json.reserve`, tick report `agent.reserve`). Then
  `tests/fixtures/disclosure/lit-q3-run.json` stays byte-identical. Do not regenerate it.
- No live writes. Work only in the worktree and in scratch homes under `$TMPDIR`. Never call a model; tests use
  `tests/helpers/fakeModel.ts`. Stage with explicit `git add <paths>`; `node_modules` is a symlink, never stage it.
  Commit; don't push.
- Exact copy:
  - `RESERVE_MESSAGE(reason)` =
    `` `Budget spent (${reason}). Call write_journal now. It records your thesis and commits what you staged. Any other tool call ends the run and nothing is saved.` ``
  - `OPERATING_RULES`: this line replaces the "Each tool result shows ..." line under "## Budgets and finishing":
    `Each tool result shows the requests, input units and output tokens you have left. Input units count fresh input in full, cache writes at 1.25 and cache reads at a tenth, so re-reading a long conversation is cheap but not free. If a budget runs out you get one last request, in which you may only write the journal; plan to finish well before that.`
  - Budget detail string: `` `input units (${budgets.inputUnits})` `` (was `input tokens (...)`).
  - CLI line when R ran: `` `finished on reserve after ${reason}` `` if the outcome is `completed`, else
    `` `reserve request used after ${reason}; nothing committed` ``.

## Review Focus

1. **The journal was already staged before exhaustion.** R still runs, so the model may restate it. If R calls no
   tool, the run ends `finished` because `isFinished()` is true. Test in Task 2.
2. **`write_journal` is refused in R** (its guardrail returns `isError`) and no journal was staged earlier. The run
   ends `budget_exhausted` with the original detail. Test in Task 2.
3. **R mixes `write_journal` with another client tool.** Nothing runs, not even the journal, and the run ends
   `budget_exhausted`. Test in Task 2.
4. **R's own request throws** (rate limit). The outcome is `budget_exhausted`, with detail
   `` `${spent}; reserve request failed: ${Class}: ${message}` ``. R's usage is not counted (no response) and the
   run is not `error`. Test in Task 2.
5. **A float boundary.** 600 cache reads × 0.1 is `60.00000000000001` in JS, which is why the count is in tenths.
   With 10 uncached + 600 read + 400 write (570 units), cap 570 stops and cap 571 continues. Test in Task 1.

---

### Task 1: Count input in weighted units

**Files:**
- Modify: `src/config/agentPolicy.ts` (the `RunBudgets` field, `DEFAULT_BUDGETS`, `budgetsFor`, new exports)
- Modify: `src/agent/loop.ts:48-73` (`inputSpent`, `exhausted`, `budgetLeft`)
- Modify: any `src/` reader of `budgets.inputTokens` (`grep -rn "inputTokens" src | grep -v usage`; expected: only
  the two files above)
- Test: `tests/agent/loop.test.ts`, `tests/config/agentPolicy.test.ts`
- Rename-only test edits (budget objects, not usage): `tests/assets/vvv.agent.test.ts:99,101`,
  `tests/agent/run.test.ts:465`, `tests/config/agentPolicy.test.ts:47`
- Create: `tests/fixtures/agent/budget-incidents.json`

**Interfaces:**
- Produces:
  - `RunBudgets.inputUnits: number`, replacing `inputTokens`. Its doc comment: "uncached ×1 + cache writes ×1.25 +
    cache reads ×0.1, summed over requests; the YAML key is `input_tokens`".
  - `export const INPUT_UNIT_WEIGHTS = { uncached: 1, cacheWrite: 1.25, cacheRead: 0.1 } as const`
  - `export function inputUnitsTenths(u: Pick<AgentUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number`
  - Tool-result budget key `input_units_left: number`: an integer, `Math.max(0, Math.floor((10·cap − tenths) / 10))`.
    It replaces `input_tokens_left`.
  - Exhaustion detail `input units (<cap>)`.

- [ ] **Step 1: Write the failing tests**
  - `loop.test.ts` "runs tool calls…": the expected budget becomes `input_units_left: 599_900` (100 uncached per
    step, so units equal tokens here).
  - Replace "counts cache reads and writes toward the input budget…":
    - `it('counts input in weighted units: uncached x1, cache writes x1.25, cache reads x0.1')`: the step usage is
      10 / 600 / 400 (= 570 units).
      - `inputUnits: 570`, script `[cached, cached]`: `stop: 'budget_exhausted'`, `detail: 'input units (570)'`,
        one request.
      - `inputUnits: 571`, script `[cached, calls(journal), say]`: the second request is sent, and
        `toolResults(1)[0].budget.input_units_left === 1`.
    - The output-token half of the old test is kept unchanged.
  - `it('never reports negative input units left')`: one step at 10,000,000 uncached, cap 600,000;
    `input_units_left === 0` (read from the conversation, as in the web test at line 170).
  - `it('lets the three live budget stops run on under units (AERO #44, VVV #17, #31)')`:
    - Read `tests/fixtures/agent/budget-incidents.json`, then for each incident:
    - **(a) The fixture reproduces the incident.** Pure arithmetic on its rows: the raw sum
      (`input + cache_read + cache_write`) before the last row is < the cap, and after it is ≥ the cap.
    - **(b) Run the loop.** Use `DEFAULT_BUDGETS[runType]`, one `calls(toolUse('get_drivers', {}))` step per row
      with that row's usage, then `calls(journalCall())`, `say('Done.')`. Expect `stop: 'finished'` and
      `model.requests.length === rows + 2`.
  - `agentPolicy.test.ts`:
    - `it('reads an input_tokens override as input units')`: `budgetsFor` on an asset with
      `agent.budgets.weekly.input_tokens: 2000000` gives `inputUnits: 2_000_000`.
    - `it('keeps the default numbers')`: `DEFAULT_BUDGETS` `inputUnits` for weekly/triage/deep/bootstrap/disclosure
      are 600_000 / 500_000 / 2_000_000 / 3_000_000 / 1_200_000.
    - `it('weights input in tenths, exactly')`: `inputUnitsTenths({ inputTokens: 10, cacheReadTokens: 600, cacheWriteTokens: 400 }) === 5700`.
    - The existing unknown-key refusal test stays as it is.

- [ ] **Step 2: Write the fixture** `tests/fixtures/agent/budget-incidents.json`. Per-request usage from
  `agent_transcripts.responses` (live, read-only, 2026-10-24); usage numbers only, no transcript content. Columns:
  `[input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, web_search_requests, web_fetch_requests]`.

```json
{
  "_source": "orion.db agent_transcripts.responses[].usage, runs 17/31/44, read 2026-10-24; spec 2026-10-24-orion-agent-budget-cost-weighted-design.md s.2.3",
  "incidents": [
    { "run": 17, "asset": "vvv", "runType": "triage", "rows": [[4,0,41508,387,0,0],[2,41508,2063,461,0,0],[10904,789449,73306,7866,7,5]] },
    { "run": 31, "asset": "vvv", "runType": "triage", "rows": [[4,0,41902,676,0,0],[65003,274090,22149,4567,3,4],[2,64051,2654,1146,0,0],[2,66705,1391,2271,0,0]] },
    { "run": 44, "asset": "aero", "runType": "deep", "rows": [[4,0,41306,561,0,0],[4,86737,5056,874,0,0],[16,487809,64380,4896,7,3],[8,530480,50651,9776,0,3],[172523,993790,15941,3493,4,3]] }
  ]
}
```

  Raw totals 958,744 / 537,953 / 2,448,705; unit totals 240,101.95 / 190,615.6 / 604,104.1 (spec §2.1 rounds them). Web use stays within
  each type's default (triage 8/8, deep 15/15), so only the input cap is in play.

- [ ] **Step 3: Run the tests to verify they fail.** Run `npx vitest run tests/agent/loop.test.ts tests/config/agentPolicy.test.ts`.
  Expected: FAIL (`inputUnitsTenths` is not exported; `input_tokens_left` is still sent).

- [ ] **Step 4: Implement.** Rename the field (`inputUnits: o.input_tokens ?? d.inputUnits` in `budgetsFor`).
  `exhausted()` compares `inputUnitsTenths(usage) >= budgets.inputUnits * 10`. Delete `inputSpent`. Apply the rename
  to the four test lines listed under Files.

- [ ] **Step 5: Run the tests to verify they pass.** Run
  `npx vitest run tests/agent tests/config tests/assets/vvv.agent.test.ts` and `npm run typecheck`. Expected: PASS,
  with no hash pin edited (`git diff -- tests | grep -i hash` is empty).

- [ ] **Step 6: Commit**

```bash
git add src/config/agentPolicy.ts src/agent/loop.ts tests/agent/loop.test.ts tests/config/agentPolicy.test.ts \
  tests/assets/vvv.agent.test.ts tests/agent/run.test.ts tests/fixtures/agent/budget-incidents.json
git commit -m "agent: count the input budget in weighted units (uncached x1, cache write x1.25, cache read x0.1); same caps and YAML key, no hash moves; the three live stops (#17, #31, #44) as a regression fixture"
```

### Task 2: The reserve request in the loop

**Files:**
- Modify: `src/agent/loop.ts` (`runLoop`, `LoopResult`, new exports)
- Modify: `src/agent/prompt.ts` (add `RESERVE_MESSAGE`)
- Test: `tests/agent/loop.test.ts` (new `describe('the reserve request')`)

**Interfaces:**
- Consumes: Task 1's `exhausted()` (which returns the budget string).
- Produces:
  - `export const RESERVE_MAX_TOKENS = 16_000` in `loop.ts`.
  - `export function RESERVE_MESSAGE(reason: string): string` in `prompt.ts`, with the exact copy from Global
    Constraints.
  - `LoopResult.reserve: string | null`: the budget string that triggered R; null when R did not run. A run that
    stops `budget_exhausted` after R also carries it.

**Algorithm** (the one place the tests leave a choice):
- Track `paused` (whether the last response's `stop_reason` was `pause_turn`) and `reserveUsed`.
- On `spent = exhausted(...)`: if `reserveUsed || paused`, return `budget_exhausted` (as today). Otherwise set
  `reserveUsed = true`, push `{ role: 'user', content: RESERVE_MESSAGE(spent) }` and send with the same
  model/effort/system/tools and `maxTokens: RESERVE_MAX_TOKENS`.
- **A throw:** `budget_exhausted` with detail `` `${spent}; reserve request failed: ${Class}: ${message}` ``.
- **A response:** add its usage exactly as the main path does, record it in `responses`, and push the assistant
  turn when it is non-empty. Then it ends `budget_exhausted` (detail `spent`) when any of these hold:
  - `stop_reason` is `refusal`, `max_tokens`, `model_context_window_exceeded` or `pause_turn`;
  - this response's `server_tool_use` searches + fetches > 0;
  - a `fallback` block follows a `tool_use`;
  - any `tool_use` name is not `write_journal` (run none of them).
- **Otherwise:** run each `write_journal` call through `runTool`; a throw is `error`, as on the main path. Do not
  send the results back. Return `finished` if `isFinished()`, else `budget_exhausted` (detail `spent`).
- No `exhausted()` check after R. R is bounded by being exactly one request.

- [ ] **Step 1: Write the failing tests** (an exhausting step uses usage `{ input_tokens: 10_000_000 }` against
  `DEFAULT_BUDGETS.weekly`):
  - `it('sends one reserve request on exhaustion, with the reserve message and 16k max tokens, and finishes on a journal')`:
    - script `[huge(get_drivers), calls(journalCall())]`;
    - `stop: 'finished'`, `reserve: 'input units (600000)'`;
    - `model.requests.length === 2`;
    - `requests[1].maxTokens === 16000`;
    - `requests[1].messages.at(-1)` deep-equals `{ role: 'user', content: RESERVE_MESSAGE('input units (600000)') }`;
    - `requests[1].tools` and `system` equal `requests[0]`'s;
    - `usage.requests === 2`.
  - `it('runs no tool and ends budget_exhausted when the reserve turn calls anything but write_journal')`: R =
    `calls(toolUse('get_drivers', {}), journalCall())` → `budget_exhausted`, `ran` has only the first request's
    tool, and `reserve` is set.
  - `it('ends budget_exhausted when the reserve turn uses a server tool')`: R = `calls(journalCall())` with usage
    `server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 }` → `budget_exhausted`, and the journal
    did not run.
  - `it('ends budget_exhausted when write_journal is refused in the reserve turn')`: `runTool` returns `isError`
    for `write_journal` and never sets finished → `budget_exhausted`, detail `input units (600000)`.
  - `it('finishes when the journal was already staged and the reserve turn calls nothing')`: the first step is
    `calls(journalCall())` with huge usage; R = `say('Done.')` → `finished`.
  - `it('reports a failed reserve request as budget_exhausted, not error')`: R = `new RateLimitError('429')` →
    `stop: 'budget_exhausted'`, `detail: 'input units (600000); reserve request failed: RateLimitError: 429'`.
  - `it('uses the reserve once: a reserve turn ending without a journal does not get a reminder or a second reserve')`:
    R = `say('ok')` → `budget_exhausted`, and `model.requests.length === 2`.
  - `it('covers the request, output and web budgets too')`: three cases, each finishing on a journal in R, with
    `reserve` equal to `requests (2)`, `output tokens (60)` and `web searches (2)`.
  - `it('runs no reserve after a pause_turn, refusal, error, max_tokens or no_journal')`:
    - exhaustion right after a `pause_turn` step → `budget_exhausted` and `reserve === null`;
    - each existing stop test also gets `reserve: null` in its `toMatchObject`.

- [ ] **Step 2: Run the tests to verify they fail.** Run `npx vitest run tests/agent/loop.test.ts`. Expected:
  the new tests FAIL (no reserve request; `RESERVE_MESSAGE` is not exported).

- [ ] **Step 3: Implement** per the algorithm above, in `runLoop`. Move the shared "add the usage, record the
  response" lines into a local function so the main path and R use the same code.

- [ ] **Step 4: Run the tests to verify they pass.** Run `npx vitest run tests/agent`. Expected: PASS, the
  existing loop tests included.

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts src/agent/prompt.ts tests/agent/loop.test.ts
git commit -m "agent: one reserve request on exhaustion, in which only write_journal may run (no tool_choice: Opus 5.5 refuses forced tools with thinking); never after pause_turn/refusal/error"
```

### Task 3: Commit through the run, record the reserve, update the rules

**Files:**
- Modify: `src/agent/run.ts` (`TOOL_LAYER_VERSION` → `'1.2.0'`; the summary)
- Modify: `src/agent/prompt.ts` (the `OPERATING_RULES` line)
- Test: `tests/agent/run.test.ts`, `tests/agent/context.test.ts`

**Interfaces:**
- Consumes: `LoopResult.reserve` (Task 2).
- Produces: `summary_json.reserve = { reason: string }`, present only when `loop.reserve !== null`. Spread it in
  as `...(reserve ? { reserve: { reason } } : {})`. A run that finishes on reserve has outcome `completed` and
  `error` null, and commits through the existing path: reload hash check, `AgentConflict`, valuation.

- [ ] **Step 1: Write the failing tests**
  - `run.test.ts`:
    - `it('commits what was staged when it finishes on the reserve request, and records why')`:
      - script: `apply_assumption_change` (as in the test at line 39) with usage `{ input_tokens: 10_000_000 }`,
        then `calls(journalCall())`;
      - outcome `completed`, `error` null;
      - `committed.setVersion` is non-null; the journal row exists;
      - `run.summary.reserve` deep-equals `{ reason: 'input units (600000)' }`;
      - a signal is emitted.
    - `it('still refuses to commit on reserve when the config changed during the run')`: the same script with a
      `reload` that returns a different hash → `conflict`, nothing committed.
    - `it('puts no reserve key in the summary when the reserve did not run')`: a normal run;
      `'reserve' in run.summary === false`.
    - `it('records the reserve on a run that still ran out')`: R calls `get_drivers` → `budget_exhausted`,
      `summary.reserve` set, nothing committed.
  - `context.test.ts` "explains the rules…": add the phrases `'you may only write the journal'` and
    `'cache reads at a tenth'` to the list. The ASCII check stays.
  - `disclosure.e2e.test.ts` is not edited, and its fixture still matches.

- [ ] **Step 2: Run the tests to verify they fail.** Run `npx vitest run tests/agent/run.test.ts tests/agent/context.test.ts`.
  Expected: FAIL (no `summary.reserve`; the old rule text).

- [ ] **Step 3: Implement.** Set `TOOL_LAYER_VERSION = '1.2.0'`, add the summary spread, and replace the
  `OPERATING_RULES` line with the exact copy. `OUTCOME_OF` is unchanged.

- [ ] **Step 4: Run the tests to verify they pass.** Run `npx vitest run tests/agent`. Expected: PASS, with
  `disclosure.e2e` unchanged (`git diff --quiet -- tests/fixtures/disclosure`).

- [ ] **Step 5: Commit**

```bash
git add src/agent/run.ts src/agent/prompt.ts tests/agent/run.test.ts tests/agent/context.test.ts
git commit -m "agent: a run that finishes on the reserve commits as completed with summary.reserve; operating rules say input units and the one last journal request; TOOL_LAYER_VERSION 1.2.0"
```

### Task 4: Show the reserve in the tick report and the CLI

**Files:**
- Modify: `src/app/tickReport.ts` (the `agent` strictObject: `reserve: z.string().optional()`)
- Modify: `src/app/tick.ts` (`agentStage`: set `stage.reserve` only when `result.run.summary?.reserve` has a
  `reason`)
- Modify: `src/cli/commands/agent.ts` (`agent runs show` and `agent run` print the reserve line)
- Test: `tests/app/tickReport.test.ts`, `tests/app/tick.test.ts`, `tests/cli/agent.cli.test.ts`

**Interfaces:**
- Consumes: `summary_json.reserve.reason` (Task 3).
- Produces: tick report `agent.reserve?: string`, absent unless R ran. The 13 cron prompts are not changed (out of
  scope, and a hard stop for this card); the field reaches Slack only through the report JSON they already read.

- [ ] **Step 1: Write the failing tests**
  - `tickReport.test.ts`: `it('accepts agent.reserve as an optional string and still accepts a report without it')`.
  - `tick.test.ts`: `it('reports agent.reserve when the run finished on the reserve request')`:
    - the scripted model exhausts on its first step (`input_tokens: 10_000_000`), then `calls(journalCall())`;
    - `report.agent.outcome === 'completed'`, `report.agent.reserve === 'input units (600000)'`;
    - in a normal tick, `'reserve' in report.agent === false`.
  - `agent.cli.test.ts`: `it('says when a run finished on the reserve request')`:
    - `agent run mini --type weekly --dry-run` with the same exhausting script;
    - the output and `agent runs show 1` both contain `finished on reserve after input units (600000)`.
    - (Run this file alone with `--maxWorkers=1` if it times out.)

- [ ] **Step 2: Run the tests to verify they fail.** Run
  `npx vitest run tests/app/tickReport.test.ts tests/app/tick.test.ts` and
  `npx vitest run --maxWorkers=1 tests/cli/agent.cli.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the schema field, the stage field and the CLI line, using the exact copy from Global
  Constraints.

- [ ] **Step 4: Run the tests to verify they pass.** Same commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/tickReport.ts src/app/tick.ts src/cli/commands/agent.ts tests/app/tickReport.test.ts tests/app/tick.test.ts tests/cli/agent.cli.test.ts
git commit -m "tick/cli: show when an agent run finished on the reserve request (agent.reserve, optional)"
```

### Task 5: Prove nothing else moved, and write the followups note

**Files:**
- Create: `docs/superpowers/notes/2026-10-24-agent-budget-cost-weighted-followups.md`

- [ ] **Step 1: Full suite.** Run `npx vitest run --maxWorkers=2`, then `npm run typecheck`. Rerun any CLI-subprocess
  timeout (`agent.cli`, `ingest.cli`, `tick.cli`) alone with `--maxWorkers=1`. Record the real file/test counts
  from both runs. Expected: all green; the count grows only by the tests added here.

- [ ] **Step 2: Hash pins.**
  - `git diff main --stat -- tests/assets` lists only `vvv.agent.test.ts`.
  - `git diff main -- tests/assets | grep -E '^[-+].*[0-9a-f]{12}'` is empty: no pin moved.
  - `tests/assets/vvv.golden.test.ts` passes unedited.

- [ ] **Step 3: Targets byte-identical.** In a scratch home, compare old vs new dist on all 13 assets:
  - **Set up.** `git worktree add $TMPDIR/orion-wt-base main`, symlink `node_modules`, and `npm run build` in both
    that worktree and this one. Both are worktrees, not the live tree.
  - **Seed the home.** `$TMPDIR/orion-budget-home` gets `assets/`, `personas/`, `skills/` and a copy of the DB:
    `sqlite3 'file:/home/hermes/git/orion/orion.db?mode=ro' ".backup '$TMPDIR/orion-budget-home/orion.db'"`.
    It gets no `.env`, since whatif needs no keys.
  - **Run whatif.** For each asset `a`:
    `ORION_HOME=$TMPDIR/orion-budget-home node <tree>/dist/cli/index.js model whatif a --as-of 2026-10-24T00:00:00.000Z --json > <tree-tag>/a.json`.
    Use two DB copies if a whatif writes.
  - **Compare.** `cmp` each pair. Expected: 13/13 identical.
  - **Clean up.** Run `python3 -c "import shutil; shutil.rmtree('<dir>')"` on the scratch dirs, then
    `git worktree remove $TMPDIR/orion-wt-base`.

- [ ] **Step 4: The followups note.** Record:
  - the five decisions with the date;
  - the test counts;
  - the 13/13 whatif result;
  - `TOOL_LAYER_VERSION` 1.2.0;
  - the first live use: AERO's next scheduled deep, ~2026-11-23 (its lost `rev_growth_y1` 0.30 → 0.25 is left to
    that run, by Mike's pick);
  - the open items:
    - the 13 weekly 2M overrides, to remove with the next change that touches all 13 YAMLs (weekly worst case
      $8.85 → $3.25, E);
    - no R after `pause_turn` (revisit if a live stop lands there);
    - the cron prompts do not yet print `agent.reserve`;
    - the projected pre-request check (spec §11).
  - Copy any `minor (deferred)` / `Ruling:` lines from the SDD ledger before the worktree goes.

- [ ] **Step 5: Secrets and staging check, then commit.**
  - `git grep -nE 'alchemy\.com/v2/[A-Za-z0-9_-]{8,}'`: only the fake test fixture may hit.
  - `git status` shows no `node_modules` staged.

```bash
git add docs/superpowers/notes/2026-10-24-agent-budget-cost-weighted-followups.md
git commit -m "docs(notes): agent budget weighted units + reserve: decisions, suite counts, 13/13 whatif identical, open items"
```

- [ ] **Step 6: Stop.** The branch is green and unmerged. Merge, build and the first live run wait for Mike.
