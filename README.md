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
- Cross-check readings are never stored. A reading outside its tolerance opens an anomaly:

```bash
orion data anomalies vvv                       # open anomalies (--all includes decided ones)
orion data ack 3 --note "Venice's API lags"    # understood and accepted: it stops affecting the signal
orion data resolve 4 --note "allowlisted the new buyback Safe"
```

  An open `degrading` anomaly on a critical metric makes the signal `degraded` with grade D until it is resolved or acknowledged. Advisory anomalies (a usage move since the last revenue disclosure, a source failing three runs in a row) are listed in `data_quality.anomalies` and change nothing else.
- Configuration, from the environment or `<ORION_HOME>/.env` (git-ignored): `ORION_BASE_RPC_URL` (default `https://mainnet.base.org`; the RPC must return `blockTimestamp` on logs, which Base's does) and `COINGECKO_API_KEY` (optional demo key; keyless works, more slowly).
- Still manual for VVV: `revenue_run_rate_usd`, and ANNOUNCED future emission cuts (`orion data set vvv emission_rate_annual <n> --at <effective date>`). Once the date passes, the daily on-chain read governs.

Every command accepts `--json`. Signals follow schema v1 (spec section 9). Orion emits signals only. It is not investment advice.
