# Orion Sub-project 3: The Agent Layer

Date: 2026-09-20
Status: Draft for review
Parent: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (the umbrella spec; binding where this document is silent, amended where section 15 says so)
Builds on: sub-projects 1 and 2, on `main` at `ef0fe8c`, 335 tests, engine 1.2.0

## 1. Purpose and scope

Give each covered asset an AI analyst persona that maintains the assumptions behind its targets, triages data problems, researches manual metrics, and explains itself, inside guardrails that code enforces and the prompt does not.

In scope:

1. A persona runner over the Claude API. Personas and skills are markdown files in git.
2. Run types `weekly`, `triage`, and `deep`.
3. A guarded tool layer: agent bands, max step, evidence, the degrading-anomaly block, the move guard, verified citations, token and turn budgets, one commit per run.
4. A journal: the agent's memory between runs.
5. Web research that records provisional observations with verified citations.
6. A proposals workflow: list, show, approve, reject, including the in-place YAML edit for config proposals.
7. Per-scenario agent bands in the asset YAML (deferred from sub-projects 1 and 2).
8. Additive signal fields: `change.cause: config`, `change.causes`, `change.author`, `provenance.agent_run_id`.
9. Tests with a scripted fake model. CI makes no live API calls.

Out of scope (sub-project 4): `orion tick`, automatic trigger evaluation, the run lock, webhooks. Also out: the `peer-multiple-selection` skill (section 9), and the deferred items listed in section 14.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Model | `claude-opus-5` by default, named in each persona's frontmatter and overridable there. Adaptive thinking; `effort` from the persona file, default `high`. |
| Credentials | `ANTHROPIC_API_KEY` from `<ORION_HOME>/.env` or the environment when set; otherwise the SDK resolves credentials itself (so an `ant auth login` profile works). Nothing resolvable fails preflight, before any model call. Recommended practice: a dedicated Console workspace and key with a monthly spend limit. |
| Refusal fallback | Enabled: server-side `fallbacks: "default"`. A declined turn is rerun on a fallback model inside the same call; the transcript records which model served. |
| Per-scenario bounds | Agent bands. Key-wide `min`/`max` bind everyone, as today. Optional `bear`/`base`/`bull` sub-ranges bind the agent only. Max step is a fraction of the scenario's band. |
| Anomaly authority | The agent may resolve an open anomaly with a note and evidence. Acknowledging, and withdrawing an acknowledgement, are proposals. Acknowledged anomalies are read-only to the agent. |
| Write block | Only open `degrading` anomalies block assumption writes. Advisory anomalies are shown and handled by skill instructions. |
| Authority tiers | Section 5.1. |
| Config proposals | Approve edits `assets/<id>.yaml` in place, preserving comments; the user commits. |
| Research trust | Verified citations always. On a critical metric that allows provisional data, a researched value more than `provisional_move_pct` (default 25) from the value in force becomes a proposal instead of a live row. |
| Signal change block | Additive fields; `schema_version` stays 1. |
| One transaction per run | A staging ledger: writes are validated and queued in memory, merged into the agent's reads, and applied through the real write functions in one short transaction on a clean finish. |
| Loop | A manual tool-use loop behind a one-method `ModelClient` interface, not the SDK's beta tool runner. |

### Cost expectation (estimates, not measurements)

At Opus 5 list prices ($5 input, $25 output per million tokens) with prompt caching: a weekly run about $0.70, a deep run with research $2.50 to $4, a triage run $0.30 to $1.50; about $10 per month for VVV (4 weekly, 1 deep, about 4 triage). Budgets (section 4.4) cap the worst case at about $4 weekly and $12 deep with no cache hits at all. Web search bills at $10 per 1,000 searches. `agent_runs` records real token counts from the first run on.

## 2. Facts this design rests on

