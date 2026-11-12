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
   (D9) `report yield --json` is the income statement v2 object. Releases before Task 11 printed the v1 keys only with
   `--legacy`, which `orion-remote` does not pass; since Task 11 there is no v1 and no `--legacy`. So the reference runs
   without it. The Phase 2 proof (`tools/phase2-proof/reports.sh`) runs both sides with identical flags and compares v2
   against v2 (README there).
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

## Phase 2 release (migrations 0003-0005)

The first release after the cutover that carries Phase 2 (`feat/data-strategy`, rebased onto `main`): migrations
`0003_checks.sql`, `0004_provenance.sql`, `0005_tokens_prices.sql` (all expand-only: new nullable columns, new tables, a
view; `value` is still written), the income statement v2 beside the v1 report, and three one-time backfills. Deploy it
only with Mike's go, never during the cutover soak. The steps below run in this order; each `orion ...` command is the
release's CLI run on venus as the env's Unix user (Mike: `sudo -iu orion-<env>`), because `orion-remote` has no verb
for them (Mike, pre-G2 decision 4: those verbs are Phase 3 work). Define this shell function first, in that login shell
(`<env>` = `stage` or `prod`). A function, not a quoted variable: `$HOME` must expand when the command runs, and a
variable's value is never re-expanded (`O='... $HOME/home ...'` passed the literal text `$HOME/home`):

```
o() { ORION_ENV=<env> ORION_HOME="$HOME/home" ORION_ENV_FILE="$HOME/shared/.env" /opt/node-v26/bin/node "$HOME/current/dist/cli/index.js" "$@"; }
type o                                         # prints the function; `o db status` must name current = 5
```

1. **Before the deploy: the soak script.** `~/.hermes/profiles/raymond/scripts/orion-stage-soak.py` (Raymond's, outside
   the repo) reads the v1 keys of `report yield`. From this release `report yield --json` prints the v2 object and the v1
   keys need `--legacy`, which `orion-remote report yield` does not pass. Change the script before the staging deploy
   (pass `--legacy` where it runs the CLI itself; read the v2 fields where it goes through `orion-remote`), or its parity
   check fails on the first run.
2. **Stage and prod migrate in the same release step.** `staging_refresh` refuses a dump whose migrations differ from
   staging's (`schema mismatch: prod ..., staging ...; refresh after both run the same schema`), so between the staging
   switch (stage at 0005) and the prod switch (prod at 0005) the weekly refresh (Sunday 10:30 UTC) refuses and alerts;
   nothing is restored. Deploy stage, let it soak one scheduled nightly, then deploy prod as soon as the soak passes
   (section 3), and plan the pair so no Sunday refresh falls between them where possible:
   ```
   scripts/release/deploy.sh stage <tag>        # switch runs db migrate: applied [3,4,5]
   ssh orion-stage status                       # current <tag>; then, on venus: o db status (current 5, pending none)
   ```
   Steps 3-5 run on staging right after its switch, before its first nightly (02:45 UTC), and again on prod right after
   prod's switch, before prod's first nightly (00:45 UTC).
3. **Provenance history** (Task 6; release 2 only: the command is gone since 0006): dry run first, then the real run.
   ```
   o db backfill-provenance --dry-run --json > ~/home/backfill-provenance-dry.json
   o db backfill-provenance --json
   ```
   The dry run's unmapped list must be empty. The 18 pre-v2 manual rows without a citation (ruling R17; on the
   2026-11-05 proof copy: AERO `flow_usd.fees` 2026-09-10, ids 11831 confirmed and 515 rejected, Mike's DefiLlama-artifact
   correction; VVV ids 1-16 from the 2026-09-18 research pass) are mapped by Mike's pre-G2 decision 2, on their content:
   the correction as `derived` (`manual_mean_of_neighbours@1`, inputs = the rows in force on the day before and after),
   the seeds as legacy disclosures (`disclosed`, locator `{note, legacy_seed: true}`, quoted_text = the note, no
   citation). Any unmapped row (e.g. `correction_without_neighbours`): stop and bring it to Mike. The real run writes at
   most 1,000 rows per transaction under each asset's lock and resumes on a re-run (`method IS NULL`); it never changes
   `value`.
