# Orion sub-project 4: scheduling and delivery

Date: 2026-09-21. Status: approved; plan generated and verified by extraction the same day (section 15).

Extends `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (sections 8 and 9) and `docs/superpowers/specs/2026-09-20-orion-agent-layer-design.md` (sections 4 and 11). Where this document and those differ, this one wins for the items it covers.

## 1. Purpose and scope

Give Orion one scheduled entry point, `orion tick`, that runs the whole daily loop in one process: ingest, engine re-run and signal, trigger evaluation, then the one agent run that is due or triggered. Until now the scheduler ran `orion update` only, and the user launched every agent run by hand.

In scope:

1. `orion tick <asset>`: the in-process sequence, its report, its exit codes.
2. Cadence: when a `weekly` or `deep` run is due, from `agent_runs` history and a small config block.
3. Automatic trigger evaluation from `review_triggers`, with per-instance de-duplication in a `trigger_firings` table, launching `triage`.
4. A per-asset run lock in SQLite, replacing the hour-old `abandonStaleRuns` sweep.
5. Delivery: a tick report line on stdout and in `ticks.jsonl`. No webhook.
6. The MUSTs carried from sub-project 3: `reload` required on `RunAgentDeps`; `.immediate()` on `runValuation` and the flow-ingest transaction.
7. Ops: `run-daily.sh` calls `tick`; the Hermes job prompt reads the report.

Out of scope: a webhook (section 6 says what it would add and why not now), multi-asset ticks, a daemon, any change to the engine or to the tools the agent has.

### Decisions made during brainstorming

1. **Due by interval since the last attempt.** A run type is due when no non-dry run of that type started within its interval; a deep run also satisfies weekly; a failed attempt counts, so a broken run is retried next period, not daily. Rejected: retry caps (more state), calendar days (a missed tick skips the week).
2. **One agent run per tick; a due scheduled run absorbs the triggers.** Precedence deep, weekly, triage. Rejected: triage first (starves the weekly), both in one tick (two runs' cost, two runs sharing a lock hold).
3. **Triggers de-duplicate per instance** in a `trigger_firings` table, re-armed when the condition clears. Rejected: deriving from `agent_runs.trigger_detail` (no clear "started" time for staleness), a cooldown (a new degrading anomaly would wait).
4. **The lock is taken by `tick` and `agent run` only.** The commands that run for minutes and spend money. Rejected: every writer (a 10 ms `data confirm` would fail during a run), tick only (a manual `agent run` during a tick still collides).
5. **Driver deviation is revenue only**, anchored at the last agent review. Rejected: every driver with a path function (three anchors for one trigger), deferring it (the key has sat unread in `vvv.yaml` since sub-project 1).
6. **Delivery is a tick report, no webhook.** Hermes is both the scheduler and the reader; a webhook adds nothing until that changes.
7. Manual `agent run`s count toward the cadence (a Tuesday weekly by hand means no Wednesday weekly by tick). The first scheduled run on an asset is `deep`.

## 2. Facts this design rests on

- `updateAsset(db, loaded, now, deps, opts)` (`src/app/update.ts`) already runs ingest then `runValuation`, returning `{ fetch, runId, signal }`. `emitSignal` (`src/signals/emit.ts`) is the only appender to a signals file; the path comes from the caller.
- `runAgent(db, loaded, opts, deps)` (`src/agent/run.ts`) records `trigger: 'manual'` unconditionally; `RunAgentOptions` has `runType, anomalyId, note, dryRun`; `RunAgentDeps.reload` is optional and skipped when absent. `agent_runs.trigger_kind` and `trigger_detail_json` are free text with no CHECK. Triage preflight requires `anomalyId` or `note`.
- `abandonStaleRuns(db, assetId, nowIso)` (`src/db/agentRuns.ts`) is called once, from `runAgent`'s preflight; it marks `running` rows older than one hour `error/abandoned`.
- `review_triggers` is `z.record(z.string(), z.unknown())` with only `revenue_stale_move_pct` and `provisional_move_pct` validated in a refine. `driver_deviation_pct` has no reader. `calendar` is read only by the context pack (`src/agent/context.ts`), as `{ date, note }[]`.
- `AgentConfigSchema` (`agent:`) has `max_step_fraction` and `budgets`; it is unreachable by tools and proposals (`UNPROPOSABLE_ROOTS`).
- Staleness: `computeDrivers` reports `staleMetrics` and `staleCritical`; `critical` is a per-metric flag; `staleness_days` is required per metric.
- Provisional observations: `observations.status = 'provisional'`, active when `superseded_by IS NULL AND status != 'rejected'`; agent-written rows have `agent_run_id` set (`source_detail = research:<persona>:run <id>`).
- `src/engine/paths.ts` exports pure `growthInYear(y, a)` and `revenueAt(tau, r0, a)`. `STD_METRICS.revenue = 'revenue_run_rate_usd'`; `computeDrivers(...).drivers.revenueRunRate` is that driver with `value` and `observedAt`.
- `runValuation` is one deferred `db.transaction`; the flow ingest opens one deferred transaction per scanned day (`src/ingest/flow.ts`). `.immediate()` is already used by the ledger commit, `finishAgentRun`, and `approveProposal`.
- Migrations are a flat array in `src/db/migrations.ts`; the highest id is 3. `openDb` sets WAL and `busy_timeout=5000`.
- `CliContext` provides `home, stdout, stderr, now, setExitCode, ingestDeps?, modelClient?`; `update` maps `blocked` to exit 2 and lets `OrionError` reach the top-level handler for exit 1.
- Tests: vitest; temp homes with `mkdtempSync`; the scripted fake model in `tests/helpers/fakeModel.ts`; the fetch harness in `tests/helpers/fetchHarness.ts`; two-handle concurrency tests in `tests/agent/concurrency.test.ts`.

## 3. Components

| Unit | Path | Does |
|---|---|---|
| Run lock store | `src/db/runLocks.ts` | `acquireRunLock`, `releaseRunLock` over `run_locks` |
| Lock wrapper | `src/app/lock.ts` | `withRunLock(db, assetId, holder, now, fn)`: acquire, run, release in `finally`; takeover abandons stuck runs |
| Cadence | `src/app/cadence.ts` | `dueRunType(db, asset, now)`: `'deep' \| 'weekly' \| null` |
| Firings store | `src/db/triggerFirings.ts` | insert, list, delete, attach run id, over `trigger_firings` |
| Trigger evaluation | `src/app/triggers.ts` | `evaluateTriggers(db, loaded, signal, now, { record })`: the five conditions, de-dup, re-arm |
| Deviation | `src/app/deviation.ts` | `revenueDeviation(anchor, actual, base, now)`: pure math; `revenueAnchor(db, asset, now)` |
| Tick | `src/app/tick.ts` | `tickAsset(db, loaded, now, deps, opts)`: the sequence; builds the report |
| Report | `src/app/tickReport.ts` | the `TickReport` type, its zod schema, `emitTickReport` |
| CLI | `src/cli/commands/tick.ts` | `orion tick <asset> [--no-agent]` |
| Config | `src/config/schema.ts`, `src/config/agentPolicy.ts` | `agent.cadence`, strict `review_triggers`, readers with defaults |
| Migration 4 | `src/db/migrations.ts` | `run_locks`, `trigger_firings` |

### Invariants (additions)

1. `orion tick` never spawns a process. Every stage is a library call in the one process that opened the database.
2. At most one agent run starts per tick per asset.
3. An agent failure of any kind (an exception from `runAgent`, or a non-`completed` outcome) never changes the tick's exit code and never loses the data-only signal, which was emitted before the agent stage began.
4. A trigger instance fires at most once while its condition holds. Re-firing requires the condition to clear first (`staleness`, `driver_deviation`) or a new instance key (the others).
5. The lock is released on every exit path of its holder, and only by its holder.
6. `--no-agent` and `agent.cadence.enabled: false` write nothing to `trigger_firings` and start no run.

## 4. `orion tick`

### 4.1 Command

```
orion tick <asset> [--no-agent]
```

One asset per invocation, as the Hermes job does today (one job per asset keeps one asset's failure out of another's report). `--json` is accepted for uniformity; stdout is JSON either way.

### 4.2 Sequence

All inside one `openDb`:

1. **Lock.** `withRunLock(db, asset, 'tick pid <pid>', now, ...)`. When it throws `run_in_progress`, the report has `outcome: 'run_in_progress'` and `lock: { holder, acquired_at }`; nothing else runs; exit 0.
2. **Ingest and signal.** `updateAsset` as `orion update` does: fetch, valuation, signal. The fetch summary goes to stderr; the signal summary goes to stderr; the signal is appended to `<ORION_HOME>/signals.jsonl`. If this stage throws, the report has `outcome: 'error'` and `error: { code, message }`, exit 1, and the tick ends: no agent on a day with no data. A `blocked` signal is data, not an error; the tick continues.
3. **Triggers.** `evaluateTriggers` against the fresh state (section 6). Under `--no-agent` or `enabled: false` it evaluates with `record: false`: the report lists what would have fired, nothing is written.
4. **Agent.** Choose the run: `dueRunType` gives `deep` or `weekly`; else `triage` when at least one trigger fired this tick; else none. Under `--no-agent` or `enabled: false`: report the choice in `agent_would_run` and start nothing. Otherwise call `runAgent` with `trigger: { kind, firings }` and the full deps (`reload` included). Whatever `runAgent` throws is caught and recorded as `agent.error`; a non-`completed` outcome is recorded as is. When the run committed and revalued, its signal is appended to `signals.jsonl` too, and the report carries both signal ids. After the run, the firings of this tick get `agent_run_id` (whatever the outcome).
5. **Report.** One JSON line to stdout and appended to `<ORION_HOME>/ticks.jsonl`. The lock is released in `finally`, before the report is written (the report says the tick is over).

Tick always writes both files: it is the delivery path, and tests run under a temp `ORION_HOME`. `orion update` keeps its `--out` flag and stays the manual data-only command.

### 4.3 Exit codes

| Code | When |
|---|---|
| 0 | The tick completed with a signal `ok` or `degraded`, or exited `run_in_progress` |
| 2 | The tick completed and the signal is `blocked` |
| 1 | No signal: ingest or valuation threw |

The agent stage never changes the exit code. Hermes reads `agent.outcome` and `agent.error` from the report.

### 4.4 The tick report

```
{
  schema_version: 1,
  tick_id, asset, started_at, ended_at,
  outcome: "completed" | "run_in_progress" | "error",
  lock: { holder, acquired_at } | null,          // set on run_in_progress
  ingest: { fetch_run_id, outcome, sources_failed: [source], anomalies_opened: [{ id, kind, metric, severity }] } | null,
  signal: { signal_id, status, grade, expected_target_12m, target_delta_pct, cause } | null,
  triggers_fired: [{ kind, key, detail }],       // fired this tick (or would have, under --no-agent)
  triggers_recorded: boolean,                    // false under --no-agent or enabled: false
  agent: {
    run_type, trigger_kind, run_id, outcome,
    usage: { requests, input_tokens, output_tokens, web_searches, web_fetches },
    committed: { assumption_changes, observations, anomalies_resolved, journal } | null,   // counts
    proposals: [{ id, kind }],
    signal_id | null,
    error: { code, message } | null
  } | null,
  agent_would_run: { run_type, trigger_kind } | null,   // set under --no-agent or enabled: false
  error: { code, message } | null
}
```

`tick_id` is `tick_<asset>_<started_at compact>`. Every string that came from the model or a web page is excluded by construction: the report names ids, kinds, counts, and Orion's own codes. A zod schema validates every report before it is written, as `SignalSchema` does for signals.

## 5. Cadence

### 5.1 Config

Under `agent:`, so proposals and tools cannot reach it:

```yaml
agent:
  cadence:
    weekly_days: 7      # default 7; positive integer
    deep_days: 30       # default 30; positive integer
    enabled: true       # default true
