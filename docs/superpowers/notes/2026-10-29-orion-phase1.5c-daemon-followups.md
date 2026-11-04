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

## Minors from the final review (before the first staging deploy)

From `review-final-findings.md` at 2934c1f; I-1..I-4 were fixed in the final-review fix wave. One line each:

- **M-1 (proof is blind to bytes).** The proof reads both sides through JS, so invalid UTF-8 (U+FFFD) and `documents.sha256`/`bytes` vs `text` go unchecked; recompute `sha256(text)` and compare `length(CAST(text AS BLOB))` with `octet_length(text)`.
- **M-2 (dump leg unproven).** In the dump route the `pg_dump`/`pg_restore` leg after the proof is not covered by it; verify with byte-equal `report yield --day D` per asset (now step 2 of `docs/ops/deploy.md` "First staging deploy").
- **M-3 (single-statement scan bypassable).** `queryRo`/orion-remote track only `'` and `"`, so dollar quotes and comments can hide a `;` (writes still impossible: SELECT-only role, read-only default); send with the extended protocol and refuse `pg_advisory`/`pg_sleep`/`dblink`.
- **M-4 (all-skipped nightly soaks).** A nightly whose refreshes were all `skipped` still counts as a soak; require at least one `done`.
- **M-5 (whole-database dump restore never run).** Only a `pg_dump -n` dump has been restored for real; orion-pg-dump's whole-database dump (`public`, DEFAULT ACL, ACLs) is covered only by the fake TOC; confirm on the first real refresh or add a test case.
- **M-6 (hand-placed dump ages into a weekly ALERT).** Moot for the first deploy: `refresh-staging --stdin` replaces the hand-placed `latest.dump`, and the uploaded file is removed by the job and orion-remote; a dump Mike still places by hand must be removed after use.
- **M-7 (watcher gets every secret).** The watcher, pip, yt-dlp and ffmpeg inherit the whole `.env` (RPC keys, webhook, DB URL, prod's Anthropic key), including the weekly unpinned `pip install --upgrade yt-dlp`; allow-list what the watcher needs.
- **M-8 (2027-03-08 search collision).** From PDT, stage's 16:40 UTC scan and the Hermes watcher's 09:40 PT run share a minute and an IP (DuckDuckGo 202 = failure); only matters if the parallel run lasts past 2027-03-08.
- **M-9 (READY may race `systemd-notify`, unverified).** READY via a spawned `systemd-notify --pid` can be lost if systemd cannot map the exited sender; the first `switch` shows it (90 s timeout, unit loops); fix with `Type=simple` + heartbeat or a notify helper that stays alive.
- **M-10 (`changed` schema not refused on open).** `openDb` and daemon start refuse `behind` but not `changed` (an applied migration edited since); `switch` catches it via `db migrate`, a rollback or hand-run CLI does not; refuse `changed` on open too.
- **M-11 (run-lock connection gaps).** `tryAssetRunLock`'s own `pg.Client` has no connect timeout, and `tx_asset_mismatch` checks only the outer transaction's lock (no caller relies on that today).
- **M-12 (stage publish check).** On stage `checkPublishTarget` refuses only the prod repo; any other repo passes (GitHub's per-repo deploy keys stop the push: fail-loud, not a leak).
- **M-13 (docs: no `systemctl` step).** Fixed in the fix wave: the rollout step and the cutover text no longer tell Raymond to `systemctl --user enable --now` (`switch` starts the unit).

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
  days with the daily observation diff by UTC day (PUMP buyback excepted, above);
  pause the 13 `orion-<asset>` jobs and `orion-disclosure-watch`, check nothing is mid-run; SQLite `.backup` +
  `integrity_check`; then the order is **deploy -> data restore -> `asset activate` per asset** (final review I-1):
  copy the watcher's `state/lit.json`, `transcripts/`, `log/` and the dev queue into `~orion-prod/home/disclosure/`
  before the deploy; `deploy.sh prod <tag>` after the soak (`switch` starts the daemon: its start-up reconciles 13 `inactive` rows and
  its first scheduler tick runs each entry's newest past slot at once); the data into `orion_prod` and the §8.2 proofs;
  `asset activate <a>` for each asset. `asset registry seed` is only for an empty registry, i.e. never after a daemon
  start (it is refused once rows exist). Check the first heartbeat, the first `levels` job, both dead-man checks
  green, the first commit in `orion-data`, the next 00:45 UTC nightly and its post; then remove the Hermes jobs and
  wrappers, archive the final SQLite file read-only (`orion-final-<stamp>.db`, chmod 400, local + Spaces) with
  `signals.jsonl`, and rewrite the `orion` skill for the server. Fallback for the first week: stop the prod daemon and
  re-enable the Hermes jobs on the archived copy (`docs/ops/hermes-daily-job.md`).
- **The prod data route (final review I-2).** No importer ships to the server (`tools/import-sqlite` is not packed, its
  `better-sqlite3`/`tsx` are dev dependencies, venus has no toolchain), and `refresh-staging --stdin` is stage-only.
  Before prod, pick one: an `orion db import-sqlite` in the release (built `dist/`, `better-sqlite3` as an optional prod
  dependency or a prebuilt binary), or a prod verb that restores a dump proven on uranus (the same filtered,
  schema-checked, single-transaction restore), and write it into the cutover steps above.
- Later, not blocking prod: the S3-compatible publisher driver (when Mike picks a bucket); the yearly snapshot-repo roll
  once a repo passes 500 MB; `pgbackrest info` age in `status` (plan R16: the Orion users cannot read the pgBackRest
  config); an optional Hermes second-opinion check on the nightly; fix wave 2's M-4 and M-6 above.