4. **yCRV by-sender flows** (Task 7b, R20), right after the deploy and before the first nightly:
   ```
   o data fetch ycrv --metric flow_usd.yearn_gross_fees --metric flow_usd.yearn_gross_incentives --backfill-days 183
   ```
   It scans `flow_usd.yearn_gross`'s shared transfer scan but writes only the two listed series (R20): `yearn_gross`'s
   rows and the scan cursor are left as they are. 183 days so v2 revenue growth (91 days vs the prior 91) is measured
   from the first report (review M2). Without it the legacy report and the default day are unaffected (the default day
   is v1's, review M4), but yCRV's v2 revenue and apportioned lines stay null with `apportion mix n/a` until the window
   fills. Days more than 90 back are priced from CoinGecko daily points (correction 13).
5. **Token amounts** (Task 7, R18): one asset at a time, outside 05:00-06:30 PT and clear of the env's nightly slot.
   `exit 1` means a day was refused (its re-scanned tokens differ from a stored `flow_tokens.*` twin): stop there and
   report it, do not run the next asset.
   ```
   for a in cake crv cvxcrv hype link lit sdcrv sky uni vvv ycrv; do
     o data backfill-tokens $a --json > ~/home/backfill-tokens-$a.json || { echo "STOP: $a exit $?"; break; }
   done
   ```
   AERO and PUMP have no transfer scan or first-party dollar series to fill (`not_a_transfer_flow`). It never changes
   `value` or adds a row; a re-run resumes (rows that already have tokens are counted, not rewritten). Timing on the
   rehearsal: Base ~11 s a day for VVV's 3 members; one market_chart range per CoinGecko id per run.
6. **G2 comparison** (read-only), per asset, after step 5:
   ```
   for a in aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do o data compare-usd $a --days 91 --json > ~/home/compare-usd-$a.json; done
   ```
   The stored USD (`value`) vs the hourly token buckets x hourly prices (`flow_usd_v`), per metric; it feeds Mike's G2
   per-metric comparison.

**Rollback** (section 5) to the previous release is allowed: the schema stays at 0005 and that release runs on it
(expand-only; its writers insert named columns, so the new columns stay null). What it leaves behind, and what to run
after rolling forward again:
- Its `latest_levels` upsert does not write `source_type`/`locator`, so a level it updates keeps the newer release's
  provenance, now stale (the `levels` snapshot body shows it) until the newer release's next levels run rewrites it
  (Task 6 M6).
- Rows it writes have no provenance and no token columns: after rolling forward, run step 3 (dry run, then real) and
  step 5 again, the second pass for those rows.
- It does not know yCRV's two by-sender series, so its scans advance the shared cursor without them: after rolling
  forward, run step 4 again with `--backfill-days` covering the rollback days (183 is enough for any rollback shorter
  than that).
- It stores no check results, so the days it covered have none; the newer release evaluates only the report day.

## Phase 2 tail: release with 0006 (breaking)

`0006_provenance_not_null` (Task 10, gate G3) makes `observations.method`, `source_type`, `locator`, `code_version` and
`config_hash` NOT NULL (and `latest_levels.source_type` / `locator`), adds `observations_disclosure_citation` (a
`disclosure` row needs a `citation_url`, except pre-v2 history), and drops `observations.source`: the origin
(`onchain` / `api` / `manual`) every reader, the CLI and the analyst pack show is derived from the provenance
(`src/provenance/origin.ts`, `originOf`). Its first line is `-- breaking`, so it ships as its own release (section 4)
with nothing else in it. `db backfill-provenance` is gone with it (nothing can be null any more); `data set` lost
`--source` (a hand-entered row is a disclosure, origin `manual`; `--citation` stays required).

1. **Pre-deploy check, on each env right before its switch** (all three must be 0; any other count: stop, the
   migration would fail on the first null and nothing would change; remedies below):
   ```
   ssh orion-prod sql-ro "select (select count(*) from observations where method is null or source_type is null or locator is null or code_version is null or config_hash is null) as obs_null, (select count(*) from observations where source_type = 'disclosure' and citation_url is null and code_version <> 'pre-v2') as disclosure_uncited, (select count(*) from latest_levels where source_type is null or locator is null) as levels_null"
   ```
   Staging has no `sql-ro` verb: as the env user (`sudo -iu orion-stage`), `o db query-ro "<the same select>"`.
   Remedies, then run the check again:
   - `obs_null` or `disclosure_uncited` > 0: every writer since release 2 sets these, so a writer still omits one. Find
     it (the rows' `fetched_at` and `metric_key` name the run) and fix it in a release before this one.
   - `levels_null` > 0: no writer leaves these null (the hourly levels read writes both); it is a row that has not been
     rewritten since 0004. List them (prod: `sql-ro`; staging: `o db query-ro` as above): `select asset_id, metric_key,
     observed_at from latest_levels where source_type is null or locator is null`. Then, per row:
     - the asset is active and its YAML still declares the metric: `ssh orion-<env> job run-now levels` and wait for it
       to finish (`jobs`): it rewrites every level metric of every active asset;
     - the asset is paused (the hourly read skips it): `asset resume <a>`, `job run-now levels`, then
       `asset pause <a> --reason <text>` again if it should stay paused;
     - the asset is missing, or its YAML no longer declares the metric: `job run-now retention` deletes the row.
2. **Order: stage, one scheduled nightly soak, then prod**, both with `--breaking`:
   ```
   scripts/release/deploy.sh stage <tag> --breaking     # switch: pg_dump first, then db migrate --breaking: applied [6]
   ssh orion-stage status                               # current <tag>; heartbeat; deploys.log breaking=1 dump=<file>
   # after the soak passes (section 3):
   scripts/release/deploy.sh prod <tag> --breaking
   ```
   Without `--breaking` the switch refuses before changing anything (`<tag> has a breaking migration pending (6)`). As
   for the Phase 2 release, `staging_refresh` refuses a prod dump while the two envs differ (stage at 0006, prod at
   0005): keep the gap between the two switches short and clear of the Sunday refresh.
3. **No rollback past it.** A pre-0006 release inserts `source` and cannot run on the migrated schema, so `rollback`
   is refused after this switch (`breaking=1`) and names the dump; going back means Mike restoring that dump (and losing
   what was written since). Fix forward instead.
4. **After the switch** (read-only): `report yield <a> --json` for every asset matches the previous release's output on
   the same data (the controller's prod-copy proof, ruling R10.5), and `data show <a>` still lists each row's origin.

## Phase 2 tail: Task 11 release (v1 retired, gate G4)

Release note: **Task 11 retires v1: `report yield` prints v2 only (no `--legacy`, no v1 key, in JSON or text);
snapshot schema `orion.snapshot/2`; the outbox still accepts `/1` envelopes.** It ships one release after the 0006
breaking release, with no migration and no `--breaking`.
- Config: `holder_flows` and `reporting` are gone from the asset schema (Task 11a). A YAML or a config proposal still
  carrying either is refused by name (`invalid_asset_config`) at load, at filing and at approve; every asset's config
  hash moved (the parsed config changed), so the first signal per asset after the switch lists `config`.
- The tick report's `holder_yield` reads the statement only: `flows`, `yields`, `multiple` and
  `holder_flow_growth_annualized` are the statement's, `revenue_annualized` / `revenue_growth_annualized` /
  `payout_ratio` are gone (optional when reading a job row an older release wrote). The nightly Slack block reads the
  statement's figures.
- Snapshot `full` bodies: each asset's `report` is the v2 object without the v1 keys, under `schema:
  "orion.snapshot/2"`. A row the previous release queued (`orion.snapshot/1`) still verifies and publishes as written.
  The site / any reader of the snapshot repo must read the v2 fields before this release reaches prod.
- v1 snapshot fields with **no direct v2 equivalent** (everything else maps: `flows` -> `holderFlow.lines`,
  `holderFlowGrowth` -> `holderFlow.growth`, `supply` -> `dilution.supply`, `volume` -> `incomeStatement.volume`,
  `yields` incl. `pegTrailing` and `dilutionLines` -> `incomeStatement.yields`, `crossCheck` / `disclosedGrowth` -> the
  revenue line's, `outsideRevenue` -> `belowLine`, `income.checks` -> `checks`):
  - `buckets.{burn,hold,cash}.growth` (per-bucket holder-flow growth): `holderFlow.byBucket` has no growth. Nearest:
    re-sum the bucket's `holderFlow.lines[].growth.current` / `.prior` (each line carries its `bucket`).
  - `revenueDisclosed.latestAt` / `previousAt` (the disclosure dates): v2 carries only their distances, the revenue
    line's `disclosedGrowth.latestAgeDays` (latest disclosure to the report day) and `gapDays` (between the two).
  - `revenue.streams[].metric` (each stream's series name): `revenue.lines[]` carries no metric. Nearest: the line's
    `id`, `label`, `sourceTypes` and `provenance.sources`; holder lines do carry `metric`.
  - `income.protocolMargin`: not printed. Nearest: `protocol.annualized / revenue.annualized`, on v2's revenue (gross
    user-paid fees; v1 divided by its own protocol revenue, so the two differ where cost of revenue is measured).
  - `revenue.basis`: no single field. Nearest: each revenue line's `method` (measured / derived / disclosed) and
    `settlement`, and `provenance.methods`.
- The default report day per asset is unchanged (gated on the same flows as before; yCRV on the statement's flows,
  ruling R11.6, which the controller checks on a prod copy).
- Before the staging deploy: Raymond's soak script (`~/.hermes/profiles/raymond/scripts/orion-stage-soak.py`, outside
  the repo) must not pass `--legacy` anywhere (the CLI refuses an unknown option) and must read v2 fields only.

## Phase 3 R1 release

The release that carries Phase 3 R0b + R1 (`feat/phase3-third-party`): migration 0007 (expand-only: `jobs.params_json`, no
`--breaking`), the `backfill` job kind, `orion data purge`, and three new `orion-remote` verbs, so the one-time
backfills and purges of this and later Phase 3 releases run over the deploy keys, with no `sudo -iu orion-<env>`.
`ST`/`PR` = the stage/prod ssh commands above. In deploy order:

1. **Once, before the staging deploy: Mike re-runs `orion-host.sh`** (installs the new `/usr/local/bin/orion-remote`,
   which is a copy from the checkout it runs from, independent of any release). Raymond makes a fixed snapshot of
   `scripts/provision/` at the release sha, outside any worktree (never the moving worktree; non-destructive, so a
   re-run changes nothing):
   ```
   SHA=<release sha>; D=/home/hermes/orion-provision-$SHA
   test -e "$D" || (mkdir -p "$D" && git -C /home/hermes/git/orion archive "$SHA" scripts/provision | tar -x -C "$D")
   ```
   Mike copies `$D/scripts/provision` to venus and runs it with the same flags as before (scripts/provision/README.md
   §4; add `--enable-backups` / `--with-watcher` if they are already on, both idempotent):
   ```
   sudo ./orion-host.sh --hostname venus --pg-datadir /home/postgres/18/main \
        --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from 192.168.0.112 \
        --deploy-key-stage /tmp/deploy-stage.pub --deploy-key-prod /tmp/deploy-prod.pub
   ```
   Paste back the SELF-CHECK. Check: `$ST job run-now backfill x --metrics A --backfill-days 1` exits 64 with
   `orion-remote: bad metric in --metrics` (the new orion-remote; the old one says `unknown or misplaced option`), and
   nothing is queued. The new orion-remote works with the older release still current (its other verbs are
   unchanged), but the three new verbs reach Orion only on this release or later: on an older release they fail with
   Orion's own "unknown command" / unknown option or job kind error (nothing written).
2. **Then the per-env steps** (deploy, backfills, purges), below.

Verb reference (output is JSON; every list is comma-separated with no spaces, at most 20 metrics, each
`[a-z0-9_.]{1,64}`; days 1..400; a refusal exits 64 before Orion runs and is logged without its arguments):

```
ssh orion-<env> job run-now backfill <asset> --metrics <k1,k2,...> --backfill-days <1..400>
    # queues a backfill job (Orion: --metric once per item); the daemon runs it at priority 70, one attempt, no retry
    $ST job run-now backfill vvv --metrics flow_tokens.burn,flow_usd.burn --backfill-days 3
ssh orion-<env> data compare-usd <asset> [--days <1..400>]      # read-only (default 91 days)
    $ST data compare-usd vvv --days 91
ssh orion-<env> data purge <asset> --metrics <k1,k2,...> [--source-type <rung>] [--yes]
    # a dry run without --yes; --yes first writes every metric's rows to ONE file per call,
    # ~/home/purged/<asset>-<first metric>[+N]-<UTCstamp>.json (src/db/purge.ts), then deletes. <rung>: contract_state, log_scan, first_party_api, pool_scan, disclosure, derived, constant,
    # market_data, third_party. Prod purges only on Mike's go.
    $PR data purge lit --metrics unlocks_next_year --source-type third_party      # dry run: prints the counts
```

- **Size a backfill:** a backfill must be sized to finish inside the 4 h clearance before the env's nightly; split it by
  --backfill-days otherwise. (It defers while the env's nightly is under 4 h away, while a nightly began under 2 h ago
  (it waits until that slot + 2 h), and while that nightly's refresh / nightly_report jobs are unfinished; stage nightly
  02:45 UTC, prod 00:45 UTC. Queued at 00:50 UTC on prod, it starts at 02:45 UTC at the earliest.) Watch it with
  `jobs --since <iso>`. The daemon has one worker: while a backfill runs, every other job waits for it, the hourly
  `levels` job included (its watch fire/clear posts and the `levels` snapshot), and on prod so does the
  `ORION_DEADMAN_URL` ping (docs/ops/daemon.md), so a backfill of more than an hour or two can trip the prod dead-man.
- **Rollback across this release:** the deploy keys have no drain verb, and `rollback` drains with a 30 min wait: while
  a backfill runs past that, the drain times out and `rollback` aborts (exit 1, nothing switched). So before `rollback`
  to a release older than this one, run `ssh orion-<env> jobs` and wait until no `backfill` job is `running` (a running
  one holds the worker). A `backfill` still `queued` when the older release takes over fails "no handler" there, with
  no retry: re-queue it with `job run-now backfill ...` after rolling forward again.

**Per-env release block** (after step 1 above; no `--breaking`; R1 itself queues no `backfill` beyond stage's one smoke
backfill, step 4). The order is: **stage, one scheduled nightly soak (section 3), then prod on Mike's go.** As in the
Phase 2 release, `staging_refresh` (Sunday 10:30 UTC, stage only) refuses a prod dump while the two envs differ (stage
at 0007, prod at 0006: `schema mismatch ...`) and alerts; nothing is restored. Before deploying stage, check that no
Sunday 10:30 UTC falls between the planned stage switch and the planned prod switch (stage switch, then stage's next
02:45 UTC nightly, then the soak check and Mike's go). If one does, deploy stage after that Sunday's refresh. Run the
block on stage, and after the soak, the same block on prod (`<env>` = `stage`, then `prod`; `ssh orion-<env>` = `$ST` /
`$PR`). The 12 assets whose config changes in R1 (every asset but AERO, whose report must stay byte-identical): `cake
crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv`.

**Do not let a scheduled nightly slot (stage 02:45 UTC, prod 00:45 UTC) fall between step 0 and step 3**: the nightly
refreshes write new level and flow observations inside the step-0 reports' asOf (a report for day `d` reads levels as of the end of `d + 1`),
and step 3 then STOPs on every asset. Start step 0 with enough time to reach step 3 before the next slot. For the same
reason the report check (step 3) comes before any refresh: `job run-now refresh` writes price, supply and staking
levels "now", inside that asOf, and moves price, market cap and every yield.

0. **Before the switch: save the pre-deploy reports** (read-only, on the release still current), the 12 and AERO,
   on the machine running the deploy:
   ```
   mkdir -p ~/r1-<env>/before ~/r1-<env>/after ~/r1-<env>/mid ~/r1-<env>/purged
   for a in aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do
     ssh orion-<env> report yield $a > ~/r1-<env>/before/$a.json || { echo "STOP: $a exit $?"; break; }
   done
   ```
   Each file's top-level `day` is that asset's report day (read it with
   `python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["day"])' ~/r1-<env>/before/<a>.json`); steps 3, 5
   and 9 report the same day, since CAKE's, UNI's and VVV's default day may move with this release (they no longer
   wait on the removed DefiLlama series).
1. **Deploy:**
   ```
   scripts/release/deploy.sh <env> <tag>        # switch runs db migrate: applied [7]; no --breaking (0007 is expand-only)
   ```
   Paste the report verbatim into the thread; its migrations line must list 7 (and only 7).
2. **Check the switch:**
   ```
   ssh orion-<env> status                       # current <tag>; heartbeat fresh, on <tag>
   ssh orion-<env> logs 30                      # daemon started on <tag>; heartbeat lines on <tag>; no error
   ```
   `~/deploys.log` (in the deploy report and in `status`) shows `switch <from> -> <tag> migrations=7 breaking=0`. The
   deploy keys have no `db status` verb; the switch report's migrations applied `[7]` is the schema check (as the env
   user, `o db status` must name current = 7, pending none).
