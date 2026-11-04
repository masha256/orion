# Building, deploying and rolling back a release (Phase 1.5c)

Everything here runs on uranus (the dev host) as `hermes`, from the Orion checkout (before cutover: the `feat/daemon`
worktree). venus is reached only through the two forced-command deploy keys; their only program is
`/usr/local/bin/orion-remote` (no shell, no scp). Spec §3 with its "Amendments made during execution"; the daemon itself:
`docs/ops/daemon.md`.

## SSH to the two environments

| env | key (uranus) | login | forced command |
|---|---|---|---|
| staging | `~/.ssh/orion-stage_ed25519` | `orion-stage@192.168.0.12` | `/usr/local/bin/orion-remote` (stage verbs) |
| prod | `~/.ssh/orion-prod_ed25519` | `orion-prod@192.168.0.12` | `/usr/local/bin/orion-remote` (prod verbs) |

`deploy.sh` passes the key explicitly (`ssh -i ~/.ssh/orion-<env>_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes
orion-<env>@192.168.0.12 <verb>`), so it needs no `~/.ssh/config`. For hand calls, optional aliases:

```
Host orion-stage
  HostName 192.168.0.12
  User orion-stage
  IdentityFile ~/.ssh/orion-stage_ed25519
  IdentitiesOnly yes
  BatchMode yes
Host orion-prod
  HostName 192.168.0.12
  User orion-prod
  IdentityFile ~/.ssh/orion-prod_ed25519
  IdentitiesOnly yes
  BatchMode yes
```

then `ssh orion-stage status`. venus's host key must be in `~/.ssh/known_hosts` (BatchMode never asks). Each call is
one verb with its arguments (`docs/ops/daemon.md` lists the read verbs); quotes group an argument, nothing is expanded.
uranus has no SSH key for GitHub: branches and tags go to GitHub over HTTPS with `GH_PAT`, and `deploy.sh` fetches the
same way (a one-shot credential helper reads only the `GH_PAT=` line of `~/.hermes/profiles/raymond/.env`; the token is
never on argv or printed).

## Prerequisites (once)

- Mike has run `orion-host.sh` with sudo on venus from a commit that has the final-review fix wave (`refresh-staging
  --stdin` and `git`) or later. The export at `/home/hermes/orion-provision-2e45881/provision` predates it: its
  orion-remote has no `--stdin` and it installs no git, so make a fresh export of `scripts/provision/` at that commit.
  Never the 32d2ec5 copy: its `orion-remote sql-ro` gives a shell (review C-1). That run installs the full
  `orion-remote`, the user unit, `known_hosts` with GitHub's host keys, the `orion-refresh` group and directory, `git`
  (the publisher pushes with it; the self-check prints `git --version`), and (with `--with-watcher`) the watcher venv.
- Each `~/shared/.env` is filled (Mike): `ORION_DATABASE_URL=postgresql://orion_<env>@/orion_<env>?host=/var/run/postgresql`
  (the role must be named), the RPC URLs, `COINGECKO_API_KEY` (and `COINGECKO_PLAN=pro` on prod once it has the Basic
  key), `SLACK_WEBHOOK_URL` (different per env), `ORION_PUBLISH` (`git:git@github.com:masha256/orion-data[-staging].git#main`
  or `off`; the daemon refuses to start without it), `ORION_DEADMAN_NIGHTLY_URL`, prod also `ORION_DEADMAN_URL` and
  `ANTHROPIC_API_KEY`. Staging never gets an Anthropic key (and Orion refuses every agent run on stage regardless:
  `agent_refused_stage`). No `ORION_HOME` line.

## 1. Tag and build

A release is an annotated tag `orion-YYYY.MM.DD.N` (date of the cut, N from 1), never moved; a fix is a new tag. Prod
releases are tagged on `main`; before cutover staging releases are tagged on `feat/daemon` (R-c1).

```
git tag -a orion-2026.11.05.1 -m "orion-2026.11.05.1" <commit>
git push <github https remote> orion-2026.11.05.1        # HTTPS + GH_PAT, like the branch push
ORION_TEST_DATABASE_URL='postgresql://orion_dev@/orion_test?host=/var/run/postgresql' \
  scripts/release/build.sh orion-2026.11.05.1
```

`build.sh` refuses a dirty checkout (tracked files), a malformed, missing or lightweight tag, and an unset
`ORION_TEST_DATABASE_URL`. In a detached worktree of the tag under `$TMPDIR` it runs `npm ci`, `npm run build`, the full
suite and typecheck (a red suite stops it; no skip flag), then packs `~/orion-releases/orion-2026.11.05.1.tgz` plus its
`.sha256` and prints the `RELEASE` record (tag, commit, schema, built_at = the commit time, so a re-pack is
byte-identical). The worktree is removed on every exit.

