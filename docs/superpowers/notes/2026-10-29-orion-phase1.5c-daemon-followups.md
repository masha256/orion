# Phase 1.5c (daemon and deploy): rulings and follow-ups

Carried out of the subagent-driven execution of `docs/superpowers/plans/2026-10-29-orion-phase1.5c-daemon-deploy.md`
on branch `feat/daemon`. This file is the durable record; Task 16 completes it.

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