3. **Report check against the pre-deploy reports, right after the switch, before any refresh** (read-only), on each
   asset's step-0 day:
   ```
   for a in cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do
     d=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["day"])' ~/r1-<env>/before/$a.json)
     ssh orion-<env> report yield $a --day $d > ~/r1-<env>/after/$a.json
     python3 tools/phase3-proof/flatdiff.py ~/r1-<env>/before/$a.json ~/r1-<env>/after/$a.json \
       --allow tools/phase3-proof/r1-allowlist.json --asset $a || echo "STOP: $a flatdiff exit $?"
   done
   d=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["day"])' ~/r1-<env>/before/aero.json)
   ssh orion-<env> report yield aero --day $d > ~/r1-<env>/after/aero.json
   cmp ~/r1-<env>/before/aero.json ~/r1-<env>/after/aero.json || echo "STOP: aero differs"
   ```
   Every asset must exit 0 (every differing path allowed) and AERO must be byte-identical (it is not in the 12 and has
   no allowlist entry). Exit 1 (an unallowed path) or 2 (bad input), or an AERO difference: stop, paste the output and
   bring it to Mike (on stage: no prod deploy). At this point LIT and PUMP still read the old third-party unlock row
   (the schedule row arrives with step 5's refresh), so their unlock entries print `WARN unmatched` (no effect on the
   exit code); LIT's and VVV's flags / provenance entries match, each pinned to the exact removed value. Those entries
   are positional (`flags[3]` is where prod's report holds VVV's flag): if an env holds the entry at another index,
   flatdiff fails closed; re-derive the index from that env's `before/<a>.json` (tools/phase3-proof/README.md) and
   bring it to the thread, never drop the pin. Read every printed diff path anyway: any `perTokenFdv` revenue /
   grossProfit / holderFlow.total move is a stop (ruling R22: FDV does not move in R1).
