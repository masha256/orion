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
- Machine-written, in `orion.db` (git-ignored): observations, assumption-set versions, snapshots, runs, signals.

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

- A backfill is resumable: each completed UTC day commits on its own, and the next run carries on after the last one. `--backfill-days <n>` re-scans the last `n` days; re-scanned days supersede the old rows.
- Fetched flow rows never silently overwrite hand-entered ones. Without `--adopt`, a fetch that would overlap them writes nothing for that scan and lists the conflicting rows. `--adopt` rejects only rows whose source is `manual`.
- Several metrics can share one burn-flow scan (same token, sink, and allowlist) and so share its cursor: `--metric` on any one of them fetches every metric that shares its scan, at no extra cost.
- A metric added later to an existing scan group gets no history by itself (the cursor is already past those days): re-run with `--backfill-days <n>`.
- The cron line above runs in the machine's local time; the code itself works in UTC either way, and any time after 00:05 UTC picks up the previous UTC day.
- A plain `--dry-run` on a database that still has hand-entered burn rows reports the burn scan as `skipped` and lists the conflicts; add `--adopt` to the dry run to see what would be written without writing it.
- Cross-check readings are never stored. A reading outside its tolerance opens an anomaly:

```bash
orion data anomalies vvv                       # open anomalies (--all includes decided ones)
orion data ack 3 --note "Venice's API lags"    # understood and accepted: it stops affecting the signal
orion data resolve 4 --note "allowlisted the new buyback Safe"
```

  An open `degrading` anomaly on a critical metric makes the signal `degraded` with grade D until it is resolved or acknowledged. Advisory anomalies (a usage move since the last revenue disclosure, a source failing three runs in a row) are listed in `data_quality.anomalies` and change nothing else.
- Configuration, from the environment or `<ORION_HOME>/.env` (git-ignored): `ORION_BASE_RPC_URL` (default `https://mainnet.base.org`; the RPC must return `blockTimestamp` on logs, which Base's does) and `COINGECKO_API_KEY` (optional demo key; keyless works, more slowly).
- Still manual for VVV: `revenue_run_rate_usd`, and ANNOUNCED future emission cuts (`orion data set vvv emission_rate_annual <n> --at <effective date>`). Once the date passes, the daily on-chain read governs.

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
| Rarely | `orion data fetch vvv --backfill-days <n>` | Re-scan burns after an allowlist change, or after adding a metric to the burn scan. |

Exit codes of `orion update`, for whatever watches the cron job: `0` for an `ok` or `degraded` signal, `2` for `blocked`, `1` for an error. A signal is always emitted, including `blocked`.

Known limitation: an anomaly never closes itself, and an acknowledgement holds only until the same condition is seen again. The daily fetch re-evaluates every cross-check, so a mismatch that persists after you `ack` it opens a new anomaly on the next run, and on a critical metric the signal is `degraded` again. For a disagreement you expect to last, widen that cross-check's `tolerance_pct` in `assets/<id>.yaml` instead. See `docs/superpowers/notes/2026-09-19-ingestion-followups.md`.

Every command accepts `--json`. Signals follow schema v1 (spec section 9). Orion emits signals only. It is not investment advice.