```

`enabled: false` is the durable per-asset form of `--no-agent`: ingest and signal daily, triggers evaluated and reported but not recorded, no run.

### 5.2 Due rule

`dueRunType(db, asset, now)`:

- Consider non-dry `agent_runs` for the asset, any `trigger_kind`, any outcome. A run counts as an attempt of its type from `started_at`.
- `deep` is due when no `deep` run started within `deep_days`.
- `weekly` is due when no `weekly` or `deep` run started within `weekly_days`.
- Return `deep` if due, else `weekly` if due, else `null`.

On a fresh asset both are due and the first tick runs `deep`. A failed run counts, so a broken run is not retried until its interval passes; the report says it failed and the user can rerun by hand. Dry runs never count. `triage` is never due.

## 6. Triggers

### 6.1 Config

`review_triggers` becomes a strict object. All fields optional with defaults, so an existing config without them keeps validating. The config hash is taken over the parsed config with defaults applied, so the new `agent.cadence` defaults (section 5.1) move VVV's hash once, and the next signal reports `cause: config`.

```yaml
review_triggers:
  driver_deviation_pct: 25          # positive; the revenue deviation threshold
  provisional_move_pct: 25          # positive; the move guard (unchanged)
  revenue_stale_move_pct: 30        # positive; the ingest advisory (unchanged)
  calendar:                         # default []
    - { date: "2026-10-01", note: "Announced emission cut to 2.0M VVV per year" }
