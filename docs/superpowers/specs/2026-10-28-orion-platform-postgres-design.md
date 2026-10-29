# Orion Phase 1.5: platform (environments, daemon, deploy, Postgres)

Status: **revision 2**, draft for review (2026-10-29, kanban t_269c7cc5). Revision 1 (f27fd4c, DO managed Postgres + an
Orion droplet + timers) was overtaken before review by Mike's revised roadmap decisions 8-12 (Slack #orion-dev,
2026-10-28; umbrella `2026-10-28-orion-coinrevs-core-roadmap.md` on branch `feat/coinrevs-core` @ 192762c). Assumes
Phase 1 (`2026-10-28-orion-phase1-remove-valuation-design.md`) has landed: no engine, signals, assumptions, journal or
trigger firings; a refresh = lock, ingest, anomalies, report.

Fixed by Mike (not re-argued here):
- **Hosting (decision 8, revised).** Prod and staging Orion and their Postgres run on Mike's own server on the same LAN as
  this dev host (quad-core i7, 16 GB RAM, SSD, on a UPS). No DO managed Postgres, no Orion droplet. The coinrevs website
  stays on DigitalOcean.
- **Users (decision 9).** Two Unix users on that server (prod, staging), same layout under each home, own `.env`, own
  schedule, own database and role on the local Postgres over the Unix socket; the staging role has no rights on the prod
  database. Raymond deploys over SSH from this host with forced-command keys (no SSH key exists here yet). Dev stays on
  this host with a local Postgres.
- **Backups are ours**: nightly `pg_dump` plus WAL archiving (PITR), copied off the box, with a restore drill.
- **Site path (decision 10).** The site never connects into the LAN. Orion pushes a versioned snapshot after every
  refresh. The read-only `coinrevs_site` role of revision 1 is dropped.
- **Scheduling (decision 11).** One long-lived `orion daemon` per environment (systemd service, `Restart=always`):
  internal scheduler, a jobs table with leases so a restart never double-runs, heartbeat and watchdog. Asset definitions
  stay YAML in the release; an asset registry table holds state (active / paused with who, when, why; last run).
  `orion asset pause <a> --reason` / `resume` / `activate`. Paused assets are skipped and listed as paused in the report.
  No cron job or script per asset.
- **Cadence (decision 12).** Nightly full refresh after the UTC day closes (flows, income statement, snapshot push),
  plus hourly supply and watch-item reads written to a latest-only table (no history rows).

Nothing in this spec has been installed or provisioned. *Measured* figures were read on 2026-10-28/29 from main 34a9f9d,
the live `orion.db` (read-only `.backup` copy), and dry-run fetches in a scratch home with a request-counting `fetch`
preload (§5.7). Vendor prices were read from the vendors' public pages on 2026-10-29.

## 1. Survey (what exists today)

**Runtime path.** Hermes cron (raymond profile) runs 13 agent jobs `orion-<asset>` at 05:05-06:05 PT, 5 min apart. Each has a
pre-run script `scripts/orion-tick-<asset>.sh` → `orion-tick.sh <asset>`, which sources `/home/hermes/git/orion/.env`, runs
`run-daily.sh <asset>` (→ `node dist/cli/index.js tick <asset>`, stderr appended to `tick.log`), retries once on exit 1
(10 min) or `run_in_progress` (30 min), and frames each attempt for the agent. The agent (a ~13k-character prompt per job)
formats the tick report into the #orion-ops message and later runs the decision verbs Mike replies with (confirm, reject,
approve, decline, ack, resolve). A 14th job, `orion-disclosure-watch` (09:40 PT, `no_agent`), runs a Python watcher that
lives outside the repo (`~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/`, 1,274 lines; needs `yt-dlp`,
`ffmpeg`, `faster-whisper` `small.en`, PyYAML) and calls the Orion CLI. Phase 1 rewrites the 13 prompts but keeps Hermes cron.

**DB layer.** `better-sqlite3`, synchronous. `src/db/` = 16 files, 1,852 lines; `openDb` sets WAL, `foreign_keys = ON`,
`busy_timeout`, and applies migrations on every open. 8 migrations; 5, 7 and 8 rebuild tables because SQLite cannot alter a
CHECK (they copy `sqlite_sequence` by hand).

**Live data (measured).** 28.2 MB file, schema 8. Rows kept after Phase 1: observations 27,447 (4,241 superseded; sources
onchain 20,340 / api 7,083 / manual 24), fetch_runs 329 (~10.6/day, avg 2.9 kB `detail_json`), fetch_cursors 55, anomalies 11,
config_versions 70, coverage 13, documents 1, proposals 4, agent_runs 49, agent_transcripts 49 (10.8 MB, of which the one
disclosure run is 0.24 MB), run_locks 0. Every timestamp is 24-char ISO UTC with milliseconds (`...T..:..:..sssZ`; 0
exceptions in observations). Every `value` is REAL; every `detail_json` is valid JSON. Largest block cursor 130,181,609.
(Observations were 27,645 in the 2026-10-29 copy: one more day of fetches.)

**Sources per asset (from `assets/*.yaml`, main 34a9f9d).** 34 transfer-scan groups (one `eth_getLogs` stream per
token + sink): Ethereum 31 (sdCRV 10, cvxCRV 7, SKY 4, CRV 3, LINK 3, LIT 2, UNI 1, yCRV 1), BNB 2 (CAKE), Base 1 (VVV).
Every asset has one CoinGecko `/coins/markets` read; USD-valued scans also pull a `market_chart` series per CoinGecko id.
First-party APIs: Hyperliquid (HYPE), Lighter (LIT), Venice (VVV), Solana RPC + Jupiter (PUMP), Llama Airforce (CRV).

**Conversion scope (measured on main, before Phase 1 removes its slice; the plan re-measures after it).**

| | files | lines | calls to the 51 exported db functions | raw `db.prepare/exec/transaction/pragma` |
|---|---|---|---|---|
| `src/` touching a `Db` | 40 | 5,864 | 116 | 61 (all but 7 inside `src/db/`) |
| `tests/` touching a `Db` | 57 | 11,387 | 553 | 113 (67 in `tests/db/connection.test.ts`) |

Raw transactions outside `src/db/`: `ingest/flow.ts:321`, `ingest/periodic.ts:70`, `ingest/apiFlow.ts:190`,
`app/proposals.ts:66`, `agent/ledger.ts:271` (plus `app/triggers.ts`, `app/valuation.ts`, removed in Phase 1). Ingest is
already async (network), so most callers above the DB already `await`; the new `async` surfaces are `report/load.ts`, the
`app/` and CLI command bodies, the agent context/tools/ledger used by disclosure runs, and every test.

