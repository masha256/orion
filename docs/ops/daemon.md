# The Orion daemon (Phase 1.5c)

One `orion daemon` process per environment runs everything on a schedule: the nightly refreshes and report, the hourly
levels, the snapshot publishing, the disclosure watcher, retention and (staging only) the weekly refresh from prod. It
replaces the 13 Hermes `orion-<asset>` jobs and `orion-disclosure-watch` at cutover (`docs/ops/hermes-daily-job.md` is
kept for the fallback week). Spec: `docs/superpowers/specs/2026-10-28-orion-platform-postgres-design.md` §5, §6, §8.5,
§9 (with its "Amendments made during execution"). Deploying it: `docs/ops/deploy.md`.

## Where it runs

| | prod | staging |
|---|---|---|
| host | venus (192.168.0.12) | venus |
| Unix user | `orion-prod` | `orion-stage` |
| database / role | `orion_prod` / `orion_prod` (schema `orion`) | `orion_stage` / `orion_stage` |
| Slack | #orion-ops | #orion-staging |
| snapshots | `masha256/orion-data` | `masha256/orion-data-staging` |
| dead-man checks | levels hourly (`ORION_DEADMAN_URL`, `15 * * * *`), nightly (`ORION_DEADMAN_NIGHTLY_URL`, `45 0 * * *`) | nightly only (`45 2 * * *`) |

The process is the systemd **user** unit `orion-daemon.service` of that user (linger on, so it runs without a login
and starts at boot). It runs `/opt/node-v26/bin/node ~/current/dist/cli/index.js daemon` with `ORION_ENV`,
`ORION_HOME=~/home`, `ORION_ENV_FILE=~/shared/.env`, the sign and publish key paths and `ORION_WATCHER_VENV=~/watcher-venv`
set by the unit. `Type=notify`, `WatchdogSec=120` (the daemon pings the watchdog every 30 s), `Restart=always` after
30 s, `TimeoutStopSec=15min`. The unit is enabled by `orion-host.sh` but never started by it; it is skipped until a
release exists (`ConditionPathExists=%h/current/RELEASE`).

Layout of each user's home:

```
~/releases/<tag>/          an installed release (dist/, assets/, personas/, skills/, schedule.yaml, tools/disclosure-watcher/,
                           scripts/provision/, RELEASE, .installed); the newest 5 are kept
~/current -> releases/<tag> the running release (repointed atomically by orion-remote switch)
~/shared/.env              secrets, mode 600, Mike's; re-read at the start of every job (no restart after an edit)
~/shared/snapshot-sign.key, ~/shared/publish_ed25519, ~/shared/predeploy/   (signing key, GitHub deploy key, --breaking dumps)
~/home/                    data home: daemon.log (+ .1 at 10 MB), publish/ (the snapshot repo clone), disclosure/,
                           start-failure.json
~/watcher-venv/            the disclosure watcher's Python (orion-host.sh --with-watcher)
~/deploys.log, ~/remote.log  every switch/rollback; every orion-remote call (verb, argc, outcome; never argument text)
```

## Start-up

In this order, each refusal posting one `ORION ALERT <env>: daemon not started: <reason>` (not re-posted for the same
failure on the next restart; `~/home/start-failure.json` remembers it) and exiting non-zero:

1. The singleton lock (a Postgres session advisory lock): a second daemon on the same database refuses to start.
2. The schema must be current for this release (`orion db status`; migrations run only in `switch`).
3. stage/prod need `SLACK_WEBHOOK_URL`, `ORION_DEADMAN_NIGHTLY_URL` and `ORION_PUBLISH` (`off` allowed) in the `.env`.
4. Every asset YAML must load; `schedule.yaml` must parse; `ORION_PUBLISH` must name this env's own repo (staging never
   publishes to `orion-data`, prod never to `orion-data-staging`).
5. Registry reconciliation against the release's `assets/` (below). One that would retire every asset or more than 2
   at once is refused (`reconcile_would_retire`) unless the operator accepts it (`orion-remote reconcile --allow-retire`).
6. Every job left `running` by a dead daemon is re-queued (or failed, when it has no attempts left) and posts
   `ORION RESTARTED <env> after unclean exit, job <id> re-queued|failed (lease_expired)`.