## 2. Deploy to staging

```
scripts/release/deploy.sh stage orion-2026.11.05.1 --branch feat/daemon     # before cutover (tag on feat/daemon)
scripts/release/deploy.sh stage orion-2026.11.05.1                          # after cutover (tag on main)
```

deploy.sh:

1. fetches GitHub, refuses unless the tag is on origin, the tarball's `RELEASE` names the tag and the tag's commit, the
   `.sha256` exists and matches, and the commit is on `origin/main` (stage: `origin/<branch>` with `--branch`);
2. (prod only) the soak gate, below;
3. `install <tag> <sha256>` with the tarball on stdin: unpack to `~/releases/<tag>`, `npm ci --omit=dev`, validate every
   asset, `db status` (pending migrations listed, none applied), `asset registry diff`, then the `.installed` marker
   last. A tag directory without the marker (a died install) is replaced;
4. only after a clean install, `switch <tag>`: drain (skipped, and the unit stopped, when the unit is not active or its
   heartbeat is stale), stop the old daemon, `db migrate`, repoint `~/current`, append to `~/deploys.log`
   (`switch <from> -> <to> migrations=<ids> breaking=0|1`), restart, wait 60 s for the heartbeat with the new tag;
5. prints the report: before/after tag, migrations applied, registry changes, the next slot and the next nightly.
   Paste it verbatim into the thread.

A failed switch undrains the old daemon (and starts it again if it was stopped); `~/current` is unchanged. Exit 0 only
when every step worked.

Then check: `ssh orion-stage status`, `ssh orion-stage logs 50`, and #orion-staging at the next slot. The first nightly
on the new tag (02:45 UTC on staging) is the soak.

## First staging deploy (empty `orion_stage`)

The order is **deploy -> data restore -> `asset activate` per asset -> watch the 02:45 UTC nightly** (final review I-1,
I-2). `asset registry seed` does not appear: it is only for an empty registry, and `switch` starts the daemon, whose
start-up already writes 13 `inactive` rows. There is no `systemctl` step either: `switch` starts the unit. Times UTC.
`ST` = `ssh -i ~/.ssh/orion-stage_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes orion-stage@192.168.0.12`, `WT` = the
worktree at the release's commit with `dist/` built, `CLI` = `node $WT/dist/cli/index.js`.

