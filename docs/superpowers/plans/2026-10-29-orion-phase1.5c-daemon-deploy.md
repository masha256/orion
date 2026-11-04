# Orion Phase 1.5c: daemon, cadence, Slack, snapshots, release and deploy. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one long-lived `orion daemon` per environment runs every scheduled job from a Postgres jobs table with leases
(nightly refresh + report at 00:45 UTC, hourly latest-only levels with watch alerts, snapshot publishing to a git repo,
the disclosure watcher, staging refresh, retention), posts to Slack itself, pings an outside dead-man's switch, and is
shipped as a tagged release over forced-command SSH with expand-only migrations and one-step rollback.

**Architecture:** everything the daemon does is a row in `jobs`: a scheduler loop inserts slots idempotently, one worker
claims them with `FOR UPDATE SKIP LOCKED` and a renewed lease, and each kind is a handler that reuses existing code
(`tickAsset` for `refresh`, `fetchAsset` in dry-run mode restricted to level metrics for `levels`, `inboxLines` and the
Phase 1 message rules for the Slack report). An asset registry table decides what runs; YAML in the release decides
what exists. Snapshots go through an outbox table, then a `Publisher` (git driver now). Release/deploy are bash scripts
on the dev host; the server side is the root-owned `/usr/local/bin/orion-remote` (Python, argv only, no shell) that
1.5a stubbed, re-installed by re-running `scripts/provision/orion-host.sh`.

**Tech Stack:** TypeScript (Node 26, ESM), commander, zod, `pg` (from 1.5b), vitest on real Postgres 18; bash
(release/deploy/provisioning); Python 3 stdlib (`orion-remote`), Python 3 + venv (disclosure watcher); git CLI;
systemd user units; `systemd-notify`.

**Spec:** `docs/superpowers/specs/2026-10-28-orion-platform-postgres-design.md` (revision 3; Status block decisions N3,
N6 and §2.1, §3, §4, §5, §6 option A, §8.5, §9, §13 are what this plan implements). Conventions follow
`docs/superpowers/plans/2026-10-28-orion-phase1-remove-valuation.md`.

## Dependencies

- **Branch:** `feat/daemon`, cut from `feat/platform-pg` (plan 1.5b,
  `docs/superpowers/plans/2026-10-29-orion-phase1.5b-postgres.md`, written in parallel; do not edit it). Task 15 also
  needs `feat/provision` (plan 1.5a) merged into main and main merged into `feat/daemon` first, because it edits
  `scripts/provision/orion-host.sh`, `files/orion-remote` and the dry-run harness that 1.5a creates.
- **What this plan consumes from 1.5b** (names as assumed here; Task 0 maps each to 1.5b's actual name and records the
  mapping at the top of the task ledger; a missing item is added by the task that first needs it, in `src/db/connection.ts`):
  - `Db` in `src/db/connection.ts`: `all<T>(sql, params?): Promise<T[]>`, `one<T>(sql, params?): Promise<T | null>`,
    `run(sql, params?): Promise<{ rowCount: number; rows: any[] }>`, `tx<T>(fn: (db: Db) => Promise<T>, opts?: { lockAsset?: string }): Promise<T>`
    (a nested `tx` is a SAVEPOINT; `lockAsset` takes `pg_advisory_xact_lock`).
  - A pool opener `openDb(url: string, opts: { max: number }): Promise<Db & { close(): Promise<void> }>` and a pinned
    session `withSession<T>(db, fn: (s: Db) => Promise<T>): Promise<T>` (one pool client for the call, needed for
    session-level advisory locks).
  - `advisoryKey(name: string): bigint` (64-bit key from sha256), with the asset key = `advisoryKey('orion:asset:' + id)`.
  - The asset run lock that replaced `run_locks` (`pg_try_advisory_lock`, OrionError `run_in_progress`), used by
    `tickAsset` unchanged in signature: `tickAsset(db, loaded, deps): Promise<TickResult>`.
  - Migrations: files `src/db/pg/migrations/NNNN_*.sql` copied into `dist/` by `npm run build`; `orion db migrate`,
    `orion db status [--json]` → `{ applied: number, required: number, pending: { id, name, sha256 }[] }`; the
    open-time check (older schema refused, newer accepted); `schema_migrations (id, name, sha256, applied_at)`.
  - Async db modules and CLI (`withDbAsync(ctx, fn)` reads `ORION_DATABASE_URL` through `loadEnv`); type parsers
    (timestamptz → 24-char ISO string, date → `YYYY-MM-DD`, json → raw string, int8 → number).
  - Test helper `tests/helpers/pg.ts`: `freshDb(): Promise<Db>` (new schema `t_<random>`, all migrations applied, pool
    `max: 1`, dropped in `afterAll`) and the env a CLI subprocess needs to reach that schema.
  - The SQLite importer (`tools/import-sqlite`). It cannot seed `asset_registry` (a 1.5c table); Task 3 provides
    `orion asset registry seed` for the cutover.
- **1.5a (provisioning)** installs the `/usr/local/bin/orion-remote` stub (status only), the home layout of spec §2.1,
  the keys of R5 and `/opt/node-v26`. It defers to this plan (its R4): the full `orion-remote`, the `orion-daemon` user
  unit, and the watcher venv. Task 15 adds them to `orion-host.sh`.
- **The disclosure watcher** today lives at `~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/`. Read it,
  copy it; never edit it there (it stays live until cutover).

## Global Constraints

- All 1.5c tables in one migration, `src/db/pg/migrations/0002_daemon.sql`: `jobs`, `asset_registry`,
  `asset_state_events`, `latest_levels`, `watch_state`, `day_blocks`, `snapshots_out`, `daemon_heartbeat`.
  Migrations are expand-only; nothing in this plan is `-- breaking`.
- **Slots are UTC only.** `schedule.yaml` with a `tz` other than `UTC`, or a daily or weekly slot in **07:00-08:00 UTC**
  (07:00 inclusive, 08:00 exclusive), is refused by `orion daemon` at start-up and by `orion asset validate`'s
  schedule check. The shipped slots, verbatim: nightly `00:45` UTC; levels `every: 1h, minute: 15`;
  disclosure_watch `16:40` UTC; staging_refresh `weekly: sun, at: "10:30"`, `env: stage`; staging overrides nightly
  `02:45` UTC, levels `every: 6h`; plus retention `03:30` UTC (not in the spec; chosen here).
- Daemon numbers: scheduler every 30 s; one worker; lease 3 min, renewed every 60 s; `refresh` `max_attempts = 2`, retry
  `run_after` = failure + 10 min (`run_in_progress`: + 30 min); `levels` `max_attempts = 1`; heartbeat row at each job
  start and end and every 15 min (never on the 30 s beat); `WATCHDOG=1` every 30 s; pool `max: 4` in the daemon, `max: 1`
  in CLI commands; `nightly_report` waits for the slot's `refresh` jobs to be terminal or 3 h after the slot.
- Unit file values, verbatim: `Type=notify`, `NotifyAccess=all`, `Restart=always`, `RestartSec=30`, `WatchdogSec=120`,
  `TimeoutStopSec=15min`, `ExecStart=/opt/node-v26/bin/node %h/current/dist/cli/index.js daemon`,
  `Environment=ORION_HOME=%h/home`.
- Fixed message texts: `ORION RESTARTED <env> after unclean exit, job <id> re-queued`; `ORION ALERT ...` as a message's
  first line; `ORION WATCH <SYM>: <metric> <rule> <value>` (+ ` (was <previous>)` when previous is not null) and
  `ORION WATCH <SYM> cleared: <metric> <rule>`; `PAUSED <SYM> since <YYYY-MM-DD> by <by>: <reason>`.
- Slack: incoming webhook `SLACK_WEBHOOK_URL`; a failed post is retried 3 times over 10 min (waits 1, 3, 6 min); after
  that the text stays in `jobs.result_json` and that run's dead-man ping is withheld. Unset webhook (dev) = log only.
- Dead-man: ping `ORION_DEADMAN_URL` after each successful `levels` job and `ORION_DEADMAN_NIGHTLY_URL` after each
  delivered `nightly_report` (two URLs; see spec gaps). Unset = no ping.
- Snapshots: envelope `schema: "orion.snapshot/1"`; file layout exactly spec §9.2 (`manifest.json`,
  `manifest.json.sig`, `full/latest.json`, `full/YYYY/YYYY-MM-DD.json`, `levels/latest.json`, `assets.json`); push retry
  1, 5, 15 min, then hourly; ALERT once after 3 h unpushed; outbox prune: older than 30 days except the newest 7 `full`.
  `jobs` rows older than 90 days are deleted by `retention`.
- `ORION_PUBLISH` = `git:<url>#<branch>` (git driver), `s3:...` (refused: `publish_driver_not_built`), unset (publishing
  off; snapshots still go to the outbox). Staging and prod publish to different repos; the daemon refuses to start if
  `ORION_ENV=stage` and `ORION_PUBLISH` names `orion-data.git` (the prod repo, N11).
- Release tag `orion-YYYY.MM.DD.N`; tarball `orion-<tag>.tgz` + `.sha256`; contents `dist/ assets/ personas/ skills/
  schedule.yaml scripts/ tools/disclosure-watcher/ package.json package-lock.json RELEASE` (no `src/`, `tests/`, `.env`,
  DB files, `node_modules/`). A red suite stops the build; no skip flag.
- Secrets: never printed, logged, put in a release or in `deploys.log`; `.env` is re-read at the start of every job;
  `orion-remote` has no verb that reads `.env` and passes caller text only as argv (never a shell).
- Tests: `npx vitest run --maxWorkers=2`, then `npm run typecheck`. Real Postgres (1.5b's `freshDb`); no network: fake
  `http`/`rpc`, fake `fetch` for Slack and the dead-man, `file://` bare git repos for the publisher, fake `ssh` /
  `systemctl` / `psql` on `PATH` for scripts. Report the real pass/fail counts of both commands in each task report.
- Never touch `/home/hermes/git/orion`'s working tree, its `orion.db` or `.env`, `~/.hermes/profiles/raymond/cron` or
  `scripts`, or the live watcher directory. Scratch homes live under `$TMPDIR` and are deleted with
  `python3 -c "import shutil; shutil.rmtree('<dir>')"` when they hold an `.env` copy.

## Review Focus

1. **The daemon dies mid-job** (kill -9, power cut, OOM): on the next start the `running` job is re-queued exactly once
   if attempts remain (else `failed` with `lease_expired`), `ORION RESTARTED <env> after unclean exit, job <id> re-queued`
   is posted once, and nothing runs twice concurrently. Pinned in Task 6: `daemon: a running job from a dead daemon is
   re-queued once and announced`.
2. **The host's local time zone or DST** (process `TZ=America/Los_Angeles`, a run across 2026-11-01 09:00 UTC when PDT
   ends): slots are identical to a `TZ=UTC` run and the nightly is labelled with the UTC day it covers. Pinned in Task 5:
   `schedule: slots do not move with TZ or DST`.
3. **Slack is down at 00:45** (webhook 500s or times out): the nightly report text survives in `result_json`, the
   nightly dead-man ping is not sent (so the outside check alerts), the job does not fail the refreshes, and the full
   snapshot is still enqueued. Pinned in Task 10: `nightly_report: undeliverable report is kept and the dead-man is not pinged`.
4. **Someone edits the snapshot repo** (a commit on `main` that Orion did not make): the publisher refuses to merge or
   force, posts one ALERT, and keeps every outbox row for retry after a human fixes the repo. Pinned in Task 9:
   `git publisher: a moved remote is refused, alerted once, outbox kept`.
5. **Hostile or malformed SSH commands** (`ack 7 '$(id)'`, `status; rm -rf ~`, a newline in a note, `sql-ro` on stage,
   a tarball larger than the cap, an unknown verb): `orion-remote` refuses or passes the text literally as one argv
   element, logs the call, never invokes a shell. Pinned in Task 14: `orion-remote: injection attempts are literal or refused`.

