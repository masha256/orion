# Phase 1.5c (daemon and deploy): rulings and follow-ups

Carried out of the subagent-driven execution of `docs/superpowers/plans/2026-10-29-orion-phase1.5c-daemon-deploy.md`
on branch `feat/daemon`. This file is the durable record of what was deferred, found or left open. The rulings that
changed the spec are in the spec's "Amendments made during execution" (`docs/superpowers/specs/2026-10-28-orion-platform-postgres-design.md`).
Runbooks: `docs/ops/daemon.md`, `docs/ops/deploy.md`, `docs/ops/disclosure-watcher.md`.

## Deferred from the Tasks 1-5 review (fix wave 1)

- **M-2 (jobs retention keys).** `deleteJobsBefore` (`src/db/jobs.ts`) deletes finished jobs by `slot`, while the
  retention handler (Task 6) deletes by `ended_at` (more than 90 days ago), which is what the plan text says.
  `enqueueJob`'s dedupe relies on the row existing, so a deleted old row lets the same (kind, asset, slot) be enqueued
  again. Safe today: the scheduler only ever creates the newest slot and `job run-now` uses `now` as its slot.
  Deferred because nothing calls `deleteJobsBefore` (retention uses `ended_at`) and it is pinned by Task 2's test;
  remove it, or re-key it on `ended_at`, when Task 9 touches retention (the snapshot prune).
- **M-4 (a stray `RELEASE` in a checkout).** A `RELEASE` file at a dev checkout's root flips it into release mode and D6
  then blocks config approvals there. Deferred: it is R-c3, owned by Task 13 (the release build must never write
  `RELEASE` into a checkout; the check for a checkout uses `existsSync('.git')`, since in a worktree `.git` is a file).
- **M-5 (renaming an asset YAML).** `loadAsset` ties the id to the file name, so a rename is a retirement plus a new
  asset: the old row goes `missing` with all its data, the new id arrives `inactive` with none, and nothing links them.
  Retention deletes `latest_levels` / `watch_state` of a `missing` asset, so a YAML missing for one release re-fires its
  watches when it returns. Deferred: acceptable by design; the ops doc (Task 15) must say "never rename an asset YAML".

## Deferred from the Tasks 6-15 review (fix wave 2)

