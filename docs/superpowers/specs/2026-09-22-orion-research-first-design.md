# Orion sub-project 5: research first

Date: 2026-09-22. Status: implemented on branch feat/research-first (2026-09-22/23); section 15 records every amendment from execution and review.

Extends `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (Data principle, section 1), `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (sources, section 4), `docs/superpowers/specs/2026-09-20-orion-agent-layer-design.md` (sections 4, 5.5, 9, 11), and `docs/superpowers/specs/2026-09-21-orion-scheduling-design.md` (sections 4.4, 5, 11). Where this document and those differ, this one wins for the items it covers.

## 1. Purpose and scope

Make the operating principle stated on 2026-09-22 true end to end: the user never researches or hand-enters a figure. Orion's analyst researches what no API publishes and records it provisional; the user confirms or rejects it from the daily message; nothing researched reaches a signal unconfirmed. This is the code the principle needs before a second asset is covered. The asset onboardings themselves (AERO, then HYPE) are sub-projects 6 and 7.

In scope:

1. `orion inbox <asset>`: everything awaiting the user's decision, and the same queue embedded in the tick report.
2. Hermes executes the user's replies: six decision verbs, each an existing command, under prompt-level guards.
3. Research may write a future-dated row onto a fetched `schedule` or `event` metric.
4. A `bootstrap` run type that populates an empty asset's manual metrics from research, with its own skill and budget.
5. `defillama` as the primary source of a `flow` metric, written as daily rows with a cursor.

Out of scope: the AERO and HYPE asset files, personas, and calibrations; a generic HTTP series source; a multi-asset Hermes job; decision tokens (section 14).

### Decisions made during brainstorming

- Three sub-projects, not one: this code first, proven on VVV; then AERO (on Base, needs no code beyond item 5); then HYPE (non-EVM, may need adapters the AERO pass will not reveal).
- The user acts on the queue by replying to Hermes, which then operates Orion as the user's hands. The earlier rule "Hermes never operates Orion" is replaced by "only on the user's explicit reply, one command per reply".
- The daily message shows Orion's numbers and the citation URL for a row awaiting confirmation, never the quote or the note. The tick report keeps its no-model-text guarantee; the citation URL is the one model-chosen string in it, and Hermes never fetches one.
- Hermes may execute: confirm and reject an observation, approve and reject a proposal, ack and resolve an anomaly. Not assumption changes: those are the user's views and are set from a Claude session after the sweep.
- Orion owns the decision surface (one inbox command, embedded in the report) rather than Hermes assembling it from three list commands, and rather than one-time decision tokens.
- `bootstrap` is a real run type, because skills, budgets, and the cadence key on run type.
- The flow source is DefiLlama only. Both target assets are on DefiLlama; a generic series source would be designed against no consumer.

## 2. Facts this design rests on