---

## File Structure

- `src/cli/paths.ts` (new): where config, data and secrets live (release root vs `ORION_HOME` vs `.env` file).
- `src/db/jobs.ts`, `src/db/registry.ts`, `src/db/latestLevels.ts`, `src/db/watchState.ts`, `src/db/dayBlocks.ts`,
  `src/db/snapshotsOut.ts`, `src/db/heartbeat.ts` (new): one store per 0002 table.
- `src/registry/reconcile.ts`, `src/registry/actions.ts` (new): YAML vs registry, pause/resume/activate/seed.
- `src/notify/slack.ts`, `src/notify/deadman.ts`, `src/notify/format.ts` (new): delivery and the deterministic report text.
- `src/daemon/schedule.ts`, `src/daemon/daemon.ts`, `src/daemon/systemd.ts`, `src/daemon/log.ts` (new): the process.
- `src/daemon/jobs/{refresh,nightlyReport,levels,snapshotPush,disclosureWatch,stagingRefresh,retention}.ts` (new): handlers.
- `src/levels/levels.ts`, `src/levels/watchTransitions.ts` (new): hourly read and fire/clear logic.
- `src/push/{envelope,sign,body,publisher,gitPublisher}.ts` (new): snapshots.
- `src/ingest/flow.ts`, `src/ingest/run.ts`, `src/ingest/sources/coingecko.ts`, `src/ingest/transport/{rpc,viemRpc,http}.ts`
  (modify): day-boundary cache, finalized block, CoinGecko plan, shared nightly cache.
- `src/cli/commands/{daemon,job}.ts` (new), `src/cli/commands/asset.ts`, `src/cli/program.ts`, `src/cli/util.ts`,
  `src/cli/env.ts`, every command that loads assets/personas/skills (modify).
