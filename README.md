# Orion

Token revenue, holder-flow and supply data with provenance: the data core for the coinrevs site. Orion fetches each asset's metrics from the sources named in `assets/<id>.yaml` (on-chain reads, first-party APIs, CoinGecko, and DefiLlama until Phase 3), cross-checks them, stores every observation with its source, opens anomalies when a check fails, and builds the holder-yield report (revenue, holder flows by bucket, yields, growth). It also stores issuer documents (call transcripts, posts) for the disclosure watcher's analyst runs.

Orion makes no price judgements. The valuation layer (price targets, assumption sets, signals, review triggers, the scheduled analyst runs) was removed in Phase 1 (2026-10-28). Roadmap, spec and followups: `docs/superpowers/specs/2026-10-28-orion-coinrevs-core-roadmap.md`, `docs/superpowers/specs/2026-10-28-orion-phase1-remove-valuation-design.md`, `docs/superpowers/notes/2026-10-28-orion-phase1-followups.md`.

Design of what stays: `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (ingestion, cross-checks, anomalies), `docs/superpowers/specs/2026-10-10-orion-holder-yield-report-design.md` (the report), `docs/superpowers/specs/2026-10-23-orion-disclosure-watcher-design.md` (documents and the disclosure run).

## Quick start

```bash
npm install && npm run build && npm link     # provides the `orion` command
export ORION_HOME="$PWD"
orion init
# .env (mode 600): ORION_DATABASE_URL=postgresql://orion_dev@/orion_dev?host=/var/run/postgresql   (always name the role)
orion db migrate                             # creates schema `orion` (or ORION_DB_SCHEMA) and applies the migrations
orion asset validate
orion data fetch vvv --dry-run               # read and cross-check everything, write nothing
orion data fetch vvv                         # the first real run backfills the flows
orion report yield vvv
```

## Where things live

- Human-authored, in git: `assets/*.yaml` (metrics, sources, cross-checks, the `income_statement` block: revenue, its uses and holder-flow lines, dilution, checks), `personas/` and `skills/` (the disclosure analyst).
- Machine-written, in PostgreSQL 18 (since Phase 1.5b; schema `ORION_DB_SCHEMA`, default `orion`): observations, fetch runs, fetch cursors, anomalies, coverage, documents, agent runs and their transcripts, proposals, the journal. The SQLite `orion.db` of earlier releases is imported once with `tools/import-sqlite` and then archived. Its valuation-era tables, `config_versions` and `run_locks` are not carried. Setup, migrations, the import runbook and diagnostic queries are in `docs/ops/postgres.md`.

## Commands

Kept: `init`, `db`, `asset`, `data`, `report`, `doc`, `proposals`, `inbox`, `persona`, `agent` (disclosure runs only), `tick`. Removed in Phase 1: `model`, `signal`, `update` (each is now an unknown command). `proposals` moved from `model proposals` to the top level.

```bash
orion db status | migrate [--breaking]    # the Postgres schema vs this build; migrations never run on open
orion asset list | show <id> | validate [id]
orion data fetch [asset] [--metric <key>]... [--backfill-days <n>] [--adopt] [--dry-run]
orion data sources vvv                    # per metric: source, cross-checks, last fetch outcome, age of the value in force
orion data show vvv [metric]              # active observations, newest first
orion data backfill-tokens crv [--metric <key>]... [--days <n>] [--dry-run]   # fill token amounts on pre-0005 flow rows: transfer scans (+ hourly buckets), first-party dollar series as usd (never changes value; exit 1 on a refused day)
orion data compare-usd crv [--days 91]   # stored USD vs hourly tokens x hourly prices, per metric (read-only; gate G2)
orion data set vvv price_usd 28.10 --citation <url>   # a hand-entered observation: a disclosure, so --citation is required (add --quote "...")
orion data confirm <obs_id>               # promote a provisional observation
orion data reject <obs_id>                # retire an observation; the row is kept
orion data anomalies [asset] [--all]
orion data ack <id> --note "..."          # understood and accepted; stays acknowledged when seen again
orion data resolve <id> --note "..."      # the cause is fixed; a recurrence opens a new anomaly
orion report yield [asset] [--day <yyyy-mm-dd>] [--json]
orion inbox vvv                           # provisional rows to confirm, pending proposals, open anomalies
orion proposals list [asset] | show <id> | approve <id> [--note "..."] | reject <id> --note "..."
orion doc add lit --url <post url> --file call.txt --kind machine_transcript   # append-only
orion doc list [asset] | show <id> [--text]
orion persona list | show <name> | assign <asset> <name>
orion agent run lit --type disclosure --doc <id> [--dry-run]
orion agent runs list [asset] | show <id> [--transcript]
orion tick <asset>                        # the scheduled entry point (below)
```

Every command accepts `--json`.

Flow rows must not overlap each other: each one covers `[--at minus --period-days, --at]`. When the full-period figure arrives, `orion data reject <id>` the partial-period row first, then enter the full one.

## Ingest

Metrics with a `source:` in `assets/<id>.yaml` are fetched; the rest are entered by hand.

- A backfill is resumable: each completed UTC day commits on its own, and the next run carries on after the last one. `--backfill-days <n>` re-scans the last `n` days; re-scanned days supersede the old rows.
- Fetched flow rows never silently overwrite hand-entered ones. Without `--adopt`, a fetch that would overlap them writes nothing for that scan and lists the conflicting rows. `--adopt` rejects only rows whose source is `manual`.
- Metrics that share one transfer scan share its cursor: `--metric` on any one of them fetches all of them. A metric added later to an existing scan gets no history by itself: re-run with `--backfill-days <n>`.
- Cross-check readings are never stored. A reading outside its tolerance opens an anomaly; so does a source failing three runs in a row (except a source that feeds only `monitor_only` metrics) and, for VVV, a usage move since the last revenue disclosure (`revenue_disclosure_stale`, advisory). Anomalies never close themselves and nothing acts on them by itself: `ack` or `resolve` them. An acknowledged anomaly carries the latest reading, so check `orion data anomalies <a> --all` now and then; for a disagreement you expect to last, widen that cross-check's `tolerance_pct` instead.
- A `watch` rule on a `monitor_only` metric reports a move in the fetch detail and the tick report, never as an anomaly.
- Configuration, from the environment or `<ORION_HOME>/.env` (git-ignored, mode 600): `ORION_DATABASE_URL` (required; it must name the role, e.g. `postgresql://orion_dev@/orion_dev?host=/var/run/postgresql`), `ORION_DB_SCHEMA` (default `orion`), `ORION_BASE_RPC_URL` (default `https://mainnet.base.org`; the RPC must return `blockTimestamp` on logs), `ORION_ETH_RPC_URL` (required for the Ethereum assets: there is no keyless default), `COINGECKO_API_KEY` (optional demo key; keyless works, more slowly), `ANTHROPIC_API_KEY` (disclosure runs only).

## The report

`orion report yield <a>` covers the asset's `income_statement.window_days` (91) up to its latest complete day: price, market cap (price x circulating supply), FDV (price x total supply), revenue (the sum of the `income_statement.revenue` lines) and its growth, cost of revenue and gross profit, holder flows by bucket (burn, hold, cash) with their yields on price, dilution, the payout ratio and the multiples. Nothing in it is a forecast. Its JSON is the income statement v2 (`incomeStatement`: revenue, cost of revenue, gross profit, holders, protocol, below the line, holder flow by bucket, ratios, multiples, per-token figures, flags) with the price, market cap and FDV. It is the only report: the v1 keys and `--legacy` were retired in Phase 2 Task 11 (`--legacy` is now refused).

## Development

Tests need the local Postgres 18 (`scripts/provision/dev-postgres.sh --os-user <you>`, on `main`; see `docs/ops/postgres.md`) and a `*_test` database. The suite refuses to start without one:

```bash
export ORION_TEST_DATABASE_URL='postgresql://orion_dev@/orion_test?host=/var/run/postgresql'   # the role must be named
npx vitest run --maxWorkers=2
npm run typecheck
npm run lint:promises
```

Each test file gets its own schema `t_<hex>` in `orion_test`, which is dropped afterwards. No test mocks the database.

## The daemon and releases (Phase 1.5c)

On the server (venus) each environment, `prod` and `stage`, runs one `orion daemon` as a systemd user unit of its Unix
user (`orion-prod`, `orion-stage`). The daemon schedules and runs everything: the nightly refreshes and report (00:45
UTC; staging 02:45), the hourly levels and watch alerts (staging every 6 h), snapshot publishing to the env's
`orion-data` repo, the disclosure watcher (16:40 UTC), retention (03:30 UTC) and, on staging, a weekly restore of prod's
nightly dump (Sun 10:30 UTC). It posts to Slack itself and pings external dead-man checks. Which assets run is the
per-environment asset registry (`orion asset activate | pause | resume | registry`); a YAML new in a release arrives
inactive. Runbooks: `docs/ops/daemon.md` (jobs, slots, registry, logs, every Slack line), `docs/ops/deploy.md` (build,
deploy, soak, rollback), `docs/ops/disclosure-watcher.md`.

A release is an annotated tag `orion-YYYY.MM.DD.N` built by `scripts/release/build.sh` into `~/orion-releases/<tag>.tgz`
and installed by `scripts/release/deploy.sh <stage|prod> <tag>` through the forced-command `orion-remote` (no shell on
the server). Layout per server user:

```
~/releases/<tag>/   dist/ assets/ personas/ skills/ schedule.yaml tools/disclosure-watcher/ scripts/provision/ RELEASE .installed
~/current           -> releases/<tag>   (the config root: a release's YAML is read-only; config changes ship as releases)
~/home/             data home (ORION_HOME): daemon.log, publish/, disclosure/
~/shared/.env       secrets (ORION_ENV_FILE), re-read at every job
```

`RELEASE` (JSON: tag, commit, schema, built_at) marks a release root; a git checkout is never one (a stray `RELEASE` at a
checkout root is ignored). Commands: `orion daemon [--allow-retire]`, `orion daemon status | drain [--wait 30m] |
undrain`, `orion job run-now <kind> [asset] [--slot <iso>]`, `orion job list [--since <iso>] [--kind <k>]`,
`orion asset registry [diff | reconcile [--allow-retire] | seed ...]`, `orion db query-ro <sql>` (read-only diagnostics).

Environment variables of the platform (the process environment wins over the `.env` file; a blank process value never
overrides it):

| Variable | Meaning |
|---|---|
| `ORION_ENV` | `dev` (default), `stage` or `prod`. The unit sets it. stage/prod refuse to run without a `RELEASE` and require `ORION_HOME` and `ORION_ENV_FILE`. |
| `ORION_HOME` | the data home (logs, publish clone, watcher state). Dev: also the config root and the `.env` directory. |
| `ORION_CONFIG_ROOT` | where `assets/`, `personas/`, `skills/` and `schedule.yaml` are read from. Default: the release root when the running `dist/` has a `RELEASE` beside it, else `ORION_HOME`. |
| `ORION_ENV_FILE` | the `.env` file. Default `<ORION_HOME>/.env`; the server uses `~/shared/.env`. |
| `ORION_DATABASE_URL` | Postgres URL; it must name the role: `postgresql://orion_<env>@/orion_<env>?host=/var/run/postgresql`. `ORION_DB_SCHEMA` defaults to `orion`. |
| `SLACK_WEBHOOK_URL` | the env's channel (prod #orion-ops, staging #orion-staging; must differ). Required on stage/prod; unset in dev = log only. |
| `ORION_PUBLISH` | snapshot target: `git:<ssh url>#<branch>` of the env's own repo (`masha256/orion-data` / `orion-data-staging`), or `off` (every nightly says `PUBLISH OFF`). Required on stage/prod. With `ORION_SIGN_KEY_FILE`, `ORION_PUBLISH_SSH_KEY`, `ORION_PUBLISH_DIR` (the unit sets them). |
| `ORION_DEADMAN_URL` | prod's hourly dead-man check, pinged after each `levels` job that read every asset and delivered every post. |
| `ORION_DEADMAN_NIGHTLY_URL` | the nightly report's dead-man check (prod and staging each have one). Required on stage/prod. |
| `COINGECKO_API_KEY`, `COINGECKO_PLAN` | the key, and its plan: unset or `demo` = the public API with the demo header; `pro` = `pro-api.coingecko.com` (the Basic plan). Prod sets `pro` with the Basic key before launch. |
| `ORION_WATCHER_VENV` | the disclosure watcher's venv (default `~/watcher-venv`). |
| `ORION_REFRESH_DUMP` | staging refresh: prod's dump (default `/home/orion-refresh/latest.dump`). |

## Daily operation

Until cutover the live install still runs from Hermes, as below; on the server the daemon replaces it.

`orion tick <asset>` is what a scheduler calls. In one process: take the asset's run lock, ingest, build the holder-yield report for the latest complete day, release the lock, build the inbox; then print the tick report (one JSON line, `schema_version: 2`) and append it to `<ORION_HOME>/ticks.jsonl`. It never starts an agent run and writes no `signals.jsonl`. Exit codes: `0` fetched and reported (or `run_in_progress`: another run holds the lock), `1` nothing fetched (the ingest threw), `2` fetched but the report is missing (`report_unavailable`) or more than 3 days behind the tick (`report_stale`).

`./run-daily.sh [asset]` is the same as a script for any scheduler: it needs no environment, calls `dist/cli/index.js` directly, prints the tick report on stdout and keeps stderr in `tick.log`. The scheduled Hermes job that runs it, reports to Slack and carries out the owner's decisions is in `docs/ops/hermes-daily-job.md`. Run it once a day, any time after 00:05 UTC and well clear of midnight (the live server: 05:05 to 06:05 America/Los_Angeles, one asset every 5 minutes).

**The run lock** is a Postgres session advisory lock per asset, held on its own connection for the whole run. `orion tick` and `orion agent run` take it. A second one finds it held and gets `run_in_progress` naming the holder and since when: exit 0 for tick, an error and exit 1 for `agent run`. The lock dies with its holder's connection, so a killed run frees it at once. The next acquirer marks any `running` agent run of the asset `error/abandoned`.

## Disclosure runs

The one analyst run left. A `disclosure` run reads one stored issuer document (`orion doc add`) and compares every figure and dated plan in it with what Orion measures. Value changes it wants and figures it records become proposals or inert rows that wait for you; code and data-source work becomes dev findings in the run summary (`orion agent runs show <id>`); dated plans become catalysts in the journal; each one cites the document. The disclosure watcher starts one per new issuer call (`docs/ops/disclosure-watcher.md`); the tick never does. Its budget is `agent.budgets.disclosure`, about $1 to $3 a call. `--out <file>` is accepted and ignored (no run writes a signal any more).

Credentials: `ANTHROPIC_API_KEY=...` in `<ORION_HOME>/.env` or the environment. A run either finishes cleanly and commits everything together, or commits nothing (`budget_exhausted`, `refused`, `no_journal`, `conflict`, `error`); the run row, transcript and token counts are kept either way. Exit `0` completed, `1` anything else. Old weekly, triage, deep and bootstrap runs stay readable with `orion agent runs list|show`.

Approving a config proposal edits `assets/<id>.yaml` in place, keeping comments and layout: review it with `git diff` and commit it (the asset's hash-pin test fails until it is re-pinned). Valuation-era `assumption_value` proposals are not carried into Postgres, and the database refuses that kind. Personas and skills are markdown files; runs record the hash of what they used.

## Maintaining the system

| When | Command | Why |
|---|---|---|
| Daily, from the Hermes message | reply `confirm <id>`, `reject <id>`, `approve <id> [note]`, `decline <id> <note>`, `ack <id> <note>`, or `resolve <id> <note>` | The message ends with the inbox; Hermes runs the one command for your reply. `orion inbox <a>` shows the same queue. |
| When an anomaly opens | `orion data anomalies <a>`, then `ack` or `resolve` | It stays in every daily message until you decide it. |
| Weekly | `orion data sources <a>` | Last fetch outcome and age of the value in force, per metric. |
| When Venice states a new VVV run rate | `orion data set vvv revenue_run_rate_usd <usd> --citation <url> --quote "..."` | VVV's revenue is its cited disclosures. |
| After a disclosure run | `orion agent runs show <id>`, `orion proposals list` | Read what it found; decide its proposals. |
| Rarely | `orion data fetch <a> --backfill-days <n>` | Re-scan flows after an allowlist change, or after adding a metric to a scan. |

Orion reports data. It is not investment advice.