- **M-4 (a restart uses up a refresh's attempt).** `abandonRunning` (`src/db/jobs.ts`) re-queues a job a dead daemon was
  running without giving its attempt back, so a refresh interrupted on its first attempt and failing normally afterwards
  is reported "failed twice" (and gets no retry) when it failed once. Options: give the attempt back in
  `abandonRunning` (`attempts = attempts - 1` for re-queued rows), or word the alert "attempt 2 of 2". Deferred: rare
  (a crash mid-refresh), loud rather than wrong.
- **M-6 (wrong-chain RPC poisons `day_blocks`).** `day_blocks` is first-write-wins forever and the transport never checks
  `eth_chainId` (`src/ingest/transport/viemRpc.ts`, `src/db/dayBlocks.ts`), so an RPC URL for the wrong network would
  store foreign day boundaries under the configured chain id that outlive fixing the URL. Mostly blocked today:
  `decimals()` on the token fails first (`src/ingest/flow.ts`). Fix later: check `eth_chainId` once per transport and
  refuse a mismatch before any read.
- **Fix wave 2 interpretations to confirm:** I-3's soak counts a refresh as finished when it is done, failed or skipped
  (a failed one shows as `<asset>:*` in the soak's failed sources, which the prod gate compares), not only `done`. M-1
  remembers the last start failure posted in `<ORION_HOME>/start-failure.json` (one post per distinct failure; cleared
  by a good start); a database that is down before `Daemon.start` (the pool open in `runDaemon`) still posts nothing.
  I-2's `PUBLISH PENDING` line counts as an alert in the nightly header; `PUBLISH OFF` does not. M-2's
  `job run-now nightly_report --slot <s>` is refused (`job_exists`) when that slot's report already exists.
- **M-1 (unit start limits, not ruled).** Start-up failures now post one ALERT per distinct failure, but the unit still
  has `Restart=always`, `RestartSec=30` and no `StartLimitIntervalSec` / `StartLimitBurst`, so a refused start loops
  every 30 s (quietly now). A database that is down before `Daemon.start` (the pool open in `runDaemon`) posts nothing;
  the dead-man checks catch it. Consider `StartLimitIntervalSec=1h`, `StartLimitBurst=10` in `orion-daemon.service`.
- **M-9 (remainder).** `deploy.sh` now requires and checks `<tarball>.sha256`, and `.installed` records the sha256, but
  the prod soak gate does not compare prod's tarball sha with the one staging soaked (only the tag). Add it to the gate
  (`status --json` would need to show the installed sha).

## Other minors and interpretations carried from the task reports

- `databaseConfig`'s `no_database_url` text and `src/cli/env.ts`'s comment still say `<ORION_HOME>/.env`; on a server
  the file is `ORION_ENV_FILE` (`~/shared/.env`). A test pins the text (Task 1).
- `deleteJobsBefore` (`src/db/jobs.ts`) is still unused and keys on `slot` (wave 1 M-2 above): remove it.
- A watch whose rule changes in the YAML starts afresh: a row firing under the old rule is overwritten without a
  `cleared` post (Task 8).
- The manifest's `generated_at` is the push time, so a retried push makes a new commit with the same content (Task 9).
- The watcher's `requirements.txt` pins only the four top-level packages; faster-whisper's transitive dependencies
  (ctranslate2, av, tokenizers, onnxruntime, huggingface-hub) are unpinned, and re-running `orion-host.sh
  --with-watcher` after a pin change resets the weekly-upgraded yt-dlp to its pin (Task 11).
- `scripts/provision/README.md` described `/home/orion-refresh` as `postgres:postgres` 750; corrected in Task 16 to
  `postgres:orion-refresh` 2750 (what `orion-host.sh` does).

## Task 12 (`staging_refresh`) as built

- Env-local tables (never restored from prod), with the reason each: `jobs` (staging's queue, including the running
  refresh), `asset_registry` and `asset_state_events` (states are per environment, spec §8.5), `latest_levels` and
  `watch_state` (staging's own readings and fire/clear state; prod's would make the next levels job post transitions
  staging never saw), `snapshots_out` (its seqs belong to `orion-data-staging`), `daemon_heartbeat` (the live staging
  daemon and its drain flag), `day_blocks` (a cache staging's own code computed), `schema_migrations` (the refresh only
  runs when the dump's migrations equal staging's by id and checksum, so prod's copy would add only prod's applied_at).
  Everything depending on them (sequences, indexes, constraints, comments) is dropped from the restore list too.
  `tests/daemon/stagingRefresh.test.ts` fails when a migration adds a table nobody classified.
- `--no-privileges`: prod's dump carries `GRANT SELECT ... TO orion_prod_ro`; restoring it would let prod's read-only
  role read staging. `--single-transaction`: a failed restore leaves staging as it was.
- No dump file is `skipped` (`no dump yet`), with one log line and no post: the prod dump timer is part of the deferred
  backups step, and a weekly ALERT until then would be noise. Once the timer runs, a dump older than 36 h alerts.
- The dump must hold staging's schema name (`orion` in both databases); a dump of another schema is refused.
- A password in `ORION_DATABASE_URL` (none on venus: peer auth) would go to `PGPASSWORD`, never on argv.
- Not tested on venus yet: the first real run needs the dump timer (backups step). `refresh-staging` then proves it.

## Found during execution

- **PUMP `supply_burn_daily` is unstable after the UTC close (source, not platform).** The controller's live check
  (Task 7, 13 assets, the 1.5b release against 67cf4da on the same imported live data) found every source and value
  equal except PUMP `flow_tokens` / `flow_usd.buyback` for the day ending 2026-11-04T00:00Z. Four runs seconds apart,
  alternating old and new release, gave 182,135,936 / 182,130,446 / 182,125,371 / 182,201,365 tokens: the old release
  alone moves run to run, about 7 h after the UTC close. So `solana.supply_burn_daily` (a supply-diff day value) is not
  stable for a closed day at that age. Open item for the PUMP source (not 1.5c): find when the day's value settles (or
  read the burns per transaction), and until then expect PUMP's closed-day buyback to differ between runs, e.g. between
  staging and prod in the parallel run.
- **`env.template` named no role.** `scripts/provision/files/env.template` showed
  `ORION_DATABASE_URL=postgresql:///orion_<env>?host=...`; libpq then connects as the Unix user's name (`orion-<env>`,
  with a dash), which is no role, and the peer map admits only `orion_<env>`. Fixed in Task 16: the example is
  `postgresql://orion_<env>@/orion_<env>?host=/var/run/postgresql` (provision harness test). Mike's filled `.env` files
  already name the role. The template also gains a commented `COINGECKO_PLAN`.
