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