## Jobs

A scheduler enqueues the newest slot of every schedule entry every 30 s. A job exists once per (kind, asset, slot), so a
restart or a second scheduler never doubles one, and after downtime only the newest missed slot runs. One worker claims
jobs by priority under a 3 min lease renewed every 60 s; a job whose lease is lost is aborted and its result dropped.

| kind | priority | attempts | what it does |
|---|---|---|---|
| `staging_refresh` | 5 | 1 | stage only: restores prod's nightly dump into staging (below) |
| `refresh` | 10 | 2 (retry after 30 min) | one asset's nightly tick: fetch, cross-checks, anomalies, watch state. Skipped for an asset not active |
| `nightly_report` | 20 | 1 | waits (deferred 5 min at a time, up to 3 h) for the slot's refreshes, posts the nightly report, pings `ORION_DEADMAN_NIGHTLY_URL`, stores the `full` snapshot and queues a `snapshot_push` |
| `snapshot_push` | 30 | 1 | publishes the newest pending snapshots (git driver: commit + push to the env's repo); a failure re-queues itself (1, 5, 15 min, then hourly) |
| `levels` | 40 | 1 | reads the level metrics of every active asset into `latest_levels`, posts watch fire/clear lines, stores the `levels` snapshot, pings `ORION_DEADMAN_URL` |
| `disclosure_watch` | 50 | 1 | the disclosure watcher's daily `scan` (`docs/ops/disclosure-watcher.md`) |
| `retention` | 60 | 1 | deletes finished jobs older than 90 days, levels/watch rows of retired assets or metrics, and outbox rows older than 30 days (keeps the newest 7 `full` and the newest `levels`) |

A `failed` job is retried only when it has attempts left and the handler asked for a retry; a handler that throws is
retried after 10 min (only `refresh` has a second attempt).

## Slots (`schedule.yaml`, UTC; never a daily slot in 07:00-08:00 UTC)

| entry | UTC | Pacific (PST / PDT) | stage |
|---|---|---|---|
| `nightly` (refreshes + report) | 00:45 daily | 16:45 / 17:45 the day before | 02:45 (18:45 / 19:45) |
| `levels` | every hour at :15 | every hour at :15 | every 6 h at :15 (00:15, 06:15, 12:15, 18:15) |
| `retention` | 03:30 daily | 19:30 / 20:30 the day before | same |
| `disclosure_watch` | 16:40 daily | 08:40 / 09:40 | same (dry run) |
| `staging_refresh` | Sun 10:30 | Sun 02:30 / 03:30 | stage only |
| (prod dump, `orion-pg-dump.timer`, root's) | 08:30 daily | 00:30 / 01:30 | not yet enabled (backups step) |

The nightly report is labelled with the UTC day before the slot. A slot is UTC only, so DST never moves it; the Pacific
column moves by an hour instead. `orion daemon status` prints the next slot of each entry.

## The asset registry

What exists is the release's `assets/*.yaml`; what runs is the registry (`asset_registry`, per environment).

- A YAML new in a release arrives `inactive`; only `asset activate` makes it active. A YAML gone from a release turns its
  row `missing` (its data is kept; its levels and watch rows go at the next retention); it comes back `inactive`.
- `asset pause <a> --reason <text>` stops its refreshes and levels from the next job; `asset resume <a>` returns it to the
  state it was paused from (an asset paused while inactive resumes inactive). `resume` prints the paused days and the
  backfill the next refresh covers.
- An asset activated after a nightly slot began gets no refresh for that slot; `activate` prints the next slot and
  suggests `job run-now refresh <a>`.
- Never rename an asset YAML: the id is the file name, so a rename is a retirement plus a new inactive asset with no data.
- Every change is an event in `asset_state_events` (who, why, which release).

Through `orion-remote` (recorded `--by raymond`, or `--for mike` → `mike via raymond`):

```
asset registry            # every row: state, since, by, reason
asset registry diff       # what this release's YAML would change (also printed by install)
asset pause <a> --reason "<text>" [--for <who>]
asset resume <a> [--for <who>]
asset activate <a> [--for <who>]
reconcile --allow-retire [--yes]   # only for a refused retirement: prints the diff; --yes applies it
```

`orion asset registry seed [ids...|--all] --reason <text> --by <who>` is for cutover only: it refuses unless the registry
is empty and prints what it activates.

## Drain, undrain, restart

- `orion daemon drain [--wait 30m]`: the daemon finishes the job it holds, claims nothing new and reports `drained`.
  A daemon whose unit is not active or whose heartbeat is older than 30 min is treated as gone (`orion-remote` stops the
  unit instead of waiting). `switch` and `rollback` drain first; you rarely need it by hand.
- `orion daemon undrain`: the daemon claims jobs again (a failed `switch` does this itself).
- If `orion-remote` dies between drain and restart, the next `orion-remote` call of any verb undrains and restarts the
  daemon and prints `recovered <verb> ...` (also in `~/deploys.log`).
- Raymond has no shell on venus: restarts happen through `switch`/`rollback`. `systemctl --user` by hand is Mike's.

## Logs and diagnostics (`orion-remote`, from uranus)

```
ssh -i ~/.ssh/orion-prod_ed25519 -o IdentitiesOnly=yes orion-prod@192.168.0.12 <verb>     # or orion-stage / orion-stage_ed25519
status [--json]          # env, host, current release, postgres, heartbeat, registry, last 10 jobs, next slots, soak, last nightly
logs [n]                 # the last n lines of ~/home/daemon.log (default 200, at most 2000)
jobs [--since <iso>]     # the job list (JSON)
dev-queue [n]            # the watcher's dev queue (~/home/disclosure/dev-queue.md)
report yield [<a>] [--day <d>] | data anomalies [<a>] [--all] | data sources <a> | data show <a> [<metric>]
proposals list [<a>] [--all] | agent runs list [<a>] | inbox <a>
confirm|reject <id> | approve <id> [note] | decline|ack|resolve <id> <note>
job run-now <kind> [asset] [--slot <iso>]   # enqueues; nightly_report needs --slot (the slot to report again)
refresh-staging          # stage only: job run-now staging_refresh
refresh-staging --stdin <sha256> < dump   # stage only: restore an uploaded pg_dump -Fc dump (below); waits for the job
load-prod --stdin <sha256> < dump         # prod only, once: the cutover's initial load into an empty prod (deploy.md)
sql-ro "<one SELECT>"    # prod only: orion db query-ro as orion_prod_ro (read-only, 30 s, one statement, no backslash)
```

`daemon.log` lines are `<ISO> <text>`: `queued job <id> <kind> [asset] slot <iso>`, `job <id> <kind> started (attempt
a of m)`, `... done|skipped|failed: <error>|deferred until <iso>`, `... lease expired, re-queued`, plus each handler's
own lines (`job <id> refresh lit: ...`). A job's full result is in `jobs` (`result_json`).

## What each Slack line means

| line | from | means / do |
|---|---|---|
| `ORION NIGHTLY <env> <day>: <n> assets ok` | nightly_report | all refreshes ran, nothing alerts; the asset blocks follow (`== <SYM> ==`) |
| `ORION ALERT <env> nightly <day>: <n> alert(s)` | nightly_report | the head lists what: anomalies, `REFRESH MISSING <SYM>: no finished refresh 3 h after the <slot> slot`, `LAG <SYM> <n>d` (an asset's last complete day is n days behind; LIT 1 day is normal and not listed), `PUBLISH PENDING <n> snapshot(s), oldest <iso>`, WATCH FIRING; also PAUSED, INACTIVE, MISSING, CONFIG CHANGED, RESUMED lines |
| `PUBLISH OFF` | nightly_report | `ORION_PUBLISH=off`: nothing is published (not an alert) |
| `ORION ALERT <env> nightly <day>: report not built: ...` / `the full snapshot was not stored: ...` | nightly_report | look at `logs`; no dead-man ping follows, so the check goes red too |
| `ORION ALERT <env> refresh <SYM> failed twice: <code>: <message>` | refresh | both attempts failed; `data sources <a>` |
| `ORION WATCH <SYM>: <metric> <rule> <value> (was <prev>)` / `ORION WATCH <SYM> cleared: <metric> <rule>` | levels, refresh | a watch rule started / stopped firing |
| `ORION ALERT <env> snapshot publish failing since <iso>: <error>` | snapshot_push | pushes failing for 3 h (or at once for a moved remote or a wrong repo) |
| `ORION RESTARTED <env> after unclean exit, job <id> ...` | start-up | the previous process died mid-job |
| `ORION ALERT <env>: daemon not started: <reason>` | start-up | fix the reason (often the `.env`: Mike); systemd retries every 30 s |
| `ORION DISCLOSURE ...` / `ORION DISCLOSURE ALERT ...` | disclosure_watch | the watcher's own lines (`docs/ops/disclosure-watcher.md`) |
| `ORION ALERT <env> disclosure_watch exit <code>: <stderr line>` | disclosure_watch | the scan crashed or timed out (2 h) |
| `ORION STAGING REFRESH done: restored <dump mtime>, <n> tables` | staging_refresh | staging holds prod's data as of that dump |
| `ORION STAGING REFRESH done: restored the uploaded dump (<mtime>), <n> tables` | staging_refresh | the dump sent with `refresh-staging --stdin` is restored |
| `ORION PROD INITIAL LOAD done: restored the uploaded dump (<mtime>), <n> tables` | staging_refresh (prod) | the dump sent with `load-prod --stdin` is restored into the empty prod |
| `ORION ALERT prod initial_load: prod already holds data ...` | staging_refresh (prod) | refused: prod has observations or fetch runs, nothing restored |
| `ORION ALERT stage staging_refresh: <reason>` | staging_refresh | below |

Silence means broken: the dead-man ping is withheld whenever a post is undelivered, the nightly report could not be
built, or (levels) any asset's read threw. A red healthchecks check with no Slack line means the daemon is down or
cannot post: `status` and `logs` first.

## The staging refresh (`staging_refresh`, stage only)

Weekly (Sun 10:30 UTC) or by `refresh-staging`. Restores prod's nightly dump `/home/orion-refresh/latest.dump`
(`$ORION_REFRESH_DUMP` overrides; written by root's `orion-pg-dump` at 08:30 UTC, group `orion-refresh`, 640) into
`orion_stage`:

- Not stage: `skipped` (`not stage`); it never restores into prod or dev.
- No dump file: `skipped`, `no dump yet`, one log line, no post. This is the state until the backups step enables the dump
  timer.
- A dump that is not a readable file, or older than 36 h: `failed` + ALERT (the dump timer has stopped).
- The dump's `schema_migrations` (ids and checksums) must equal staging's, else `schema mismatch: prod <a>, staging <b>;
  refresh after both run the same schema`. Deploy the same release to both first.
- Restore: `pg_restore --clean --if-exists --no-owner --no-privileges --role=orion_stage --single-transaction` of a
  filtered TOC (a failure rolls everything back). Kept from staging, never restored: `jobs`, `asset_registry`,
  `asset_state_events`, `latest_levels`, `watch_state`, `snapshots_out`, `daemon_heartbeat`, `day_blocks`,
  `schema_migrations`, and everything depending on them. Everything else (observations, fetch runs and cursors,
  anomalies, coverage, agent runs, transcripts, proposals, journal, documents) becomes prod's: staging's own week of those
  rows is overwritten, by design. Grants are not restored (prod's grant to `orion_prod_ro` would leak onto staging).
- Then registry reconciliation against staging's release and a migration status check; then the done line.

It runs at priority 5 with one worker, so nothing else runs meanwhile.

**An uploaded dump (`refresh-staging --stdin <sha256>`, I-1/I-2).** Staging's data can also come from a dump made on
uranus (an import proven there, `docs/ops/deploy.md` "First staging deploy"): `ssh orion-stage refresh-staging --stdin
<sha256> < latest.dump`. orion-remote reads the stdin (8 GB cap) into `~/home/incoming/staging-refresh.dump` (600, the
directory 700), refuses a wrong sha256 or a file that is not a `pg_dump -Fc` dump (no `PGDMP` header), queues
`staging_refresh`, waits for it (up to 3 h), prints the job and exits 0 only when it is `done`. While that file exists the
job restores it instead of prod's dump, by exactly the steps above (filtered list, schema check, one transaction, the
Slack line says `the uploaded dump`), and removes it afterwards whatever the outcome; orion-remote removes it too, so it
is never restored twice and never ages into the 36 h alert. Nothing for Mike to place by hand.