**SQLite-specific code to replace.** `lastInsertRowid` (10 sites) → `RETURNING id`; `.changes` (10) → `rowCount`;
`INSERT OR IGNORE` (`runs.ts` config_versions; `assumptionChanges.ts` goes in Phase 1) → `ON CONFLICT DO NOTHING`;
`ON CONFLICT ... excluded.` (4, valid in Postgres as written); `.iterate()` in `fetchRuns.recentSourceStatuses` (scans every
fetch run of an asset in JS) → one SQL query over `json_array_elements(detail_json->'sources')`; `.immediate()` transactions
(run lock, periodic and API-flow writes, ledger) → the locking rule in §7.3; `IN (?,?,...)` → `= ANY($1)`; `?` → `$n`;
`pragma` calls and `sqlite_sequence` go. No `datetime()`/`strftime()`/`json_extract` in `src/` (the only `json_extract` use is
in the skill's diagnostic queries, which get Postgres equivalents in the ops doc).

**Test fixtures.** 45 test files open `':memory:'` or file DBs through `openDb`; `tests/helpers/{fetchHarness,agentWorld}.ts`
build most of them; `tests/db/connection.test.ts` tests SQLite migration mechanics directly (retired with them);
`tests/agent/concurrency.test.ts` and `tests/db/runLocks.test.ts` open two connections to one file to race the run lock;
`tests/cli/{cli,tick.cli,agent.cli}.test.ts` spawn the CLI against a temp `ORION_HOME`.

## 2. Hosting, environments and Unix users

### 2.1 The Orion server (Mike's LAN box)
Hardware (Mike): quad-core i7, 16 GB RAM, SSD, on a UPS, same LAN as this dev host. **Provisioning inputs still owed
(decision N1):** OS and version, hostname, a fixed LAN address (DHCP reservation), UPS model and whether it signals the
box (USB/NUT) so it can shut down cleanly before the battery runs out. Recommendation: Ubuntu 24.04 LTS, the same as
this dev host (systemd 255, same apt packages, same Node build), so dev and prod differ only in data.

| env | host | Unix user | `ORION_HOME` | DB / role (local socket) | scheduler | posts to |
|---|---|---|---|---|---|---|
| dev | this host | `hermes` | worktree or scratch dir | local Postgres: `orion_dev`; tests in `orion_test` | none (by hand, `orion job run-now`) | nowhere |
| staging | Orion server | `orion-stage` | `~orion-stage/home` | `orion_stage` / role `orion_stage` | its own daemon (§5) | #orion-staging (D3) |
| prod | Orion server | `orion-prod` | `~orion-prod/home` | `orion_prod` / role `orion_prod` | its own daemon (§5) | #orion-ops |

One Postgres cluster on the server holds both databases (Mike: "one DB + role per env"). Consequences, accepted here:
both environments share the server's RAM, disk and I/O (sizing in §11 shows ample headroom), and PITR restores the
cluster as a whole, so a prod point-in-time restore goes through a side instance (§10.3) rather than rewinding staging too.

Same layout under each home (only the user differs):

```
~/releases/<tag>/        immutable: dist/, assets/, scripts/, schedule.yaml, package.json, package-lock.json, node_modules/
~/current -> releases/<tag>
~/shared/.env            mode 600, never in a release (§4)
~/shared/site-push.key   Ed25519 private key for snapshot pushes (§9), mode 600; prod only
~/home/                  ORION_HOME: daemon.log (journal mirror), disclosure watcher state/ and transcripts/
~/bin/orion-remote       forced-command entry point for SSH (§3.4); installed by provisioning, not by releases
~/.config/systemd/user/orion-daemon.service   installed by provisioning (§5.1)
~/deploys.log            one line per install / switch / rollback
```

At cutover (§8.4) this dev host stops being production: `/home/hermes/git/orion` becomes a plain dev checkout, and the
live-install rules in the `orion` skill move to the server.

### 2.2 Network
- **Outbound only.** The server opens connections to RPC providers, CoinGecko, first-party APIs, Slack webhooks, the
  site's push endpoint (§9), DO Spaces (§10) and the dead-man's-switch service (§5.6). No port forward on the LAN
  router, no inbound from the internet. A residential uplink with a changing public IP therefore needs no handling.
- **Inbound on the LAN:** SSH only, from this dev host's LAN address and Mike's machine (`ufw` default deny, allow 22 from
  those two). Postgres `listen_addresses = ''` (Unix socket only); nothing on the network can reach it, this dev host
  included. Raymond's diagnostics go through `orion-remote sql-ro` (§3.4).
- Shared fate: the dev host and the server share the LAN, its uplink and (likely) its power circuit. Anything that
  watches the server from this host goes silent in the same outage, which is why the watchdog has an external leg (§5.6).

### 2.3 Software
Node: the same major on all three (pinned in `.nvmrc` and `engines`), installed system-wide under `/opt/node-v<major>` by
provisioning. Postgres: the same major on the server and this dev host, both from the PGDG apt repository (decision D12),
plus `pgbackrest` (§10). Python 3 + the watcher's deps on the server (D11).

## 3. Release and deploy

### 3.1 Releases
- A release is an annotated git tag on `main`, pushed to GitHub: `orion-YYYY.MM.DD.N` (date of cut, N from 1). Tags are
  never moved; a fix is a new tag.
- `scripts/release/build.sh <tag>` (dev host): `git worktree add --detach` the tag in `$TMPDIR`, `npm ci`, `npm run build`,
  full suite + typecheck against the local test Postgres, then pack `dist/ assets/ schedule.yaml scripts/ package.json
  package-lock.json` (no `src/`, `tests/`, `.env`, DB files) into `orion-<tag>.tgz` with a `RELEASE` file (tag, commit sha,
  schema version the code requires, build time) and a `.sha256`. A red suite stops the build; there is no skip flag.

### 3.2 Deploy
`scripts/release/deploy.sh <stage|prod> <tag>` (dev host, one SSH key per env, §3.4):
1. Refuse unless the tarball's commit is reachable from `origin/main` and the tag exists on GitHub.
2. **prod only:** refuse unless the same tag is `current` on staging and the staging daemon has completed at least one
   scheduled nightly refresh on it with no failed source that prod didn't also fail (read from staging's `jobs` table via
   `orion-remote status --json`). Override `--no-soak` exists for a hotfix and is printed in the report (decision D5).
3. `scp` the tarball + sha; remote `orion-remote install <tag>`: verify sha, unpack to `releases/<tag>`,
   `npm ci --omit=dev --ignore-scripts` (the runtime deps are pure JS once `better-sqlite3` is gone), `orion asset validate`
   for every asset, `orion db status` (pending migrations listed, nothing applied yet), `orion asset registry diff`
   (assets new in this release, which arrive `inactive`; assets whose YAML is gone, which become `missing`; §5.3).
4. Remote `orion-remote switch <tag>`:
   - `orion daemon drain --wait 30m`: the daemon finishes the job it holds, claims nothing new, and reports drained
     (refuses after 30 min with the job it is stuck on). A deploy therefore never lands mid-refresh.
   - `orion db migrate` with the new release, atomically repoint `current` (`ln -sfn` to a temp name + `mv -T`),
     `systemctl --user restart orion-daemon`, wait for the new daemon's first heartbeat carrying the new tag (60 s), append
     to `deploys.log`.
   - Jobs whose slot passed during the drain run on start-up (catch-up rule, §5.2), so nothing is skipped.
5. Print the before/after tag, migrations applied, registry changes, and the next scheduled job. Raymond reports this
   verbatim.

Assets live in the release (`assets/*.yaml`), so a YAML change is a release. That breaks today's
`model proposals approve <id>` for `config` proposals, which edits `assets/<a>.yaml` in place (decision D6).

### 3.3 Migrations and rollback
- New migration series in `src/db/pg/migrations/NNNN_<name>.sql`, starting at `0001_baseline` (the post-Phase-1 schema of
  §7.1 plus the daemon tables of §5). The SQLite migrations 1-8 leave the code; they stay in git history and in the archived file.
- `schema_migrations (id, name, sha256, applied_at)`: a migration file whose hash differs from the applied row is refused.
- Migrations run only in the deploy's `switch` step (`orion db migrate`), never on open. On open the CLI and the daemon check
  `max(id) >= RELEASE.schema`: older schema → refuse ("run orion db migrate"); newer schema → run (rollback, below).
- **Rollback** = `deploy.sh <env> --rollback`: drain, repoint `current` to the previous release, restart; no data change.
  That only works if the previous release runs on the newer schema, so migrations are **expand-only** by rule (add tables,
  columns with defaults, indexes, widen a CHECK). A migration that drops or rewrites data is marked `-- breaking` in its
  first line; the deploy then requires `--breaking`, takes a `pg_dump` into `~/shared/predeploy/` first, and rollback past
  it means restoring that dump (or PITR, §10). Breaking migrations get their own release with nothing else in it.

