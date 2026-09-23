# Orion

Price-target signals for crypto tokens with real value capture. A deterministic engine turns observations and a versioned assumption set into 6-month and 12-month targets, emitted as JSON signals.

Design: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (framework), `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (ingestion, anomalies, engine 1.2.0), and `docs/superpowers/specs/2026-09-22-orion-research-first-design.md` (the inbox, decisions by reply, the bootstrap run, API-series flows).

## Quick start

```bash
npm install && npm run build && npm link     # provides the `orion` command
export ORION_HOME="$PWD"
orion init
orion asset validate
./calibration/vvv-seed-2026-09-18.sh
orion model assumptions import vvv calibration/vvv-assumptions.yaml --rationale "first calibration"
orion model run vvv
orion signal emit vvv --out signals.jsonl
```

## Where things live

- Human-authored, in git: `assets/*.yaml` (metrics, holder flows, modules, weights, assumption bounds), `personas/`, `skills/`, `calibration/`.
- Machine-written, in `orion.db` (git-ignored): observations, assumption-set versions, snapshots, runs, signals, agent runs and their transcripts, proposals, the journal.

## Everyday commands

```bash
orion data set vvv price_usd 28.10                       # new observation, now
orion data show vvv revenue_run_rate_usd                 # inspect
orion data confirm 17                                    # promote a provisional observation
orion inbox vvv                                          # everything awaiting your decision: rows to confirm, proposals, open anomalies
orion model assumptions show vvv
orion model assumptions set vvv rev_growth_y1 0.6 --scenario base --rationale "slower Q4"
orion model whatif vvv --set regime_multiplier=0.5       # explore, nothing saved
orion model run vvv                                      # new signal
orion model replay 12                                    # prove run 12 reproduces
```

Flow rows must not overlap each other: each one covers `[--at minus --period-days, --at]`, and a run is blocked when two periods for the same metric cover any of the same time. So when the full-period figure arrives, `orion data reject <id>` the partial-period (month-to-date) row first, then enter the full one.

## Daily operation

Metrics with a `source:` in `assets/<id>.yaml` are fetched; the rest are entered by hand. Design: `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md`.

```bash
orion data fetch vvv --dry-run      # read and cross-check everything, write nothing
orion data fetch vvv --adopt        # first real run: a 90-day burn backfill (about 2,000 RPC calls, several minutes);
                                    # --adopt rejects the hand-entered monthly burn rows the daily rows replace
orion data sources vvv              # per metric: source, cross-checks, last fetch outcome, age of the value in force
orion update vvv --out signals.jsonl   # fetch, value, emit one JSON line. Exit 0 ok or degraded, 2 blocked, 1 error
orion tick vvv                         # the scheduled entry point: update, then the triggers, then the one agent run that is due (see Scheduling)
```

One cron line gives a daily signal and runs the analyst on its schedule:

```
15 0 * * *  cd /path/to/orion && ORION_HOME="$PWD" orion tick vvv 2>> tick.log
```

`./run-daily.sh [asset]` is the same line as a script for any scheduler: it needs no environment (`ORION_HOME` defaults to its own directory, and it calls `dist/cli/index.js` directly, so no `npm link`), prints the tick report on stdout and the fetch and signal summaries on stderr, keeps the report in `ticks.jsonl`, every signal in `signals.jsonl`, and stderr in `tick.log`, and exits with `orion tick`'s code. For an agent-driven scheduler that checks the result and notifies you, see `docs/ops/hermes-daily-job.md`. `orion update` stays as the data-only command for a manual refresh.

- A backfill is resumable: each completed UTC day commits on its own, and the next run carries on after the last one. `--backfill-days <n>` re-scans the last `n` days; re-scanned days supersede the old rows.
- Fetched flow rows never silently overwrite hand-entered ones. Without `--adopt`, a fetch that would overlap them writes nothing for that scan and lists the conflicting rows. `--adopt` rejects only rows whose source is `manual`.
- Several metrics can share one burn-flow scan (same token, sink, and allowlist) and so share its cursor: `--metric` on any one of them fetches every metric that shares its scan, at no extra cost.
- A metric added later to an existing scan group gets no history by itself (the cursor is already past those days): re-run with `--backfill-days <n>`.
- The cron line above runs in the machine's local time; the code itself works in UTC either way, and any time after 00:05 UTC picks up the previous UTC day.
- A plain `--dry-run` on a database that still has hand-entered burn rows reports the burn scan as `skipped` and lists the conflicts; add `--adopt` to the dry run to see what would be written without writing it.
- Cross-check readings are never stored. A reading outside its tolerance opens an anomaly:

```bash
orion data anomalies vvv                       # open anomalies (--all includes decided ones)
orion data ack 3 --note "Venice's API lags"    # understood and accepted: it stops affecting the signal, and stays that way if seen again
orion data resolve 4 --note "allowlisted the new buyback Safe"
```

  An open `degrading` anomaly on a critical metric makes the signal `degraded` with grade D until it is resolved or acknowledged. Advisory anomalies (a usage move since the last revenue disclosure, a source failing three runs in a row) are listed in `data_quality.anomalies` and change nothing else.
- Configuration, from the environment or `<ORION_HOME>/.env` (git-ignored): `ORION_BASE_RPC_URL` (default `https://mainnet.base.org`; the RPC must return `blockTimestamp` on logs, which Base's does) and `COINGECKO_API_KEY` (optional demo key; keyless works, more slowly).
- Still manual for VVV: `revenue_run_rate_usd` and ANNOUNCED future emission cuts. The analyst researches both and records each as a provisional row (an announced cut goes on `emission_rate_annual` with its effective date) for you to `orion data confirm`; no researched figure reaches the signal unconfirmed. Once the cut's date passes, the daily on-chain read governs.

## The analyst agent

An AI analyst persona maintains the assumptions, looks into anomalies, and researches the figures no API publishes. It never writes a target: the engine still does all the math. What it may do is enforced in code, not in its prompt.

```bash
orion persona assign vvv ai-infra-analyst                            # once: who covers the asset
orion agent run vvv --type weekly --out signals.jsonl                # review what moved; adjust within its bands
orion agent run vvv --type triage --anomaly 7 --out signals.jsonl    # look into one anomaly
orion agent run vvv --type triage --note "https://..." --out signals.jsonl   # a lead to verify; never evidence by itself
orion agent run vvv --type deep --out signals.jsonl                  # monthly: re-underwrite the thesis
orion agent run <asset> --type bootstrap --out signals.jsonl         # a new asset: research every manual metric; you confirm the rows from the inbox
orion agent run vvv --type weekly --dry-run                          # everything except the commit (spends tokens)
orion agent runs list vvv
orion agent runs show 3 [--transcript]                   # outcome, what was committed, tokens, estimated cost
orion model proposals list                               # what it wants and may not do itself
orion model proposals show 4
orion model proposals approve 4 [--note "..."]
orion model proposals reject 4 --note "..."              # the note is required; the agent reads it next run
```

Credentials: put `ANTHROPIC_API_KEY=...` in `<ORION_HOME>/.env` (or the environment). Without it the SDK looks for its own credentials, so an `ant auth login` profile also works. Use a dedicated Console workspace and key with a monthly spend limit, and enable web search for the organization.

What the agent can do directly: change an assumption inside its band for that scenario (the `bear`/`base`/`bull` sub-ranges under `assumptions:` in the asset YAML) and within the max step per run (25 percent of the band's width), citing at least one observation it has seen in that run; resolve an open anomaly with evidence; record a researched figure as a provisional observation, citing a page it fetched in that run and quoting it verbatim; write its journal. Everything else becomes a proposal: a value outside its band or step, any change to the asset YAML, acknowledging an anomaly, confirming or rejecting an observation, and a researched value on a critical metric that moves more than `review_triggers.provisional_move_pct` (25) from the last confirmed value (its own earlier provisional figures never move that baseline). A quote it cites must sit inside one paragraph, table cell, or list item of the fetched page, so it cannot be spliced from unrelated parts; and it cannot record a figure where an observation already exists at the same metric and time: it proposes rejecting that one instead. While a `degrading` anomaly is open it cannot change assumptions at all. It can never touch `agent:` settings, persona or skill files, or a signal.

A new asset starts with a `bootstrap` run: the one run type that needs no assumption set. It researches every manual metric of the asset and records what it can cite as provisional rows, changes no assumption, and proposes no config change; its journal lists each metric as found, not found, or ambiguous. `orion tick` starts it by itself on an asset that has never had a deep or bootstrap attempt, and it counts as that month's deep and that week's weekly. The rows wait in `orion inbox <asset>` for you to confirm; then the calibration sweep is run against confirmed data and the set is imported, and the next tick produces the first signal. Its budget is its own (`agent.budgets.bootstrap`), about $8 to $12 at list price.

A run either finishes cleanly, journal entry included, and commits everything together, or commits nothing (`budget_exhausted`, `refused`, `no_journal`, `conflict`, `error`). The run row, the transcript, and the token counts are kept either way. `conflict` means the world changed mid-run (you saved an assumption set, or edited `assets/<id>.yaml`, while it ran): run it again. After a commit that can move a signal the run values the asset and prints the signal; `change.author` and `provenance.agent_run_id` say who moved it. Exit codes: `0` completed, `2` completed with a `blocked` signal, `1` anything else.

Give every real agent run you launch by hand `--out signals.jsonl`, the same file `orion tick` appends to: a signal an agent run produced can be the one the next daily signal names in `change.prev_signal_id`, and whatever reads `signals.jsonl` (the Hermes job above compares against it) must be able to find it there. A `--dry-run` writes no signal and needs no `--out`. Runs that tick starts write there by themselves.

Approving a config proposal edits `assets/<id>.yaml` in place, keeping comments and layout: review it with `git diff` and commit it. A proposal is refused as stale when what it was filed against has changed; reject it with a note. Personas and skills are markdown files in `personas/` and `skills/`; edit them like any other file, and runs record the hash of what they used. Per-run budgets (requests, tokens, web searches and fetches) have defaults in code and can be overridden under `agent:` in the asset YAML.

## Scheduling

`orion tick <asset>` is the one entry point a scheduler calls. In one process, in order: take the asset's run lock; fetch, value, and append the signal to `<ORION_HOME>/signals.jsonl`; evaluate the review triggers; then start the one agent run that is due or triggered; then print the tick report (one JSON line) and append it to `<ORION_HOME>/ticks.jsonl`. Design: `docs/superpowers/specs/2026-09-21-orion-scheduling-design.md`.

```bash
orion tick vvv                # the daily job
orion tick vvv --no-agent     # everything but the agent: the report says which run it would have started, and records no trigger
```

Exit codes: `0` when there is a signal (`ok` or `degraded`), or when another run holds the lock (`run_in_progress`); `2` when the signal is `blocked`; `1` when there is no signal because the fetch or the valuation could not run. The agent stage never changes the exit code: a run that fails is in the report's `agent.outcome` and `agent.error`, and the data-only signal was already written.

The report on stdout is the delivery; the two files are copies. If a file cannot be appended, tick warns on stderr and goes on; every signal and report is also in the database.

**When the agent runs.** A `deep` run is due when none started in the last `deep_days` (30); a `weekly` when neither a weekly nor a deep started in the last `weekly_days` (7). Every attempt counts, whatever its outcome or who launched it, so a failed run waits out its interval rather than being retried daily, and a run you launched by hand is not repeated. On a fresh asset the first scheduled run is `deep`. When nothing is due and a trigger fired this tick, tick runs `triage` with the firings as its target; when a scheduled run is due, it absorbs them (they appear in its context pack as `trigger.triggers_this_tick`). At most one run starts per tick. A run that ends `conflict` (you edited the asset YAML or saved an assumption set while it ran) counts as that interval's attempt: run it again by hand.

```yaml
agent:
  cadence:
    weekly_days: 7      # default 7
    deep_days: 30       # default 30
    enabled: true       # false: tick never starts a run for this asset and records no trigger; the report says what it would have run
```

**Triggers** come from `review_triggers` in the asset YAML and Orion's own data. Each instance fires once, on the tick it first holds, and is recorded in the `trigger_firings` table with the run that handled it:

| kind | instance | fires when | fires again |
|---|---|---|---|
| `open_anomaly` | the anomaly id | an anomaly is open, either severity | a new anomaly is a new id |
| `staleness` | the metric | a `critical` metric is past its `staleness_days` | after it was fresh again |
| `driver_deviation` | `revenue_run_rate_usd` | revenue is further than `driver_deviation_pct` (25) from where the base scenario's growth path, started at the current assumption set's creation (an assumption change, the agent's or yours, moves it), says it should be; not while revenue itself is stale, and not until the anchor is six and a half days old | after it came back inside |
| `provisional` | the observation id | you entered a provisional observation (the agent's own research rows do not count) | never |
| `calendar` | the date | a `review_triggers.calendar` event's date has arrived, for seven days | never |

**The run lock** is one row per asset in `run_locks`. `orion tick` and `orion agent run` take it; a second one finds it held and exits (`run_in_progress` for tick, exit 0; an error and exit 1 for `agent run`). A lock older than two hours belongs to a process that died: the next acquirer takes it over and marks any `running` agent run of the asset `error/abandoned`. Nothing else takes the lock; SQLite serialises the short commands itself.

**The report** (`ticks.jsonl`, one line per tick) names ids, kinds, counts, and Orion's own codes: `outcome`, the ingest's failed sources and raised anomalies, the signal's id, status, grade, 12m target and delta, the triggers that fired, and the agent run's type, trigger, outcome, token usage, what it committed (by count) and proposed (id and kind), and its signal id; and `inbox`, everything awaiting your decision after the tick: provisional rows with the move against the last confirmed value and their citation URL, pending proposals with their computed effect, open anomalies with their reading. `orion inbox <asset>` prints the same queue. Nothing in it was written by a model or read from a web page; the citation URL is the one model-chosen string, and the Hermes job is told never to fetch one.

## Maintaining the system

With the cron line in place, the daily signal takes care of itself. What is left for you:

| When | Command | Why |
|---|---|---|
| Daily, from the Hermes message | reply `confirm <id>`, `reject <id> <note>`, `approve <id> [note]`, `decline <id> <note>`, `ack <id> <note>`, or `resolve <id> <note>` | The message ends with the inbox; Hermes runs the one command for your reply and reports Orion's answer. `orion inbox vvv` shows the same queue from a session. |
| Whenever you want the number | `orion signal latest vvv` | Read the latest signal. |
| Weekly, or when a signal says `degraded` | `orion data anomalies vvv` | See what opened. |
| After checking an anomaly | reply `ack <id> <note>` or `resolve <id> <note>` to Hermes, or `orion data ack <id> --note "..."` / `orion data resolve <id> --note "..."` | Close it. `ack`: understood and accepted. `resolve`: the cause is fixed. |
| Weekly | `orion data sources vvv` | Last fetch outcome and age of the value in force, per metric. |
| Weekly | `tail update.log` | Catch a source that keeps failing. Three failed runs in a row also open an advisory anomaly. |
| When the analyst records a revenue disclosure | reply `confirm <id>` to Hermes, or `orion data confirm <id>` (`orion inbox vvv` lists the row) | Revenue has no API. The analyst researches it and you confirm it; until you do it stays out of the signal. The advisory `revenue_disclosure_stale` anomaly says when usage has moved since the last figure. |
| When the analyst records an announced emission cut | reply `confirm <id>` to Hermes, or `orion data confirm <id>` (the row is dated at the cut's effective date) | Announced cuts exist only on Venice's blog; the analyst records them as future-dated rows on the fetched schedule. Once the date passes, the daily on-chain read takes over. |
| When your views change | `orion model assumptions set vvv <key> <value> --scenario <s> --rationale "..."` | The next daily run picks it up. |
| Weekly | `orion agent run vvv --type weekly --out signals.jsonl`, then `orion model proposals list` | The analyst reviews what moved; decide what it proposed (by reply to Hermes, or `orion model proposals approve` / `reject`). |
| Monthly | `orion agent run vvv --type deep --out signals.jsonl` | Re-underwrite the thesis; expect structural proposals. |
| When an anomaly opens | `orion agent run vvv --type triage --anomaly <id> --out signals.jsonl` | It resolves what has passed and proposes an acknowledgement for what will persist. |
| Rarely | `orion data fetch vvv --backfill-days <n>` | Re-scan burns after an allowlist change, or after adding a metric to the burn scan. |

Exit codes of `orion update`, for whatever watches the cron job: `0` for an `ok` or `degraded` signal, `2` for `blocked`, `1` for an error. A signal is always emitted, including `blocked`.

Anomalies never close themselves, but an acknowledgement stands: when the daily fetch sees an acknowledged condition again it says "seen again, stays acknowledged", counts the repeat on the same row, and the signal is not degraded again. A `resolved` anomaly that recurs opens a new one, because resolved means the cause was fixed. To withdraw an acknowledgement, `orion data resolve <id> --note "..."` the acknowledged anomaly: the next occurrence then opens a new one. The acknowledged row always carries the latest reading, so check `orion data anomalies vvv --all` now and then: a disagreement you accepted at 3 percent is still acknowledged at 30. For a disagreement you expect to last, widening that cross-check's `tolerance_pct` in `assets/<id>.yaml` is the cleaner fix.

Every command accepts `--json`. Signals follow schema v1 (spec section 9). Orion emits signals only. It is not investment advice.