- `personas/` and `skills/` exist and are empty. There is no loader, no Anthropic SDK dependency, and none of the umbrella spec's agent tables.
- The write paths the agent must call through: `saveAssumptions` (`src/app/assumptions.ts`), `insertObservation`, `confirmObservation`, `rejectObservation` (`src/db/observations.ts`), `decideAnomaly` (`src/db/anomalies.ts`), `runValuation` and `whatIf` (`src/app/valuation.ts`).
- better-sqlite3 transactions are synchronous. An agent run awaits the API for minutes. A transaction held open that long holds SQLite's write lock against `orion update`.
- VVV's bounds are per key and wide: `rev_growth_y1` is `[-0.3, 2.5]` for all scenarios, with bear at 0.25 and bull at 2.0. A 25 percent step of that range is 0.7 per run.
- The `observations.source` CHECK constraint allows `onchain`, `api`, `manual`. Provisional status, not source, drives provenance.
- An acknowledged anomaly stands across recurrences; a resolved one whose condition persists reopens at the next fetch (ingestion spec 6.3).
- Claude API (from the `claude-api` skill reference, cached 2026-06-24): `claude-opus-5` runs adaptive thinking by default and rejects `budget_tokens` and sampling parameters; server tools `web_search_20260209` and `web_fetch_20260209` run on Anthropic's side and can end a turn with `stop_reason: "pause_turn"`; the SDK's tool runner does not resume `pause_turn`; `fallbacks: "default"` needs `client.beta.messages` and beta header `server-side-fallback-2026-07-01`; top-level `cache_control: {type: "ephemeral"}` caches the growing prefix; parallel tool calls must be answered in one user message.
- (unverified; section 12) Whether `web_fetch_20260209`, which filters page content with server-side code, still returns the full page text to the client transcript. Citation verification reads it there.
- (unverified; section 12) Whether the `yaml` Document API preserves the flow-style maps and comments in `assets/vvv.yaml` through `setIn`.

## 3. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/config/personas.ts` | Load `personas/*.md` and `skills/*.md`; validate frontmatter with zod; content hashes. | nothing |
| `src/config/edit.ts` | Comment-preserving edits to an asset YAML by segment path (section 6.3). | `yaml` |
| `src/agent/model.ts` | `ModelClient`: `send(request) -> Promise<Anthropic.Message>`. `anthropicModelClient(env)` is the only place the SDK client is constructed. | `@anthropic-ai/sdk` |
| `src/agent/loop.ts` | The tool-use loop: dispatches client tools, resumes `pause_turn`, stops on `refusal` and `max_tokens`, enforces budgets, accumulates usage and the transcript. Knows nothing of Orion's domain. | `model.ts` |
| `src/agent/guardrails.ts` | Pure rule functions: band, max step, evidence, anomaly block, move guard, citation match. | config types |
| `src/agent/ledger.ts` | Staged writes, merged reads, `commit(db)`. | `src/app`, `src/db` |
| `src/agent/research.ts` | Extracts fetched pages (URL and text) from the transcript for citation verification. | SDK types |
| `src/agent/tools/read.ts`, `think.ts`, `write.ts` | One object per tool: name, description, zod input schema, `run(ctx, input)`. Write tools call guardrails, then the ledger; they never touch the database. | guardrails, ledger, `src/app` |
| `src/agent/context.ts` | Builds the context pack. | `src/app`, `src/db` |
| `src/agent/prompt.ts` | System prompt: persona body, operating rules, the run type's skills, in a fixed order. | personas |
| `src/agent/run.ts` | `runAgent(db, loaded, opts, deps)`: the lifecycle in section 4. | all of the above |
| `src/app/proposals.ts` | Approve and reject, per kind (section 6). | `src/db`, `src/config/edit.ts` |
| `src/db/agentRuns.ts`, `proposals.ts`, `journal.ts`, `coverage.ts`, `assumptionChanges.ts` | Migration 3 stores. | db |
| `src/cli/commands/agent.ts`, `persona.ts`; additions to `model.ts` | Command surface (section 10). | app, agent |

### Invariants (additions to the umbrella and ingestion specs)

1. **Guardrails live in the tool layer.** No rule in sections 5 to 7 depends on the model obeying its prompt.
2. **The agent calls through, not around.** Every committed write goes through the same function the CLI uses. The agent layer contains no SQL against sub-project 1 and 2 tables.
3. **A run's domain writes are all-or-nothing.** Every outcome except `completed` commits nothing.
4. **The run record always survives.** The `agent_runs` row, transcript, and token usage are written outside the ledger, whatever the outcome.
5. **Nothing the agent reads from the web reaches the database except as a cited, verified, provisional observation or a proposal.**
6. **The agent cannot change its own limits.** Nothing under `agent:` in the asset YAML, no persona or skill file, and no budget is reachable by any tool or proposable.
7. **Only `src/agent/model.ts` imports the SDK client.** Tests never import that constructor.

## 4. Run lifecycle

### 4.1 Command

```
orion agent run <asset> --type weekly|triage|deep [--anomaly <id>] [--note <text>] [--dry-run] [--out file] [--json]
```

The persona comes from `coverage`. `triage` requires `--anomaly`, `--note`, or both. The note is placed in the context pack labelled as an unverified lead; it is not an observation and so can never be cited as evidence. `trigger` is recorded as `manual`.