### 3.4 SSH access
- Two ed25519 keys on this host, created at provisioning with Mike's go: `~/.ssh/orion-stage_ed25519`,
  `~/.ssh/orion-prod_ed25519`. Each is installed only in its own user's `authorized_keys`, with
  `restrict,command="~/bin/orion-remote"`. A leaked dev-host key then can run only the wrapper's verbs, never a shell, and
  cannot read `.env`.
- `orion-remote` verbs:
  - deploy: `install <tag>`, `switch <tag>`, `rollback`;
  - status: `status [--json]` (daemon heartbeat, release, registry, last and next jobs), `logs [n]`, `jobs [--since]`;
  - read-only Orion commands: `report`, `data anomalies/sources/show`, `proposals list`, `agent runs list`;
  - the six decision verbs (§5.5);
  - registry: `asset pause <a> --reason <text>`, `asset resume <a>`, `asset activate <a>` (recorded `--by raymond` plus
    the requester Raymond names, e.g. `mike via raymond`);
  - `job run-now <kind> [asset]`, which enqueues a job for the daemon rather than running it in the SSH process, so a
    manual run and a scheduled one can never overlap;
  - `sql-ro <query>` through the read-only diagnostics role (§9.3); `refresh-staging` (stage only).

  Anything else is refused and logged. Arguments are passed as argv (no shell expansion), notes quoted as one argument.
- Mike keeps his own admin key with sudo on the server; OS install, provisioning and `.env` edits are his (decision D4).
- `known_hosts` pinned at provisioning.

## 4. Secrets

`~/shared/.env` per user, mode 600, owner the env's user; read by Orion's `loadEnv` (no sourcing needed by wrappers).

| key | prod | staging | dev |
|---|---|---|---|
| `ORION_DATABASE_URL` | `postgresql:///orion_prod?host=/var/run/postgresql` (peer auth, no password) | same with `orion_stage` | local socket |
| `ORION_ETH_RPC_URL`, `ORION_BASE_RPC_URL`, `ORION_BNB_RPC_URL`, Solana | prod Alchemy app | a separate Alchemy app (own key, own quota line; same account and bill) | Mike's current key |
| `COINGECKO_API_KEY` | Basic plan key (roadmap decision 3) | a free Demo key (10k credits/mo; §5.7 sizes staging under it) | none |
| `ANTHROPIC_API_KEY` | disclosure runs only | none: staging watcher runs `--dry-run` | as today |
| `SLACK_WEBHOOK_URL` | #orion-ops webhook | #orion-staging webhook | none |
| `ORION_SITE_PUSH_URL` | the site's prod endpoint (§9) | the site's staging endpoint, or unset (D3) | unset |
| `ORION_DEADMAN_URL` | the prod check's ping URL (§5.6) | the staging check's | unset |

Not in either `.env`: the Spaces keys and the pgBackRest encryption passphrase belong to the `postgres` OS user
(`/etc/pgbackrest/pgbackrest.conf`, root:postgres 640), so neither Orion user can read or delete backups (§10).

Rules: never in a release, a tarball, a log or `deploys.log`; `orion-remote` has no verb that prints `.env`; the deploy never
copies or edits it. Rotation: Mike edits the file over his admin key, then `orion-remote` restarts nothing: the daemon
re-reads `.env` at the start of every job. `ORION_HOME` is not in `.env` (the unit file sets it), which removes today's
scratch-shell trap of a copied `.env` re-pointing commands at production.

## 5. The daemon, the asset registry and the cadence

### 5.1 One daemon per environment
`orion daemon` is one long-lived Node process per environment, run as a **systemd user service** under that
environment's user (`loginctl enable-linger orion-prod orion-stage` at provisioning), so the deploy can restart it
without sudo (decision N2):

```
[Service]
Type=notify            # the daemon sends READY=1 once the DB, schema and registry checks pass
NotifyAccess=all
Environment=ORION_HOME=%h/home
ExecStart=/opt/node-v<major>/bin/node %h/current/dist/cli/index.js daemon
Restart=always
RestartSec=30
WatchdogSec=120        # no WATCHDOG=1 for 2 min = hung event loop → SIGABRT, restart
TimeoutStopSec=15min   # SIGTERM = drain: finish the current job, then exit 0
```

`sd_notify` is sent by running `systemd-notify` (READY=1, WATCHDOG=1 every 30 s from the event loop), so no native
module is needed. Start-up checks: schema version, `asset validate` for every YAML in `current/assets`, registry
reconciliation (§5.3). A failed check exits non-zero; systemd retries every 30 s and the external watchdog alerts (§5.6).

Inside the daemon there are two loops, both driven by the database, never by in-memory state:
- **Scheduler** (every 30 s): for each entry in `schedule.yaml` whose slot has come, `INSERT ... ON CONFLICT DO NOTHING`
  one row per job into `jobs`. The unique key `(kind, asset_id, slot)` makes scheduling idempotent: a restart, a second
  daemon started by mistake, or a clock replay inserts nothing new.
- **Worker** (one at a time per environment): claims the oldest due job with
  `UPDATE jobs SET status='running', lease_owner=$me, lease_expires_at=now()+'3 min', attempts=attempts+1, started_at=now()
  WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after <= now() ORDER BY priority, run_after, id
  FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, renews the lease every 60 s while it runs, and ends it `done`, `failed`
  or `skipped` with a `result_json`.

One worker keeps today's sequential behaviour (13 assets back to back in one process; the keyless CoinGecko spacing is
per process) and keeps the load on the shared box predictable. A worker-count knob exists for later; at 100 assets the
nightly refresh still fits one worker (§5.7).

### 5.2 Jobs, leases and restarts

```
jobs (id bigint identity, kind text, asset_id text null, slot timestamptz, run_after timestamptz,
      priority smallint, status text check (queued|running|done|failed|skipped),
      attempts smallint, max_attempts smallint, lease_owner text, lease_expires_at timestamptz,
      started_at, ended_at timestamptz, result_json json, release_tag text,
      unique (kind, asset_id, slot))
```

| kind | slot | does |
|---|---|---|
| `refresh` (per active asset) | nightly (§5.4) | ingest every metric (flows for the closed UTC day, levels, API series), anomalies, income-statement figures, the asset's report block |
| `nightly_report` | nightly, after the slot's `refresh` jobs are terminal (or 3 h after the slot) | posts the run's report to Slack (§6), then enqueues `snapshot_push full` |
| `levels` (one job, all active assets) | hourly at :15 | level reads only → `latest_levels`; watch rules; enqueues `snapshot_push levels` |
| `snapshot_push` | on demand | pushes the newest snapshot of its kind (§9) |
| `disclosure_watch` | daily (D11) | runs the watcher; staging `--dry-run` |
| `staging_refresh` | weekly, staging only | restore prod's dump into staging (§8.5) |
| `retention` | daily | deletes `jobs` rows older than 90 days, `latest_levels` rows for retired metrics |

- **Leases.** A job whose lease expired (the daemon was killed, the box lost power) is returned to `queued` by the next
  claim pass if `attempts < max_attempts`, else marked `failed` with `lease_expired`. A re-run is safe because every
  ingest path is already idempotent per day: transfer scans commit day by day and resume from `fetch_cursors`, API
  series upsert by day, levels write one row per fetch. Two daemons cannot run the same job: the claim is a row lock plus
  the lease, and a refresh additionally takes the asset's advisory lock (§7.3), so even a manual CLI `data fetch` on the
  server cannot overlap the daemon on one asset.
- **Retry rule** (today's, kept): a `refresh` that fails gets one more attempt with `run_after` ≥ 10 min later;
  `max_attempts = 2`. `levels` gets no retry (the next hour is the retry).
- **Catch-up rule.** On start-up after downtime the scheduler creates only the **newest** missed slot of each kind (one
  nightly refresh, one hourly levels), never one per missed slot. A nightly refresh run late still scans every closed day
  since its cursor, so a 3-day outage is repaired by one refresh, as after today's outages.
- **Clean stop.** SIGTERM (deploy, `systemctl stop`, UPS low-battery shutdown) = drain: the running job finishes or, if
  the 15 min stop timeout hits, its lease simply expires and the job is re-run.

### 5.3 The asset registry

```
asset_registry (asset_id text pk, state text check (inactive|active|paused|missing),
                state_since timestamptz, state_by text, state_reason text,
                config_hash text,          -- hash of the YAML the release carries
                first_seen_release text, last_job_id bigint, last_run_at timestamptz, last_outcome text)