- `record_provisional_observation` refuses any metric with a `source` (`fetched_metric`), refuses a future `observed_at` except on `schedule` and `event` metrics, refuses a row where one exists at the same metric and time, and verifies the citation against pages fetched in the run. With `allow_provisional: false` (VVV's revenue since 2026-09-22) `routeObservation` is inert: every researched row is provisional and stays out of every signal until `orion data confirm`.
- The tick report (`TickReportSchema`, version 1) carries ids, kinds, counts, dates, and Orion's own numbers, validated before it is written. `agent.proposals` lists id and kind only. The signal lists `stale_metrics` and `provisional_metrics` by key, not by id.
- `agent_runs.run_type` is a CHECK constraint over `('weekly','triage','deep')`; skills declare `run_types` over the same enum; `DEFAULT_BUDGETS` is keyed by run type. Migrations run to id 4.
- `runAgent` preflight throws `no_assumption_set` when the asset has none; `dueRunType` returns `deep` when no deep attempt is within `deep_days`, else `weekly`; on a fresh asset the first scheduled run is `deep`.
- `approveProposal` runs in an immediate transaction and refuses a stale proposal; `confirmObservation` refuses a row that is not provisional. `orion tick` and `orion agent run` take the run lock; the short commands do not, and SQLite serialises them.
- A `flow` metric's primary must be `transfer_flow` (`sourceIssues`), which scans ERC-20 logs to one sink on an EVM chain and writes one row per completed UTC day under a cursor in `fetch_cursors`; `--adopt` retires manual rows that overlap fetched days. `defillama` is allowed only as a cross-check, `compare: monthly_sum`, and its handler already returns a `daily_series` from `/summary/fees/<slug>?dataType=<x>` (`totalDataChart`, unix-second timestamps, USD). `event` metrics can have no source.
- The Hermes job doc's prompt names every command Hermes may run; the tick's stderr and the report carry no model or page text, which is what makes a shell agent safe to read them daily.

## 3. Components

| Area | Change |
|---|---|
| `src/app/inbox.ts` (new) | Builds the inbox for an asset: provisional observations, pending proposals, open anomalies, numbers and ids only. Used by the CLI command and the tick. |
| `src/cli/commands/inbox.ts` (new) | `orion inbox <asset> [--json]`. |
| `src/app/tickReport.ts` | `inbox` field (section 4.2). |
| `src/app/tick.ts` | Computes the inbox after the agent step, before the report. |
| `src/agent/tools/write.ts`, `src/agent/guardrails.ts` | The fetched-metric rule of section 6. |
| `src/types.ts`, `src/db/migrations.ts` (migration 5), `src/config/personas.ts`, `src/config/agentPolicy.ts`, `src/app/cadence.ts`, `src/agent/run.ts`, `src/agent/prompt.ts` | The `bootstrap` run type (section 7). |
| `skills/bootstrap-research.md` (new), `skills/disclosure-research.md` | Skill text (sections 6.3, 7.3). |
| `src/config/sources.ts`, `src/ingest/sources/defillama.ts`, `src/ingest/apiFlow.ts` (new), `src/ingest/run.ts`, `src/ingest/plan.ts` | The DefiLlama flow primary (section 8). |
| `docs/ops/hermes-daily-job.md`, `README.md`, `assets/vvv.yaml` (comments), `tests/fixtures/hype.yaml`, `tests/fixtures/aero.yaml` | Ops text, the last hand-entry row removed, fixtures gain a `defillama` flow primary. |

### Invariants (additions)

1. The tick report and the inbox carry no text a model wrote or a page said. A citation URL is the only model-chosen string, and it is never fetched by the scheduled agent.
2. A researched row is provisional and reaches no signal until the user confirms it, on every metric. `allow_provisional: true` remains legal config and is a deliberate exception the asset file must comment.
3. Research never writes onto a fetched metric at or before now. The fetch owns the present.
4. Hermes runs one decision command per user reply, for an id in the latest inbox it sent, and nothing else that writes.
5. A `bootstrap` run changes no assumption and files no config proposal.

## 4. The inbox

### 4.1 Command

`orion inbox <asset> [--json]`. Text output is one line per item in the forms of section 5.2; JSON is the object below. Exit 0 always; an empty inbox is three empty arrays.

```
{
  asset, as_of,
  observations: [{ id, metric, value, observed_at, period_days, unit, citation_url, recorded_by: { persona, agent_run_id } | null,
                   move_pct }],              // move_pct: percent against the last CONFIRMED value in force at observed_at; null when none
  proposals:    [{ id, kind, persona, agent_run_id, filed_at, effect }],   // effect: the stored ProposalEffect, numbers only, or null
  anomalies:    [{ id, kind, metric, severity, occurrences, first_seen_at, last_seen_at, reading }]  // reading: Orion's numbers from detail
}
```

Rules:

- `observations` is every active provisional row of the asset, whoever wrote it (the user's own `--provisional` entries included), newest first. `recorded_by` is parsed from `source_detail` (`research:<persona>:run <n>`) and null for a user entry. `quoted_text`, `note`, and `rationale` never appear.
- `proposals` is every `pending` proposal, newest first. `effect` is the `effect_json` Orion computed at filing time, which is numbers only by construction (agent-layer spec 6.1). `rationale` never appears.
- `anomalies` is every `open` anomaly. `reading` is the numeric subset of `detail` (values, tolerances, percents, counts); string fields of `detail` that name sources or metrics may appear; a `note` never does. Acknowledged and resolved anomalies are not in the inbox.
- `move_pct` uses `valueInForce(..., { confirmedOnly: true })` at the row's `observed_at`, the same baseline as the move guard, so the user sees the move the guard would have seen.

### 4.2 In the tick report

`TickReportSchema` gains `inbox: InboxSchema` (the object above without `asset` and `as_of`), computed after the agent step, so rows the day's run just committed are in the day's message. Schema version stays 1: the field is additive. `emitTickReport` validates it as it does everything else. `signal.provisional_metrics` is unchanged; the inbox is where the ids live.

## 5. Hermes decision replies

### 5.1 Contract change

The job doc's opening rule becomes: the scheduled agent runs the tick and reports; it operates Orion only as the user's hands, one command per explicit reply. Everything else in the HARD RULES stands, with the six commands of 5.3 moved from the NEVER list to a DECISIONS list.

### 5.2 The daily message

After the summary line (and the analyst line when a run happened), a DECISIONS block printed from `report.inbox`, one line per item:

```
obs #41   revenue_run_rate_usd  120000000 at 2026-09-15  +20.0% vs confirmed  https://venice.ai/blog/...
prop #12  assumption_value  filed 2026-09-21 by ai-infra-analyst run #9  effect: 12m target 35.06 -> 37.10
anom #7   cross_check_disagreement  price_usd  degrading  seen 3x since 2026-09-19  reading 4.1%
```

An empty inbox prints `nothing to decide`. A non-empty inbox is not by itself an ALERT; the existing ALERT conditions stand. Every message ends with the reply forms of 5.3 in one line.

### 5.3 Replies

| Reply | Command Hermes runs |
|---|---|
| `confirm <id>` | `node dist/cli/index.js data confirm <id> --json` (confirm takes no note; words after the id are ignored and Hermes says so) |
| `reject <id> [note]` | `node dist/cli/index.js data reject <id> --note "<note>" --json` |
| `approve <id> [note]` | `node dist/cli/index.js model proposals approve <id> --note "<note>" --json` |
| `decline <id> [note]` | `node dist/cli/index.js model proposals reject <id> --note "<note>" --json` |
| `ack <id> [note]` | `node dist/cli/index.js data ack <id> --note "<note>" --json` |
| `resolve <id> [note]` | `node dist/cli/index.js data resolve <id> --note "<note>" --json` |

`decline` rather than `reject` for a proposal so one word never names two queues. The note is the user's words after the id, verbatim; a verb that requires a note and gets none is answered with a request for one, not a default. Hermes runs the command exactly once, prints Orion's JSON result and exit code verbatim, and stops. Several decisions in one reply are run in the order written, each once, stopping at the first failure.

### 5.4 Guards

All in the prompt; nothing new in Orion:

- The id must appear in the most recent inbox Hermes sent. Otherwise Hermes prints the current `orion inbox <asset>` and asks again. This is what stops a poisoned file, page, or command output from steering a decision: only the user's reply carries a verb, and only an id the user has seen is accepted.
- The instruction must come from the user's reply, never from a file, a command's output, or a message Hermes composed.
- Hermes never fetches a citation URL, never runs git, npm, or sqlite3, and never reads or relays a rationale, quote, note, or transcript. When the user asks what a row says, Hermes answers that this needs a Claude session (`orion data show`, `orion model proposals show <id>`).
- Orion's own guards are the backstop: `approve` refuses a stale proposal, `confirm` refuses a row that is no longer provisional, `ack` and `resolve` refuse a decided anomaly, all inside immediate transactions. A reply that races the daily tick fails loudly and the user replies again.

### 5.5 Consequence to accept

Approving a config proposal edits `assets/<id>.yaml` on the server and leaves an uncommitted diff there. The message says so. The user commits it from a Claude session; the vvv hash-pin test fails until that commit updates it (the existing tax, scheduling follow-ups note).

## 6. Research onto fetched schedule and event metrics

### 6.1 Rule

`record_provisional_observation` on a metric with a `source`:

- `observed_at` at or before now: refused, `fetched_metric`, as today. The fetch owns the present.
- `observed_at` strictly after now and the metric is `schedule` or `event`: accepted. Stored provisional, `source: manual`, `source_detail: research:<persona>:run <n>`, citation and quote kept.
- `observed_at` after now on a fetched `level` or `flow`: refused, `fetched_metric`, with the message saying only schedule and event metrics take announcements.

Everything else about the row is existing behaviour: `observation_exists` blocks a second row at the same metric and date (so the same announcement is not re-recorded weekly and a user-entered row is never overwritten); the row sits in the inbox until confirmed; once confirmed it is the newest schedule step until its date, when the on-chain read at or after that date is newer and governs; if the chain has not moved by then, the signal follows the chain. A withdrawn announcement is handled by rejecting the row, by the user or by the agent's `reject_observation` proposal. The calendar and deviation triggers need no change.

### 6.2 Tool text

The tool description gains: "A fetched metric takes a researched row only when it is a schedule or event metric and the date is in the future: an announced change with its effective date. Fetched levels and flows never take one."

### 6.3 Skill text

`disclosure-research.md` gains a paragraph: announced changes to a fetched schedule (an emission cut on the project's blog) or a dated event (an unlock) are recorded on that metric with the EFFECTIVE date, not the announcement date; the row waits for the user; do not record one whose effective date has passed, because the chain now says what happened.

### 6.4 Docs

README: the emission-cut row of the operations table becomes "confirm the analyst's row", and the "still manual" bullet loses its `orion data set` instruction. `assets/vvv.yaml`: the emission-rate comment says the analyst records announced cuts and the user confirms them.

## 7. The `bootstrap` run

### 7.1 Type

`RUN_TYPES` becomes `['weekly','triage','deep','bootstrap']`. Migration 5 rebuilds `agent_runs` with the widened CHECK (SQLite cannot alter a CHECK in place): create the new table, copy, drop, rename, recreate indexes. Skills' `run_types` and the tick report's enums follow from the constant.

### 7.2 When it runs

`dueRunType`: when the asset has no attempt of type `deep` or `bootstrap` on record, return `bootstrap`; otherwise as today. `lastAttemptAt(db, id, ['deep'])` becomes `['deep','bootstrap']` in the deep rule and `['weekly','deep','bootstrap']` in the weekly rule, so a bootstrap counts as that interval's deep and weekly. VVV has a deep attempt (#3) and is unaffected. By hand: `orion agent run <asset> --type bootstrap`.

### 7.3 Preflight and tools

`runAgent` skips the `no_assumption_set` check for `bootstrap`. With no set, `apply_assumption_change` and the assumption-set reads are not offered to the model (the tool list is built per run); the context pack's assumptions block says `none yet`. When a set exists (a bootstrap run by hand on a live asset), the run behaves as a deep run does for assumptions but the skill still says not to touch them. `propose_change` is offered but the skill forbids config proposals; the run's revaluation is unchanged and yields a `blocked` signal until rows are confirmed, which the report shows as normal.

### 7.4 Skill

`skills/bootstrap-research.md`, `run_types: [bootstrap]`: list the asset's manual metrics (no `source`), required first, then critical, then the rest; for each, find one citable primary-source figure and record it with the date and unit rules of disclosure-research (which also loads for this type: its `run_types` gains `bootstrap`); record nothing you cannot cite; never change an assumption and never propose a config change; write a journal entry listing every manual metric as found, not found, or ambiguous, with what was searched, so the next run does not repeat it.

### 7.5 Budget

`DEFAULT_BUDGETS.bootstrap = { requests: 60, inputTokens: 3_000_000, outputTokens: 100_000, webSearches: 30, webFetches: 30, proposals: 2 }`. About 8 to 12 dollars at list price with caching. `agent.budgets.bootstrap` in the asset YAML overrides it like the others.

### 7.6 Onboarding sequence (for sub-projects 6 and 7)

1. Claude writes `assets/<id>.yaml` and assigns the persona; the user approves the file.
2. The Hermes job is scheduled for the asset.
3. The first tick fetches what it can and runs the bootstrap.
4. The message lists the researched rows; the user confirms by reply.
5. Claude runs the calibration sweep with the user against confirmed data and imports the set.
6. The next tick produces the first signal.

## 8. The DefiLlama flow primary

### 8.1 Config

`{ type: defillama, slug, data_type, backfill_days?: 90 }` as a `flow` metric's `source`. `compare` is required in the cross-check role and forbidden in the primary role (schema: `compare` optional; `sourceIssues` enforces the role). The metric's `unit` must be `usd`. No `ingest` block is required for it. A DefiLlama-primary flow may carry an `adapter` cross-check; it may not cross-check against `defillama`.

### 8.2 Writing

`src/ingest/apiFlow.ts`: for each DefiLlama-primary flow, fetch the series through the existing handler, then write one row per completed UTC day (every day strictly before the run's UTC day) that is after the cursor: `period_days: 1`, `observed_at` the end of that day, `source: api`, `source_detail` the URL. The cursor (`fetch_cursors`, scan key the source id) records the last day written; the first run backfills `backfill_days`. A day absent from the chart is skipped, not written as zero, and is picked up when it appears. Revision window: the three most recent days already written are re-read; when a value differs, the day's row is superseded by the new value through `insertObservation` (same metric and time supersedes). Manual rows overlapping fetched days: refused without `--adopt`, retired with it, exactly as for transfer flows, inside the same immediate transaction. `fetchAsset` dispatches DefiLlama-primary flows to this writer beside `transfer_flow`; the plan lists them under the flow group so `data sources` reports them the same way.

### 8.3 Downstream

Holder-flow windows, `burn_momentum`, staleness, the source-failure streak, provenance (`api`), and cross-checks see ordinary daily flow rows. Nothing in the engine changes.

## 9. Data model summary

- Migration 5: `agent_runs.run_type` CHECK widened to include `bootstrap`. No other table changes. The inbox is a query, not a table.

## 10. Ops

- `docs/ops/hermes-daily-job.md`: the contract paragraph, the message format (DECISIONS block, reply forms), the DECISIONS command list, the guards of 5.4, the consequence of 5.5, and the "why" section updated (a wrong ack is now one reply away; the id-in-latest-inbox rule is why that is acceptable).
- README: the analyst section describes the bootstrap; the operations table gains a "daily, from the Hermes message" row for decisions; `orion inbox` joins the command list.

## 11. Testing

- Inbox: a fixture with two provisional rows (one researched, one user-entered), two pending proposals (one with an effect), one open, one acknowledged, and one resolved anomaly; the JSON matches the schema, carries no `quoted_text`, `note`, or `rationale` key anywhere (a recursive key scan), and `move_pct` equals the guard's baseline; the tick report embeds it and validates; a row committed by the day's run is in that day's inbox.
- Fetched schedule/event rule: the four cases on the VVV config (future row on the emission rate accepted; row at now refused; future row on a fetched level refused; after confirmation the engine's schedule step at that date is the researched value while daily fetch rows keep landing beneath it).
- Bootstrap: `dueRunType` returns `bootstrap` on an empty asset and `deep` for VVV's history; a bootstrap counts as the deep and the weekly for its interval; preflight passes with no assumption set; the assumption tool is absent from the tool list; a run with the fake model records rows and a journal and commits; the report and the Hermes fixtures accept the new type; migration 5 preserves existing rows.
- DefiLlama flow: canned responses on the HYPE and AERO fixtures cover backfill, the cursor, a skipped day, a revised day, adoption, and the role rules in `sourceIssues`; one live dry run against `/summary/fees/venice?dataType=dailyHoldersRevenue` from a scratch config proves the endpoint shape (not committed to VVV).
- Hermes prompt: no code, but the doc's example message is generated from a real report fixture so it cannot drift.

## 12. Build order

1. Inbox module, command, and report field.
2. Fetched schedule/event rule, tool and skill text, README and VVV comment.
3. `bootstrap`: constant, migration, budgets, cadence, preflight, tool list, skill, prompt.
4. DefiLlama flow primary: schema and role rules, writer, dispatch, fixtures.
5. Hermes doc and prompt; README operations table.
6. Final whole-branch review; deploy: migration 5 runs on the first `orion` command after deploy, the Hermes job text is replaced on the server.

## 13. Known limitations

- The inbox lists a proposal's effect as stored at filing time; it is not refreshed as data moves (agent-layer spec 16).
- The revision window for DefiLlama is three days; a revision older than that is not picked up.
- Hermes's guards are prompt rules. A model that ignores its prompt could run a decision command on its own; the blast radius is one reversible decision on an id the user has already seen, and Orion's transactions refuse anything stale.
- A bootstrap run on an asset with nothing citable produces only a journal; the asset stays `blocked` and the next scheduled run is a weekly a week later, which will research again under the smaller budget. Launch another bootstrap by hand if the first found little.

## 14. Alternatives not taken

- Hermes composing the queue from `data show`, `model proposals list`, and `data anomalies`: three outputs not designed for a shell agent, a page of assembly logic in the prompt, and every new field a prompt change.
- One-time decision tokens: strongest against a poisoned message, but a token table and a command family for a threat the id-in-latest-inbox rule covers, since only the user's reply carries a verb.
- A generic HTTP series flow source: no consumer yet.
- The bootstrap as a deep run in a special mode: skills, budgets, and cadence all key on run type, so a mode would need a parallel switch in each.

## 15. Amendments made during execution and review (2026-09-22/23)

The plan was generated from a per-task prototype and applied byte for byte; the task reviews then found design defects in four of five tasks, each ruled on by the controller with the spec's invariants as the authority. Where this section and an earlier one disagree, this section governs.

1. **`move_pct` is measured at now (4.1).** The inbox measures a provisional row's move against the last CONFIRMED value in force at now, not at the row's `observed_at`: that is the baseline the tool's move guard uses, which is the stated purpose. `buildInbox(db, asset, nowIso)`; the tick passes its clock, the CLI its own, and reuses it for `as_of`.
2. **The inbox never fails a tick (4.2).** `buildInbox` is guarded in the tick's finalizer: on a throw (a stored shape the schema does not expect) the report carries an empty inbox and stderr warns; `report.error` is not set.
3. **Invariant 5 is enforced in code (7.3).** A bootstrap is never offered `apply_assumption_change`, set or no set (`get_assumptions` stays when a set exists); `ToolContext` carries the run type and `propose_change` refuses `kind: 'config'` on a bootstrap (`not_in_bootstrap`). 7.3's "behaves as a deep run for assumptions" is withdrawn.
4. **Without an assumption set only bootstraps are due (7.2).** `dueRunType` returns `bootstrap` at once when none was attempted, else again `weekly_days` after the last bootstrap attempt, and never `weekly` or `deep`, which fail preflight without a set. Once a set exists the rules of 7.2 apply unchanged. A bootstrap that ran out of budget is therefore retried weekly at its full cost until the user imports a set or disables the cadence.
5. **`manual_metrics` in the context pack (7.3, 7.4).** The pack's `asset` block lists the sorted keys of every metric with no `source`; the bootstrap skill works through that list, the ones with no value in force first.
6. **The API-series writer (8.2).** The cursor key is the source id AND the metric (`<sourceId>><metric>`), so `--metric` narrowing cannot leave gaps; the primary is served from its batch rather than a flow group (`data sources` is unaffected). With `--adopt`, every overlapping manual row is retired up front inside the transaction, whether or not its day is rewritten; retirements are reported only after the commit. The days read are the revision window (the last three written days) plus each GAP day individually: a day inside the backfill window, at or after the series' first day, that no active row of the metric covers (manual rows included, period-aware). A gap is retried on every run until it appears; the days between a gap and the window are not re-read, so the three-day revision limit holds; a permanently absent day costs one skipped-day note per run. Section 13's "a revision older than that is not picked up" stands; "a late day is lost" is withdrawn.
7. **Migration 5 runs with foreign keys off, checked after (9).** `MIGRATIONS[].rebuildsTables` makes `migrate()` switch the pragma off outside the transaction, run `foreign_key_check` inside it (a violation rolls the migration back), and restore it in `finally`. The AUTOINCREMENT counter is carried across the rebuild explicitly.
8. **Event metrics (6).** Event metrics cannot carry a source today, so the exception of section 6 is reachable only for `schedule` metrics; the code covers both.