### 4.2 Steps

1. **Preflight, before any model call.** The asset loads; a persona is assigned and loads; the run type's skills load; an assumption set exists; an `--anomaly` target exists, belongs to the asset, and is open; credentials resolve. Any `running` row for this asset older than one hour is marked `error` with `abandoned`. Then the `agent_runs` row is inserted as `running`, with the agent config hash: sha256 over the asset config hash, the persona hash, the loaded skill hashes, and the constant `TOOL_LAYER_VERSION`.
2. **Context pack**, one user message (section 4.3).
3. **Loop** (section 8), with the tools in section 5. Every run type gets the same tools; run types differ in skills and budgets.
4. **Clean finish** means the model ended its turn and a journal entry is staged. If the entry is missing, the runner sends one reminder as a user message. Still missing: outcome `no_journal`.
5. **Commit and value.** `ledger.commit(db)` applies everything in one transaction (section 7.3). Then `runValuation` runs, with the agent run id, only if the commit wrote an assumption set, an observation, or an anomaly resolution. The signal is printed and appended to `--out` as `orion update` does. If `runValuation` throws, the commit stands, the run is `completed`, and the summary records the valuation error.
6. **Finalize** the `agent_runs` row: outcome, usage, summary, transcript.

`--dry-run` performs steps 1 to 4 and 6, skips step 5, and prints what would have been committed. It spends tokens.

### 4.3 Context pack

- Asset id, name, run type, the triage target (anomaly detail, note), the run's budgets.
- Drivers now, each with provenance and age, beside the drivers as of the previous completed agent run's start (omitted on the first run).
- Open anomalies of both severities. Acknowledged anomalies, marked read-only, with latest detail, `occurrences`, and `last_seen_at`.
- Stale metrics and provisional metrics from the driver report.
- Current assumptions per scenario, each with its key-wide bounds, its agent band, and the range allowed this run (band intersected with the max step).
- The latest signal (compact) and the last eight 12m expected targets with dates.
- Pending proposals. The ten most recently decided proposals with status and decision note.
- The last three journal entries.
- Source failures from the last seven fetch runs.
- Calendar events from `review_triggers.calendar` dated within the next 30 days.

Every observation id that appears in the pack counts as shown (section 5.3).

### 4.4 Budgets

Defaults in code; `agent.budgets` in the asset YAML overrides per run type and per field.

| Run type | Model requests | Input tokens | Output tokens | Web searches | Web fetches | Proposals |
|---|---|---|---|---|---|---|
| `weekly` | 25 | 600,000 | 40,000 | 5 | 5 | 10 |
| `triage` | 20 | 500,000 | 30,000 | 8 | 8 | 10 |
| `deep` | 40 | 2,000,000 | 80,000 | 15 | 15 | 10 |

Input tokens are `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` summed over requests. The request and token budgets are checked before each request; when either is spent the run ends `budget_exhausted`. Web limits are passed to the server tools as `max_uses`; fetched pages are capped with `max_content_tokens: 25000`. Every client tool result carries `budget: { requests_left, input_tokens_left, output_tokens_left }`.

### 4.5 Outcomes

| Outcome | Meaning | Commits |
|---|---|---|
| `completed` | Clean finish, with or without changes | yes |
| `budget_exhausted` | A request or token budget ran out | no |
| `refused` | The final response has `stop_reason: "refusal"` (the whole fallback chain declined) | no |
| `no_journal` | No journal entry after the reminder | no |
| `conflict` | A commit-time re-validation failed (section 7.3) | no |
| `error` | API error after the SDK's retries, `max_tokens` mid-tool-call, or an internal exception | no |

## 5. Tools and guardrails

### 5.1 Authority tiers

| Tier | Actions |
|---|---|
| **Applies directly**, guarded | Assumption values inside the agent band and max step, with evidence and no open degrading anomaly. Resolving an open anomaly with evidence. Recording a provisional observation with a verified citation. The journal entry. |
| **Proposal** | Assumption values outside the band or step, or outside key-wide bounds. Any asset YAML change except under `agent:` and `id`: module weights, enablement, and params; scenario probabilities; key-wide bounds and agent bands; `supply_basis`; peer set; review triggers; metric definitions and source config (allowlists, tolerances, staleness). Acknowledging an anomaly or withdrawing an acknowledgement. Confirming or rejecting any observation. A move-guarded researched observation. |
| **Never** | Anything in a signal or target. Persona and skill files. `agent:` settings and budgets. Another asset. Deleting anything. |