asset_state_events (id, asset_id, from_state, to_state, at, by, reason, release_tag)   -- append-only audit
```

- **YAML defines what exists, the registry what runs.** At start-up the daemon reconciles: a YAML without a row → row
  `inactive` (decision N4: a new asset arrives in a release but does not run on prod until `orion asset activate <a>`, so
  shipping an onboarding branch and switching it on are separate steps); a row whose YAML is gone → `missing` (never run,
  history kept, listed in the report until Mike retires it); `config_hash` updated, and a change is listed in the next
  report as "config".
- `orion asset pause <a> --reason <text> [--by <who>]`, `resume <a>`, `activate <a>`: each writes one
  `asset_state_events` row and updates the registry in one transaction. `--reason` is required for pause. Pausing does not
  interrupt a running refresh of that asset; it takes effect from the next job.
- **Paused / inactive / missing assets are skipped**: the scheduler creates no `refresh` for them and `levels` leaves them
  out. The nightly report lists each one with state, since when, by whom and why ("PAUSED AERO since 2026-11-03 by mike
  via raymond: AERO+VELO merger rebuild"). The site snapshot marks them paused (stale data is shown as such, not dropped).
- **On resume**, the next refresh scans from the asset's cursors, so on-chain flows backfill the paused days on their own.
  API series refill only as far back as each source's `backfill_days`; the report says when a pause was longer than that.
- Replaces today's per-asset cron jobs and wrapper scripts: adding an asset becomes YAML + release + `activate`.

### 5.4 Cadence

`schedule.yaml` ships in the release (reviewed like code):

```yaml
nightly:  { at: "00:45", tz: UTC }      # refresh for every active asset, then nightly_report, then snapshot_push full
levels:   { every: 1h, minute: 15 }     # latest-only supply + watch reads, then snapshot_push levels
disclosure_watch: { at: "16:40", tz: UTC }   # 09:40 PDT, today's slot
staging_refresh:  { weekly: sun, at: "10:30", tz: UTC, env: stage }
staging_overrides: { nightly: { at: "02:45", tz: UTC }, levels: { every: 6h } }   # D3, §5.7
```

- **Nightly at 00:45 UTC** (decision N3): 45 min after the UTC day closes, so Ethereum (finalised after ~13 min) and Base
  and BNB are final for the day's last block, and first-party APIs have closed their day. Scans read up to the
  `finalized` block tag where the chain has one. That moves the report from today's 05:05 PT to **17:45 PDT / 16:45 PST**
  (UTC has no DST). Today's 05:05 PT run is 12 h after the day closed and adds nothing in accuracy; the API sources that
  revise later days are already re-read by `revision_days`.
- **Hourly levels**: every active asset's level metrics (`total_supply`, `circulating_supply`, staked/locked supply, the
  schedule step in force, and every `monitor_only` level with a `watch`), read with the same source code as the nightly
  run but written **only** to `latest_levels`, never to `observations`. The nightly refresh still writes its one daily
  level row per metric as today, so history is unchanged and the hourly data is "now" only.

```
latest_levels (asset_id, metric_key, value double precision, observed_at timestamptz, source text,
               block_number bigint null, job_id bigint, primary key (asset_id, metric_key))