4. **Stage only: the smoke backfill** (ruling R25: the backfill handler's first real run; keyless Hyperliquid). It
   comes after step 3, so its re-read rows cannot move HYPE's comparison:
   ```
   ssh orion-stage job run-now backfill hype --metrics flow_usd.af_buys_direct --backfill-days 3
   ssh orion-stage jobs --since <iso of the switch>       # repeat until the backfill job is `done`
   ```
   Check the Slack lines: `ORION BACKFILL stage HYPE started: ...` and the done line (duration, rows per metric). It
   defers while stage's 02:45 UTC nightly is under 4 h away (and until 2 h after a nightly that began under 2 h ago):
   `jobs` shows it queued; let it wait, or run this step after the window. A `failed` job or an ALERT line: stop, bring
   the job row and `logs 50` to the thread (no prod deploy). Not on prod. Its re-read can move HYPE's report: if it
   finishes after `mid/` is saved (step 5), save `mid/` again (step 5's loop) before step 9, or step 9 STOPs on HYPE
   for a correct change.
5. **Refresh LIT and PUMP before any purge, check the new unlock rows, save `mid/`** (ruling R14: the refresh rewrites
   `latest_levels` for `unlocks_next_year` from the new `schedule` source, so a later purge of the third-party rows
   leaves no stale third-party level):
   ```
   ssh orion-<env> job run-now refresh lit
   ssh orion-<env> job run-now refresh pump
   ssh orion-<env> jobs --since <iso of the switch>        # repeat until both refresh jobs are `done`
   ssh orion-<env> data show lit unlocks_next_year
   ssh orion-<env> data show pump unlocks_next_year
   ```
   A refresh that ends `failed`: stop, do not purge; bring the job row and `logs 50` to the thread. The newest
   `unlocks_next_year` row must be, for LIT, 138,888,888.89 tokens (10 monthly tranches of 500M / 36 in the next 365
   days; 152,777,777.78 = 11 tranches from 2026-11-29, 166,666,666.67 = 12 from 2026-12-29) with `citationUrl` =
   Lighter's x.com post; for PUMP 82,500,000,000 tokens with `citationUrl` = the Blockworks filing (`data show` prints
   `source` and `citationUrl`, not the rung or method; the rung is `disclosure` by the adapter's registry entry). Any
   other value or citation: stop. Then save the post-refresh reports on the step-0 days, the comparison base for the
   purges:
   ```
   for a in aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do
     d=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["day"])' ~/r1-<env>/before/$a.json)
     ssh orion-<env> report yield $a --day $d > ~/r1-<env>/mid/$a.json || echo "STOP: $a exit $?"
   done
   ```
6. **Purge dry runs of the four orphan pairs** (nothing is deleted without `--yes`; ruling R27). Each metric is no
   longer configured (no `--source-type`) and no report reads it. Paste each output's counts into the thread:
   ```
   ssh orion-<env> data purge cake --metrics flow_usd.fees,flow_usd.llama_revenue
   ssh orion-<env> data purge lit  --metrics flow_usd.fees,flow_usd.llama_revenue
   ssh orion-<env> data purge uni  --metrics flow_usd.swap_fees
   ssh orion-<env> data purge vvv  --metrics flow_usd.revenue_proxy
   ```
   A refusal (a configured metric without `--source-type`, the metric's current source type, an open anomaly, a kept
   row referencing a purged one) writes nothing: stop and bring it to Mike. On prod, compare the counts with stage's and
   with the Task 7 prod-copy rehearsal (cake 398, lit 191, uni 191, vvv 345).
7. **On Mike's go (per env, given in the thread after he has seen the dry-run counts): the same four with `--yes`:**
   ```
   ssh orion-<env> data purge cake --metrics flow_usd.fees,flow_usd.llama_revenue --yes
   ssh orion-<env> data purge lit  --metrics flow_usd.fees,flow_usd.llama_revenue --yes
   ssh orion-<env> data purge uni  --metrics flow_usd.swap_fees --yes
   ssh orion-<env> data purge vvv  --metrics flow_usd.revenue_proxy --yes
   ```
   Each deleted count must equal its dry run's. Before deleting, each call writes its rows to one file,
   `~/home/purged/<asset>-<first metric>[+N]-<UTCstamp>.json` on that env (`$ORION_HOME/purged/`; one file per call,
   e.g. `cake-flow_usd.fees+1-<stamp>.json`); with the nightly `pg_dump` they are the only copy of the purged rows, so
   keep them (the Phase 3 followups note lists them). If a nightly slot has passed since `mid/` was saved, save `mid/`
   again (step 5's loop) right before this step.
8. **Gated, only on Mike's pick: the LIT / PUMP third-party unlock purges** (ruling R27; a separate decision from step
   7). These rows are still read: a report for day `d` reads `unlocks_next_year` as of the end of `d + 1`, so for any day
   whose asOf ends before step 5's refresh (in practice two or more days before the deploy day) it finds no `schedule`
   row and reads the third-party one. Deleting them (LIT 31 rows, PUMP 29 on the prod copy: 2026-10-16 .. the deploy
   day) nulls `dilution`, `yields.dilution`, `yields.netShareholder`, `holderFlow.netOfDilution` and the per-token
   dilution in each such `report yield lit|pump --day <earlier day>` (about four weeks of history: ad-hoc historical
   reports, a re-run of an old nightly slot, any later history consumer). The nightly and the snapshot (yesterday's
   day) are unaffected after the deploy day. Levels cannot be
   backfilled, so the loss is permanent. Mike picks one:
   - **(a) purge now** (spec D6): if a nightly slot or the smoke backfill has run since `mid/` was saved, save `mid/`
     again first (step 5's loop); run the dry runs, paste the counts, then on his go the `--yes` pair:
     ```
     ssh orion-<env> data purge lit  --metrics unlocks_next_year --source-type third_party
     ssh orion-<env> data purge pump --metrics unlocks_next_year --source-type third_party
     ssh orion-<env> data purge lit  --metrics unlocks_next_year --source-type third_party --yes
     ssh orion-<env> data purge pump --metrics unlocks_next_year --source-type third_party --yes
     ```
     Each deleted count must equal its dry run's; two more export files per env.
   - **(b) keep the third-party rows until R8** (Mike's pick, 2026-11-12): skip this step. A report for the day before
     the deploy day or later reads the schedule row step 5's refresh wrote (reports read observations, newest at or
     before the end of `d + 1`); only older days still read the kept third-party rows.
9. **After the purge(s): compare against `mid/`** (read-only; the prod-copy rehearsal showed the purges byte-neutral for
   the step-0 day when that day is the day before the deploy, so its asOf includes step 5's schedule row; for an
   older step-0 day the orphan purges are still neutral, nothing reads them):
   ```
   for a in aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do
     d=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["day"])' ~/r1-<env>/before/$a.json)
     ssh orion-<env> report yield $a --day $d > ~/r1-<env>/purged/$a.json
     cmp ~/r1-<env>/mid/$a.json ~/r1-<env>/purged/$a.json || echo "STOP: $a differs from mid/"
   done
   ```
   Every report must be byte-identical to its `mid/` copy. A difference: stop and bring both files to the thread. Run
   it after step 7, and again after step 8 when Mike picks (a).

Stage: steps 0-9 (step 4 is stage-only), then the soak (one scheduled 02:45 UTC nightly on the new tag, section 3).
Prod: on Mike's go after the soak passes, steps 0-9 with `<env>` = `prod` and without step 4; steps 7 and 8 again only
on Mike's go for prod.

## The ssh verbs (any release)

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