### 5.2 Tool list

| Group | Tool | Notes |
|---|---|---|
| Read | `get_drivers {as_of?}` | The driver report at `as_of` (default now). |
| Read | `get_observations {metric, limit?, include_inactive?}` | Newest first, staged rows included. |
| Read | `get_anomalies {include_decided?}` | Staged resolutions reflected. |
| Read | `get_assumptions {}` | The staged view, with bounds, bands, and allowed ranges. |
| Read | `get_signal_history {limit?}` | Compact signals, newest first. |
| Read | `get_journal {limit?, before_id?}` | Entries older than the pack's three. |
| Think | `run_whatif {overrides[]}` | `whatIf` with staged assumption changes and staged observations underneath the given overrides. Bounds not enforced. Nothing persisted or staged. |
| Write | `apply_assumption_change`, `propose_change`, `resolve_anomaly`, `record_provisional_observation`, `write_journal` | Sections 5.3 to 5.7. |
| Research | `web_search`, `web_fetch` | Anthropic server tools; section 8. |

Tool inputs are validated with zod; the API's `input_schema` is generated from the same zod objects. A validation failure or a guardrail refusal is returned as an `is_error` tool result: `{ refused: <reason_code>, message, ...numbers the agent needs }`. The loop continues. Only an unexpected exception ends the run as `error`.

### 5.3 `apply_assumption_change {key, scenario: bear|base|bull|all, value, evidence[], rationale}`

Checks, in order. With `all`, every scenario must pass or nothing is staged.

1. `key` is in `requiredAssumptionKeys(asset)`; `value` is finite; `rationale` is not blank.
2. **Anomaly block.** If any `degrading` anomaly on the asset is open and not staged-resolved: refused `anomaly_block`, listing the ids.
3. **Evidence.** At least one observation id. Each must belong to the asset, be active (or staged in this run), and have been **shown in this run**: present in the context pack, in a read tool's result, or staged by this run. Otherwise refused `evidence_not_shown` or `evidence_invalid`.
4. **Bounds and band.** Outside the key-wide bounds, or outside the scenario's agent band: nothing is applied; an `assumption_value` proposal is staged with the same rationale and evidence; the result says `converted_to_proposal` and why. (A value outside key-wide bounds can be approved only after the bounds change; section 6.2.)
5. **Max step.** `abs(value - start) <= max_step_fraction * (band.max - band.min)`, where `start` is the committed value when the run began and the band defaults to the key-wide bounds when the key has no band for that scenario. Otherwise refused `max_step`, returning the allowed range. The agent may then apply the largest step and propose the rest. Measuring from `start` means repeated calls cannot ratchet.
6. **Whole-set validity.** The committed values merged with all staged changes must pass `validateAssumptions(asset, values)`. Otherwise refused `invalid_set` with the errors.

A later call for the same key and scenario replaces the earlier staged change. When the committed value is itself outside its band (the user set it by hand), the allowed range is still the band intersected with the step, so the agent can only move it toward the band or propose.

### 5.4 `resolve_anomaly {id, note, evidence[]}`

The anomaly belongs to the asset and is `open` (an acknowledged anomaly is refused `acknowledged_is_read_only`); the note is not blank; evidence follows rule 3 above. Staged; commit calls `decideAnomaly(..., 'resolved', note, now, persona)`.

### 5.5 `record_provisional_observation {metric, value, observed_at, period_days?, citation_url, quoted_text}`

1. The metric is declared in the asset and has **no configured `source`**: refused `fetched_metric` otherwise. The agent never writes onto a fetched metric.
2. `value` finite; `observed_at` parses; a future `observed_at` is allowed only for `schedule` and `event` metrics; `period_days` is required for `flow` metrics and positive.
3. **Verified citation.** `citation_url` must match the URL of a page fetched by `web_fetch` in this run (after normalizing the fragment and a trailing slash), and `quoted_text`, at least 20 characters, must occur in that page's text after both are whitespace-normalized and the page is stripped of HTML tags and entity-decoded. Otherwise refused `citation_not_fetched` or `quote_not_found`.
4. **Routing.**
   - Metric has `allow_provisional: false`: staged as a provisional observation. It stays out of every signal until `orion data confirm`, as today.
   - Metric has `allow_provisional: true`, is `critical`, and either no value is in force or `abs(value / in_force - 1) * 100 > provisional_move_pct`: staged as an `observation` proposal (section 6.2). The result says `converted_to_proposal`. Such a value has no observation id and cannot be cited as evidence.
   - Otherwise: staged as a provisional observation; it goes live at grade C.

