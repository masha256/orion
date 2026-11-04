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

- Mike has run `orion-host.sh` with sudo on venus from a commit at or after `2e45881` (the export at
  `/home/hermes/orion-provision-2e45881/provision`). Never the 32d2ec5 copy: its `orion-remote sql-ro` gives a shell
  (review C-1). That run installs the full `orion-remote`, the user unit, `known_hosts` with GitHub's host keys, the
  `orion-refresh` group and directory, and (with `--with-watcher`) the watcher venv.
- Each `~/shared/.env` is filled (Mike): `ORION_DATABASE_URL=postgresql://orion_<env>@/orion_<env>?host=/var/run/postgresql`
  (the role must be named), the RPC URLs, `COINGECKO_API_KEY` (and `COINGECKO_PLAN=pro` on prod once it has the Basic
  key), `SLACK_WEBHOOK_URL` (different per env), `ORION_PUBLISH` (`git:git@github.com:masha256/orion-data[-staging].git#main`
  or `off`), `ORION_DEADMAN_NIGHTLY_URL`, prod also `ORION_DEADMAN_URL` and `ANTHROPIC_API_KEY`. Staging never gets an
  Anthropic key.

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
```

If an orion-remote call died between drain and restart (ssh dropped), the next call of any verb recovers: it undrains,
restarts the daemon and prints `recovered ...`.