watch_state   (asset_id, metric_key, firing boolean, since timestamptz, last_value double precision, primary key (...))
```

- **Watch alerts** move from "printed first in the morning report" to the hour they fire: a `watch` that changes from
  not-firing to firing posts one `ORION WATCH <SYM>: ...` line to Slack, and a firing that clears posts one "cleared"
  line; a watch that stays firing is not re-posted hourly (`watch_state`), but stays in the nightly report until it
  clears. Watches on flows (`above: <n>`) are evaluated on the nightly refresh only (flows are daily).
- Prices: the hourly job reads CoinGecko `/coins/markets` (it carries circulating supply), so `latest_levels` carries the
  price too, labelled with its time. The site uses its own live price (decision 12); Orion's hourly price is context.

### 5.5 Decisions (confirm, reject, approve, decline, ack, resolve) after Hermes cron
Mike replies in #orion-dev (or any Raymond thread): "ack 7 <note>". Raymond runs `ssh orion-prod orion-remote ack 7
'<note>'` and posts Orion's JSON result. The verbs and refusal rules are today's prompt rules, enforced by `orion-remote`
(only the six verbs; ids must exist and be pending; notes passed as one argv). Config proposals follow decision D6.
Pause / resume / activate go the same way.

### 5.6 Heartbeat and watchdog
Three layers, because each one misses something the others catch:

| layer | catches | misses |
|---|---|---|
| systemd `WatchdogSec` + `Restart=always` | crash, hung event loop | a daemon that is alive but whose jobs all fail; a dead box |
| Daemon self-report: a `daemon_heartbeat` row (pid, release, started_at, beat_at, current job), written at each job start and end and every 15 min (not every 30 s: each write forces a WAL segment to the archive, §10.1); an unclean previous exit (a `running` job with an expired lease at start-up) posts "ORION RESTARTED <env> after unclean exit, job <id> re-queued"; a `refresh` that fails twice posts "ORION ALERT" at once, not only in the report | job failures, restarts | anything that stops the daemon from posting |
| **Dead-man's switch outside the LAN** (decision N10): the daemon pings `ORION_DEADMAN_URL` after each `nightly_report` and each `levels` job (a free healthchecks.io-style check: "expect a ping every 1 h, grace 30 min" and "every 24 h, grace 2 h"); a missing ping alerts Slack and email from outside | dead box, power or uplink outage, broken Slack webhook, daemon stuck in restart loops | nothing above |

A Hermes check on this dev host (revision 1's "ORION SILENT") would go dark in the same LAN or power outage as the
server (§2.2), so it is kept only as an optional second opinion, not the alerting path.

### 5.7 Call volume at 13 and at 100 assets

**Measured** (scratch home, `data fetch <a> --dry-run` with a request-counting `fetch` preload, 2026-10-29 18:45 UTC;
ETH and BNB assets could not be run there because the worker may not copy the live `.env`, so their cost is derived from
the same code paths):

| run | requests |
|---|---|
| VVV, no new day (an hourly-style level read) | Base RPC 4 (1 block, 3 `eth_call`), CoinGecko 1, Venice 4 |
| VVV, one new day (cursor set back 1 day) | Base RPC 13 (5 block lookups, 4 `eth_call`, 4 `eth_getLogs`), CoinGecko 2 (+1 `market_chart`) |
| AERO levels | Base RPC 6, CoinGecko 1 |
| PUMP | Solana RPC 3, Jupiter 1, CoinGecko 2 |
| HYPE | Hyperliquid REST 20 (14-day fund-buys re-read), CoinGecko 1 |

So one transfer-scan group costs ~5 block lookups for the day boundary plus the day's `eth_getLogs` (1 on Ethereum at
10k blocks per call; on Base 4 were measured, though a full day of 43,200 blocks at the 2,000-block cap can take up
to ~22; ~4 on BNB at 50k per call), plus one `market_chart` per USD-valued group; one asset's level read costs ~4-6
RPC requests and one CoinGecko call. Every group repeats the same day-boundary block search today.

**Estimate** (100 assets assumed to have today's mix: ~2.6 scan groups and ~1.5 CoinGecko ids per asset):

| | 13 assets | 100 assets |
|---|---|---|
| Nightly RPC: scans (~6/group on ETH, ~9 Base/BNB) + levels (~5/asset) | ~280 | ~2,100 |
| — with a shared day-boundary cache (`day_blocks (chain_id, day, first_block)`, one search per chain per night) | ~120 | ~800 |
| Hourly RPC (levels, ~5/asset) | ~65/h = ~1,560/day | ~500/h = ~12,000/day |
| **RPC per month** | **~55k requests ≈ 1.4M Alchemy CU** | **~400k requests ≈ 10M CU** |
| Alchemy cost (PAYG $0.52/M CU; Free tier is out: it caps `eth_getLogs` at 10 blocks) | ~$1 | ~$5-6 |
| Nightly CoinGecko (1 markets/asset + 1 chart/group; with a per-night cache by id) | ~45 (~15 cached) | ~350 (~150 cached) |
| Hourly CoinGecko, per-asset calls as today | 13/h = 9,400/mo | 100/h = 72,000/mo |
| Hourly CoinGecko, **one batched `/coins/markets` call** (≤250 ids) | 1/h = 720/mo | 1/h = 720/mo |
| **CoinGecko per month (Orion prod, batched, cached)** | **~1.2k** | **~5k** |
| Site live price (decision 12), one batched call per cache period | 60 s: 43,200/mo; 30 s: 86,400/mo | same |

- **Throughput:** the nightly at 100 assets is ~800-2,100 RPC calls and ~150-350 CoinGecko calls, minutes of work at
  Alchemy's 300 req/s and CoinGecko Basic's 300/min. Runtime is set by per-source spacing, not volume: today's 13 refreshes
  have a median of 10 s (p90 32 s, max 58 s, fetch runs since 10-20), so ~3-5 min; 100 assets ≈ 25-40 min with one worker,
  done by ~01:30 UTC. One worker is enough.
- **CoinGecko is the binding budget, not RPC.** Basic = 100k credits/mo at 300/min ($35/mo, $29 billed yearly). Orion
  prod needs ≤5k if the hourly read is batched; unbatched at 100 assets it is ~75k and the site's price layer would push
  the account over the cap. Recommended (decision N8): batch the hourly read, cache `market_chart` per id per night, run
  the site's price cache at **60 s** (43k/mo; total ~50k with headroom) rather than 30 s (~92k, at the cap), and put
  staging on a free Demo key (staging nightly + 6-hourly levels ≈ 1.6k/mo at 13 assets, ~6k at 100: inside 10k).
- RPC batching across assets (one multicall per chain per hour for every asset's levels) would cut hourly RPC ~50x but
  costs a new read path; at ~$6/mo it isn't worth it now (N9). The day-boundary cache is worth it: small, and it halves
  the nightly.

## 6. Getting reports and alerts to Slack (decision D2)

After Phase 1 the report needs no model: it is formatting of the run's results (watch lines, failed sources,
anomalies, paused assets, a holder-yield block).

- **A. Orion posts itself (recommended; Mike's roadmap note keeps it as the recommendation).** `nightly_report`
  formats the slot's `refresh` results deterministically (the Phase 1 message format and ALERT rules) and posts to the
  incoming webhook in `.env`; restarts, double failures and watch firings post as they happen (§5.4, §5.6). Silence is
  covered by the dead-man's switch. No Anthropic spend for reports (today 13 agent sessions a day). Loses: replying in
  the #orion-ops thread to run a decision, which moves to Raymond over SSH (§5.5).
- **B. Server runs, Hermes posts.** Hermes jobs on this host pull each report over SSH and keep today's agent message
  and thread replies. Reports then depend on this host and keep agent spend and Hermes on the critical path decision 11
  removes. Not recommended.
- Delivery failures: a failed webhook post is retried 3 times over 10 min, then the report is kept in `jobs.result_json`
  and the dead-man's ping for that run is withheld, so the outside check alerts.

## 7. Postgres schema and the async conversion

### 7.1 Schema (`0001_baseline`), post-Phase-1 tables plus the daemon's
One schema `orion` per database, owned by the env role. Type mapping:

| SQLite | Postgres | why |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint GENERATED BY DEFAULT AS IDENTITY` | BY DEFAULT so the import keeps ids; sequence set to SQLite's `sqlite_sequence` value |
| `REAL` | `double precision` | both IEEE 754 double; Postgres ≥12 prints the shortest exact form, so values round-trip bit-for-bit |
| ISO-text timestamps | `timestamptz` (decision D7) | the site export and ops can do date arithmetic; read back as the same 24-char ISO string (§7.2) |
| `fetch_cursors.last_day` text | `date` | read back as the raw `YYYY-MM-DD` string |
| `*_json` text | `json` (not `jsonb`) | validated and queryable (`->`, `->>`), but stored byte-for-byte, so the row proof can compare text and key order never changes |
| other `TEXT` | `text COLLATE "C"` | byte-order sorting as in SQLite; the cluster's default locale (`en_US.UTF-8` from initdb) would reorder `ORDER BY metric_key` and could move report output |
| `INTEGER` flags (`dry_run`) | `smallint CHECK (dry_run IN (0,1))` | no code change; a boolean is not worth the diff |
| block numbers, counts | `bigint` | |

Carried tables: `observations`, `fetch_runs`, `fetch_cursors`, `anomalies` (with the partial unique index
`WHERE status = 'open'`), `documents`, `proposals` (CHECK without `assumption_value`), `coverage`, `config_versions`,
`agent_runs` (CHECK keeps the historical run types so history imports; the code creates only `disclosure`),
`agent_transcripts`, `schema_migrations`. Same columns and indexes as SQLite after migration 8, plus
`idx_obs_metric_day (asset_id, metric_key, observed_at DESC) WHERE superseded_by IS NULL AND status <> 'rejected'` (the
report's main read). Foreign keys are real and always on (Orion's SQLite connection turns them on too; only the `sqlite3`
shell runs without them, which is why today's hand repairs delete children first. In Postgres a wrong-order delete is
refused instead).

New tables (§5, §9): `jobs`, `asset_registry`, `asset_state_events`, `latest_levels`, `watch_state`,
`daemon_heartbeat`, `day_blocks`, `snapshots_out`. `run_locks` is dropped (0 rows; replaced by the per-asset advisory lock
and job leases).

Not carried: `assumption_sets`, `assumptions`, `assumption_changes`, `assumption_evidence`, `snapshots`, `valuation_runs`,
`signals`, `journal`, `trigger_firings`, transcripts of non-disclosure runs, and `assumption_value` proposals (decision D8).
They stay in the archived SQLite file (§8.4).

### 7.2 Driver: `pg` (node-postgres) with a pool
- Chosen over `postgres` (porsager) and query builders (Kysely, Drizzle): it keeps every query as written SQL with `$n`
  placeholders (smallest diff, easiest review) and gives per-type parsers. Connection over the Unix socket, peer auth.
- Type parsers set once in `src/db/connection.ts`: int8 → `Number` (throws above 2^53), timestamptz → `new
  Date(v).toISOString()`, date → raw string, json → raw string (callers already `JSON.parse`). Then every `fromRow` stays
  as it is and every value the code sees is the same type and text as today.
- `Db` becomes a small interface the rest of the code uses: `all(sql, params)`, `one`, `run` (→ `{rowCount, rows}`),
  `tx(fn, {lockAsset?})`. A `tx` handle is itself a `Db`, and a nested `tx` is a SAVEPOINT (better-sqlite3 nests the same
  way, and `ledger.commit` → `insertObservation` relies on it).