Staged observations get temporary negative ids, usable as evidence in the same run and remapped at commit. Committed rows are `source: manual`, `status: provisional`, `source_detail: research:<persona>:run <agent_run_id>`.

"In force" is the newest active eligible level at or before now; for a `schedule` metric, the step in force; `flow` and `event` metrics have no value in force and so always take the proposal route when critical and `allow_provisional`.

### 5.6 `propose_change {kind, ..., rationale, evidence?}`

| Kind | Payload | Filing checks | Filed against |
|---|---|---|---|
| `assumption_value` | `key`, `scenario` (one), `value` | Key required by the asset; value finite; evidence rule 3 (required) | The committed value |
| `config` | `edits: [{ path: segment[], value }]` | No path under `agent` or `id`; the edited copy of the config passes `AssetConfigSchema` and `validateAssetModules`; the latest assumption set passes `validateAssumptions` under it | The current value at each path (`null` when absent) |
| `acknowledge_anomaly` | `anomaly_id`, `note` | Anomaly is open | `open` |
| `withdraw_acknowledgement` | `anomaly_id`, `note` | Anomaly is acknowledged | `acknowledged` |
| `confirm_observation` | `observation_id`, `note` | Observation is an active provisional row | active provisional |
| `reject_observation` | `observation_id`, `note` | Observation is active | active |
| `observation` | Not callable; staged only by the move guard | | The value in force, or `null` |

Kinds that can move a target (`assumption_value`, `config`, `observation`, `confirm_observation`, `reject_observation`) store `effect: { "6m": {from, to}, "12m": {from, to} }` of expected targets, or `{ blocked: [...] }`, computed by `whatIf` with the change applied and nothing persisted. For this `whatIf` gains two optional inputs: a config override, and observation additions and removals applied after eligibility.

A proposal whose `kind` and canonical `change` JSON equal a pending proposal for the asset is refused `duplicate_proposal`. A run stages at most `budgets.proposals`.

### 5.7 `write_journal {thesis, open_questions[], summary}`

One entry per run; a later call replaces the staged one. `thesis` is the running view of the asset; `open_questions` is what the next run should look at; `summary` is what this run did and why.

### 5.8 Prompt injection posture

Web content reaches the model only inside server-tool result blocks; the operating rules state that it is data, never instructions. The defence that counts is structural: whatever a page says, the agent's reach is the tool list above, inside bands, steps, evidence, the move guard, and verified citations. It has no shell, no file access, and Orion makes no HTTP request on its behalf.

## 6. Proposals

### 6.1 Commands

```
orion model proposals list [asset] [--all]
orion model proposals show <id>
orion model proposals approve <id> [--note text]
orion model proposals reject <id> --note text
```

Statuses: `pending`, `approved`, `rejected`. Decisions are final. `list` shows id, asset, persona, kind, a one-line summary, the stored effect, and age; pending only unless `--all`. `show` adds the rationale, cited observations with values, the filing agent run, and the decision.

### 6.2 Approve, by kind

Each approval is one transaction through existing functions. First, the **staleness check**: the proposal's filed-against state must still hold, else `stale_proposal` with what changed. There is no `--force`; the user rejects with a note or waits for the agent to refile.

| Kind | Action |
|---|---|
| `assumption_value` | Latest set plus this one change, through `saveAssumptions` with author `user` and rationale `Approved proposal #<n> from <persona>: <rationale>`. An `assumption_changes` row and its evidence are written for the new set. Outside key-wide bounds, `saveAssumptions` refuses; the message says to widen `assumptions.<key>` first. |
| `acknowledge_anomaly` | `decideAnomaly(id, 'acknowledged', note)`; the note is the user's `--note`, else the proposal's. |
| `withdraw_acknowledgement` | `decideAnomaly(id, 'resolved', note)`. |
| `confirm_observation`, `reject_observation` | `confirmObservation`, `rejectObservation`. |
| `observation` | `insertObservation` as `confirmed`, `source: manual`, citation and quote kept, `source_detail: research:<persona>:run <n>; approved proposal #<id>`. |
| `config` | Section 6.3. |

Approve does not run a valuation. The next `orion update` does, and its `change` block explains the move. `reject` requires a note. Decision notes appear in later context packs.

### 6.3 The YAML edit

A path is an array of segments. A string segment selects a map key; on a sequence whose items have an `id` (modules, holder flows, total-return variants), a string segment selects the item with that id; an integer selects by index. A value may be a scalar, a map, a list, or `null` to delete the key.