```

`calendar[].date` is an ISO date (`YYYY-MM-DD`); `note` a non-empty string. Unknown keys are rejected. Proposal reachability is unchanged: `provisional_move_pct` and the whole node.

### 6.2 Table

Migration 4: `trigger_firings (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('open_anomaly','driver_deviation','staleness','provisional','calendar')), key TEXT NOT NULL, fired_at TEXT NOT NULL, agent_run_id INTEGER REFERENCES agent_runs(id), detail_json TEXT NOT NULL)` with `CREATE UNIQUE INDEX idx_trigger_firings_instance ON trigger_firings (asset_id, kind, key)`. One live row per instance.

### 6.3 Conditions

Each condition yields zero or more instances `{ kind, key, detail }`.

| kind | key | fires when | re-arms |
|---|---|---|---|
| `open_anomaly` | anomaly id | the anomaly is `open`, either severity | never needed; a new anomaly has a new id |
| `driver_deviation` | `revenue_run_rate_usd` | section 7 says the deviation exceeds `driver_deviation_pct` | the row is deleted when the condition is false, so the next breach fires again |
| `staleness` | metric key | the metric is `critical` and in the signal's `data_quality.stale_metrics` | deleted when fresh again |
| `provisional` | observation id | an active `provisional` observation of this asset with `agent_run_id` null (user-entered; the agent's own rows are already its knowledge) | never needed |
| `calendar` | the event date | `today >= date` and `today < date + 7 days` (a tick missed for a week does not fire an event months late) | never; the date is the instance |

Detail per kind: `open_anomaly` carries `{ kind, metric, severity, first_seen_at }`; `driver_deviation` carries `{ anchor_value, anchor_as_of, implied, actual, deviation_pct }`; `staleness` carries `{ freshness, staleness_days }`; `provisional` carries `{ metric, observed_at, value }`; `calendar` carries `{ note }`. Nothing model-written enters a detail: an anomaly's note is not copied.

### 6.4 Evaluation

`evaluateTriggers(db, loaded, signal, now, { record })` returns `{ fired: Firing[], standing: Firing[] }`:

1. Compute the current instance set from the database and the signal just produced.
2. In one `.immediate()` transaction when `record` is true: for each current instance with no row, insert one (`agent_run_id` null) and add it to `fired`; for each existing row whose instance is current, add to `standing`; for `staleness` and `driver_deviation`, delete rows whose instance is no longer current.
3. When `record` is false, compute `fired` as the instances with no row, and write nothing.

After the agent stage, `attachRun(db, firingIds, runId)` sets `agent_run_id` on this tick's fired rows when a run started, whatever its outcome. A run that never started (preflight threw, `--no-agent`) leaves it null; the instance still does not re-fire, and the report shows why.

### 6.5 The run's context

`RunAgentOptions` gains `trigger?: { kind: 'schedule' | 'trigger'; firings: Firing[] }`; absent means `manual`, as today. `agent_runs.trigger_kind` is `manual`, `schedule`, or `trigger`; `trigger_detail_json` is `{ anomalyId?, note?, firings? }`. Triage preflight accepts an anomaly, a note, or at least one firing (`triage_needs_target` otherwise). The context pack gains a block `triggers_this_tick: [{ kind, key, detail }]` when firings are present, placed with the triage target. A scheduled run absorbing firings gets the same block. The `anomaly-triage` skill gains one paragraph on reading the block; it is a user-authored file and the diff is shown at review.

## 7. Revenue deviation

`src/app/deviation.ts`, pure except the anchor lookup.

- **Anchor.** `revenueAnchor(db, asset, now)`: the as-of time is `started_at` of the newest completed, non-dry agent run for the asset; before any such run, `created_at` of the current assumption set. The anchor value is `computeDrivers(asset, eligibleObservations(db, asset, asOf), asOf).drivers.revenueRunRate` at that as-of (pure functions over stored rows: reproducible). No anchor when the driver is missing at that time.
- **Implied.** `revenueAt(elapsedYears, anchor.value, set.values.base)` from `src/engine/paths.ts`, with `elapsedYears = (now - anchorAsOf) / (365.25 days)` and `set` the current assumption set.
- **Deviation.** `actual / implied - 1`, with `actual` the revenue driver from the tick's own valuation. Fires when `|deviation| > driver_deviation_pct / 100`.
- **Not evaluated** (no instance, and any standing row is deleted) when: the revenue driver is missing now; it is in `stale_critical` now (the `staleness` trigger owns that datum); the anchor is under 7 days old; there is no anchor; or `implied <= 0`.

## 8. The run lock

### 8.1 Table

Migration 4: `run_locks (asset_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL)`.

### 8.2 Semantics

`withRunLock(db, assetId, holder, now, fn)`:

- **Acquire**, one `.immediate()` transaction: no row, insert. A row with `expires_at <= now`, replace it (takeover) and mark every `running` `agent_runs` row for the asset `error` with `error = 'abandoned'` and `ended_at = now`; this is what `abandonStaleRuns` did, and the sweep, its constant, and its two tests go. Otherwise throw `OrionError('run_in_progress', 'asset <id> is locked by <holder> since <acquired_at>')`.
- `expires_at = now + LOCK_TTL_MS`, `LOCK_TTL_MS` = 2 hours: past any run's budget, so a live run is never taken over.
- **Release** in `finally`: `DELETE FROM run_locks WHERE asset_id = ? AND holder = ?`. A holder that outlived its TTL and was taken over does not delete the new holder's row.
- `holder` is `<command> pid <pid>`; the pid is informational.

The lock guards process-level overlap (two agent runs, two ingests); SQLite's own locking still guards the writes. `runAgent` does not take the lock; callers compose it.

### 8.3 Callers

- `tick`: `run_in_progress` becomes report `outcome: 'run_in_progress'`, exit 0.
- `agent run`: the lock wraps `runAgent`; `run_in_progress` propagates as an `OrionError`, so the CLI prints `error: ...` and exits 1. A manual command that did nothing exits non-zero.
- `finishAgentRun`'s "one finish per run" rule is unchanged: a taken-over run that is in fact alive still records its one real finish.

## 9. Transactions and the `reload` dependency

- `RunAgentDeps.reload` becomes required. Tests that omitted it pass `reload: () => loaded`.
- `runValuation`'s transaction becomes `db.transaction(...).immediate`, with the same comment the ledger carries (a deferred transaction that begins with reads fails at once with `SQLITE_BUSY_SNAPSHOT` when a writer intervenes; `busy_timeout` cannot retry that).
- The flow ingest's per-day transaction (`src/ingest/flow.ts`) becomes `.immediate()` likewise.
- `tests/agent/concurrency.test.ts` gains one case for each: a writer interleaved at the first read no longer fails the transaction.

## 10. Data model summary

Migration 4 adds `run_locks` and `trigger_firings` (sections 6.2, 8.1). No existing table changes. Rollback note for the follow-ups: an older binary against a migrated database ignores both tables; a newer binary against an unmigrated database migrates on open, and two first-openers can race on migration 4 as on 2 and 3 (`M9`).

## 11. Ops

- `run-daily.sh`: `update "$asset" --out signals.jsonl` becomes `tick "$asset"`; stdout is the tick report; the log file is `tick.log`. The contract comment is rewritten: stdout one JSON report line (empty on exit 1), stderr the fetch and signal summaries, exit codes per section 4.3. The script appends to `tick.log` from now on; an existing `update.log` is left alone.
- `docs/ops/hermes-daily-job.md`: the prompt reads the report line. Alert conditions gain: `outcome` is `run_in_progress` or `error`; `agent` is non-null and its `outcome` is not `completed`, or `agent.error` is set; `agent.proposals` is non-empty (report id and kind only; the untrusted-data rule stays); `agent.committed.assumption_changes > 0` (report `signal.cause` and `change.author`). The `proposals list` step is dropped. `signals.jsonl` still holds every signal for the "yesterday" lookup; `ticks.jsonl` holds every report. The allowed read-only command list gains `tail -n 20 ticks.jsonl`.
- README: a "Scheduling" section with the cadence config, the trigger table, the lock, `--no-agent`, `enabled: false`, and the two files.

## 12. Testing

All under a temp `ORION_HOME`, with the scripted fake model and the fetch harness. No live calls.

- **Cadence**: fresh asset gives `deep`; weekly due at 7 days and not at 6; deep satisfies weekly; a failed run counts; a dry run does not; a manual run counts; `weekly_days` and `deep_days` overrides; `enabled: false`.
- **Triggers**: each of the five fires once, stays standing on the next evaluation, and `attachRun` records the run; `staleness` and `driver_deviation` re-arm when the condition clears and fire again; `calendar` does not fire eight days after the date; `provisional` ignores agent-written rows; `record: false` writes nothing.
- **Deviation**: golden values against `revenueAt`; each skip condition; the anchor before and after a completed run.
- **Lock**: second acquire on another handle throws `run_in_progress`; an expired lock is taken over and the stuck `running` row is abandoned; release leaves a foreign holder's row; a throwing body still releases; a live lock is not taken over.
- **Tick end to end**: a clean tick with no agent (report and both files); a tick running the first `deep`, with both signals in `signals.jsonl` and one report line; a firing launching `triage` with `triggers_this_tick` in the pack and `trigger_kind: 'trigger'`; a scheduled run absorbing a firing (`agent_run_id` on the firing points at the deep run); `runAgent` throwing at preflight gives `agent.error`, exit 0, and the signal already in the file; a `budget_exhausted` outcome leaves exit 0; `run_in_progress` gives exit 0 and no files written but the report; `blocked` gives exit 2; ingest throwing gives exit 1 and `outcome: 'error'`; `--no-agent` reports `agent_would_run` and records nothing.
- **Report schema**: every report written passes the zod schema, including the `run_in_progress` and `error` shapes.
- **CLI**: `agent run` on a locked asset exits 1 with `run_in_progress`; the `trigger: 'manual'` assertion stays for the CLI path.
- **Transactions**: the two new interleaving cases in the concurrency test.

## 13. Build order

1. Migration 4, the two stores, `withRunLock`; `abandonStaleRuns` removed; `agent run` takes the lock.
2. Config: `agent.cadence`, strict `review_triggers`, readers; `dueRunType`.
3. `.immediate()` on `runValuation` and the flow ingest; `reload` required.
4. `runAgent` trigger option, preflight, context block, skill paragraph.
5. Deviation.
6. Trigger evaluation.
7. Report schema and `tickAsset`.
8. CLI `tick`, `run-daily.sh`, Hermes doc, README.

## 14. Known limitations

- A firing whose run failed at preflight stays standing with `agent_run_id` null; the instance will not re-fire until it clears. The report shows the failure the day it happens.
- The lock's 2-hour TTL is a constant. Budgets bound requests and tokens, not time; a run that outlives it is taken over by the next acquirer. The scheduler's timeout must exceed it (the Hermes doc says 150 minutes).
- Deviation is measured on the base scenario only; the bands already say how far the agent may move `rev_growth_y1`, and the trigger's job is to make it look.
- A tick per asset means two assets tick sequentially from two jobs; the lock is per asset, so they do not interfere.

## 15. Amendments made during planning (2026-09-21)

The plan's code was built as a prototype, one commit per task, and the plan was generated from it (`docs/superpowers/plans/2026-09-21-orion-scheduling.md`). Where the prototype had to depart from the text above, this section is the record; the text above is left as approved.

- **6.1, config hash.** The new keys (`agent.cadence.*`, the typed `review_triggers` fields) are optional with no zod default; readers apply the defaults. No existing config hash moves, VVV's included. The sentence in 6.1 expecting one move is superseded.
- **6.3, `provisional`.** `observations` has no `agent_run_id` column. The instance is an active provisional row whose `source_detail` does not start with `research:` (the prefix the ledger writes on every research row). The rule is the same: user-entered rows fire, the agent's own do not.
- **6.3, details.** `staleness` carries `{ staleness_days, newest_observed_at }` (not `freshness`); `driver_deviation` carries the deviation record plus `threshold_pct` and `anchor_from`.
- **6.4, evaluation.** `evaluateTriggers(db, loaded, now, { record })` takes no signal: it computes the driver report itself (`computeDrivers` over `eligibleObservations` at `now`, the context pack's own call), which also yields the revenue driver the deviation check needs. It returns `{ fired, standing, cleared }`. Unrecorded firings (`record: false`) carry `id: 0`.
- **4.4, report.** Field names as built: `ingest.anomalies_raised` (opened or seen again while open; acknowledged recurrences left out); `agent.committed = { assumption_set_version, observations, anomalies_resolved, journal }`; `agent.usage.input_tokens` is uncached plus cache reads plus cache writes; `agent.error` is `{ code: outcome, message }` for a non-`completed` outcome and the thrown error's code and message when `runAgent` threw. `tick_id` is `tick_<asset>_<YYYYMMDDTHHMMSSZ>`.
- **4.2, files.** `tickAsset` writes no file. It calls `deps.onSignal(signal)` the moment each signal exists and `deps.onFetch(fetch)` after the fetch; the CLI appends to `signals.jsonl` and prints the summaries. The report line is written by the CLI after the lock is released.
- **4.2, errors after the signal.** A throw from trigger evaluation or the cadence rule (a bug, not an expected condition) propagates out of tick as an ordinary error; only the ingest stage and the agent stage are caught into the report. `outcome: 'error'` is set whenever `error` is set.
- **6.5, `RunAgentOptions.trigger`.** The type is `RunTriggerContext = { kind: 'schedule' | 'trigger'; firings: Firing[] }`. `trigger_detail_json.firings` carries `{ kind, key, detail }` per firing.
- **8.2, takeover.** `withRunLock` takes `{ onTakeover?: (abandoned: number) => void }`; tick reports a takeover as a progress line. `abandonStaleRuns` is replaced by `abandonRunningRuns(db, assetId, nowIso)`, called only from the takeover.
- **9, findings.** `runValuation` was already write-first (its first statement is `saveConfigVersion`'s `INSERT OR IGNORE`), so the deferred transaction was safe by accident; `.immediate()` makes it explicit and the new test pins the behaviour without discriminating. The flow ingest's per-day transaction was the deferred read-then-write shape, and its test fails without the change. `insertObservation`'s own transaction (`orion data set`) has the same shape and is out of scope: carried to the follow-ups.
- **11, ops.** The Hermes prompt's one-line summaries use ` | ` as the separator (the middle dot is not ASCII, and the plan's directives must be).
