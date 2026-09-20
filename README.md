# Orion

Price-target signals for crypto tokens with real value capture. A deterministic engine turns observations and a versioned assumption set into 6-month and 12-month targets, emitted as JSON signals.

Design: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (framework) and `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (ingestion, anomalies, engine 1.2.0).

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
```

One cron line gives a daily signal:

```
15 0 * * *  cd /path/to/orion && ORION_HOME="$PWD" orion update vvv --out signals.jsonl 2>> update.log
```

`./run-daily.sh [asset]` is the same line as a script for any scheduler: it needs no environment (`ORION_HOME` defaults to its own directory, and it calls `dist/cli/index.js` directly, so no `npm link`), prints the signal on stdout and the fetch summary on stderr, keeps both in `signals.jsonl` and `update.log`, and exits with `orion update`'s code. For an agent-driven scheduler that checks the result and notifies you, see `docs/ops/hermes-daily-job.md`.

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
- Still manual for VVV: `revenue_run_rate_usd`, and ANNOUNCED future emission cuts (`orion data set vvv emission_rate_annual <n> --at <effective date>`). Once the date passes, the daily on-chain read governs.

## The analyst agent

An AI analyst persona maintains the assumptions, looks into anomalies, and researches the figures no API publishes. It never writes a target: the engine still does all the math. What it may do is enforced in code, not in its prompt.

```bash
orion persona assign vvv ai-infra-analyst                # once: who covers the asset
orion agent run vvv --type weekly                        # review what moved; adjust within its bands
orion agent run vvv --type triage --anomaly 7            # look into one anomaly
orion agent run vvv --type triage --note "https://..."   # a lead to verify; never evidence by itself
orion agent run vvv --type deep                          # monthly: re-underwrite the thesis
orion agent run vvv --type weekly --dry-run              # everything except the commit (spends tokens)
orion agent runs list vvv
orion agent runs show 3 [--transcript]                   # outcome, what was committed, tokens, estimated cost
orion model proposals list                               # what it wants and may not do itself
orion model proposals show 4
orion model proposals approve 4 [--note "..."]
orion model proposals reject 4 --note "..."              # the note is required; the agent reads it next run
```

Credentials: put `ANTHROPIC_API_KEY=...` in `<ORION_HOME>/.env` (or the environment). Without it the SDK looks for its own credentials, so an `ant auth login` profile also works. Use a dedicated Console workspace and key with a monthly spend limit, and enable web search for the organization.

What the agent can do directly: change an assumption inside its band for that scenario (the `bear`/`base`/`bull` sub-ranges under `assumptions:` in the asset YAML) and within the max step per run (25 percent of the band's width), citing at least one observation it has seen in that run; resolve an open anomaly with evidence; record a researched figure as a provisional observation, citing a page it fetched in that run and quoting it verbatim; write its journal. Everything else becomes a proposal: a value outside its band or step, any change to the asset YAML, acknowledging an anomaly, confirming or rejecting an observation, and a researched value on a critical metric that moves more than `review_triggers.provisional_move_pct` (25) from the last confirmed value (its own earlier provisional figures never move that baseline). A quote it cites must sit inside one paragraph, table cell, or list item of the fetched page, so it cannot be spliced from unrelated parts; and it cannot record a figure where an observation already exists at the same metric and time: it proposes rejecting that one instead. While a `degrading` anomaly is open it cannot change assumptions at all. It can never touch `agent:` settings, persona or skill files, or a signal.

A run either finishes cleanly, journal entry included, and commits everything together, or commits nothing (`budget_exhausted`, `refused`, `no_journal`, `conflict`, `error`). The run row, the transcript, and the token counts are kept either way. `conflict` means the world changed mid-run (you saved an assumption set, say): run it again. After a commit that can move a signal the run values the asset and prints the signal; `change.author` and `provenance.agent_run_id` say who moved it. Exit codes: `0` completed, `2` completed with a `blocked` signal, `1` anything else.

Approving a config proposal edits `assets/<id>.yaml` in place, keeping comments and layout: review it with `git diff` and commit it. A proposal is refused as stale when what it was filed against has changed; reject it with a note. Personas and skills are markdown files in `personas/` and `skills/`; edit them like any other file, and runs record the hash of what they used. Per-run budgets (requests, tokens, web searches and fetches) have defaults in code and can be overridden under `agent:` in the asset YAML. There is no scheduler yet: run the agent by hand, or from your own cron, until sub-project 4.

## Maintaining the system

With the cron line in place, the daily signal takes care of itself. What is left for you:

| When | Command | Why |
|---|---|---|
| Whenever you want the number | `orion signal latest vvv` | Read the latest signal. |
| Weekly, or when a signal says `degraded` | `orion data anomalies vvv` | See what opened. |
| After checking an anomaly | `orion data ack <id> --note "..."` or `orion data resolve <id> --note "..."` | Close it. `ack`: understood and accepted. `resolve`: the cause is fixed. |
| Weekly | `orion data sources vvv` | Last fetch outcome and age of the value in force, per metric. |
| Weekly | `tail update.log` | Catch a source that keeps failing. Three failed runs in a row also open an advisory anomaly. |
| When Venice discloses revenue | `orion data set vvv revenue_run_rate_usd <n> --at <date> [--provisional --citation <url>]` | Revenue has no API. The advisory `revenue_disclosure_stale` anomaly says when usage has moved since the last figure. |
| When Venice announces an emission cut | `orion data set vvv emission_rate_annual <n> --at <effective date>` | Announced cuts exist only on their blog. Once the date passes, the daily on-chain read takes over. |
| When your views change | `orion model assumptions set vvv <key> <value> --scenario <s> --rationale "..."` | The next daily run picks it up. |
| Weekly | `orion agent run vvv --type weekly`, then `orion model proposals list` | The analyst reviews what moved; decide what it proposed. |
| Monthly | `orion agent run vvv --type deep` | Re-underwrite the thesis; expect structural proposals. |
| When an anomaly opens | `orion agent run vvv --type triage --anomaly <id>` | It resolves what has passed and proposes an acknowledgement for what will persist. |
| Rarely | `orion data fetch vvv --backfill-days <n>` | Re-scan burns after an allowlist change, or after adding a metric to the burn scan. |

Exit codes of `orion update`, for whatever watches the cron job: `0` for an `ok` or `degraded` signal, `2` for `blocked`, `1` for an error. A signal is always emitted, including `blocked`.

Anomalies never close themselves, but an acknowledgement stands: when the daily fetch sees an acknowledged condition again it says "seen again, stays acknowledged", counts the repeat on the same row, and the signal is not degraded again. A `resolved` anomaly that recurs opens a new one, because resolved means the cause was fixed. To withdraw an acknowledgement, `orion data resolve <id> --note "..."` the acknowledged anomaly: the next occurrence then opens a new one. The acknowledged row always carries the latest reading, so check `orion data anomalies vvv --all` now and then: a disagreement you accepted at 3 percent is still acknowledged at 30. For a disagreement you expect to last, widening that cross-check's `tolerance_pct` in `assets/<id>.yaml` is the cleaner fix.

Every command accepts `--json`. Signals follow schema v1 (spec section 9). Orion emits signals only. It is not investment advice.