1. Read `assets/<id>.yaml`. Check each path against its filed-against value by deep equality: mismatch is `stale_proposal`.
2. Apply the edits with the `yaml` Document API, preserving comments, key order, and flow style.
3. Validate the new text: `parseAssetYaml`, `validateAssetModules`, and `validateAssumptions` for the latest assumption set.
4. Write `<file>.tmp`, then rename over the original.
5. Mark the proposal approved. If that write throws, restore the original text and rethrow.

Approve prints the changed paths with old and new values and reminds the user to review `git diff` and commit. The edit happens wherever the command runs; carrying it between server and laptop is the user's operational choice.

## 7. The staging ledger

### 7.1 Staged state

`assumptionChanges` (keyed by key and scenario: value, rationale, evidence, start value), `anomalyResolutions`, `observations` (with temporary negative ids), `proposals`, `journal` (at most one), `shownObservationIds`.

### 7.2 Merged reads

`get_assumptions` and the step check see staged values over committed ones. The anomaly block and `get_anomalies` see staged resolutions. `get_observations` lists staged rows. `run_whatif` and proposal effects pass staged assumption changes as overrides and staged observations as additions to `whatIf`.

### 7.3 Commit

One `db.transaction()`, in this order:

1. **Conflict checks.** The latest assumption-set version equals the version at run start, when any assumption change is staged. Each anomaly to resolve is still `open`. Any failure throws `AgentConflict`; the transaction rolls back; the outcome is `conflict`.
2. Insert staged observations through `insertObservation`; build the temporary-to-real id map.
3. If assumption changes are staged: one `saveAssumptions` call with author = persona name and a generated digest rationale (`<key> <scenario> <from> -> <to>: <rationale>; ...`), then one `assumption_changes` row per change with its remapped `assumption_evidence` rows.
4. `decideAnomaly` per resolution, with `decidedBy` = persona name and the evidence ids appended to the note.
5. Insert proposals (evidence remapped) and the journal entry.
6. Return the summary: set version, observation ids, anomaly ids, proposal ids, journal id.

An `OrionError` from a real write function during commit (for example `invalid_assumptions` because the config changed mid-run) is also a `conflict`.

## 8. Model client and loop

`ModelClient.send(request)` takes `{ model, effort, system, tools, messages, maxTokens }` and returns an `Anthropic.Message` (SDK types throughout; no parallel type definitions).