0. **Prerequisites (Mike, above).** `orion-host.sh` re-run from this fix wave or later (paste the SELF-CHECK: orion-remote
   755 root, the unit verifies and is enabled, linger, `known_hosts`, the `orion-refresh` group, `git --version`); the
   stage `.env` has `ORION_DATABASE_URL` (role named), `SLACK_WEBHOOK_URL` (#orion-staging), `ORION_DEADMAN_NIGHTLY_URL`,
   `ORION_PUBLISH`, and no `ANTHROPIC_*` or `ORION_HOME` line. Without `--with-watcher` expect a daily `disclosure_watch
   exit 1` ALERT. The branch and the tag are pushed (HTTPS + `GH_PAT`, in a shell of their own); `$ST status` prints the
   full form (`env: stage`, `current: none`, `postgres: accepting connections`, `daemon: no release installed`), else stop.
1. **Deploy.** `scripts/release/deploy.sh stage <tag> --branch feat/daemon`. Expect `install`: `db.state: behind`
   (pending 1, 2), registry `added` = the 13 ids; `switch`: `from: null`, `migrations: [1,2]`. The daemon now runs with 13
   `inactive` rows, and its first scheduler tick runs each entry's newest past slot at once: in #orion-staging an
   immediate nightly (13 INACTIVE lines), levels, retention, and (with the venv) a dry disclosure scan. If `switch`
   fails at the restart or the heartbeat wait: `$ST logs 50` for `ORION ALERT stage: daemon not started: <reason>`
   (usually the `.env`: Mike fixes it; the unit retries every 30 s); do not re-run deploy.sh (install and switch refuse
   a second time).
2. **Data: import and prove on uranus, dump, send (`refresh-staging --stdin`).** In a private dir (mode 700, it holds
   production data; removed at the end):
   ```
   P=/home/hermes/git/orion/.worktrees/stage-import-$(date -u +%Y%m%dT%H%M%SZ); mkdir -m 700 "$P"
   pgrep -af 'dist/cli/index.js|run-daily' | grep -v pgrep          # must be empty: no live tick mid-run
   sqlite3 /home/hermes/git/orion/orion.db ".backup '$P/snap.db'" && sqlite3 "$P/snap.db" 'PRAGMA integrity_check'
   psql -X -U orion_dev -d orion_dev -Atc "select count(*) from pg_namespace where nspname='orion'"   # must be 0
   mkdir -m 700 "$P/new" "$P/ref" && cp -r $WT/assets $WT/personas $WT/skills "$P/new/"
   printf 'ORION_DATABASE_URL=postgresql://orion_dev@/orion_dev?host=/var/run/postgresql\n' > "$P/new/.env"
   ORION_HOME="$P/new" $CLI db migrate --json                        # applied [1,2]: the release's own files
   U='postgresql://orion_dev@/orion_dev?host=/var/run/postgresql'
   cd $WT && ORION_HOME="$P/new" npx tsx tools/import-sqlite/cli.ts import --from "$P/snap.db" --to "$U" \
     --schema orion --assets $WT/assets --manifest-dir "$P"
   npx tsx tools/import-sqlite/cli.ts proof --from "$P/snap.db" --to "$U" --schema orion --assets $WT/assets \
     --manifest "$P"/import-*.json                                   # ok: true
   for a in aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do
     ORION_HOME="$P/new" $CLI report yield $a --day <D> --json > "$P/ref/$a.json"; done   # D = yesterday UTC; no --legacy (below)
   /usr/lib/postgresql/18/bin/pg_dump -Fc -n orion -f "$P/latest.dump" "$U"
   $ST refresh-staging --stdin "$(sha256sum "$P/latest.dump" | cut -d' ' -f1)" < "$P/latest.dump"
   ```
   The manifest exclusions must be only `observations undeclared_metric`, `agent_transcripts non_disclosure_transcript`
   and `proposals retired_kind`; anything else: stop. `refresh-staging --stdin` checks the sha256 and the `PGDMP` header,
   then the daemon's `staging_refresh` job restores the file (the same filtered list, schema-equality check and single
   transaction as the weekly refresh; it overwrites anything the first dry scan added) and both remove it; the call
   waits and prints the job, exit 0 only when it is `done`. #orion-staging: `ORION STAGING REFRESH done: restored the
   uploaded dump (<mtime>), 10 tables`. `schema mismatch` means the prep schema was not migrated by this release's
   files: redo the migrate. Then verify (the dump leg is outside the import proof, M-2):
   ```
   for a in <the 13 ids>; do $ST report yield $a --day <D> | cmp - "$P/ref/$a.json"; done     # all identical
   ```
   and compare `$ST data anomalies --all` / `$ST proposals list --all` with `$CLI ... --json` on `$P/new`.
   Both sides are the same release, so the bytes match either way, but they must print the same shape: from Phase 2 on
   (D9) `report yield --json` is the income statement v2 object and the v1 keys need `--legacy`, which `orion-remote`
   does not pass. So the reference runs without `--legacy` too. A byte comparison of the v1 keys across two releases
   (the cutover proof, `tools/import-sqlite/cli.ts reports`; the Phase 2 proof, `tools/phase2-proof/reports.sh`) runs
   the new side with `--legacy` when its `report yield --help` lists it, and compares it without `incomeStatement`.
3. **Activate.** `for a in aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do $ST asset activate $a --for
   mike; done`, then `$ST asset registry` (13 active). Optionally `$ST job run-now refresh <a>` per asset for data now;
   otherwise the first refreshes come with the nightly (an asset activated after a slot began gets none for that slot).
4. **Clean up on uranus.** `psql -X -U orion_dev -d orion_dev -c 'drop schema orion cascade'`, remove `$P`.
5. **Watch.** The 02:45 UTC nightly in #orion-staging (the first soak candidate; `$ST status --json` shows `soak` once a
   scheduler-made nightly with at least one refresh ran on the tag) and the healthchecks stage-nightly check green; the
   first commit in `orion-data-staging`; levels at 06:15/12:15/18:15; the 16:40 dry disclosure line, which must say `dry
   run on stage` (a run id means an agent ran: pause and stop); `$ST jobs` for any `failed` job other than real source
   failures.

## 3. The soak rule and prod

```
scripts/release/deploy.sh prod orion-2026.11.05.1
```

Prod deploys only from `origin/main` (`--branch` is refused) and only after the same tag has soaked on staging:
staging's `status --json` must show the tag as current and a soak on it, which is the newest scheduler-made `done`
nightly report on the tag whose slot had at least one refresh, every refresh finished (done, failed or skipped) on that
tag, and the report itself run on it. Every source that soak lists as failed (`<asset>:<source>`, or `<asset>:*` for a
refresh with no ingest) must also be failed in prod's last nightly; otherwise prod is refused, naming the sources. When
it passes the report says `SOAK OK: staging ran <tag> through the scheduled nightly of <slot>; failed sources: ...`.

`--no-soak` skips the gate for a hotfix and prints `SOAK SKIPPED (--no-soak)` in the report. Prod is not deployed before
cutover, and never without Mike's go.

### Prod's one-time initial load (cutover, I-2)

Prod's data arrives the way staging's first data did: imported and proven on uranus (step 2 of the first staging
deploy, the same commands with `P=.../prod-import-<stamp>`), dumped with `pg_dump -Fc -n orion`, then sent with
`load-prod` instead of `refresh-staging`:

```
PR='ssh -i ~/.ssh/orion-prod_ed25519 -o IdentitiesOnly=yes orion-prod@192.168.0.12'
$PR load-prod --stdin "$(sha256sum "$P/latest.dump" | cut -d' ' -f1)" < "$P/latest.dump"
```

`load-prod` is prod-only and checks the sha256 and the `PGDMP` header like `refresh-staging --stdin`. It writes
`~/home/incoming/prod-initial-load.dump` and runs the daemon's `staging_refresh` job, which on prod does only this:
restore that file (the same filtered list, schema-equality check and single transaction, as `orion_prod`), and only
while prod has no `observations` and no `fetch_runs` row. A prod that holds data refuses it before any restore
(`ORION ALERT prod initial_load: prod already holds data ...`), so the verb can never overwrite a live prod. The file is
removed afterwards. #orion-ops: `ORION PROD INITIAL LOAD done: restored the uploaded dump (<mtime>), 10 tables`. Then
the same verification as staging (`report yield` per asset `cmp` against `$P/ref`, anomalies, proposals), then
`asset activate` x13. The cutover order stays deploy -> load -> activate (final review I-1).

## 4. Breaking migrations

A migration whose first line is `-- breaking` (it drops or rewrites data) gets its own release with nothing else in it.
`switch` refuses it unless asked:

```
scripts/release/deploy.sh stage orion-2026.11.06.1 --breaking
```

With `--breaking`, `switch` first takes `pg_dump -Fc` into `~/shared/predeploy/<tag>-<UTC stamp>.dump`, and the
deploys.log line carries `breaking=1 dump=<file>`. Rollback across that switch is refused (the old code cannot run on the
migrated schema) and names the dump: going back means restoring it, by Mike. Migrations are otherwise expand-only and
append-only (R-c8: `0002_daemon.sql` was edited in place only before the first staging release).

## 5. Rollback

```
scripts/release/deploy.sh stage --rollback
scripts/release/deploy.sh prod --rollback
```

`rollback` goes back to the `from` of the last switch in `~/deploys.log`: drain, repoint, `rollback <cur> -> <target>`
in deploys.log, restart, wait for the heartbeat. No data changes; the schema stays where it is (an older release runs on
a newer expand-only schema). Refused when there is no switch to undo, the target is gone or has no `.installed`, or the
last switch was breaking. A crash-looping release can always be rolled back: a dead daemon is not waited for.

## 6. A refused retirement: `reconcile --allow-retire`

If a release would retire every asset or more than 2 at once (a release missing YAML files, usually a packing mistake),
the daemon refuses to start with `ORION ALERT <env>: daemon not started: release <tag> would retire ...`. Fix the release
and deploy again, or roll back. If the retirement is wanted:

```
ssh orion-stage reconcile --allow-retire          # prints the diff, changes nothing (exit 1)
ssh orion-stage reconcile --allow-retire --yes    # applies it; the daemon then starts on its next restart (30 s)
```

## Other verbs a deploy may need

```
ssh orion-<env> status [--json]       # release, heartbeat, registry, last jobs, next slots, soak, last nightly
ssh orion-<env> logs [n]              # daemon.log
ssh orion-<env> jobs [--since <iso>]
ssh orion-stage refresh-staging       # restore prod's latest dump into staging now (docs/ops/daemon.md)
ssh orion-stage refresh-staging --stdin <sha256> < x.dump   # restore an uploaded pg_dump -Fc dump; waits for the job
ssh orion-prod load-prod --stdin <sha256> < x.dump          # prod's one-time initial load (empty prod only); waits for the job
```

If an orion-remote call died between drain and restart (ssh dropped), the next call of any verb recovers: it undrains,
restarts the daemon and prints `recovered ...`.