- `schedule.yaml` (new, repo root).
- `scripts/release/{build.sh,pack.sh,deploy.sh}` (new).
- `scripts/provision/files/orion-remote` (replace 1.5a's stub; Python), `scripts/provision/files/orion-daemon.service`,
  `scripts/provision/files/watcher-requirements.txt` (new), `scripts/provision/orion-host.sh` (modify).
- `tools/disclosure-watcher/` (new: copied from the live watcher, then adapted).
- Docs: `docs/ops/daemon.md`, `docs/ops/deploy.md` (new), `docs/ops/disclosure-watcher.md`, `docs/ops/hermes-daily-job.md`,
  `README.md` (modify), `docs/superpowers/notes/2026-10-29-orion-phase1.5c-followups.md` (new).

---

### Task 0: Branch, 1.5b interface map, baseline (no commit)

**Files:** none in the repo.

- [ ] **Step 1:** `git worktree add $TMPDIR/orion-1.5c -b feat/daemon feat/platform-pg`; `npm ci`; confirm
  `ORION_TEST_DATABASE_URL` reaches the local `orion_test` database (1.5b's README line).
- [ ] **Step 2:** For every item in "Dependencies → What this plan consumes from 1.5b", find 1.5b's actual name and
  signature (`grep -rn` in `src/db`, `tests/helpers`) and write the mapping table into the task ledger. Every later task
  uses the real names; where 1.5b lacks an item, note which task adds it.
- [ ] **Step 3:** Run the suite and typecheck; record both counts as the baseline.

### Task 1: Config root, env file and release info split from `ORION_HOME`; config proposals in release mode (D6)

Today `ctx.home` is both the config root (`assets/`, `personas/`, `skills/`) and the data home (`.env`, `ticks.jsonl`).
On the server the config is the release (`~/current/`), the data home is `~/home`, and `.env` is `~/shared/.env`.

**Files:**
- Create: `src/cli/paths.ts`; `tests/cli/paths.test.ts`
- Modify: `src/cli/util.ts` (`CliContext` gains `configRoot`, `envFile`, `release`), `src/cli/index.ts`, `src/cli/env.ts`
  (`loadEnv(envFile, processEnv)`), every `loadAsset/listAssetIds/loadPersona/loadSkills/listPersonaNames(ctx.home, ...)`
  call in `src/cli/commands/*.ts` (→ `ctx.configRoot`), `src/cli/commands/agent.ts:90`, `src/app/proposals.ts`
  (`approveProposal(db, configRoot, id, opts)` + release mode), `src/cli/commands/proposals.ts`, `tests/helpers/*` that build a `CliContext`
- Test: `tests/cli/paths.test.ts`, `tests/app/proposals.test.ts`, `tests/cli/env.test.ts`

**Interfaces:**
- Produces: `interface ReleaseInfo { tag: string; commit: string; schema: number; builtAt: string }`;
  `interface OrionPaths { home: string; configRoot: string; envFile: string; release: ReleaseInfo | null }`;
  `readRelease(root: string): ReleaseInfo | null` (parses `<root>/RELEASE`, JSON, keys `tag, commit, schema, built_at`);
  `resolvePaths(env: Record<string, string | undefined>, distDir: string): OrionPaths` where `home = env.ORION_HOME ?? cwd`,
  `configRoot = env.ORION_CONFIG_ROOT ?? (readRelease(dirname(distDir)) ? dirname(distDir) : home)`,
  `envFile = env.ORION_ENV_FILE ?? join(home, '.env')`, `release = readRelease(configRoot)`;
  `type OrionEnv = 'dev' | 'stage' | 'prod'`, `orionEnv(env): OrionEnv` (`ORION_ENV`, default `dev`, anything else throws `invalid_orion_env`).
  `CliContext.configRoot: string`, `CliContext.envFile: string`, `CliContext.release: ReleaseInfo | null`.
- `approveProposal` on a `config` proposal when `release !== null`: never writes a file; records `approved` only when
  every edit's value is already what the release's YAML holds (the existing "file already holds every proposed value"
  branch), else throws `OrionError('config_needs_release', 'proposal <id> changes assets/<a>.yaml; commit the change, ship a release, deploy it, then approve')`.

- [ ] **Step 1: Write the failing tests:**
  - `paths: a release root is the config root` (temp dir with `RELEASE` and `dist/cli/`; `resolvePaths({ORION_HOME:'/h'}, '<root>/dist/cli')` → `configRoot === root`, `home === '/h'`, `release.tag === 'orion-2026.11.02.1'`).
  - `paths: a dev checkout uses ORION_HOME for config` (no `RELEASE` → `configRoot === home`).
  - `paths: ORION_CONFIG_ROOT and ORION_ENV_FILE override`.
  - `env: loadEnv reads the given file, not <home>/.env`.
  - `proposals: release mode refuses an unshipped config proposal with config_needs_release and writes no file` (mtime and bytes of `assets/<a>.yaml` unchanged).
  - `proposals: release mode approves a config proposal the release already carries` (status `approved`, no write).
  - `cli: asset list reads <configRoot>/assets while the data home is elsewhere` (subprocess with `ORION_CONFIG_ROOT`).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement as in Interfaces; `index.ts` builds the context from `resolvePaths(process.env, dirname(fileURLToPath(import.meta.url)))`.
  `orion init` keeps creating `assets/ personas/ skills/` under `home` (dev only).
- [ ] **Step 4:** Suite and typecheck green; no asset hash moves.
- [ ] **Step 5:** Commit: `feat(cli): config root (release or ORION_HOME), env file and release info resolved separately; config proposals in a release approve only what the release ships (D6)`.

### Task 2: Migration `0002_daemon.sql` and the jobs store

**Files:**
- Create: `src/db/pg/migrations/0002_daemon.sql`, `src/db/jobs.ts`; `tests/db/daemonSchema.test.ts`, `tests/db/jobs.test.ts`

**Interfaces:**
- 0002 tables (schema `orion`, text columns `COLLATE "C"` as 0001):
  - `jobs (id bigint generated by default as identity pk, kind text not null check (kind in ('refresh','nightly_report','levels','snapshot_push','disclosure_watch','staging_refresh','retention')), asset_id text null, slot timestamptz not null, run_after timestamptz not null, priority smallint not null, status text not null check (status in ('queued','running','done','failed','skipped')), attempts smallint not null default 0, max_attempts smallint not null, lease_owner text, lease_expires_at timestamptz, started_at timestamptz, ended_at timestamptz, result_json json, release_tag text, requested_by text not null default 'scheduler', last_error text, constraint jobs_slot_key unique nulls not distinct (kind, asset_id, slot))` + index `(status, priority, run_after, id)`.
  - `asset_registry (asset_id text pk, state text not null check (state in ('inactive','active','paused','missing')), state_since timestamptz not null, state_by text not null, state_reason text, config_hash text not null, first_seen_release text, last_job_id bigint, last_run_at timestamptz, last_outcome text)`.
  - `asset_state_events (id bigint identity pk, asset_id text not null, from_state text, to_state text not null, at timestamptz not null, by text not null, reason text, release_tag text)`.
  - `latest_levels (asset_id text, metric_key text, value double precision not null, observed_at timestamptz not null, source text not null, block_number bigint, job_id bigint, primary key (asset_id, metric_key))`.
  - `watch_state (asset_id text, metric_key text, rule text not null, firing boolean not null, since timestamptz not null, last_value double precision, primary key (asset_id, metric_key))`.
  - `day_blocks (chain_id integer, day date, first_block bigint not null, first_block_ts bigint not null, primary key (chain_id, day))`.
  - `snapshots_out (id bigint identity pk, kind text not null check (kind in ('full','levels')), seq bigint not null, snapshot_id text not null, sha256 text not null, day date, body json not null, created_at timestamptz not null, pushed_at timestamptz, attempts integer not null default 0, last_error text, alerted_at timestamptz, unique (kind, seq))`.
  - `daemon_heartbeat (daemon_id text pk, pid integer not null, host text not null, release_tag text, started_at timestamptz not null, beat_at timestamptz not null, current_job_id bigint, state text not null check (state in ('running','draining','drained','stopped')), drain_requested_at timestamptz)`.
- Produces in `src/db/jobs.ts`: `JOB_KINDS`, `type JobKind`, `type JobStatus`,
  `JOB_PRIORITY: Record<JobKind, number> = { staging_refresh: 5, refresh: 10, nightly_report: 20, snapshot_push: 30, levels: 40, disclosure_watch: 50, retention: 60 }`,
  `MAX_ATTEMPTS: Record<JobKind, number>` (`refresh: 2`, all others `1`), `LEASE_MS = 180_000`,
  `interface Job { id; kind; assetId: string | null; slot: string; runAfter: string; priority: number; status: JobStatus; attempts: number; maxAttempts: number; leaseOwner: string | null; leaseExpiresAt: string | null; startedAt: string | null; endedAt: string | null; result: unknown; releaseTag: string | null; requestedBy: string; lastError: string | null }`,
  `interface NewJob { kind: JobKind; assetId: string | null; slot: string; runAfter?: string; requestedBy?: string; releaseTag?: string | null }`,
  `enqueueJob(db, j: NewJob): Promise<Job | null>` (`ON CONFLICT ON CONSTRAINT jobs_slot_key DO NOTHING`; null when it existed),
  `claimNextJob(db, owner: string, now: Date, releaseTag: string | null): Promise<Job | null>` (the spec §5.1 statement, with `now` passed as a parameter, never `now()` in SQL, so the fake clock rules),
  `renewLease(db, id, owner, now): Promise<boolean>` (false when the row is no longer ours),
  `finishJob(db, id, owner, out: { status: 'done' | 'failed' | 'skipped'; result: unknown; error?: string }, now): Promise<void>`,
  `retryJob(db, id, owner, runAfter: Date, error: string): Promise<void>` (status `queued`, lease cleared),
  `deferJob(db, id, owner, runAfter: Date): Promise<void>` (status `queued`, `attempts - 1`),
  `reapExpired(db, now): Promise<{ requeued: Job[]; failed: Job[] }>` (running with `lease_expires_at < now`: `attempts < max_attempts` → queued, else failed with `last_error = 'lease_expired'`),
  `abandonRunning(db, now): Promise<{ requeued: Job[]; failed: Job[] }>` (every `running` row, whatever its lease; start-up only),
  `listJobs(db, f: { since?: string; kind?: JobKind; slot?: string; limit?: number }): Promise<Job[]>`, `deleteJobsBefore(db, iso): Promise<number>`.

- [ ] **Step 1: Write the failing tests:**
  - `schema: 0002 applies after 0001 and records its sha256`; `schema: every 0002 table exists in schema orion`.
  - `jobs: the same (kind, null, slot) enqueued twice gives one row` (proves `nulls not distinct`; the second call returns null).
  - `jobs: claim takes the lowest priority, then oldest run_after, then id, and skips future run_after`.
  - `jobs: two concurrent claims on two pool clients never return the same job` (open a second `openDb` on the same schema; `Promise.all` of 20 claims over 10 jobs → 10 distinct ids, 10 nulls).
  - `jobs: renewLease returns false after another owner re-claimed the row`.
  - `jobs: reapExpired requeues while attempts remain and fails with lease_expired when not`.
  - `jobs: deferJob does not consume an attempt`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement the migration and the store (row mapping as the other `src/db/` modules do).
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(db): migration 0002_daemon (jobs, registry, latest levels, watch state, day blocks, snapshot outbox, heartbeat) and the jobs store with leases`.

### Task 3: Asset registry: reconcile, pause / resume / activate, registry commands

**Files:**
- Create: `src/db/registry.ts`, `src/registry/reconcile.ts`, `src/registry/actions.ts`; `tests/registry/reconcile.test.ts`, `tests/registry/actions.test.ts`
- Modify: `src/cli/commands/asset.ts`; `tests/cli/cli.test.ts`

**Interfaces:**
- `src/db/registry.ts`: `type AssetState = 'inactive' | 'active' | 'paused' | 'missing'`;
  `interface RegistryRow { assetId; state: AssetState; stateSince: string; stateBy: string; stateReason: string | null; configHash: string; firstSeenRelease: string | null; lastJobId: number | null; lastRunAt: string | null; lastOutcome: string | null }`;
  `listRegistry(db): Promise<RegistryRow[]>` (by asset_id), `getRegistryRow(db, id)`,
  `recordRun(db, assetId, jobId, at, outcome: string): Promise<void>`, `listStateEvents(db, assetId, limit)`.
- `src/registry/reconcile.ts`: `interface RegistryDiff { added: string[]; missing: string[]; returned: string[]; configChanged: string[] }`;
  `planReconcile(rows: RegistryRow[], yamls: { id: string; hash: string }[]): RegistryDiff` (pure);
  `applyReconcile(db, diff, yamls, releaseTag: string | null, now: Date): Promise<void>` (one `tx`): added → `inactive`
  (`by 'release'`, reason `new in release <tag>`); missing → `missing`; returned (a `missing` row whose YAML is back) →
  `inactive`; configChanged → `config_hash` updated. One `asset_state_events` row per state change.
  `reconcileFromDisk(db, configRoot, releaseTag, now): Promise<RegistryDiff>` (loads every YAML with `loadAsset`; an
  invalid YAML throws `invalid_asset_config` before anything is written).
- `src/registry/actions.ts`: `pauseAsset(db, id, { reason, by, now, releaseTag })` (from `active` or `inactive`;
  `reason` required, blank → `reason_required`), `resumeAsset(db, id, opts)` (from `paused` → `active`; returns
  `{ pausedDays: number; backfillDays: number | null; refillShort: boolean }` with `refillShort = backfillDays !== null && pausedDays > backfillDays`),
  `activateAsset(db, id, opts)` (from `inactive` → `active`), `seedRegistry(db, configRoot, { state: 'active', by, reason, now })`
  (rows for YAMLs without a row only). Wrong from-state → `OrionError('invalid_state_transition', '<a> is <state>; <verb> needs <states>')`;
  unknown asset → `asset_not_in_registry`. Every action = one `tx` with the event row.
- CLI: `orion asset pause <a> --reason <text> [--by <who>]`, `asset resume <a> [--by]`, `asset activate <a> [--by]`
  (`--by` default `$USER`), `asset registry [--json]` (state, since, by, reason, last run), `asset registry diff [--json]`
  (planReconcile against the YAMLs, writes nothing), `asset registry seed --reason <text> --by <who> [--json]`.

- [ ] **Step 1: Write the failing tests:**
  - `reconcile: a YAML with no row arrives inactive` (Spec N4); `reconcile: a row whose YAML is gone becomes missing, history kept`;
    `reconcile: a returning YAML comes back inactive`; `reconcile: a hash change is listed as configChanged and stored`;
    `reconcile: running it twice changes nothing the second time` (diff all empty, no new event rows).
  - `actions: pause needs a reason`; `actions: pause then resume writes two events and ends active`;
    `actions: resume after 40 days on an asset with backfill_days 30 reports refillShort`;
    `actions: activate refuses a paused asset with invalid_state_transition`.
  - `cli: asset registry diff writes nothing` (row counts unchanged); `cli: asset registry seed makes every YAML active once`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(registry): asset registry (inactive/active/paused/missing) reconciled from release YAML; asset pause/resume/activate/registry/diff/seed`.

### Task 4: Slack notifier, dead-man pinger, report formatting

**Files:**
- Create: `src/notify/slack.ts`, `src/notify/deadman.ts`, `src/notify/format.ts`; `tests/notify/slack.test.ts`, `tests/notify/format.test.ts`

**Interfaces:**
- `interface Notifier { post(text: string): Promise<{ ok: boolean; attempts: number; error?: string }> }`;
  `SLACK_RETRY_DELAYS_MS = [60_000, 180_000, 360_000]`;
  `slackNotifier(o: { webhookUrl: string | undefined; fetch: typeof fetch; sleep(ms: number): Promise<void>; log(line: string): void }): Notifier`
  (POST `{"text": ...}` JSON; 2xx = ok; anything else or a throw → wait the next delay; 4 tries in all; unset URL →
  `{ ok: true, attempts: 0 }` and one log line `slack disabled: <first line>`); the webhook URL is never logged.
- `pingDeadman(url: string | undefined, fetch): Promise<boolean>` (GET, 10 s timeout, one retry after 5 s; unset → false, no request).
- `SLACK_MAX_CHARS = 3900`; `splitForSlack(blocks: string[][], max = SLACK_MAX_CHARS): string[]` (joins blocks with a
  blank line, starts a new post only at a block boundary; a single block over `max` is cut at line boundaries with
  `(continued)` as the next post's first line).
- `fmtNum(x: number | null): string`: null → `n/a`; |x| ≥ 1e9 → `1.23B`, ≥ 1e6 → `1.23M`, ≥ 1e3 → `1.23K`, ≥ 1 → 2
  decimals, else 4 significant digits (`0.01234`). `fmtPct(x)`: fraction → percent with 2 decimals (`0.0345` → `3.45%`).
- `interface AssetRunResult { symbol: string; report: TickReport | null; job: { status: JobStatus; attempts: number; error: string | null }; fetchLines: string[]; alertFlags: string[] }`;
  `formatAssetBlock(r: AssetRunResult): { lines: string[]; alert: boolean }` in this order: `ORION WATCH <SYM>: ...`
  lines from `report.ingest.watch`; `failed sources: <id>, <id>`; `DECISIONS` + `inboxLines(report.inbox)` (or
  `nothing to decide`); `HOLDER YIELD <SYM>  <day> (<window_days>d window)` and the four Phase 1 lines
  (`docs/ops/hermes-daily-job.md` STEP 3 part 4) with `fmtNum`/`fmtPct`, or the `report_error` line; then, when
  `alert`, the `fetchLines` that carry `OUTSIDE`, `conflict` or `unlisted sender`. `alert` is true on: job `failed`;
  report outcome `error` or `run_in_progress`; `report_error` set; `anomalies_raised` non-empty; a `degrading` inbox
  anomaly; `sources_failed` non-empty; any `alertFlags`.
- `formatWatchPost(sym, firing: WatchFiring): string` and `formatWatchCleared(sym, metric, rule): string` (texts in Global Constraints).

- [ ] **Step 1: Write the failing tests:**
  - `slack: three failures then success posts once with attempts 4 and waits 1, 3, 6 min` (fake sleep records `[60000,180000,360000]`).
  - `slack: four failures returns ok false and never logs the webhook URL`.
  - `slack: unset webhook posts nothing and logs one line`.
  - `deadman: unset url sends nothing`.
  - `split: blocks are never split below the limit; an oversize block continues in the next post`.
  - `fmt: fmtNum(1234567890) is 1.23B, fmtNum(0.012345) is 0.01235, fmtNum(null) is n/a; fmtPct(0.0345) is 3.45%`.
  - `format: a clean asset prints DECISIONS nothing to decide and the holder-yield block, alert false` (fixture TickReport).
  - `format: watch lines come first and print (was x) only when previous is non-null`.
  - `format: report_stale prints the error line after the block's first line and is an alert`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(notify): Slack webhook notifier with 3 retries over 10 min, dead-man pinger, deterministic report blocks (Phase 1 message rules)`.

### Task 5: `schedule.yaml`, the UTC-only rule and slot arithmetic

**Files:**
- Create: `schedule.yaml`, `src/daemon/schedule.ts`; `tests/daemon/schedule.test.ts`
- Modify: `src/cli/commands/asset.ts` (`asset validate` also validates `<configRoot>/schedule.yaml` when present)

**Interfaces:**
- `schedule.yaml` (repo root, ships in the release):
  ```yaml
  nightly:  { at: "00:45", tz: UTC }
  levels:   { every: 1h, minute: 15 }
  disclosure_watch: { at: "16:40", tz: UTC }
  staging_refresh:  { weekly: sun, at: "10:30", tz: UTC, env: stage }
  retention: { at: "03:30", tz: UTC }
  staging_overrides: { nightly: { at: "02:45", tz: UTC }, levels: { every: 6h } }
  ```
- `type ScheduleKey = 'nightly' | 'levels' | 'disclosure_watch' | 'staging_refresh' | 'retention'`;
  `type Cadence = { daily: { hh: number; mm: number } } | { weekly: { dow: 0..6; hh; mm } } | { every: { hours: number; minute: number } }`;
  `interface ScheduleEntry { key: ScheduleKey; cadence: Cadence }`;
  `parseSchedule(text: string, env: OrionEnv): ScheduleEntry[]` (zod-strict; applies `staging_overrides` when
  `env === 'stage'`; drops entries whose `env` differs; `every` must divide 24; `minute` 0-59 default 0) throwing
  `OrionError('invalid_schedule', ...)` on: a `tz` other than `UTC` (message names the key), a daily/weekly slot with
  07:00 ≤ at < 08:00 (`"<key> at <at> UTC falls in 07:00-08:00 UTC, whose Pacific date differs between PDT and PST"`),
  unknown keys; `loadSchedule(configRoot, env)`;
  `newestSlot(c: Cadence, now: Date): Date` (latest slot ≤ now, UTC arithmetic only, `Date.UTC`),
  `nextSlot(c: Cadence, now: Date): Date` (earliest slot > now); `reportDay(nightlySlot: Date): string` (UTC day before
  the slot's date when the slot is before 12:00 UTC, else the slot's own date).

- [ ] **Step 1: Write the failing tests:**
  - `schedule: the shipped schedule.yaml parses for dev, stage and prod` (prod has no staging_refresh; stage nightly is 02:45 and levels every 6h).
  - `schedule: 07:00 and 07:59 are refused, 06:59 and 08:00 are accepted` (daily and weekly).
  - `schedule: tz America/Los_Angeles is refused naming the key`.
  - `schedule: slots do not move with TZ or DST` (run `newestSlot` for nightly and levels at 2026-11-01T08:30Z,
    09:30Z, 2026-11-02T00:50Z under `process.env.TZ = 'America/Los_Angeles'` and `'UTC'`; identical ISO strings;
    `newestSlot(nightly, 2026-11-02T00:50Z) = 2026-11-02T00:45:00.000Z`, `reportDay(...) = '2026-11-01'`) (Review Focus 2).
  - `schedule: levels every 6h at minute 15 gives 00:15, 06:15, 12:15, 18:15`.
  - `schedule: weekly sun 10:30 newest slot on a Wednesday is the previous Sunday`.
  - `cli: asset validate fails on a schedule.yaml with a 07:30 slot`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(daemon): schedule.yaml (UTC only; no daily or weekly slot in 07:00-08:00 UTC) and slot arithmetic`.

### Task 6: The daemon process: scheduler, worker, leases, drain, heartbeat, systemd, CLI

**Files:**
- Create: `src/daemon/daemon.ts`, `src/daemon/systemd.ts`, `src/daemon/log.ts`, `src/db/heartbeat.ts`,
  `src/daemon/jobs/retention.ts`, `src/cli/commands/daemon.ts`, `src/cli/commands/job.ts`, `tests/helpers/clock.ts`;
  `tests/daemon/daemon.test.ts`, `tests/daemon/retention.test.ts`, `tests/cli/daemon.cli.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- `interface Clock { now(): Date; sleep(ms: number): Promise<void> }`; `FakeClock` in `tests/helpers/clock.ts`
  (`advance(ms)`, sleeps resolve when advanced past).
- `type JobOutcome = { status: 'done' | 'skipped'; result: unknown } | { status: 'failed'; result: unknown; error: string; retryAfterMs?: number } | { status: 'deferred'; untilMs: number }`;
  `interface JobContext { db: Db; clock: Clock; env: OrionEnv; paths: OrionPaths; envVars: Record<string, string | undefined>; notify: Notifier; enqueue(j: NewJob): Promise<Job | null>; log(line: string): void }`
  (`envVars` = `loadEnv(paths.envFile, process.env)` re-read for each job);
  `type JobHandler = (job: Job, ctx: JobContext) => Promise<JobOutcome>`.
- `interface DaemonDeps { db: Db; clock: Clock; env: OrionEnv; paths: OrionPaths; handlers: Partial<Record<JobKind, JobHandler>>; notifier: (envVars) => Notifier; systemd: SystemdNotifier; log(line: string): void; daemonId: string; activeAssets(db): Promise<string[]> }`;
  `class Daemon { constructor(d: DaemonDeps); start(): Promise<void>; schedulerTick(): Promise<number>; workerTick(): Promise<boolean>; requestStop(): void; run(): Promise<void> }`.
  - `start()`: take `pg_try_advisory_lock(advisoryKey('orion:daemon'))` on a pinned session (held for the process's
    life; failure → `OrionError('daemon_running', 'another orion daemon holds this database')`); schema check; asset
    validate of every YAML; `loadSchedule`; `reconcileFromDisk`; refuse `stage` + prod publish repo; insert the
    heartbeat row (`state 'running'`); `abandonRunning` → for each requeued or failed job post
    `ORION RESTARTED <env> after unclean exit, job <id> re-queued` (failed: `... job <id> failed (lease_expired)`); then `systemd.ready()`.
  - `schedulerTick()`: for each schedule entry compute `newestSlot`; `nightly` → one `refresh` per active asset and
    one `nightly_report` (asset null); other keys → one job of the same name; all via `enqueueJob` (returns how many were new).
    The catch-up rule falls out of `newestSlot`: only the newest missed slot is ever created.
  - `workerTick()`: unless draining, `reapExpired`, then `claimNextJob`; heartbeat `current_job_id`; renew the lease
    every 60 s while the handler runs; map the outcome (`failed` with `attempts < maxAttempts` and `retryAfterMs` →
    `retryJob`; `deferred` → `deferJob`); heartbeat again; returns whether a job ran. A handler throw = `failed` with the
    message capped at 300.
  - `run()`: scheduler every 30 s, worker loop polling every 5 s when idle, `systemd.watchdog()` every 30 s, heartbeat
    every 15 min; checks `drain_requested_at` before each claim (sets state `draining`, then `drained` when idle);
    SIGTERM → `requestStop()`: finish the current job, mark heartbeat `stopped`, exit 0.
- `interface SystemdNotifier { ready(): void; watchdog(): void; stopping(): void }`; `systemdNotifier(spawn)` runs
  `systemd-notify --pid=<process.pid> READY=1|WATCHDOG=1|STOPPING=1` only when `NOTIFY_SOCKET` is set (else no-op).
- `src/db/heartbeat.ts`: `startHeartbeat(db, row)`, `beat(db, daemonId, { currentJobId, state }, now)`,
  `requestDrain(db, now): Promise<string | null>` (sets `drain_requested_at` on the newest non-stopped row; null when none),
  `clearDrain(db)`, `latestHeartbeat(db): Promise<HeartbeatRow | null>`.
- `src/daemon/log.ts`: `daemonLog(home): (line) => void` writes `<ISO> <line>` to stdout and appends to
  `<home>/daemon.log`, rotating to `daemon.log.1` at 10 MB.
- `retentionHandler`: deletes `jobs` ended more than 90 days ago, `latest_levels`/`watch_state` rows whose asset is
  `missing` or whose metric is no longer in the asset's YAML, and prunes `snapshots_out` via `pruneSnapshots` (Task 9
  provides it; until then this task deletes jobs and levels only, and Task 9 adds the call).
- CLI: `orion daemon` (builds real deps; pool `max: 4`); `orion daemon drain [--wait <dur>]` (default `30m`; polls the
  heartbeat every 2 s; exit 0 when `drained`, exit 1 with `drain timed out; still running job <id> <kind> <asset>`);
  `orion daemon undrain`; `orion daemon status [--json]` → `{ env, heartbeat, release, registry: RegistryRow[], last_jobs: Job[] (10), next: { key, slot }[] }`;
  `orion job run-now <kind> [asset] [--by <who>]` (slot = now, `requested_by 'run-now:<who>'`; `refresh` needs an asset
  that is `active` unless `--force`); `orion job list [--since <iso>] [--kind <k>] [--json]`.

- [ ] **Step 1: Write the failing tests** (FakeClock, real test DB, stub handlers):
  - `daemon: two schedulers in the same slot insert one row per job` (two `Daemon` instances' `schedulerTick` on two pool clients; `select count(*)` per kind/slot = 1).
  - `daemon: catch-up after 3 days down creates one nightly slot and one levels slot`.
  - `daemon: a paused asset gets no refresh job`.
  - `daemon: a running job from a dead daemon is re-queued once and announced` (insert a `running` row with another owner; `start()` → status `queued`, attempts unchanged, one notifier post with the exact RESTARTED text; second `start()` of a fresh daemon after it ran posts nothing) (Review Focus 1).
  - `daemon: a second daemon on the same database refuses to start with daemon_running`.
  - `daemon: a failed refresh is retried once no sooner than 10 minutes later, then stays failed`.
  - `daemon: the lease is renewed while a slow handler runs and expires when the handler hangs past 3 min without renewal` (handler blocks; advance clock; second daemon's `reapExpired` requeues only in the no-renewal case).
  - `daemon: drain finishes the current job, claims nothing new, reports drained; undrain resumes`.
  - `daemon: a deferred job does not consume an attempt`.
  - `daemon: a start-up check failure (invalid YAML) exits before READY and inserts no heartbeat`.
  - `retention: jobs older than 90 days are deleted, newer kept`.
  - `cli: daemon drain --wait 1s times out naming the running job` (subprocess against the test schema with a `running` heartbeat).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(daemon): orion daemon (idempotent scheduler, one leased worker, catch-up, retry, drain, singleton lock, heartbeat, systemd notify/watchdog, unclean-exit alert), job run-now/list, retention`.

### Task 7: Ingest efficiency: day-boundary block cache (N9), finalized scans, CoinGecko plan and nightly chart cache (N8)

**Files:**
- Create: `src/db/dayBlocks.ts`; `tests/ingest/dayBlocks.test.ts`, `tests/ingest/coingeckoPlan.test.ts`
- Modify: `src/ingest/transport/rpc.ts` (`RpcTransport.finalizedBlock?(): Promise<BlockRef>`), `src/ingest/transport/viemRpc.ts`
  (`getBlock({ blockTag: 'finalized' })`), `src/ingest/flow.ts` (scan upper bound and boundary search),
  `src/ingest/run.ts` (`FetchDeps.dayBlocks?`, `FetchDeps.sharedHttpCache?`), `src/ingest/sources/coingecko.ts`,
  `src/ingest/flow.ts:65` and `src/ingest/adapters/solana.ts:120` (base URL), `src/ingest/transport/http.ts`

**Interfaces:**
- `interface DayBlockCache { get(day: string): Promise<BlockRef | null>; put(day: string, b: BlockRef): Promise<void> }`;
  `dbDayBlocks(db, chainId: number): DayBlockCache` in `src/db/dayBlocks.ts`; `FetchDeps.dayBlocks?: (chainId: number) => DayBlockCache`.
  In `scanFlowGroup` the boundary for "first block at or after day start D" is read from the cache first; on a miss
  it is searched as today and stored **only** when not a dry run and the found block is at least 1 h older than the
  scan's upper-bound block (so a reorg-able boundary is never cached).
- Flow scans use `rpc.finalizedBlock()` as their upper bound when the transport has it (levels keep `latestBlock`);
  `lastCompleteDay` is computed against that block's timestamp.
- `coingeckoBase(env): string` = `https://pro-api.coingecko.com/api/v3` when `env.COINGECKO_PLAN === 'pro'`, else
  `COINGECKO_API`; `coingeckoHeaders(env)` sends `x-cg-pro-api-key` for `pro`, `x-cg-demo-api-key` otherwise;
  any other `COINGECKO_PLAN` value throws `invalid_coingecko_plan`. Every URL builder uses `coingeckoBase`.
- `withSharedCache(inner: HttpTransport, cache: Map<string, Promise<unknown>>, match: (url: string) => boolean): HttpTransport`
  in `http.ts`; `FetchDeps.sharedHttpCache?: Map<string, Promise<unknown>>` applied in `fetchAsset` for URLs whose path
  contains `/market_chart` (the nightly worker keeps one map per nightly slot, Task 10).

- [ ] **Step 1: Write the failing tests:**
  - `dayBlocks: the second scan of the same chain and day makes no boundary search calls` (counting fake RPC: `getBlock` calls on the second asset = 0 for the boundary).
  - `dayBlocks: a dry run reads the cache but writes nothing`.
  - `dayBlocks: a boundary within 1 h of the upper bound is not cached`.
  - `finalized: a scan stops at the finalized block when the transport has one` (fake rpc with latest 1000, finalized 990: last log block read ≤ 989).
  - `coingecko: pro plan uses pro-api host and x-cg-pro-api-key; default stays demo; a bad plan is refused`.
  - `sharedCache: two assets with the same price id fetch market_chart once` (counting http).
  - All existing ingest and asset tests stay green unchanged (they pass no `dayBlocks`, no cache, no finalized).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green; no asset hash moves.
- [ ] **Step 5:** Commit: `feat(ingest): day-boundary block cache per chain (N9), scans bounded by the finalized block, CoinGecko pro plan, shared market_chart cache per nightly (N8)`.

### Task 8: Hourly `levels` job: latest-only levels, batched CoinGecko, watch fire/clear

**Files:**
- Create: `src/db/latestLevels.ts`, `src/db/watchState.ts`, `src/levels/levels.ts`, `src/levels/watchTransitions.ts`,
  `src/daemon/jobs/levels.ts`; `tests/levels/levels.test.ts`, `tests/levels/watchTransitions.test.ts`, `tests/daemon/levelsJob.test.ts`

**Interfaces:**
- `src/db/latestLevels.ts`: `interface LatestLevel { assetId; metricKey; value: number; observedAt: string; source: string; blockNumber: number | null; jobId: number | null }`;
  `upsertLatestLevels(db, rows: LatestLevel[]): Promise<void>`, `listLatestLevels(db, assetId?)`, `deleteLatestLevels(db, keep: (r) => boolean)`.
- `src/db/watchState.ts`: `interface WatchStateRow { assetId; metricKey; rule: WatchRule; firing: boolean; since: string; lastValue: number | null }`;
  `listWatchStates(db, assetId?)`, `putWatchStates(db, rows)`.
- `levelMetricKeys(asset: AssetConfig): string[]`: metrics of type `level` or `schedule` with a source whose type is
  neither `derived` nor `constant`, and (`monitor_only !== true` or a `watch` is set), sorted.
- `prefetchMarkets(http, env, ids: string[]): Promise<Map<string, Record<string, unknown>>>` (one
  `/coins/markets?vs_currency=usd&ids=<sorted,joined>` call per 250 ids); `withPrefetchedMarkets(http, rows): HttpTransport`
  answers any `/coins/markets?...ids=` GET from `rows` (subset, in the requested id order) and passes every other URL through.
- `runLevels(db, assets: LoadedAsset[], deps: FetchDeps, now: Date, jobId: number): Promise<LevelsResult>` where
  `LevelsResult = { perAsset: { assetId; ok: string[]; failed: { sourceId; error }[]; firings: WatchFiring[] }[]; rows: LatestLevel[] }`:
  per asset `fetchAsset(db, a, now, { ...deps, http: withPrefetchedMarkets(deps.http, rows) }, { metrics: levelMetricKeys(a.config), dryRun: true })`;
  each written level → one `LatestLevel` (schedule metrics: the newest step with `observedAt ≤ now`); writes only
  `latest_levels` (never `observations`, `fetch_runs` or anomalies); an asset whose fetch throws is listed failed and
  the others continue.
- `watchTransitions(prev: WatchStateRow[], firings: WatchFiring[], evaluated: { metricKey: string; rule: WatchRule; value: number }[], now: string): { fired: WatchFiring[]; cleared: { metricKey: string; rule: WatchRule }[]; next: WatchStateRow[] }`:
  a metric evaluated this run and firing now but not before → `fired`; firing before and evaluated but not firing →
  `cleared`; a metric not evaluated (its read failed) keeps its state; `above` (flow) rules are never touched here.
  Firings come from `fetchAsset`'s own `watch` output, so `change_pct` compares against the newest stored nightly row
  (the existing `previousLevelIn` rule).
- `levelsHandler`: active assets only; posts `formatWatchPost`/`formatWatchCleared` for each transition; enqueues
  `snapshot_push` (slot = job slot) after inserting a `levels` snapshot (Task 9's `insertSnapshot`; until Task 9 lands
  the handler takes an optional `onLevels` hook and Task 9 wires it); pings `ORION_DEADMAN_URL` when every asset's
  read ran (even with per-source failures); result `{ assets, rows, failed, fired, cleared }`; `failed` outcome only when
  every asset failed (no retry: `max_attempts 1`).

- [ ] **Step 1: Write the failing tests:**
  - `levels: writes latest_levels and nothing else` (counts of `observations`, `fetch_runs`, `anomalies` unchanged).
  - `levels: one batched coins/markets call for all assets` (counting http: 1 markets call for 3 assets with 4 ids).
  - `levels: a re-run overwrites the row (one row per asset and metric)`.
  - `levels: a monitor-only level without a watch is not read`.
  - `levels: one asset's RPC failure leaves the other assets' rows written`.
  - `watch: not firing to firing posts once; staying firing posts nothing; clearing posts once` (three hourly runs).
  - `watch: a failed read keeps the firing state`.
  - `levelsJob: the dead-man is pinged after a run and not when every asset failed`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(levels): hourly latest-only level reads with one batched CoinGecko call; watch alerts posted on fire and clear (watch_state)`.

### Task 9: Snapshot outbox, signed manifest, `Publisher` with the git driver, `snapshot_push`

**Files:**
- Create: `src/db/snapshotsOut.ts`, `src/push/envelope.ts`, `src/push/sign.ts`, `src/push/body.ts`, `src/push/publisher.ts`,
  `src/push/gitPublisher.ts`, `src/daemon/jobs/snapshotPush.ts`; `tests/push/envelope.test.ts`, `tests/push/gitPublisher.test.ts`, `tests/daemon/snapshotPush.test.ts`
- Modify: `src/daemon/jobs/levels.ts` (wire the levels snapshot), `src/daemon/jobs/retention.ts` (`pruneSnapshots`)

**Interfaces:**
- `src/db/snapshotsOut.ts`: `interface OutboxRow { id; kind: 'full' | 'levels'; seq: number; snapshotId: string; sha256: string; day: string | null; body: string; createdAt; pushedAt: string | null; attempts: number; lastError: string | null; alertedAt: string | null }`;
  `insertSnapshot(db, s: { kind; day: string | null; envelope: SnapshotEnvelope }): Promise<OutboxRow>` (seq =
  `coalesce(max(seq),0)+1` per kind inside `tx` with `lockAsset: 'orion:snapshots'`), `pendingSnapshots(db)`
  (unpushed, oldest first), `markPushed(db, ids, at)`, `markFailed(db, ids, error, at)`, `markAlerted(db, ids, at)`,
  `latestPushed(db, kind)`, `pruneSnapshots(db, now)` (older than 30 days, keep the newest 7 `full`).
- `src/push/envelope.ts`: `SNAPSHOT_SCHEMA = 'orion.snapshot/1'`;
  `interface SnapshotEnvelope { schema; kind; snapshot_id: string /* uuid */; seq: number; generated_at: string; env: OrionEnv; release_tag: string | null; sha256: string /* of canonicalJson(body) */; body: unknown }`;
  `buildEnvelope(kind, body, { seq, env, releaseTag, now, uuid }): SnapshotEnvelope`;
  `buildFileSet(state: { full: OutboxRow | null; levels: OutboxRow | null; assets: unknown; env; releaseTag; now }, signKeyPem: string): Record<string, string>`
  producing exactly the §9.2 paths; each file is `canonicalJson(...) + '\n'`; `manifest.json` =
  `{ schema, env, release_tag, generated_at, full: { seq, day, path, sha256 } | null, levels: { seq, generated_at, path, sha256 } | null }`
  where each `sha256` is of the file's exact bytes; `manifest.json.sig` = base64 Ed25519 signature over the exact
  bytes of `manifest.json`, no trailing newline.
- `src/push/sign.ts`: `signManifest(bytes: Buffer, keyPem: string): string`, `verifyManifest(bytes, sigB64, publicKeyPem): boolean` (node:crypto, `sign(null, ...)`).
- `src/push/body.ts`: `fullBody(db, configRoot, registry: RegistryRow[], day: string): Promise<unknown>` =
  `{ day, assets: { [id]: { state, state_since, state_reason, report: <report yield --json object> | null, report_error: string | null } } }`
  for every `active` and `paused` asset (paused assets keep their last report, marked); `levelsBody(db, registry)` =
  `{ assets: { [id]: { state, levels: LatestLevel[] } } }`; `assetsFile(registry)` = `{ [id]: { state, since, reason } }` for active and paused.
- `src/push/publisher.ts`: `interface Publisher { publish(files: Record<string, string>, message: string): Promise<{ ref: string }> }`;
  `parsePublishTarget(v: string | undefined): { driver: 'git'; url: string; branch: string } | { driver: 's3' } | null`
  (`git:<url>#<branch>`, branch default `main`; anything else → `invalid_publish_target`);
  `publisherFromEnv(envVars, paths, run): Publisher | null` (s3 → `OrionError('publish_driver_not_built', ...)`).
- `src/push/gitPublisher.ts`: `gitPublisher(o: { url; branch; dir: string; sshKeyFile: string | undefined; author: string; run: (args: string[], opts) => Promise<{ code; stdout; stderr }> }): Publisher`:
  clone into `dir` if missing (an empty remote = new orphan branch); `git fetch origin <branch>`; refuse with
  `OrionError('publish_remote_moved', ...)` unless `origin/<branch>` is absent or an ancestor of `HEAD`; write files,
  `git add -A`, commit as `author` only when something changed, `git push origin HEAD:<branch>` (never `--force`);
  `GIT_SSH_COMMAND = ssh -i <sshKeyFile> -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes` when a key is given;
  `author` = `orion-<env>@<hostname>`; message `<kind> seq <n> day <D|-> release <tag>`.
  Paths from env: `ORION_PUBLISH_DIR` (default `<home>/publish`), `ORION_PUBLISH_SSH_KEY`, `ORION_SIGN_KEY_FILE`.
- `snapshotPushHandler`: publishing off → `skipped`; else build the file set from the newest pending (or newest
  pushed) row of each kind plus `assets.json`, publish once, `markPushed` every pending row it covered; on error
  `markFailed`, enqueue a new `snapshot_push` with slot = now + backoff (`1, 5, 15` min by the oldest pending row's
  attempts, then `60` min), and, when the oldest pending row is older than 3 h and not alerted, post
  `ORION ALERT <env> snapshot publish failing since <created_at>: <error>` once (`markAlerted`).
  `publish_remote_moved` is alerted at once (first failure).

- [ ] **Step 1: Write the failing tests:**
  - `envelope: sha256 is of the canonical body; seq increases per kind`.
  - `files: exactly the six paths; manifest hashes match file bytes; the signature verifies with the public key and fails on one changed byte`.
  - `git publisher: first publish to an empty bare repo creates the branch with the six files` (`file://` bare repo in `$TMPDIR`; clone it again and compare).
  - `git publisher: nothing changed means no new commit`.
  - `git publisher: a moved remote is refused, alerted once, outbox kept` (push an outside commit to the bare repo; handler result failed, one ALERT post, rows unpushed; a second run alerts no more) (Review Focus 4).
  - `snapshotPush: a failed push is retried after 1, 5, 15 minutes then hourly and alerts once after 3 h`.
  - `snapshotPush: ORION_PUBLISH unset skips and leaves rows pending`; `publisher: s3 target is refused with publish_driver_not_built`.
  - `retention: snapshots older than 30 days are pruned but the newest 7 full stay`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(push): snapshot outbox, orion.snapshot/1 envelope, Ed25519-signed manifest, Publisher with git driver (fetch, refuse a moved remote, commit, push), snapshot_push with backoff and 3 h alert`.

### Task 10: `refresh` and `nightly_report` jobs

**Files:**
- Create: `src/daemon/jobs/refresh.ts`, `src/daemon/jobs/nightlyReport.ts`; `tests/daemon/refresh.test.ts`, `tests/daemon/nightlyReport.test.ts`
- Modify: `src/cli/commands/daemon.ts` (`status --json` gains `soak` and `last_nightly`), `src/daemon/daemon.ts` (handler wiring, per-slot shared HTTP cache)

**Interfaces:**
- `refreshHandler(job, ctx)`: registry state not `active` → `skipped` `{ reason: '<state>' }`; build `FetchDeps` from
  `ctx.envVars` with `dayBlocks: (c) => dbDayBlocks(ctx.db, c)` and `sharedHttpCache` = the worker's map for this
  `job.slot`; `tickAsset(db, loadAsset(configRoot, id), { onFetch, onProgress })`; from `onFetch` keep
  `fetchLines = fetchSummary(fetch)`, `alertFlags` (lines with `OUTSIDE`, `conflict`, `unlisted sender`), upsert the
  fetch's written level rows into `latest_levels` and update `watch_state` for level watches (no posts; the report shows them).
  Exit 0 or 2 → `done`; exit 1 → `failed`, `retryAfterMs 600_000`; `run_in_progress` → `failed`, `retryAfterMs 1_800_000`.
  `result = { report: TickReport, fetchLines, alertFlags }`; `recordRun` on the registry. On the last failed attempt post
  `ORION ALERT <env> refresh <SYM> failed twice: <code>: <message>` at once.
- `nightlyReportHandler(job, ctx)`: if any `refresh` of `job.slot` is not terminal and now < slot + 3 h → `deferred`
  5 min. Build `NightlyInput { env; day: reportDay(slot); releaseTag; results: AssetRunResult[] (by asset id); notRun: RegistryRow[] (paused, inactive, missing); configChanged: string[] (assets whose registry `config_hash` changed since the previous delivered nightly); resumedShort: { assetId; pausedDays; backfillDays }[]; firingWatches: WatchStateRow[]; refreshesMissing: string[] (active assets with no terminal refresh at the 3 h cut) }`.
  `formatNightly(input): string[]` (in `src/notify/format.ts`, added here): first post's first line
  `ORION ALERT <env> nightly <day>: <n> alert(s)` when any block alerts or `refreshesMissing` is non-empty, else
  `ORION NIGHTLY <env> <day>: <n> assets ok`; then `release <tag>`; `PAUSED <SYM> since <date> by <by>: <reason>`
  (and `INACTIVE` / `MISSING` the same way); `CONFIG CHANGED <SYM>`; `RESUMED <SYM> after <n> days; API series refill
  only <b> days back`; `WATCH FIRING <SYM>: <metric> <rule> <last_value> since <date>`; then one block per asset
  (`formatAssetBlock`); last line `reply to Raymond: confirm <id> | reject <id> | approve <id> [note] | decline <id> <note> | ack <id> <note> | resolve <id> <note>`;
  split with `splitForSlack`. Post each; if all delivered → ping `ORION_DEADMAN_NIGHTLY_URL`; else keep
  `{ posts, delivered: false }` in the result and do not ping. Either way insert a `full` snapshot
  (`fullBody`, day = report day) and enqueue `snapshot_push`; outcome `done`.
- `daemon status --json` adds `soak: { tag, nightly_slot, status, failed_sources: string[] } | null` (newest
  scheduler-made `nightly_report` that is `done` with `release_tag` = the running tag; `failed_sources` =
  `<asset>:<sourceId>` from that slot's refresh results) and `last_nightly` (the same, any tag).

- [ ] **Step 1: Write the failing tests** (fetch harness fakes from `tests/helpers/fetchHarness.ts`, fake notifier):
  - `refresh: a paused asset is skipped`; `refresh: exit 2 is done with report_error kept`; `refresh: exit 1 asks for a retry in 10 minutes`;
    `refresh: the second failure posts ORION ALERT at once`; `refresh: level rows written by the nightly refresh land in latest_levels too`.
  - `nightly_report: waits while a refresh is running, then posts after it ends`.
  - `nightly_report: posts after 3 h even if a refresh is stuck, listing it as missing, as an ALERT`.
  - `nightly_report: lists PAUSED with since, by and reason` (exact line `PAUSED AERO since 2026-11-03 by mike via raymond: AERO+VELO merger rebuild`).
  - `nightly_report: undeliverable report is kept and the dead-man is not pinged` (fake fetch 500 on webhook; result `delivered false`, posts present, nightly dead-man fetch count 0, a `snapshot_push` job enqueued) (Review Focus 3).
  - `nightly_report: labelled with the UTC day before the 00:45 slot`.
  - `status: soak names the tag's first scheduled nightly and its failed sources; run-now nightlies do not count`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(daemon): refresh job (tick per asset, retries, double-failure alert) and nightly_report (waits for the slot, Slack report with paused/config/watch lines, dead-man on delivery, full snapshot)`.

### Task 11: Disclosure watcher moves into the repo as the `disclosure_watch` job (D11)

**Files:**
- Create (copied from `~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/`, then edited in the repo copy
  only): `tools/disclosure-watcher/bin/disclosure_watch.py`, `tools/disclosure-watcher/bin/check_acceptance.py`,
  `tools/disclosure-watcher/watch.yaml`, `tools/disclosure-watcher/tests/**` (with `tests/fixtures/`),
  `tools/disclosure-watcher/requirements.txt` (pinned: `PyYAML`, `faster-whisper`, `numpy`, `yt-dlp`, versions read from
  the live Hermes tools Python with `pip freeze`), `tools/disclosure-watcher/README.md` (points to `docs/ops/disclosure-watcher.md`)
- Create: `src/daemon/jobs/disclosureWatch.ts`; `tests/daemon/disclosureWatch.test.ts`, `tests/tools/disclosureWatcher.test.ts`
- Not copied: `state/`, `log/`, `transcripts/`, `acceptance/`, `brief.md`, `__pycache__/` (state moves at cutover).

**Interfaces:**
- Watcher changes (repo copy): `BASE_DIR` default = `$ORION_DW_BASE_DIR` else the script's parent dir;
  `DEFAULT_QUEUE` = `$ORION_DW_QUEUE` else `<base_dir>/dev-queue.md`; `DEFAULT_CACHE` = `$ORION_DW_CACHE` else
  `<base_dir>/cache`; `LIVE_ORION_REPO` removed: `ORION_DW_REPO` is required for real runs (error text
  `set ORION_DW_REPO to the Orion release root`); the node binary is `$ORION_NODE` else `node`; `agent run` no longer
  passes `--out` (Phase 1 open item); `scan` gains `--dry-run` and `--queue-file` (same rules as `ingest`: a dry run
  needs an explicit queue file and leaves state unwritten).
- `disclosureWatchHandler(job, ctx)`: runs `<venv>/bin/python <configRoot>/tools/disclosure-watcher/bin/disclosure_watch.py scan --orion-home <home>`
  (`venv` = `$ORION_WATCHER_VENV`, default `~/watcher-venv`; stage adds `--dry-run --queue-file <home>/disclosure/dev-queue.dry.md`)
  with env `ORION_DW_BASE_DIR=<home>/disclosure`, `ORION_DW_REPO=<configRoot>`, `ORION_NODE=process.execPath`, plus
  `ctx.envVars` (the watcher's Orion calls need `ORION_DATABASE_URL` and `ANTHROPIC_API_KEY`); timeout 2 h. Each
  non-empty stdout → one Slack post (lines starting `ORION DISCLOSURE ALERT` make the post's first line that line);
  exit ≠ 0 → `failed` and `ORION ALERT <env> disclosure_watch exit <code>: <last stderr line, 300 chars>`.
  Before the scan, when `<venv>/.ytdlp-upgraded` is older than 7 days: `<venv>/bin/pip install --upgrade yt-dlp`
  (failure → a warning line in the result, scan still runs), then touch the stamp.

- [ ] **Step 1: Write the failing tests:**
  - `tests/tools/disclosureWatcher.test.ts`: `watcher unit tests pass in the repo copy` (runs
    `$ORION_WATCHER_PYTHON -m unittest discover -s tests` in `tools/disclosure-watcher`; fails loudly when
    `ORION_WATCHER_PYTHON` is unset and `python3 -c "import yaml"` fails). Expected count = Phase 1 Task 0 Step 6's count
    plus the new cases below.
  - New Python cases in `tools/disclosure-watcher/tests/test_platform.py`: `test_paths_from_env`,
    `test_repo_required_for_real_runs`, `test_agent_run_has_no_out`, `test_scan_dry_run_needs_queue_file`,
    `test_scan_dry_run_writes_no_state`.
  - `disclosureWatch: stdout is posted, stage passes --dry-run with the dry queue file, a non-zero exit alerts` (fake
    python: a shell script on a temp venv path echoing its argv and env names, never values).
  - `disclosureWatch: yt-dlp is upgraded at most weekly`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Copy (`cp -r` of the listed files only), then edit the repo copy; implement the handler. `diff -r`
  of `bin/` against the live dir shows only the planned edits (paste the diff stat in the task report).
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(disclosure): the watcher moves into tools/disclosure-watcher (paths from env, no --out, scan --dry-run) and runs as the daemon's disclosure_watch job; stage dry-runs; yt-dlp upgraded weekly`.

### Task 12: `staging_refresh` job (spec §8.5)

**Files:**
- Create: `src/daemon/jobs/stagingRefresh.ts`; `tests/daemon/stagingRefresh.test.ts`

**Interfaces:**
- `ENV_LOCAL_TABLES = ['jobs', 'asset_registry', 'asset_state_events', 'latest_levels', 'watch_state', 'snapshots_out', 'daemon_heartbeat', 'day_blocks']`.
- `stagingRefreshHandler(job, ctx)`: refuses unless `ctx.env === 'stage'` (`skipped`, reason `not stage`);
  dump = `$ORION_REFRESH_DUMP` (default `/srv/orion-refresh/latest.dump`), missing or older than 36 h → `failed`;
  reads the dump's `schema_migrations` max id (`pg_restore -f - -t schema_migrations --data-only` parsed) and refuses
  when it differs from the staging database's (`failed`, `schema mismatch: prod <a>, staging <b>; refresh after both run the same schema`);
  else `pg_restore -l` → drop every TOC line naming an `ENV_LOCAL_TABLES` table → `pg_restore --clean --if-exists
  --no-owner --role=orion_stage -L <filtered list> -d <ORION_DATABASE_URL>`; then `reconcileFromDisk`, `migrationStatus`
  (must have no pending), post `ORION STAGING REFRESH done: restored <dump mtime>, <n> tables` (or `ORION ALERT ...` on
  failure). Runs as one job at priority 5, so the single worker runs nothing else meanwhile. The commands run through
  an injected `run(args)` so tests use fakes.

- [ ] **Step 1: Write the failing tests:**
  - `stagingRefresh: skipped outside stage`; `stagingRefresh: a stale or missing dump fails and alerts`.
  - `stagingRefresh: schema mismatch is refused before any restore command`.
  - `stagingRefresh: the restore list excludes every env-local table` (fake `pg_restore -l` output with all tables; the `-L` file passed contains none of `ENV_LOCAL_TABLES`).
  - `stagingRefresh: staging's registry rows survive` (rows present before = after; the fake restore touches nothing).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green.
- [ ] **Step 5:** Commit: `feat(daemon): staging_refresh restores prod's nightly dump into staging, keeping staging's own daemon tables; refuses a schema mismatch`.

### Task 13: Release build: `build.sh` and `pack.sh`

**Files:**
- Create: `scripts/release/build.sh`, `scripts/release/pack.sh`; `tests/release/pack.test.ts`

**Interfaces:**
- `scripts/release/pack.sh <srcdir> <tag> <commit> <outdir>`: requires `<srcdir>/dist/cli/index.js` and
  `<srcdir>/dist/db/pg/migrations/`; writes `<srcdir>/RELEASE` = `{"tag","commit","schema":<max NNNN in dist/db/pg/migrations>,"built_at":<UTC ISO>,"node":"<node -v>"}`;
  tars exactly the Global Constraints list with `--sort=name --owner=0 --group=0 --numeric-owner --mtime=@<commit time>`
  under a top dir `orion-<tag>/`, gzip `-n`; writes `orion-<tag>.tgz.sha256` (`sha256sum` format); refuses when any
  `.env*`, `*.db`, `src/` or `tests/` path would be included. Tag must match `^orion-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$`.
- `scripts/release/build.sh <tag> [--out <dir>]` (default `~/orion-releases`): refuses a dirty or missing tag, a tag
  not annotated, or `ORION_TEST_DATABASE_URL` unset; `git worktree add --detach $TMPDIR/orion-build-<tag> <tag>`;
  `npm ci`; `npm run build`; `npx vitest run --maxWorkers=2`; `npm run typecheck`; `pack.sh`; removes the worktree on
  every exit path (trap); prints the tarball path, sha256 and RELEASE.

- [ ] **Step 1: Write the failing tests** (`tests/release/pack.test.ts`, fixture tree in `$TMPDIR`):
  - `pack: the tarball holds exactly the release paths under orion-<tag>/ and a RELEASE with schema 2`.
  - `pack: two packs of the same tree are byte-identical` (same sha256).
  - `pack: a tree containing .env or src/ is refused`; `pack: a bad tag is refused`.
  - `build: refuses when ORION_TEST_DATABASE_URL is unset` (runs `build.sh` with it unset; exit ≠ 0 before any worktree is created).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement; `shellcheck -x scripts/release/*.sh` clean.
- [ ] **Step 4:** Suite and typecheck green; one real `build.sh` run on a throwaway local tag (`git tag -a orion-2026.11.02.99 -m test`, deleted after) produces a tarball; record its listing in the task report.
- [ ] **Step 5:** Commit: `feat(release): build.sh (worktree, npm ci, build, full suite + typecheck, pack) and reproducible pack.sh with RELEASE`.

### Task 14: Full `orion-remote` (forced-command entry point)

**Files:**
- Replace: `scripts/provision/files/orion-remote` (1.5a's bash stub → Python 3, stdlib only, `#!/usr/bin/python3 -I`)
- Create: `scripts/provision/test/test_orion_remote.py`; `tests/release/orionRemote.test.ts` (runs the Python tests)

**Interfaces:**
- Reads `SSH_ORIGINAL_COMMAND`, splits with `shlex.split(posix=True)` (quotes honoured, nothing expanded; a parse
  error or a NUL/newline outside quotes → refused), logs `<ISO> <user> <verb> <argc> <ok|refused|exit n>` to
  `~/remote.log` (never argument text). Env name from the Unix user (`orion-prod` → `prod`, `orion-stage` → `stage`;
  anything else exits 64). Runs Orion as `/opt/node-v26/bin/node ~/current/dist/cli/index.js <argv>` with a clean env
  (`HOME`, `PATH=/usr/bin:/bin`, `ORION_HOME=~/home`, `ORION_ENV=<env>`, `ORION_ENV_FILE=~/shared/.env`,
  `XDG_RUNTIME_DIR=/run/user/<uid>`) via `subprocess.run(list)` (never `shell=True`). Exit code = the child's.
- Verbs (anything else: `orion-remote: '<verb>' is not an allowed verb` exit 64):
  - `install <tag> <sha256>`: tarball on **stdin** (cap 300 MB) → `~/incoming/orion-<tag>.tgz`; verify sha256;
    unpack to `~/releases/<tag>` (refuse if it exists); `npm ci --omit=dev --ignore-scripts` with
    `/opt/node-v26/bin/npm`; run the new release's `asset validate --json`, `db status --json`, `asset registry diff --json`;
    print one JSON object `{ tag, release, validate, db, registry }`; prune releases beyond the newest 5, never `current`
    or its predecessor.
  - `switch <tag> [--breaking]`: `daemon drain --wait 30m` (current release); when `db status` lists a pending
    migration whose first line is `-- breaking` and `--breaking` is absent → `undrain`, refuse; with `--breaking`,
    `pg_dump -Fc` into `~/shared/predeploy/<tag>-<stamp>.dump` first; `db migrate` (new release; on failure `undrain`,
    exit 1, current unchanged); `ln -sfn releases/<tag> ~/current.tmp && mv -T ~/current.tmp ~/current`;
    `systemctl --user restart orion-daemon`; poll `daemon status --json` until `heartbeat.release_tag == <tag>` and
    `beat_at` newer than the restart (60 s; else exit 1 with the rollback hint); append
    `<ISO> switch <from> -> <to> migrations=<ids>` to `~/deploys.log`; print `{ from, to, migrations, registry, next }`.
  - `rollback`: target = `from` of the last `switch` line in `deploys.log`; drain, repoint, restart, heartbeat check,
    log `rollback <from> -> <to>`.
  - `status [--json]` → `daemon status [--json]`; `logs [n]` (tail of `~/home/daemon.log`, n ≤ 2000, default 200);
    `jobs [--since <iso>]` → `job list --json [--since]`.
  - Read-only: `report yield [<asset>] [--day <d>]`, `data anomalies [<asset>] [--all]`, `data sources <asset>`,
    `data show <asset> [<metric>]`, `proposals list [<asset>] [--all]`, `agent runs list [<asset>]`, `inbox <asset>`,
    `dev-queue [n]` (tail of `~/home/disclosure/dev-queue.md`); each always with `--json` except `dev-queue` and `logs`.
  - Decisions: `confirm <id>` → `data confirm <id> --json`; `reject <id>` → `data reject <id> --json`;
    `approve <id> [note]` → `proposals approve <id> [--note <note>] --json`; `decline <id> <note>` → `proposals reject <id> --note <note> --json`;
    `ack <id> <note>`, `resolve <id> <note>` → `data ack|resolve <id> --note <note> --json`. `<id>` must match `^[0-9]{1,12}$`;
    a verb that needs a note and has none is refused (`note required`); the note is exactly one argv element.
  - Registry: `asset pause <a> --reason <text> [--for <who>]`, `asset resume <a> [--for <who>]`, `asset activate <a> [--for <who>]`
    → `asset <verb> <a> [--reason <text>] --by '<who> via raymond'` (or `raymond`); `<a>` must match `^[a-z0-9-]{1,32}$`.
  - `job run-now <kind> [asset]` → `job run-now <kind> [asset] --by raymond --json` (kind from `JOB_KINDS`).
  - `sql-ro <query>`: prod only (stage → refused, `sql-ro is prod-only: staging has no read-only role`); `psql -X
    --no-psqlrc -v ON_ERROR_STOP=1 -U orion_prod_ro -d orion_prod -c <query>`; output capped at 1 MB.
  - `refresh-staging`: stage only → `job run-now staging_refresh --by raymond --json`.
- [ ] **Step 1: Write the failing tests** (`unittest`, fake `node`/`npm`/`psql`/`systemctl`/`pg_dump` scripts on a temp
  `PATH` that record argv to a file; temp `HOME`; `ORION_REMOTE_TEST_NODE` etc. overrides only honoured when
  `ORION_REMOTE_TEST=1` and the uid is not 0):
  - `test_injection_attempts_are_literal_or_refused`: `ack 7 '$(id)'` → the fake node received exactly
    `['data','ack','7','--note','$(id)','--json']`; `status; rm -rf ~` → refused (`status;` is not a verb); an unclosed
    quote → refused; `approve 7 "two\nlines"` inside quotes → one argv element; `install x` → refused (no sha);
    `sql-ro 'select 1'` as `orion-stage` → refused; `bogus` → exit 64; remote.log has no argument text (Review Focus 5).
  - `test_install_verifies_sha_and_caps_size`; `test_install_refuses_existing_release`.
  - `test_switch_order`: recorded calls are drain → db status → db migrate → symlink swap → systemctl restart → status
    polls, and `deploys.log` gets one line.
  - `test_switch_migrate_failure_undrains_and_keeps_current`; `test_switch_refuses_breaking_without_flag`;
    `test_switch_breaking_dumps_first`.
  - `test_rollback_targets_previous_release`.
  - `test_registry_verbs_compose_by`: `asset pause aero --reason 'merger' --for mike` → `--by 'mike via raymond'`.
- [ ] **Step 2:** Run: FAIL (the stub supports `status` only).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite and typecheck green; `python3 -m py_compile` clean.
- [ ] **Step 5:** Commit: `feat(remote): full orion-remote (install from stdin with sha check, switch with drain/migrate/atomic repoint/restart/heartbeat, rollback, status, logs, read-only commands, six decision verbs, registry verbs, run-now, sql-ro prod-only, refresh-staging); argv only`.

### Task 15: `deploy.sh`, the user unit, and `orion-host.sh` changes

**Files:**
- Create: `scripts/release/deploy.sh`, `scripts/provision/files/orion-daemon.service`,
  `scripts/provision/files/watcher-requirements.txt` (identical copy of `tools/disclosure-watcher/requirements.txt`);
  `tests/release/deploy.test.ts`, `tests/release/provisionFiles.test.ts`
- Modify: `scripts/provision/orion-host.sh`, `scripts/provision/test/run.sh`, `scripts/provision/README.md`

**Interfaces:**
- `scripts/release/deploy.sh <stage|prod> <tag> [--no-soak] [--breaking]` and `deploy.sh <stage|prod> --rollback`
  (dev host; SSH host aliases `orion-stage` / `orion-prod` with `IdentityFile ~/.ssh/orion-<env>_ed25519`,
  `IdentitiesOnly yes`; `ssh` overridable by `ORION_DEPLOY_SSH` for tests):
  1. `git fetch origin --tags`; refuse unless `git ls-remote --tags origin refs/tags/<tag>` exists, the tarball's
     `RELEASE.commit` equals the tag's commit, and `git merge-base --is-ancestor <commit> origin/main`.
  2. prod only, unless `--no-soak`: `ssh orion-stage status --json` must show `release.tag == <tag>` and a non-null
     `soak` for it; and every entry of `soak.failed_sources` must also be in prod's `last_nightly.failed_sources`
     (`ssh orion-prod status --json`); else refuse naming the sources. `--no-soak` prints `SOAK SKIPPED (--no-soak)` in the report.
  3. `ssh orion-<env> install <tag> <sha256> < orion-<tag>.tgz`; print its JSON.
  4. `ssh orion-<env> switch <tag> [--breaking]`; print its JSON.
  5. Print the before/after tag, migrations applied, registry changes, next scheduled job, and the soak line.
  `--rollback` → `ssh orion-<env> rollback`.
- `orion-daemon.service` (template, `@ORION_ENV@` substituted): the Global Constraints values plus
  `Environment=ORION_ENV=@ORION_ENV@`, `Environment=ORION_ENV_FILE=%h/shared/.env`,
  `Environment=ORION_SIGN_KEY_FILE=%h/shared/snapshot-sign.key`, `Environment=ORION_PUBLISH_SSH_KEY=%h/shared/publish_ed25519`,
  `Environment=ORION_PUBLISH_DIR=%h/home/publish`, `Environment=ORION_WATCHER_VENV=%h/watcher-venv`, `[Install] WantedBy=default.target`.
- `orion-host.sh` additions (idempotent, `--dry-run` aware, through 1.5a's `lib.sh` helpers): install
  `files/orion-remote` to `/usr/local/bin/orion-remote` root:root 755 (replacing the stub); per Orion user:
  `~/.config/systemd/user/orion-daemon.service` from the template (`systemctl --user daemon-reload` as that user; **not**
  enabled or started), `~/incoming/` 700, `~/home/disclosure/` 700, `~/shared/predeploy/` 700, `~/watcher-venv`
  (`python3 -m venv`, then `pip install -r files/watcher-requirements.txt`), `~/.ssh/known_hosts` with github.com's
  published host keys (pinned in the script, checked against `ssh-keyscan` output only as a warning); group
  `orion-refresh` with both users and `/srv/orion-refresh` root:orion-refresh 750 (the dump timer writes
  `latest.dump` postgres:orion-refresh 640; added to the 1.5a dump unit if not already there). Self-check lines:
  `orion-remote` is the full version (`SSH_ORIGINAL_COMMAND=bogus` → exit 64 with the new text), each unit file
  passes `systemd-analyze --user verify`, each venv imports `yaml, faster_whisper` and runs `yt-dlp --version`.

- [ ] **Step 1: Write the failing tests:**
  - `deploy: refuses a tag that is not on origin` and `deploy: refuses a tarball whose commit differs from the tag` (temp
    repo with a `file://` bare origin; fake ssh records argv and stdin byte count).
  - `deploy: prod refuses without a staging soak on the same tag, names the extra failed source, and --no-soak overrides with the SOAK SKIPPED line`.
  - `deploy: the tarball goes to install on stdin and switch follows only after install exits 0`.
  - `deploy: --rollback calls rollback only`.
  - `provisionFiles: the unit file has the spec values` (each Global Constraints line present verbatim; `@ORION_ENV@` placeholder present).
  - `provisionFiles: watcher-requirements.txt equals tools/disclosure-watcher/requirements.txt`.
  - In `scripts/provision/test/run.sh`: dry-run of `orion-host.sh` lists the unit install, venv, orion-remote
    replacement, known_hosts, orion-refresh group; a second dry run on an already-provisioned fake state prints only `ok:` lines.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement; `shellcheck -x` clean.
- [ ] **Step 4:** Suite and typecheck green; `scripts/provision/test/run.sh` green.
- [ ] **Step 5:** Commit: `feat(deploy): deploy.sh (tag/commit checks, staging soak gate with --no-soak, install over stdin, switch, rollback); orion-daemon user unit; orion-host.sh installs full orion-remote, unit, watcher venv, known_hosts, orion-refresh`.

### Task 16: Docs, dev soak proof, followups

**Files:**
- Create: `docs/ops/daemon.md` (jobs, kinds, slots in UTC and PT, registry verbs, drain/undrain, logs, what each Slack
  line means, diagnostics through `orion-remote`), `docs/ops/deploy.md` (build, deploy, rollback, breaking migrations,
  the soak rule, SSH config for the two hosts), `docs/superpowers/notes/2026-10-29-orion-phase1.5c-followups.md`
- Modify: `docs/ops/disclosure-watcher.md` (in-repo location, env paths, daemon job, staging dry run, dev queue on the
  server + `orion-remote dev-queue`), `docs/ops/hermes-daily-job.md` (header: superseded by the daemon at cutover; kept
  for the fallback week), `README.md` (daemon, release layout, env variables `ORION_ENV`, `ORION_CONFIG_ROOT`,
  `ORION_ENV_FILE`, `ORION_PUBLISH`, `ORION_DEADMAN_URL`, `ORION_DEADMAN_NIGHTLY_URL`, `COINGECKO_PLAN`)

- [ ] **Step 1: Dev soak (spec §12 step 4, part).** In a scratch home with a fresh dev schema (`orion_dev` or a scratch
  schema of it, never live data), `.env` copy without `ORION_HOME=`, `SLACK_WEBHOOK_URL` = a test webhook Mike names
  (or unset: log-only), `ORION_PUBLISH=git:file://$TMPDIR/soak-data.git#main`, `ORION_ENV=dev`,
  `orion asset registry seed --reason "dev soak" --by raymond`, run `orion daemon` under `systemd-run --user --unit
  orion-soak` with the unit's environment for 48 h. Expected: 2 nightly reports, ~48 levels jobs, no job `failed`
  except real source failures, `snapshots_out` all pushed, the bare repo's manifest signature verifies with the public
  key, `day_blocks` hit on the second asset of each chain (count `getBlock` calls in `daemon.log` progress lines), and
  one kill -9 mid-refresh shows the RESTARTED line and a single re-run. Record figures in the followups note.
- [ ] **Step 2:** Write the docs and the followups note: proof results, the spec gaps and rulings of this plan, open
  items (S3 driver, yearly repo roll at 500 MB, `pgbackrest info` in status, Hermes optional second-opinion check).
- [ ] **Step 3:** Full suite and typecheck on the final commit; report both counts.
- [ ] **Step 4:** Delete scratch homes holding `.env` copies (`shutil.rmtree`); `systemctl --user stop orion-soak`.
- [ ] **Step 5:** Commit: `docs: daemon and deploy runbooks, watcher on the daemon, README env variables; Phase 1.5c followups (dev soak results)`. Stop; merge is Mike's go.

---

## Rollout checklist (controller-run, interactive, each step on Mike's go; not executed by this plan)

Spec §12 steps 5-7 and §8.4. Live-install rules apply; nothing here runs before 1.5a, 1.5b and 1.5c are merged.

1. Mike: create `masha256/orion-data` and `masha256/orion-data-staging` (N11, N12), add each server user's
   `~/shared/publish_ed25519.pub` as a write deploy key on its own repo only; create the two dead-man checks per env
   (1 h grace 30 min for levels, 6 h for staging levels; 24 h grace 2 h for nightly) and the #orion-staging and
   #orion-ops webhooks; fill both `~/shared/.env` files (`ORION_DATABASE_URL`, RPC keys, `COINGECKO_API_KEY` +
   `COINGECKO_PLAN=pro` on prod, `SLACK_WEBHOOK_URL`, `ORION_PUBLISH`, `ORION_DEADMAN_URL`, `ORION_DEADMAN_NIGHTLY_URL`;
   `ANTHROPIC_API_KEY` prod only).
2. Raymond, on Mike's go: create `~/.ssh/orion-stage_ed25519` and `~/.ssh/orion-prod_ed25519`; Mike re-runs
   `orion-host.sh` with `--deploy-key-stage/--deploy-key-prod` (installs full `orion-remote`, units, venvs); paste back
   the self-check.
3. Tag and build the first release (`build.sh`); then, in this order (final review I-1): **deploy -> data restore ->
   `asset activate` per asset**. `deploy.sh stage <tag>`: `switch` starts the daemon (the unit is enabled at
   provisioning), whose start-up reconciles 13 `inactive` registry rows, and its first scheduler tick runs each entry's
   newest past slot at once (a nightly with 0 assets, levels, retention, a dry disclosure scan). Data: import a fresh
   `.backup` of live SQLite on uranus into a dev schema, prove it, `pg_dump -Fc -n orion`, and send it with
   `ssh orion-stage refresh-staging --stdin <sha256> < dump` (I-2: no importer ships to the server; the restore
   overwrites any document the first dry scan added). Then `asset activate <a> --for mike` for each of the 13 (`asset
   registry seed` is only for an empty registry, i.e. never after a daemon start: it is refused once rows exist). No
   `systemctl` step: `switch` already started the unit (M-13). Runbook: `docs/ops/deploy.md` "First staging deploy".
4. Parallel run ≥ 3 days (spec §8.3) with the daily observation diff by UTC day; first restore drill (§10.3).
5. `deploy.sh prod <tag>` (soak gate passes on the staging nightly).
6. Cutover (§8.4): pause the 13 `orion-<asset>` Hermes jobs and `orion-disclosure-watch`; check nothing is mid-run;
   `.backup` + `integrity_check`; the same order as staging (I-1): copy the watcher's `state/lit.json`, `transcripts/`
   and `log/` into `~orion-prod/home/disclosure/` and the dev queue to `~orion-prod/home/disclosure/dev-queue.md`
   **before** the deploy (its first tick runs the newest past disclosure slot for real); `deploy.sh prod <tag>`; the data
   into `orion_prod` (the prod import route is still open: followups note, "Open before prod"); rerun the §8.2 proofs
   against prod; `asset activate` per asset (not `registry seed`: the daemon has already reconciled); check the first
   heartbeat, the first `levels` job, both dead-man checks green, the first snapshot commit in `orion-data`; watch the
   next 00:45 UTC nightly and its Slack post.
7. Then remove the Hermes jobs and their 13 wrapper scripts plus `orion-disclosure-watch.sh` (cron-job-administration
   skill), archive the final SQLite file read-only (`orion-final-<stamp>.db`, chmod 400, local + Spaces) with
   `signals.jsonl`, rewrite the `orion` skill for the server. Fallback for the first week: stop the prod daemon,
   re-enable the Hermes jobs on the archived copy.

## Spec gaps and rulings (made here; listed for review)

- **R1 `jobs` uniqueness:** Postgres treats NULLs as distinct, so the spec's `unique (kind, asset_id, slot)` would not
  dedupe `nightly_report`/`levels` (asset null). 0002 uses `UNIQUE NULLS NOT DISTINCT` (PG ≥ 15).
- **R2 forced command blocks `scp`:** with `restrict,command=` the spec's `scp` step cannot work; the tarball is
  streamed on stdin to `orion-remote install <tag> <sha256>`.
- **R3 release contents:** the spec's pack list lacks `personas/`, `skills/` (disclosure runs need them) and
  `tools/disclosure-watcher/` (D11); added. Migration SQL ships inside `dist/` (1.5b).
- **R4 config vs data home:** the code reads assets/personas/skills and `.env` under `ORION_HOME`; the spec puts them
  in `~/current` and `~/shared/.env`. Task 1 resolves the config root from the release's `RELEASE` file and the env file
  from `ORION_ENV_FILE`.
- **R5 two dead-man URLs:** one `ORION_DEADMAN_URL` cannot be both the 1 h and the 24 h check; adds
  `ORION_DEADMAN_NIGHTLY_URL`.
- **R6 CoinGecko Basic is the pro API** (`pro-api.coingecko.com`, `x-cg-pro-api-key`); the code knows only the demo
  header. Adds `COINGECKO_PLAN=pro`.
- **R7 staging refresh:** `pg_restore --clean` of the whole prod dump would overwrite staging's own `jobs` (including
  the running refresh job), registry, outbox and heartbeat, and a schema-version difference would break the staging
  release. Restore excludes the env-local tables via a filtered TOC and refuses a schema mismatch.
- **R8 daemon singleton:** a session advisory lock refuses a second daemon on the same database, which is what makes
  "every `running` job at start-up is abandoned" safe; scheduling stays idempotent regardless.
- **R9 drain mechanism** (unspecified): a `drain_requested_at` flag on the heartbeat row; `orion daemon undrain` exists
  so a failed `switch` can resume the old daemon.
- **R10 migration numbering:** the spec puts the daemon tables in `0001_baseline`; per the 1.5b/1.5c split they are `0002_daemon`.
- **R11 importer cannot seed the registry** (table is 1.5c's): `orion asset registry seed` at cutover.
- **R12 retention slot** not in the spec's `schedule.yaml`: `03:30` UTC.
- **R13 hourly `change_pct` baseline** unspecified: compared with the newest stored nightly row (today's rule), so an
  hourly firing means "moved since last night", and fire/clear is tracked per metric in `watch_state`.
- **R14 dev queue on the server:** today a file in Raymond's profile; on the server `~/home/disclosure/dev-queue.md`,
  read with a new read-only verb `orion-remote dev-queue [n]` (not in the spec's verb list). Staging writes
  `dev-queue.dry.md` (a dry run needs an explicit queue file).
- **R15 `sql-ro` on staging:** §9.3 creates no read-only role for staging; the verb is prod-only.
- **R16 `pgbackrest info` age in status** (§10.2): the Orion users cannot read `/etc/pgbackrest/pgbackrest.conf`
  (root:postgres 640); omitted, left as a followup.
- **R17 watcher venv at provisioning** happens before any release exists, so `orion-host.sh` carries its own copy of the
  requirements file, pinned equal to the repo's by a test.
- **R18 Slack size:** 100 assets' blocks exceed one message; posts are split at asset boundaries at 3,900 characters.
- **R19 `/srv/orion-refresh`** and the `orion-refresh` group (§8.5) are not in plan 1.5a; added to `orion-host.sh` in Task 15.
- **R20 finalized block:** §5.4's "scans read up to the `finalized` tag" is implemented in Task 7 (flow scans only).
- **R21 decision reply path:** with option A the report's reply line points at Raymond (no thread replies in #orion-ops); unchanged from §5.5.

## Self-review notes

- Spec coverage: §2.1 layout (Tasks 1, 15), §3.1 (13), §3.2 (14, 15), §3.3 migrations/rollback (2, 14), §3.4 verbs (14),
  §4 secrets (1, 6 re-read per job, 14 clean env), §5.1-5.2 (2, 6), §5.3 (3), §5.4 (5, 8, 10), §5.5 (14), §5.6 (4, 6, 8, 10),
  §5.7 N8/N9 (7, 8), §6 option A (4, 10), §8.5 (12), §9.1-9.2 (9), D6 (1), D11 (11), cutover (Rollout checklist).
  Not here by design: backups/PITR timers (1.5a), the Postgres conversion and importer (1.5b), the S3 driver (later).
- Names used across tasks: `OrionPaths`, `ReleaseInfo`, `OrionEnv`, `Job`, `NewJob`, `JobKind`, `JobOutcome`,
  `JobContext`, `JobHandler`, `Notifier`, `AssetRunResult`, `RegistryRow`, `RegistryDiff`, `LatestLevel`,
  `WatchStateRow`, `DayBlockCache`, `SnapshotEnvelope`, `OutboxRow`, `Publisher`, `ENV_LOCAL_TABLES`.