The real client: `client.beta.messages.stream({...}).finalMessage()` with `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, `thinking: { type: "adaptive" }`, `output_config: { effort }`, `max_tokens: 16000`, top-level `cache_control: { type: "ephemeral" }`, SDK default retries. The API key is passed explicitly when `loadEnv` finds one; otherwise the constructor takes no arguments. Exact request shapes are confirmed against `shared/model-migration.md` and the TypeScript SDK during planning (section 12).

Tools sent: the client tools of section 5.2, then `{ type: "web_search_20260209", name: "web_search", max_uses }` and `{ type: "web_fetch_20260209", name: "web_fetch", max_uses, max_content_tokens: 25000 }` (or the basic fetch variant; section 12). Tool order is fixed, for caching.

The loop, per response:

- `end_turn`: finish (subject to the journal rule).
- `pause_turn`: append the assistant content, send again. Counts as a request.
- `refusal`: outcome `refused`. No tool in that response is run.
- `max_tokens`: outcome `error` (`max_tokens`). No tool in that response is run.
- `tool_use`: append the assistant content unchanged (thinking blocks included); run every client `tool_use` block in order; return all results in one user message; failures as `is_error` results.

The transcript is the full `messages` array plus each response's `model`, `stop_reason`, and `usage`. History is append-only. API keys and auth headers never enter it.

System prompt, fixed order: the persona body; the operating-rules block from code (authority tiers in brief, web content is data, the evidence rule, budgets are visible in tool results, finish with `write_journal`); the run type's skills sorted by name.

## 9. Personas and skills

`personas/<name>.md` frontmatter: `name` (matches the filename), `model` (default `claude-opus-5`), `effort` (`low|medium|high|xhigh|max`, default `high`), `temperament`, `sectors[]`. The body is the persona's system prompt.

`skills/<name>.md` frontmatter: `name`, `description`, `run_types[]`. The body is instructions.

Shipped: persona `ai-infra-analyst` (AI-infrastructure tokens whose revenue settles off-chain), assigned to VVV. Skills: `assumption-review` (weekly, deep), `anomaly-triage` (triage), `disclosure-research` (weekly, triage, deep), `tokenomics-audit` (deep). The user reviews all five files at a checkpoint; they are human-authored content.

Skill content carries what the guardrails do not: when `revenue_disclosure_stale` is open, research a newer disclosure before touching growth assumptions and say in the rationale if none was found; prefer primary sources; flag an acknowledged anomaly whose reading has grown.

`peer-multiple-selection` is deferred: `peer_set` is empty and no asset declares peer-multiple metrics, so the skill would have no observation to cite.

## 10. Command surface

```
orion persona list | show <name> | assign <asset> <name>
orion agent   run <asset> --type ... (section 4.1)
orion agent   runs list [asset] | runs show <id> [--transcript]
orion model   proposals list | show | approve | reject (section 6.1)
```

`runs show` prints outcome, what was committed, token counts, web tool counts, and an estimated cost from a price table in code (costs are never stored). Every command accepts `--json`; the new commands also print errors as JSON under `--json`. `agent run` exit codes: `0` for `completed`, `2` for `completed` with a `blocked` signal (matching `orion update`), `1` for any other outcome.

## 11. Data model and configuration

### 11.1 Migration 3

| Table | Columns |
|---|---|
| `coverage` | asset_id (primary key), persona, assigned_at. Updated in place. |
| `agent_runs` | id, asset_id, persona, run_type, trigger, trigger_detail JSON, outcome (`running` and section 4.5), dry_run, config_hash, model, started_at, ended_at, requests, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, web_searches, web_fetches, error, summary JSON |
| `agent_transcripts` | run_id (primary key), messages JSON |
| `proposals` | id, asset_id, persona, agent_run_id, kind, change JSON, filed_against JSON, rationale, evidence JSON, effect JSON, status, created_at, decided_at, decision_note |
| `assumption_changes` | id, set_id, key, scenario, from_value, to_value, rationale |
| `assumption_evidence` | change_id, observation_id; primary key both |
| `journal` | id, asset_id, persona, agent_run_id, created_at, thesis, open_questions JSON, summary |

Column additions: `anomalies.decided_by` (null means the user), `valuation_runs.agent_run_id` (nullable; not an engine input, replay unaffected).

`agent_runs` is updated in place while a run is in flight; `proposals` on decision; the rest are append-only.

### 11.2 Asset YAML

All optional with no defaults, so existing config hashes do not move.

```yaml
assumptions:
  rev_growth_y1:
    min: -0.3
    max: 2.5
    bear: { min: -0.3, max: 0.625 }
    base: { min: 0.625, max: 1.5 }
    bull: { min: 1.5, max: 2.5 }
agent:
  max_step_fraction: 0.25        # default 0.25; must be in (0, 1]
  budgets: { weekly: { requests: 25 } }   # partial overrides of section 4.4
review_triggers:
  provisional_move_pct: 25       # default 25; positive