- **R-c7 (DefiLlama in `asset resume`).** `resumeAsset`'s `backfillDays` is the smallest primary `defillama`
  `backfill_days` of the asset (default 90), else null; adapter-paged API flows (LIT `params.days`, Solana) are not
  counted. When Phase 3 removes DefiLlama this always returns null: re-base it on the replacement sources' backfill
  depth then.

## Dev soak (Task 16 Step 1): replaced

R-c21: no 48 h dev soak was run. The staging soak replaces it: staging is the real host, real chains and real webhooks,
and `deploy.sh prod` refuses a tag that has not completed a scheduled staging nightly. What the dev soak was to show is
read from staging instead: two nightlies and their posts in #orion-staging, levels every 6 h, no `failed` job except real
source failures (`status`, `jobs`), `snapshots_out` all pushed and the `orion-data-staging` manifest signature valid,
`day_blocks` hits on the second asset of a chain (progress lines in `logs`), and one restart mid-refresh showing the
RESTARTED line and a single re-run.

## Open before prod

- **Backups (deferred step).** `orion-host.sh --enable-backups`: pgBackRest to the Spaces bucket `orion-backups`
  (weekly full Sun 09:00, daily diff 09:00 UTC) and `orion-pg-dump.timer` (08:30 UTC: age-encrypted dumps to
  `/home/orion-backups/dumps/<env>/` and Spaces, and prod's `/home/orion-refresh/latest.dump`). Needs Mike: the bucket and
  key, the age recipient in `/etc/orion/dump-recipient`, a first `pgbackrest check`. Then the first restore drill (§10.3)
  and the first real `staging_refresh`.
- **CoinGecko Basic.** Prod's `.env` moves from the free Demo key to the Basic key with `COINGECKO_PLAN=pro`
  (`pro-api.coingecko.com`, `x-cg-pro-api-key`); staging stays on Demo.
- **C-1 install.** Mike re-runs `orion-host.sh` from 2e45881 or later (never the 32d2ec5 copy) before the prod deploy key
  gets the full verb set.
- **Prod cutover checklist** (the plan's "Rollout checklist", steps 4-7, each on Mike's go): parallel run of at least 3
  days with the daily observation diff by UTC day (PUMP buyback excepted, above); `deploy.sh prod <tag>` after the soak;
  pause the 13 `orion-<asset>` jobs and `orion-disclosure-watch`, check nothing is mid-run; SQLite `.backup` +
  `integrity_check`; import into `orion_prod` and rerun the §8.2 proofs; `asset registry seed --reason "carried from
  SQLite install" --by import`; copy the watcher's `state/lit.json`, `transcripts/`, `log/` and the dev queue into
  `~orion-prod/home/disclosure/`; start the daemon; check the first heartbeat, the first `levels` job, both dead-man checks
  green, the first commit in `orion-data`, the next 00:45 UTC nightly and its post; then remove the Hermes jobs and
  wrappers, archive the final SQLite file read-only (`orion-final-<stamp>.db`, chmod 400, local + Spaces) with
  `signals.jsonl`, and rewrite the `orion` skill for the server. Fallback for the first week: stop the prod daemon and
  re-enable the Hermes jobs on the archived copy (`docs/ops/hermes-daily-job.md`).
- Later, not blocking prod: the S3-compatible publisher driver (when Mike picks a bucket); the yearly snapshot-repo roll
  once a repo passes 500 MB; `pgbackrest info` age in `status` (plan R16: the Orion users cannot read the pgBackRest
  config); an optional Hermes second-opinion check on the nightly; M-4 and M-6 above.