- The daemon holds one pool (max 4: worker, scheduler, heartbeat, one spare); CLI commands open a pool of 1.

### 7.3 Concurrency
SQLite serialised all writers; `.immediate()` guarded the read-then-write paths. Postgres runs `READ COMMITTED` concurrently,
so every write transaction that reads first takes `pg_advisory_xact_lock(<asset key>)` (a 64-bit key from
sha256('orion:asset:'+id), computed in JS) through `tx(fn, {lockAsset})`. That reproduces SQLite's serialisation per asset,
which is all Orion needs. A whole refresh also holds a session-level `pg_try_advisory_lock(<asset key>)`, which replaces
`run_locks`: a second refresh of the same asset (a manual CLI fetch on the server while the daemon runs) gets
"asset busy" at once instead of interleaving. The lock dies with its connection, so a killed process never leaves a
stale lock (today's `run_locks.expires_at` exists only for that).

### 7.4 Conversion plan (sizes from §1)
1. `src/db/` rewritten (12 kept modules; ~1.3k lines after Phase 1), `connection.ts` = pool + parsers + `tx`.
2. Callers: `async`/`await` through ~35-40 `src/` files. Mechanical except the 5 raw transactions, which move into `tx`
   with an asset lock, and `recentSourceStatuses`, which becomes SQL.
3. New code: `src/daemon/` (scheduler, worker, leases, heartbeat, notify), `src/registry/`, `src/levels/` (hourly read +
   batched CoinGecko), `src/push/` (§9), `src/notify/slack.ts`; estimate ~1.5-2k lines plus tests. The hourly job reuses
   the ingest source code with a "levels only, write to latest" mode, not a second copy of the readers.
4. A guard against a classic async bug: a function inside a transaction calling the pool instead of its `tx` handle runs
   outside the transaction. The test suite runs with pool `max: 1`, so any such call deadlocks and fails on the test
   timeout instead of passing silently.
5. `better-sqlite3` leaves `dependencies`; it stays a devDependency only for the one-off importer (§8).

### 7.5 Test strategy
- Real Postgres for every test (decision D9): the same major as the server, local on this host. A vitest
  `globalSetup` creates `orion_test` once; each test file gets a fresh schema `t_<random>` (migrations applied, ~50 ms),
  dropped in `afterAll`; tests that used `':memory:'` per test get a `TRUNCATE ... RESTART IDENTITY` between tests. No mocks
  of the DB.
- `ORION_TEST_DATABASE_URL` unset → the suite fails loudly (no silent skip).
- Daemon tests run the scheduler and worker against a fake clock and the real test DB: idempotent scheduling (two
  schedulers, one row), lease expiry and re-queue, catch-up creates one slot, drain on SIGTERM, a paused asset gets no
  job, retry spacing. Two daemons racing one job use two pool clients.
- CLI subprocess tests pass the URL and schema via env. `connection.test.ts` (SQLite migration mechanics) is replaced by
  migration tests: baseline applies, hash mismatch refused, older-schema refusal, rollback compatibility (release N-1
  tests pass on schema N, run for every migration).
- The alternative, PGlite (in-process WASM Postgres), is faster and needs no install, but it is one connection, so the
  concurrency, lease and lock tests can't run on it, and it is not the server prod runs.

## 8. Data migration from SQLite

### 8.1 Importer
`node tools/import-sqlite.js --from <sqlite .backup> --to $ORION_DATABASE_URL` (dev-only tool, not in releases): refuses a
target with any rows; copies the carried tables in FK order inside one transaction; sets each identity sequence to the
`sqlite_sequence` value (e.g. observations 27,447) so new ids continue exactly where SQLite stopped; seeds
`asset_registry` with every asset `active` (`by = import`, reason "carried from SQLite install"), matching what runs
today; writes an import manifest (source file sha256, schema id 8, per-table counts carried and excluded, excluded ids)
to stdout and to `~/home/import-<stamp>.json`. 28 MB imports in seconds, so a full re-import is cheaper than any
incremental scheme. Because the server's Postgres is socket-only, the import runs on the server, from a `.backup` file
copied there by Mike's admin key.

### 8.2 Row-for-row proof
1. **Counts:** per carried table, SQLite count = Postgres count; excluded rows listed by table and reason (counts must match
   the manifest).
2. **Row hashes:** one normaliser used on both sides: each row's columns in schema order, timestamps as 24-char ISO,
   doubles via `Object.is`-exact JS numbers (shortest repr), json and text as exact strings, null as null → sha256 per row,
   then per table over rows ordered by primary key. SQLite read with better-sqlite3, Postgres read through Orion's own `Db`
   (so the type parsers are part of what is proved). Any mismatch prints the first differing row and column.
3. **Sequences:** next id per table = SQLite's `sqlite_sequence` + 1.
4. **Reports:** `report yield <a> --day <fixed> --json` for all 13 assets, SQLite release vs Postgres release on the same
   imported data; `cmp` each pair; must be identical. Plus `data anomalies --all --json` and `proposals list --json`.
5. **Ingest:** `data fetch <a> --dry-run --json` with both releases at the same moment; differences only in fetch timing.

### 8.3 Parallel run on staging
For ≥3 days the staging daemon (Postgres, its own fetches, nightly at its slot) and the live SQLite install fetch the same
chains. A daily diff of each day's new observations (asset, metric, observed_at, value, source) must be empty apart from
rows the sources revised between the two fetch times (listed with both values). That proves the Postgres release ingests
identically, not only that it reads identically. The nightly slot differs from today's 05:05 PT, so the diff compares by
UTC day, not by fetch run.

### 8.4 Cutover (live-install rules apply; Mike's go)
Pause the 13 Hermes jobs and the watcher; check nothing is mid-run; `.backup` + `integrity_check`; import into
`orion_prod`; rerun §8.2 against prod; `systemctl --user enable --now orion-daemon` for `orion-prod`; check the first
heartbeat, the first hourly `levels` job, the dead-man's check turning green; watch the next nightly refresh and its Slack
post; then remove the Hermes jobs and their 13 wrapper scripts. The final SQLite file is archived read-only
(`orion-final-<stamp>.db`, chmod 400) on this host and in Spaces, together with `signals.jsonl`. Fallback for the first
week: stop the prod daemon and re-enable the Hermes jobs on the archived copy; flow gaps refill by backfill as after any
outage.

### 8.5 Prod → staging refresh
The staging role cannot read prod, so prod exports and staging restores. The nightly logical dump (§10.1) of
`orion_prod` is also written to `/srv/orion-refresh/latest.dump` (owner `postgres`, group `orion-refresh` = both Orion
users, mode 640). Staging's weekly `staging_refresh` job: drain its own worker, `pg_restore --clean --if-exists
--no-owner --role=orion_stage` into `orion_stage`, keep staging's own `asset_registry` (states are per environment) and
re-run registry reconciliation, then `orion db status`. Staging's own week of rows is overwritten, by design. Its outcome
posts to #orion-staging. Orion holds no personal data, so no scrubbing step is needed. The weekly restore proves the
logical dump restores; the PITR path gets its own drill (§10.3).

## 9. Data path to the site: Orion pushes snapshots (decision 10)

### 9.1 What is pushed
Two snapshot kinds, both JSON, both versioned:
- `full` after each nightly report: per active asset the Phase 5 export (income statement, holder flow by bucket,
  supply, dilution, provenance, change log) plus registry state (paused assets marked, with since and reason).
- `levels` after each hourly job: per asset the `latest_levels` rows (supply figures, watch values, observed_at).

Envelope: `{schema: "orion.snapshot/1", kind, snapshot_id (uuid), seq (per kind, increasing), generated_at, env,
release_tag, sha256 (of the canonical body), body}`. Phase 1.5 builds the envelope, the transport, the outbox and a
minimal body (today's `report yield --json` per asset); Phase 5 defines the full body and bumps `schema` if it breaks
readers. Every snapshot is first written to `snapshots_out (id, kind, seq, snapshot_id, sha256, body json, created_at,
pushed_at, attempts, last_error)`, then pushed, so a failed push is retried from the outbox and nothing is recomputed;
outbox rows older than 30 days are pruned except the last 7 `full`.

### 9.2 Transport options (decision N6)

| | P1. HTTPS push endpoint on the site (**recommended**) | P2. Orion writes into a site-side database | P3. Drop into object storage (Spaces), site pulls |
|---|---|---|---|
| How | `POST /internal/orion/snapshots` (gzip JSON); site verifies, stores, flips "current" | Orion holds a write credential to a DO Postgres the site reads | Orion `PUT`s to a private Spaces bucket, then pings the site; site fetches and verifies |
| Auth | Ed25519 signature over `snapshot_id|generated_at|sha256` in a header, plus TLS; the site holds only the **public** key, so a leaked site config cannot forge data; 10 min replay window, idempotent on `snapshot_id` | DB role + TLS; the database must accept connections from Mike's residential IP, which changes, so either a wide allow-list or a VPN | Spaces keys on both sides; signature as P1 to prove origin |
| Coupling | contract = the envelope schema; site owns its storage | Orion's code depends on the site's schema; half-written pushes are visible unless every write is one transaction | as P1 |
| Failure | site down → outbox retries with backoff (1, 5, 15 min, then hourly), alert after 3 h; site keeps serving the last good snapshot with its age | Orion stalls on DB timeouts; site DB is internet-exposed | site polls; no endpoint to build, but two credentials and a poll lag |
| Site work | one endpoint + a `snapshots` table or file store | none for intake, but the site's DB becomes shared infra | a fetcher + poller |

P1 because it keeps Orion outbound-only with no credential that can write the site's data store, keeps the contract to
one versioned document, and lets the site validate before anything goes live (schema version, sha256, `seq` newer than
current, every active asset present; a failed check keeps the old snapshot and returns the reason, which Orion posts as an
ALERT). P3 is the fallback if the site's hosting can't take a POST. Staging pushes to a staging endpoint or nowhere (D3).

### 9.3 Roles
Created by `scripts/provision/pg-roles.sql`, run once by Mike as `postgres` on the server:
- `REVOKE CONNECT ON DATABASE orion_prod, orion_stage FROM PUBLIC` (Postgres grants CONNECT and TEMP to PUBLIC by default;
  without this revoke the staging role could connect to prod).
- `orion_prod` owns database `orion_prod` and schema `orion`; `orion_stage` likewise for `orion_stage`; neither has any
  grant on the other's database.
- `orion_prod_ro`: SELECT on `orion.*` in `orion_prod`, `default_transaction_read_only = on`, `statement_timeout = 30s`,
  used only by `orion-remote sql-ro` for Raymond's diagnostics (today's `sqlite3 'file:...?mode=ro'` reads).
- `pg_hba.conf`: `local orion_prod orion_prod,orion_prod_ro peer map=prod`, `local orion_stage orion_stage peer
  map=stage`, `local all postgres peer`, then `local all all reject`. `pg_ident.conf` maps Unix `orion-prod` → roles
  `orion_prod`, `orion_prod_ro` and `orion-stage` → `orion_stage` (Unix names have a hyphen, role names an underscore). So
  the `orion-stage` Unix user cannot even attempt a prod connection, and the database CONNECT revoke backs it up.
- A provisioning check proves both: `orion-stage` connecting to `orion_prod` must fail, and so must `orion_stage`
  `SET ROLE orion_prod`.
- One owner role per env does both migrations and runtime writes; a separate DML-only role adds a credential per env for
  little gain at this size; not proposed. The revision-1 `coinrevs_site` role and `site` schema are dropped (decision 10).

## 10. Backups and PITR (all ours)

### 10.1 What runs
Backups run as the `postgres` OS user from **root-owned systemd timers**, independent of both daemons, so a broken
Orion release cannot stop them and neither Orion user can read or delete them.

| | what | where | retention |
|---|---|---|---|
| Physical + WAL (PITR) | **pgBackRest** (decision N7): `archive_command` pushes each WAL segment (`archive_timeout = 300s`, so at most ~5 min of writes is unarchived; every forced switch ships a 16 MB segment, which is why the daemon writes nothing on a 30 s beat); full backup weekly (Sun 09:00 UTC), differential daily (09:00 UTC) | repo 1: DO Spaces bucket `orion-backups` (S3 API), `repo1-cipher-type=aes-256-cbc`, region near the site; repo 2: a local directory on a second disk if the box has one (fast restores) | 4 weekly fulls + their WAL in Spaces (≈ 4-5 weeks of PITR); 2 fulls locally |
| Logical | `pg_dump -Fc` of `orion_prod` (and `orion_stage`, small) nightly at 08:30 UTC, after the nightly refresh and before the physical backup | Spaces `orion-backups/dumps/prod/YYYY/MM/DD.dump`, encrypted client-side (`age` to a public key whose private half Mike keeps off both boxes); local copy at `/srv/orion-refresh/latest.dump` for §8.5 | 30 dailies + 12 monthlies (Spaces lifecycle rule) |

- Why both: PITR covers "a bad deploy rewrote rows at 01:12, restore to 01:10" and box loss; the logical dump is
  version-independent, restores into any Postgres (this dev host, a DO droplet in an emergency), feeds the staging
  refresh, and survives a pgBackRest repo problem.
- Why pgBackRest over wal-g or a hand `archive_command` + rclone: native S3 repo with encryption, retention and archive
  checks (`pgbackrest check`, `info`) built in, parallel restore, packaged in PGDG apt. wal-g is comparable (a single Go
  binary); a hand script has no retention, verification or partial-segment handling. Either of the first two is fine.
- **Key custody:** the pgBackRest cipher passphrase and the `age` private key must exist off the server (Mike's password
  manager), or a dead box takes the means to decrypt its backups with it.
- Volume: today's DB is 28 MB (10.8 MB of it analyst transcripts that are not carried), growing ~0.1 MB/day at 13
  assets (estimate from the measured ~200 observation rows + ~11 fetch runs of ~3 kB a day);
  the hourly `latest_levels` upserts add WAL but no table growth. WAL is set by segment switches, not by data: writes
  happen in ~30-40 windows a day (24 hourly jobs, the nightly, heartbeats every 15 min), so ~100 segments/day worst
  case ≈ 1.6 GB/day raw, much less after pgBackRest's compression of mostly-empty segments (not measured; staging
  measures it). Even uncompressed, 5 weeks ≈ 55 GiB, inside Spaces' 250 GiB; dumps are a few MB each.

### 10.2 Monitoring
`pgbackrest check` after each backup and the dump job's exit status post to #orion-ops on failure; the backup timers
also ping the dead-man's switch (a "backups" check, every 24 h). `pgbackrest info` age is in `orion-remote status`.

### 10.3 Restore drill
- **Monthly, on this dev host** (a `no_agent` Hermes job or by hand): `pgbackrest restore` from Spaces into a throwaway
  cluster on a spare port, to a target time ~1 h back; start it; compare per-table row counts and the max ids of
  `observations` and `fetch_runs` with prod via `orion-remote sql-ro`; record restore time (RTO) and gap (RPO) in
  `docs/ops/restore-drills.md`; delete the cluster. Also `pg_restore` the latest logical dump the same way.
- **Prod PITR runbook** (`docs/ops/pitr.md`): stop the prod daemon; restore the cluster to the target time into a
  **side instance** on another port (the live cluster keeps serving staging); `pg_dump -d orion_prod` from the side
  instance; drop and restore `orion_prod` in the live cluster from it; registry reconciliation; start the daemon. A
  whole-cluster in-place restore is used only when the box itself is lost.
- **Box lost:** provision any Ubuntu box (or a DO droplet), install the same Postgres major + pgBackRest, restore from
  Spaces, deploy the current tag. The site keeps serving its last snapshot meanwhile (§9).

## 11. Costs (per month; vendor pages read 2026-10-29)

| item | price | note |
|---|---|---|
| Orion server | $0 | Mike's hardware; electricity ≈ 30-50 W average for a quad-core i7 desktop ≈ 22-36 kWh ≈ **$8-15** at ~$0.40/kWh (estimate, not metered) |
| DO Spaces (backups, dumps) | **$5** | 250 GiB storage and 1 TiB egress included; our use is ~1-2 GiB |
| Dead-man's switch | **$0** | free tier of a healthchecks-style service (3-4 checks) |
| Alchemy RPC (prod + staging apps) | **~$1** at 13 assets, ~$6 at 100 (§5.7) | PAYG $0.52/M CU |
| CoinGecko Basic | **$35** ($29 billed yearly) | roadmap decision 3, shared by Orion prod and the site's price layer (§5.7) |
| Anthropic | disclosure runs only | the 13 daily report-agent sessions end with option A |
| **Orion total** | **~$50-55** incl. CoinGecko and power; ~$6 cash outside CoinGecko and power | revision 1 was ~$49 + CoinGecko |
| Website droplet | sized by the site, not this spec | from $6-24 |

Sizing headroom on the box (estimate): Postgres `shared_buffers = 2GB` and the whole DB in RAM for years at 100
assets; two daemons ~150-250 MB each; the watcher's `small.en` ASR wants ~2 GB for minutes a day. 16 GB leaves room
for both environments and the OS cache. Disk: under 1 GB of database at 100 assets after a year (~200 rows/day per 13
assets ≈ 1.5k rows/day at 100, measured rate scaled).

Revision 1 costs that are gone: DO managed Postgres ($15.15), Orion droplet ($24), droplet backups (~$5).

## 12. Work order (for the plan)
1. Dev Postgres on this host (PGDG apt; needs Mike's sudo, D10).
2. Branch `feat/platform-pg`: §7 code, tests green on local Postgres; importer (§8.1).
3. Branch `feat/daemon` (on 2): daemon, jobs, registry, hourly levels, watch state, Slack notify, snapshot outbox + push
   client, `orion-remote`, release/deploy scripts, user unit, provisioning scripts (`scripts/provision/{orion-host.sh,
   pg-roles.sql,pgbackrest.conf.tmpl,backup timers}`) written but not run.
4. Proofs on dev (§8.2) against a `.backup` copy of live SQLite; daemon soak on dev (a scratch DB, real chains, 48 h,
   Slack to a test webhook).
5. Mike installs the OS and runs the provisioning scripts (D4); Raymond creates the two SSH keys on his go; backup
   repo created and a first `pgbackrest check` passes; dead-man's checks created.
6. Staging: deploy, import, parallel run ≥3 days next to the live SQLite install (§8.3); first restore drill (§10.3).
7. Prod cutover (§8.4); Hermes `orion-<asset>` jobs and wrappers removed; disclosure watcher moved into the repo and
   onto the daemon (D11); `orion` skill and `docs/ops/` rewritten for the server.

## 13. Decisions owed by Mike

### 13.1 Revision-1 decisions: status after the 2026-10-28 revision

| # | Question | Status | Recommendation |
|---|---|---|---|
| D1 | Unix user and role names | open, unchanged | `orion-prod`, `orion-stage`; roles `orion_prod`, `orion_stage`, `orion_prod_ro` |
| D2 | How reports reach #orion-ops | narrowed: Mike's roadmap note keeps A recommended; confirm | **A**: Orion posts via webhook; watchdog is now the external dead-man's switch (N10), not a Hermes "ORION SILENT" job |
| D3 | Staging output | open | #orion-staging for failures, restarts, the weekly refresh and the soak result; staging pushes to a staging site endpoint only if the site has one, else nowhere; staging runs nightly + levels every 6 h |
| D4 | Who provisions | revised (no DO console) | Mike installs the OS and runs `orion-host.sh` + `pg-roles.sql` with sudo, creates the Spaces bucket and the dead-man's checks; Raymond gets only the two forced-command keys |
| D5 | Prod soak rule | open, unchanged | a tag must have completed one scheduled staging nightly before prod; `--no-soak` for hotfixes |
| D6 | Config proposals once YAML ships in releases | open, unchanged | approval = commit + release; `proposals approve` on prod refuses `config` kind unless the running release's YAML hash equals the proposal's, then records it approved |
| D7 | Timestamp type | open, unchanged | `timestamptz`, read back as today's ISO strings |
| D8 | History carried | open, unchanged (plus: `run_locks` dropped, 0 rows) | kept tables in full; all 49 agent_runs rows; the disclosure transcript only; no `assumption_value` proposals |
| D9 | Test database | open, unchanged | real local Postgres per test file, not PGlite |
| D10 | Dev Postgres on this host | open | Mike approves the PGDG apt repo + `postgresql-<major>` + `pgbackrest` (sudo) and a local role `orion_dev` |
| D11 | Disclosure watcher | revised | move it into the repo (`tools/disclosure-watcher/`), released and run as the daemon's `disclosure_watch` job (not a timer); staging runs it `--dry-run` |
| D12 | Postgres major | revised (no DO) | the newest stable PGDG major at provisioning, the same on the server and this host |
| — | revision-1 DO items: managed backups, VPC, `doadmin`, `coinrevs_site` role, Orion droplet sizing | **moot** (decisions 8, 10) | — |

### 13.2 New decisions

| # | Question | Recommendation |
|---|---|---|
| N1 | Server inputs | OS and version (recommend Ubuntu 24.04 LTS, as this host), hostname, fixed LAN IP, whether the UPS can signal a clean shutdown (USB/NUT), whether the box has a second disk for local backups |
| N2 | How the daemon runs | systemd **user** service with linger per Orion user, so deploys restart it without sudo (alternative: system units with `User=`, needs a sudoers rule for the deploy) |
| N3 | Nightly slot | **00:45 UTC** (17:45 PDT / 16:45 PST): the report arrives the same evening, not the next morning. Alternative: refresh at 00:45 UTC but hold the Slack post to 13:00 UTC (06:00 PDT) |
| N4 | A new asset in a release | arrives **inactive**, runs only after `orion asset activate <a>` (alternative: active on deploy) |
| N5 | Hourly scope | supply/staked/locked levels + every watched `monitor_only` level + the batched CoinGecko read, into `latest_levels`; watch alerts posted on change (fire / clear), not every hour; a `levels` snapshot pushed hourly |
| N6 | Site transport | **P1**: signed (Ed25519) HTTPS POST to a site endpoint, outbox with retries, site keeps the last good snapshot; P3 (Spaces drop) as the fallback |
| N7 | Backup tooling and retention | **pgBackRest** to Spaces (encrypted, ~4-5 weeks PITR) + nightly encrypted `pg_dump` (30 daily, 12 monthly); keys held by Mike off the box; monthly restore drill on this host |
| N8 | CoinGecko budget | batch the hourly read into one call, cache price series per id per night, site price cache **60 s**, staging on a free Demo key |
| N9 | RPC efficiency | build the shared day-boundary block cache; skip cross-asset multicall batching until volume or cost says otherwise (~$6/mo at 100 assets) |
| N10 | Watchdog | systemd watchdog + daemon self-alerts + an **external dead-man's switch** (free healthchecks-style service) pinged after each nightly and hourly job and each backup |