```

Band validation: `min <= max`, inside the key-wide bounds. Bands may touch or overlap; that is calibration, not schema. `saveAssumptions` and `validateAssumptions` keep checking key-wide bounds only.

VVV's starting bands come from the midpoint rule (each band runs halfway to the neighbouring scenario's calibrated value, the outer edges at the key-wide bounds) and are reviewed by the user at a calibration checkpoint with a sensitivity table of each band edge's effect on the 12m target. Adding them changes VVV's config hash once; the next signal reports `cause: config`.

### 11.3 Signal (schema version 1, additive)

- `change.cause` gains `config`: the previous signal's `provenance.config_hash` differs. `both` now means more than one cause.
- `change.causes`: the causes present, in the order `data`, `assumptions`, `config`.
- `change.author`: the latest set's author when `assumptions` is a cause, else `null`.
- `provenance.agent_run_id`: the agent run that triggered the valuation, else `null`.

All three are optional when parsing stored signals. `signalSummary` prints the author.

## 12. Verification before and during planning

1. **Live probe (a few cents; needs the user's go-ahead):** one request with `web_fetch_20260209` on a static page; confirm the `web_fetch_tool_result` in the client response carries the page text. If it does not, the runner declares `web_fetch_20250910`, confirmed the same way.
2. **Local:** round-trip `assets/vvv.yaml` through the `yaml` Document API with a `setIn` on a flow-style bounds map and on a module weight; diff must show only the edited values.
3. **Reference:** read `shared/model-migration.md` (refusal fallback, Opus 5) and `typescript/claude-api/streaming.md` before writing `model.ts`; confirm that `z.toJSONSchema` output is accepted as `input_schema`.
4. **Every plan task is verified by extraction** in a scratch tree, with the suite and `tsc` run at each task boundary, as in sub-project 2.
5. The broad final whole-branch review stays, pointed at cross-task interactions: ledger versus real write functions, staged ids versus evidence, proposals versus config hash and `change.cause`.

## 13. Testing

No network in CI. Tests run under `ORION_HOME=$(mktemp -d)`-style temp homes; nothing touches the repo-root `orion.db`.

- **Guardrails, pure:** bands and fallback to key-wide bounds; step measured from run start (no ratchet); committed value outside its band; shown-evidence; severity block and its lifting by a staged resolution; move guard edges, no value in force, schedule step; quote matching through whitespace, tags, and entities; URL normalization.
- **Ledger:** merged reads; commit through the real functions; one set version from several changes; temporary-id remapping into evidence; the world changing mid-run (the user saves a set, an anomaly is decided, the config tightens) gives `conflict` and no writes; dry run.
- **Loop with the scripted fake model:** parallel tool calls answered in one message; `pause_turn` resume; `refusal`; `max_tokens`; request and token budgets; the journal reminder; invalid tool input; thinking blocks passed back unchanged.
- **End to end on the VVV fixture with the fake model:** a weekly change (set, changes, evidence, journal, signal with `author` and `agent_run_id`); triage resolving a degrading anomaly restores the grade; out-of-band becomes a proposal; research from canned `web_fetch` blocks; the move guard; a rolled-back run leaves only its run row and transcript; a no-change run emits no signal.
- **Proposals:** each kind's approve; reject needs a note; staleness per kind; duplicate refusal; the YAML edit on a copy of the real `vvv.yaml` with comments intact; restore when the status write fails; effect computation including a blocked effect.
- **Config and signal:** band validation; fixture config hashes unchanged; `cause: config`, `causes`, `author`; stored signals without the new fields still parse.
- **Personas and skills:** frontmatter validation, run-type selection, hashes, prompt order.
- **CLI:** the new commands, `--json` errors, exit codes, preflight failures costing no model call.
- **Live, in the plan's checkpoints, not CI:** a `--dry-run` weekly run on VVV, then a first real run.

## 14. Build order

1. Migration 3 and stores; the `@anthropic-ai/sdk` dependency.
2. Config additions (bands, `agent`, `provisional_move_pct`); persona and skill loader.
3. Guardrails.
4. `whatIf` inputs (config override, observation additions and removals); `runValuation` agent run id; the signal change block.
5. Ledger.
6. Tools.
7. Model client, scripted fake model, loop.
8. Context pack, prompt assembly, `runAgent`.
9. Proposals and the YAML edit.
10. CLI, README, a line in `docs/ops/hermes-daily-job.md` suggesting the daily job report pending proposals.
11. Persona and skill drafts.
12. User checkpoints: VVV band calibration; persona and skill review; live `--dry-run` weekly run; first real run.

### Deferred again

Commander errors not JSON under `--json` for existing commands; offset-less timestamps parsing as local time; the grade counting non-required manual metrics; the as-of case of `change.cause`; the sub-project 1 and 2 test-gap lists.

## 15. Amendments to the umbrella spec

- 7.1: four initial skills; `peer-multiple-selection` deferred.
- 7.4: "An out-of-bounds value is converted into a proposal" extends to out-of-band values. "Any open anomaly blocks" becomes "any open `degrading` anomaly blocks". Max step is a fraction of the scenario's agent band. Agent bands, module params, peer set, review triggers, source config, acknowledgements, and observation confirm and reject join the proposal-only list.
- 5.2: `assumption_evidence` hangs off a new `assumption_changes` table; `agent_transcripts` is split from `agent_runs`.
- 6: on a critical metric, `allow_provisional` no longer lets a researched value more than `provisional_move_pct` from the value in force go live unattended.
- 9: the `change` and `provenance` additions in section 11.3.

## 16. Known limitations carried forward

- No run lock until sub-project 4. Two simultaneous agent runs are safe (the later commit conflicts if they overlap) but wasteful.
- Evidence must be real, active, and seen; its relevance to the change is not checked mechanically.
- Citation verification catches invented citations, not misread pages. Pages that need JavaScript or a login cannot be cited.
- A resolved anomaly whose condition persists reopens at the next fetch; the agent's remedy for a persistent, understood condition is an acknowledgement proposal.
- Transcripts grow the database; a deep run can store a few megabytes.
- Proposal effects are computed at filing time and are not refreshed as data moves.
