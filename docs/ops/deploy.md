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
  (the role must be named), the RPC URLs (from Phase 3 R2 all four: `ORION_ETH_RPC_URL`, `ORION_BNB_RPC_URL`,
  `ORION_BASE_RPC_URL`, `ORION_SOL_RPC_URL`; "Phase 3 R2 release"), `COINGECKO_API_KEY` (and `COINGECKO_PLAN=pro` on
  prod once it has the Basic key; from R2 it serves `circulating_supply` and supply cross-checks only, until R3), `SLACK_WEBHOOK_URL` (different per env), `ORION_PUBLISH` (`git:git@github.com:masha256/orion-data[-staging].git#main`
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

## 7. Writing a per-env release block

A release with one-time data steps (backfills, reprices, rebuilds, purges) gets its own section below with a numbered
per-env block. Rules learned from the blocks so far:

- **List the expected pre-remap artifacts.** When a step remaps references (token refs, source ids, metric keys), every
  read-only check that runs BEFORE that step sees the old references and can report rows as unpriced, missing or
  unmatched though nothing is wrong. For each such check the block names, before it runs: the asset and metric, which
  references cause it, the counts measured on the proof copy (and on stage, for prod's block), the step that clears it,
  and a re-check after that step that must show 0. The check's own command exempts exactly those metrics (printing
  their counts) and still stops on anything else; the re-check has no exemption. Example: R2 step 5, where yCRV's
  `flow_usd.fees` / `yearn_revenue` / `yearn_styc_fee` are unpriced until step 6 remaps `coingecko:crvusd` /
  `coingecko:yearn-crv` (stage stopped on it because the block did not list it).

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
   fills. Days more than 90 back are priced from CoinGecko daily points (correction 13; from Phase 3 R2 every scanned
   hour is priced from `prices.yaml` chain/first-party prices and these values are re-priced: "Phase 3 R2 release").
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
   rehearsal: Base ~11 s a day for VVV's 3 members; one market_chart range per CoinGecko id per run (that release's
   price path; since Phase 3 R2 `backfill-tokens` reads no price and the CoinGecko hourly series is gone).
6. **G2 comparison** (read-only), per asset, after step 5:
   ```
   for a in aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv; do o data compare-usd $a --days 91 --json > ~/home/compare-usd-$a.json; done
   ```
   The stored USD (`value`) vs the hourly token buckets x hourly prices (`flow_usd_v` at that release; since Phase 3 R2
   `compare-usd` reads the chain-only `flow_usd_chain_v`, and its output has `dailyMean` and no `beyond`/`beyondHourly`),
   per metric; it feeds Mike's G2 per-metric comparison.

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
   ssh orion-prod "sql-ro \"select (select count(*) from observations where method is null or source_type is null or locator is null or code_version is null or config_hash is null) as obs_null, (select count(*) from observations where source_type = 'disclosure' and citation_url is null and code_version <> 'pre-v2') as disclosure_uncited, (select count(*) from latest_levels where source_type is null or locator is null) as levels_null\""
   ```
   The whole remote command is one double-quoted word with the query in escaped quotes inside it: ssh joins its
   arguments with spaces and orion-remote re-splits that string (shlex), so `ssh orion-prod sql-ro "select ..."` arrives
   as many words and is refused (exit 64, `sql-ro takes exactly one argument`). Pinned in
   `scripts/provision/test/test_orion_remote.py` (`DocumentedSqlRoTests`).
   Staging: `ssh orion-stage sql-ro ...`, the same command, once Mike has re-run `orion-host.sh` from a provisioning
   snapshot that has `orion_stage_ro` (RET-41; the stage verb signs in as `orion_stage_ro`); before that, as the env user
   (`sudo -iu orion-stage`), `o db query-ro "<the same select>"`.
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
ssh orion-<env> job run-now backfill-prices --from <YYYY-MM-DD> [--to <YYYY-MM-DD>] [--refs <r1,r2,...>]
    # (R2 release on) queues a prices backfill (asset null, `job:prices` run lock): chain prices of the refs (default
    # every prices.yaml ref) for from..to; no --to: today (UTC), frozen and stored at enqueue; from <= to <= today, at
    # most 550 days (checked at enqueue only); an unknown ref is refused at enqueue. Each run works 10 min, then defers
    # to now at priority 70 (levels runs between); a lost lease re-queues it (3 attempts) and it resumes from `prices`.
    # A drain (deploy, rollback: 30 min wait) waits for the current run's budget (<= 10 min + one chain-day).
    # Refs: at most 40, each [A-Za-z0-9:/._@-]{1,120}
    $ST job run-now backfill-prices --from 2025-10-13
ssh orion-<env> data compare-usd <asset> [--days <1..400>]      # read-only (default 91 days)
    # (R2 release on) stored value vs the chain-only flow_usd_chain_v per USD flow metric: days priced, gap, dailyMean
    # (days on the daily mean), usdNative, and the rows that keep value: unpriced (legacy_unpriced), noTokens, noHourly
    $ST data compare-usd vvv --days 91
ssh orion-<env> data purge <asset> --metrics <k1,k2,...> [--source-type <rung>] [--yes]
    # a dry run without --yes; --yes first writes every metric's rows to ONE file per call,
    # ~/home/purged/<asset>-<first metric>[+N]-<UTCstamp>.json (src/db/purge.ts), then deletes. <rung>: contract_state, log_scan, first_party_api, pool_scan, disclosure, derived, constant,
    # market_data, third_party. Prod purges only on Mike's go.
    $PR data purge lit --metrics unlocks_next_year --source-type third_party      # dry run: prints the counts
ssh orion-<env> data reprice <asset> [--from <YYYY-MM-DD>] [--yes]
    # (R2 release on) a dry run without --yes: per USD flow metric the rows repriced, unchanged, refused (listed: an hour
    # with an amount and no chain price, < 24 hours on the daily mean, no twin amount) and skipped by reason (usd_native,
    # third_party, disclosed, periodic, defillama_history). --yes (asset run lock) first writes every row it touches to
    # ~/home/repriced/<asset>-<UTCstamp>.json, then rewrites value in place, one transaction per day; remaps
    # coingecko:crvusd / coingecko:yearn-crv to the address refs and recomputes the derived rates over the repriced flows.
    # A second --yes writes nothing; a rerun after an interrupted --yes finishes the derived rates too. Exits 3 when any
    # row is refused (dry run and --yes; the JSON still lists `refused`).
    $ST data reprice crv --from 2025-10-13
ssh orion-<env> data rebuild-price-levels <asset> [--yes]
    # (R2 release on) per CoinGecko (market_data) price_usd / diem_price_usd row: a new row at the same observed_at from
    # the newest chain/first-party price at or before observed_at - 1 h (refused beyond 6 h). Deletes nothing: run
    # `data purge <asset> --metrics price_usd[,diem_price_usd] --source-type market_data` afterwards. A refused row
    # keeps its CoinGecko row. Exits 3 when any row is refused (dry run and --yes, as `data reprice`; the JSON still
    # lists `refused`; --yes still writes the rows it could rebuild).
    $ST data rebuild-price-levels vvv
ssh orion-<env> data purge-prices --source coingecko [--yes]
    # (R2 release on) `job:prices` run lock; refused while an active observation has a coingecko:* token ref (run
    # `data reprice --yes` first). --yes writes ~/home/purged/prices-coingecko-<UTCstamp>.json, then deletes every
    # coingecko prices row and the coingecko:* tokens rows nothing references.
    $ST data purge-prices --source coingecko
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

## Phase 3 R2 release

The release that carries Phase 3 R2, the price swap (`feat/phase3-third-party`; plan
`docs/superpowers/plans/2026-11-13-orion-phase3-r2-price-swap.md`, its "Amendments made during execution" section, and
the followups note `docs/superpowers/notes/2026-11-13-orion-phase3-r2-followups.md`): `prices.yaml` (one method and one
check per token ref), the chain price writer (the nightly flow scans, the hourly `levels` job and the new prices backfill
call it), the `price.token` / `price.token_check` adapters every `price_usd` source now uses, and migration 0008
(expand-only, no `--breaking`: the `hour_blocks` table, `prices.check_gap_pct` / `check` / `detail`, and the chain-only
view `flow_usd_chain_v`; `flow_usd_v` is not altered). No code path reads a CoinGecko price after the switch
(`/coins/markets` stays for `circulating_supply` and supply cross-checks until R3). The one-time steps below then
rebuild the hourly price history from chain, re-price the stored flows, rebuild the CoinGecko price levels and delete
every CoinGecko price row (the verbs are in the R1 verb reference above, marked "R2 release on"). `ST`/`PR` = the
stage/prod ssh commands above.

**Prerequisites (once, before the staging deploy):**

1. **Task 10 is signed.** The proof on a prod copy (plan Task 10) is done and Mike has signed its per-asset table; the
   release tag carries `tools/phase3-proof/r2-allowlist.json` (bounds = max(2x the signed proof, R41 floors)) and the
   measured backfill call count and wall time. No tag before the sign-off. Signed: Mike 2026-11-15. Measured on the prod
   copy (one pass, 18 runs of 10 min back to back, 0 errors, 202 check breaches): 148,736 RPC calls (Ethereum 44,169,
   BNB 58,038, Base 37,477, Solana 9,034, Hyperliquid 12, Lighter 6) in 10,940 s (3 h 02 m) wall. These supersede the
   plan's P6 estimate (~50k calls). That pass still read AERO from 2026-09-23 (9,552 failed or bad hours before its
   pools existed, ruling R36), so a backfill from AERO's 2026-10-22 makes somewhat fewer Base calls. On an env it takes
   longer than 3 h: each 10-min run defers to the hourly `levels` job and around the nightly (step 3).
2. **Mike re-runs `orion-host.sh`** from a fixed snapshot of `scripts/provision/` at the release sha, exactly as in the
   R1 release step 1 above (the snapshot commands, the same flags, paste back the SELF-CHECK): R2's orion-remote adds
   `job run-now backfill-prices`, `data reprice`, `data rebuild-price-levels` and `data purge-prices`. Check:
   `$ST job run-now backfill-prices` exits 64 with `orion-remote: job run-now backfill-prices needs --from` (the R1
   orion-remote says `bad job kind`), and nothing is queued. On the older release the four verbs fail with Orion's own
   unknown command / option error (nothing written).
3. **Each env's `~/shared/.env` has all four RPC URLs** (Mike): `ORION_ETH_RPC_URL` (the Ethereum refs AND the
   Ethereum USDC/USD feed that every off-chain ref, HYPE, LIT and PUMP, is multiplied by: without it those refs get no
   price either, ruling R5), `ORION_BNB_RPC_URL` (CAKE), `ORION_BASE_RPC_URL` (VVV, DIEM, AERO) and `ORION_SOL_RPC_URL`
   (PUMP and its Meteora check; our own Solana RPC, never a pump.fun host, ruling R8). A missing URL fails that chain's
   writer, so the prices backfill fails with `price_chain_stopped` and one ALERT line.
4. **Merge and tag on `main`.** `feat/phase3-third-party` is not merged when the block is written: merge it to `main`
   (fast-forward), tag `orion-YYYY.MM.DD.N` on `main`, push the branch and the tag, then `scripts/release/build.sh
   <tag>` (section 1). `deploy.sh` refuses a commit not reachable from `origin/main` (prod refuses `--branch`), so this
   comes before step 1 on either env.
5. **A normal deploy, staging first.** 0008 is expand-only: no `--breaking`, no pre-deploy dump, rollback allowed (below).
   Stage, one scheduled nightly soak (section 3 and the soak note below), then prod on Mike's go. As in R1,
   `staging_refresh` (Sunday 10:30 UTC) refuses a prod dump while the envs differ (stage at 0008, prod at 0007: `schema
   mismatch ...`), which also keeps prod's CoinGecko-priced rows off the re-priced stage; check that no Sunday 10:30 UTC
   falls between the planned stage switch and the planned prod switch, or deploy stage after that Sunday's refresh.
   Two gaps the schema check does not cover: (i) once prod is on schema 8, a Sunday `staging_refresh` that runs before
   prod's steps 6-8 are done copies prod's un-repriced state (CoinGecko `prices` rows, CoinGecko-priced flow `value`s and
   `price_usd` rows) onto stage, and stage's soak baseline is gone: finish prod's steps 6-8 before Sunday 10:30 UTC, or
   let the refresh run and redo steps 3-8 on stage afterwards. There is no way to pause `staging_refresh` (orion-remote
   has `job run-now` only; an asset pause is per asset, ruling R35); (ii) a prod rollback to `orion-2026.11.12.1` keeps
   schema 8, so the next `staging_refresh` no longer refuses and copies the CoinGecko rows the old release writes again
   onto stage: after a prod rollback, expect that Sunday's refresh to do so, and redo steps 3-8 on stage once prod has
   rolled forward and finished its block.

**Timing.** Deploy outside the env's nightly window, the slot -4 h to +2 h (stage nightly 02:45 UTC: deploy 04:45-22:45
UTC; prod 00:45 UTC: deploy 02:45-20:45 UTC), and queue the prices backfill right after the switch (step 3). The job
defers itself while the nightly is under 4 h away or began under 2 h ago (as a `backfill` job does), so it needs no
babysitting; a nightly that runs before it finishes prices only its own scan day inline, which the backfill then skips.
The gate (step 10) compares `after/` with `before/`, so a scheduled nightly between step 0 and step 10 adds that
nightly's writes to the diff (new level and flow observations inside the reports' asOf, as in R1): start the block
right after a nightly's +2 h, so the backfill (Task 10's measured wall time) and steps 4-10 fit before the next window.
If a nightly does fall between them, run step 10 anyway, paste every unallowed path and bring it to Mike; never call
the step passed on a guess. For the same reason no `job run-now refresh` before step 10 (it writes price, supply and
staking levels "now", inside that asOf).

**Per-env release block** (`<env>` = `stage`, then `prod`; `ssh orion-<env>` = `$ST` / `$PR`). Every `--yes` on stage
runs under the release go; **every `--yes` on prod runs only on Mike's go**, given in the thread after he has seen that
step's dry runs. The 13 assets: `aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv`. Two report days per
asset: its default day `d` (step 0) and `d` minus 91 days (the prior growth window).

0. **Before the switch: save the pre-deploy reports** (read-only, on the release still current), on the machine running
   the deploy:
   ```
   A="aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv"
   mkdir -p ~/r2-<env>/before ~/r2-<env>/mid ~/r2-<env>/after ~/r2-<env>/dry ~/r2-<env>/yes
   day() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["day"])' ~/r2-<env>/before/$1.json; }
   d91() { python3 -c 'import datetime,sys; print(datetime.date.fromisoformat(sys.argv[1]) - datetime.timedelta(days=91))' "$(day $1)"; }
   for a in $A; do
     ssh orion-<env> report yield $a > ~/r2-<env>/before/$a.json || { echo "STOP: $a exit $?"; break; }
     ssh orion-<env> report yield $a --day $(d91 $a) > ~/r2-<env>/before/$a-91.json || { echo "STOP: $a-91 exit $?"; break; }
   done
   ```
   Every later report save uses the same two days (`--day $(day $a)` and `--day $(d91 $a)`): a default day may move with
   the release. `A`, `day` and `d91` are shell definitions: run every later step in the same shell (or define them
   again; `day` reads the saved `before/` file, so it gives the same day).
1. **Deploy:**
   ```
   scripts/release/deploy.sh <env> <tag>        # switch runs db migrate: applied [8]; no --breaking (0008 is expand-only)
   ```
   Paste the report verbatim into the thread; its migrations line must list 8 (and only 8).
2. **Check the switch:**
   ```
   ssh orion-<env> status                       # current <tag>; heartbeat fresh, on <tag>
   ssh orion-<env> logs 30                      # daemon started on <tag>; heartbeat lines on <tag>; no error
   ```
   `~/deploys.log` shows `switch <from> -> <tag> migrations=8 breaking=0` (as the env user, `o db status` names current
   = 8, pending none). The first hourly `levels` run on the tag writes the last 48 h of chain prices for every
   `prices.yaml` ref and the `price_usd` levels from `price.token`; an `ORION ALERT <env> levels prices: ...` line: stop,
   bring `logs 50` to the thread.
3. **Queue the prices backfill, right after the switch:**
   ```
   ssh orion-<env> job run-now backfill-prices --from 2025-10-13
   ssh orion-<env> jobs --since <iso of the switch>       # repeat until the backfill job is `done`
   ```
   No `--to`: today (UTC), frozen and stored at enqueue (at most 550 days, checked at enqueue only, ruling R27); every
   `prices.yaml` ref, each from its own `valid_from` (ruling R2: the EVM refs 2025-10-13, AERO 2026-10-22 (ruling R36:
   its pools exist from 2026-10-21), HYPE and LIT 2026-10-01, PUMP 2026-10-12). It runs under the `job:prices` lock in
   10-min runs, each deferring to now at priority 70
   so the hourly `levels` job runs between them (ruling R28); a lost lease re-queues it (op prices has 3 attempts) and it
   resumes from `prices`, never rewriting a committed chain-day. The done line, `ORION BACKFILL <env> prices done in
   <time> (2025-10-13..<to>, <n> runs): <SYM> <rows> rows, ...; oldest hour <iso>; missing <reason n, ...>; calls
   <chain n, ...>; breaches <n>`, and the job row's `result` (`jobs`) carry the rows per ref, the calls per chain and the
   missing hours by reason: paste them into the thread and compare with Task 10's prod-copy run (rows per ref, calls
   within its measured count; a missing reason or a count it did not have: stop). `ORION WATCH <env> price ...` lines
   (at most a capped number per run, then one count line) are check breaches stored on the rows (`check_gap_pct`),
   never anomalies: list them for Mike with Task 10's. A `failed` job or an `ORION ALERT <env> backfill prices ...`
   line: stop, bring the job row and `logs 50` to the thread (a chain the writer stopped names itself:
   `price_chain_stopped: <chain> stopped at <iso>: <error>`; usually a missing or failing RPC URL).
4. **Save `mid/`** (after the backfill is `done`, before any reprice), the comparison base a stop is bisected against:
   ```
   for a in $A; do
     ssh orion-<env> report yield $a --day $(day $a) > ~/r2-<env>/mid/$a.json || echo "STOP: $a exit $?"
     ssh orion-<env> report yield $a --day $(d91 $a) > ~/r2-<env>/mid/$a-91.json || echo "STOP: $a-91 exit $?"
   done
   ```
5. **Chain coverage of the stored flows** (read-only; `compare-usd` reads `flow_usd_chain_v`):
   ```
   for a in $A; do ssh orion-<env> data compare-usd $a --days 400 > ~/r2-<env>/dry/compare-usd-$a.json; done
   for a in $A; do python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); a=sys.argv[2]; pre={"flow_usd.fees","flow_usd.yearn_revenue","flow_usd.yearn_styc_fee"} if a=="ycrv" else set(); bad=[m["metric"] for m in r if m["unpriced"]>0 and m["metric"] not in pre]; exp=["%s=%d" % (m["metric"], m["unpriced"]) for m in r if m["metric"] in pre]; print(a, "STOP: unpriced in "+",".join(bad) if bad else "ok", "(expected pre-remap: "+" ".join(exp)+")" if exp else "")' ~/r2-<env>/dry/compare-usd-$a.json $a; done
   ```
   **Expected before step 6 (pre-remap artifact): yCRV `flow_usd.fees`, `flow_usd.yearn_revenue` and
   `flow_usd.yearn_styc_fee` report `unpriced` > 0.** Those rows still carry the `coingecko:crvusd` /
   `coingecko:yearn-crv` token refs, which `prices.yaml` has no chain method for, until step 6's reprice remaps them to
   the crvUSD and yCRV address refs (its `remapped` entries); the view finds no chain price for a `coingecko:*` ref.
   Measured: Task 10's prod copy 52 / 88 / 308, stage 54 / 90 / 310 (2026-11-17), prod 54 / 90 / 311 (2026-11-19);
   the counts move with each env's data, so they are not pinned. The check above prints them as `expected pre-remap`
   and does not stop on them; it stops on any other metric or asset. Their gate is the re-check after step 6.
   **After step 6's `--yes` loop, re-run the coverage check with no exemption; every asset, yCRV included, must show 0
   unpriced** (a remap that missed a row: stop):
   ```
   for a in $A; do ssh orion-<env> data compare-usd $a --days 400 > ~/r2-<env>/yes/compare-usd-$a.json || { echo "STOP: $a exit $?"; break; }; done
   for a in $A; do python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); bad=["%s=%d" % (m["metric"], m["unpriced"]) for m in r if m["unpriced"]>0]; print(sys.argv[2], "STOP: unpriced after reprice: "+" ".join(bad) if bad else "ok"); sys.exit(bool(bad))' ~/r2-<env>/yes/compare-usd-$a.json $a || break; done
   ```
   (Stage and prod: 0 unpriced on all 13 after step 6.)
   `--days 400` is orion-remote's cap (`--days <1..400>`); it reaches the first flow day (2025-10-14) only while the
   block runs on or before about 2026-11-18. Later, the days older than 400 are not checked here: for them the gate is
   step 6's reprice dry run, whose `refused` list (exit 3) names every row with an hour without a chain price.
   Every other metric must have `unpriced` (`legacy_unpriced`: a row with hourly token amounts and an hour without a
   chain price) 0; otherwise stop (the backfill left a gap: re-queue it for that ref with `--refs`, or bring it to
   Mike). The gap columns (`gapPct`, `p50DayGapPct`, `p90DayGapPct`) are the chain-vs-CoinGecko move per metric; paste them beside
   Task 10's table.
6. **Re-price the stored flows: dry runs, then `--yes` per asset.** Dry runs first, all 13 (exit 3 = a row was
   refused):
   ```
   for a in $A; do
     ssh orion-<env> data reprice $a > ~/r2-<env>/dry/reprice-$a.json; rc=$?
     [ $rc -eq 0 ] || echo "STOP: $a reprice dry run exit $rc"
   done
   ```
   Check, and paste the per-metric counts (`repriced`, `unchanged`, `refused`, `skipped` by reason, `oldSum` ->
   `newSum`, `remapped`, `derived`) into the thread:
   - **No row refused.** Exit 3 (any `refused` entry: an hour with an amount and no chain price, fewer than 24 hours on a
     daily mean, no twin amount) is a stop for Mike, on stage too: the refused rows keep their CoinGecko value.
   - **Remaps:** the only `coingecko:*` refs anywhere are `coingecko:crvusd` and `coingecko:yearn-crv` (the
     `remapped` entries, to the crvUSD and yCRV address refs); any other `coingecko:*` ref: stop.
   - **PUMP:** Task 10's prod copy: 28 rows repriced and 363 skipped as `defillama_history` (the plan's estimate was
     about 21 / 369; ruling R29; the DefiLlama-era days
     wait for R6). Skipped reasons elsewhere are by design (`usd_native`, `third_party`, `disclosed`, `periodic`),
     never a silent keep: compare the counts with Task 10's.

   **Stop here. Prod: only on Mike's go** (after he has seen the dry-run counts). Then per asset, stopping at the first
   non-zero exit:
   ```
   for a in $A; do
     ssh orion-<env> data reprice $a --yes > ~/r2-<env>/yes/reprice-$a.json || { echo "STOP: $a exit $?"; break; }
   done
   ```
   Each `--yes` writes every row it touches to `~/home/repriced/<asset>-<UTCstamp>.json` on that env first (with the
   nightly `pg_dump`, the only copy of the old values: keep them), then rewrites `value` in place, one transaction per
   day under the asset lock, and recomputes the derived rates over the repriced days (ruling R30). Its counts must equal
   the dry run's. Then run step 5's re-check (no exemption): 0 `unpriced` on all 13, yCRV included. A dry run afterwards shows 0 `repriced` (all `unchanged`): a second `--yes` writes nothing, and a
   rerun after an interrupted `--yes` finishes the derived rates too.
7. **Rebuild the CoinGecko price levels: dry runs, then `--yes`.** First the rejected-row pre-check (ruling R39,
   read-only): the purge in step 8b refuses a rejected CoinGecko price row on or after its ref's `valid_from`, and
   neither the rebuild (it reads active rows only) nor any `--yes` can clear it:
   ```
   ssh orion-prod "sql-ro \"select asset_id, metric_key, count(*) filter (where status = 'rejected') as rejected, count(*) as total from observations where source_type = 'market_data' and metric_key in ('price_usd', 'diem_price_usd') group by asset_id, metric_key order by asset_id, metric_key\""
   ```
   Stage, once `orion-host.sh` has been re-run with `orion_stage_ro` (RET-41; on an older orion-remote it exits 64
   `sql-ro is prod-only`), the same over the stage key:
   ```
   ssh orion-stage "sql-ro \"select asset_id, metric_key, count(*) filter (where status = 'rejected') as rejected, count(*) as total from observations where source_type = 'market_data' and metric_key in ('price_usd', 'diem_price_usd') group by asset_id, metric_key order by asset_id, metric_key\""
   ```
   (before that re-run: `sudo -iu orion-stage`, then `o db query-ro "<the same select>"`, as in "Phase 2 tail: release
   with 0006"; Raymond has no sudo on venus, so that form needs Mike). **Expected:**
   `rejected` 0 on every row (Task 10's prod copy: 0 on every asset). Any `rejected` > 0: stop and ask Mike; do not run
   the rebuild. If the pre-check itself errors (a non-zero exit or an `error` JSON): stop, do not run the rebuild, and
   paste the command and its full output into the thread. Then the dry runs, all 13 (exit 3 = a row was refused):
   ```
   for a in $A; do
     ssh orion-<env> data rebuild-price-levels $a > ~/r2-<env>/dry/rebuild-$a.json; rc=$?
     [ $rc -eq 0 ] || echo "STOP: $a rebuild dry run exit $rc"
   done
   for a in $A; do python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); a=sys.argv[2]; pm=r["perMetric"]; bad=[m["metric"] for m in pm if m["refused"]]; bvf=sum(len(m["beforeValidFrom"]) for m in pm); want=25 if a=="aero" else 0; s="STOP: refused in "+",".join(bad) if bad else ("STOP: beforeValidFrom %d, expected %d" % (bvf, want) if bvf != want else "ok"); print(a, " ".join("%s rows=%d rebuild=%d refused=%d beforeValidFrom=%d" % (m["metric"], m["rows"], m["rebuilt"], len(m["refused"]), len(m["beforeValidFrom"])) for m in pm), s); sys.exit(s != "ok")' ~/r2-<env>/dry/rebuild-$a.json $a || break; done
   ```
   Per `market_data` `price_usd` / `diem_price_usd` row, a new row at the same `observed_at` from the newest chain or
   first-party price at or before `observed_at - 1 h`. A row with no such price within 6 h is refused (ruling R31) and
   listed: any refused row (a non-zero exit, or a `STOP` line; every step 7/8b check exits 1 on `STOP` and its loop
   stops at that asset) is a stop for Mike, on stage too, before any `--yes`
   here and before step 8 (the purge would refuse it anyway, ruling R38). A row observed before its ref's prices.yaml
   `valid_from` is listed as `beforeValidFrom`, never rebuilt and not refused (exit 0). **Expected (Task 10):** AERO
   `price_usd` 20 rebuilt + 25 `beforeValidFrom` (2026-09-24..2026-10-21; AERO's pools exist from 2026-10-21, ruling
   R36); every other asset 0 `beforeValidFrom`. Any other `beforeValidFrom` or refused row: stop. Paste the per-metric
   lines into the thread.

   **Stop here. Prod: only on Mike's go.** Then per asset, stopping at the first non-zero exit, and compare the counts:
   ```
   for a in $A; do
     ssh orion-<env> data rebuild-price-levels $a --yes > ~/r2-<env>/yes/rebuild-$a.json || { echo "STOP: $a exit $?"; break; }
   done
   for a in $A; do python3 -c 'import json,sys; d,y=(json.load(open(f)) for f in sys.argv[1:3]); c=lambda r: [(m["metric"], m["rebuilt"]) for m in r["perMetric"]]; s="ok" if c(d)==c(y) else "STOP: dry %s != yes %s" % (c(d), c(y)); print(sys.argv[3], s); sys.exit(s != "ok")' ~/r2-<env>/dry/rebuild-$a.json ~/r2-<env>/yes/rebuild-$a.json $a || break; done
   ```
   The `--yes` counts (`rebuilt`) must equal the dry run's; it deletes nothing.
8. **Purge the CoinGecko prices, then the CoinGecko price levels: each a dry run, then `--yes`.**

   8a. `purge-prices` dry run:
   ```
   ssh orion-<env> data purge-prices --source coingecko > ~/r2-<env>/dry/purge-prices.json || echo "STOP: purge-prices dry run exit $?"
   python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print("rows", sum(p["rows"] for p in r["prices"]), "refs", len(r["prices"]), "deletedTokens", r["deletedTokens"]); print("STOP: keptTokens "+json.dumps(r["keptTokens"]) if r["keptTokens"] else "ok")' ~/r2-<env>/dry/purge-prices.json
   ```
   `purge-prices` is refused (non-zero exit, `error` in the JSON) while any active observation still has a
   `coingecko:*` token ref (step 6 remaps them). Its dry run must have `keptTokens` empty (`[]`); a kept `coingecko:*`
   row: stop. It shares the `job:prices` run lock with the prices backfill, so it is refused while a backfill run
   holds it (step 3 must be `done`). Paste the rows per ref and `deletedTokens`.

   **Stop here. Prod: only on Mike's go.** Then the `--yes` (irreversible but for its export) and the count check:
   ```
   ssh orion-<env> data purge-prices --source coingecko --yes > ~/r2-<env>/yes/purge-prices.json || echo "STOP: purge-prices exit $?"
   python3 -c 'import json,sys; d,y=(json.load(open(f)) for f in sys.argv[1:3]); c=lambda r: (sorted((p["tokenRef"], p["rows"]) for p in r["prices"]), sorted(r["deletedTokens"])); print("ok" if c(d)==c(y) else "STOP: dry %s != yes %s" % (c(d), c(y)))' ~/r2-<env>/dry/purge-prices.json ~/r2-<env>/yes/purge-prices.json
   ```
   Its `--yes` writes `~/home/purged/prices-coingecko-<UTCstamp>.json` (`exportFile`, `exportSha256` in the JSON): keep
   it.

   8b. `market_data` price-level purge, dry runs:
   ```
   for a in $A; do
     m=price_usd; [ $a = vvv ] && m=price_usd,diem_price_usd
     ssh orion-<env> data purge $a --metrics $m --source-type market_data > ~/r2-<env>/dry/purge-$a.json || echo "STOP: $a purge dry run exit $?"
   done
   for a in $A; do python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); a=sys.argv[2]; pm=r.get("perMetric", []); wr=sum(len(m.get("withoutReplacement", [])) for m in pm); want=25 if a=="aero" else 0; s="STOP: error "+json.dumps(r["error"]) if "error" in r else ("STOP: withoutReplacement %d, expected %d" % (wr, want) if wr != want else "ok"); print(a, " ".join("%s observations=%d withoutReplacement=%d" % (m["metric"], m["observations"], len(m.get("withoutReplacement", []))) for m in pm), s); sys.exit(s != "ok")' ~/r2-<env>/dry/purge-$a.json $a || break; done
   ```
   Paste the per-metric lines. The purge refuses (non-zero exit, `error` in the JSON, nothing deleted)
   a targeted row with no rebuilt row at its `observed_at` (`purge_unreplaced_price_level`, ruling R38), except a row
   observed before its ref's `valid_from`: that one is deleted and listed per metric as `withoutReplacement` (ids,
   days). **Expected (Task 10):** 25 `withoutReplacement` for AERO only (2026-09-24..2026-10-21; Mike 2026-11-14:
   "Purge"), none elsewhere. Any other `withoutReplacement` or any refusal (unreplaced row, open anomaly, a kept row
   referencing a purged one): stop and bring it to Mike. An asset with no CoinGecko price row reports nothing to purge.

   **Stop here. Prod: only on Mike's go.** Then per asset, stopping at the first non-zero exit, and compare the counts:
   ```
   for a in $A; do
     m=price_usd; [ $a = vvv ] && m=price_usd,diem_price_usd
     ssh orion-<env> data purge $a --metrics $m --source-type market_data --yes > ~/r2-<env>/yes/purge-$a.json || { echo "STOP: $a exit $?"; break; }
   done
   for a in $A; do python3 -c 'import json,sys; d,y=(json.load(open(f)) for f in sys.argv[1:3]); c=lambda r: [(m["metric"], m["observations"]) for m in r["perMetric"]]; s="ok" if c(d)==c(y) else "STOP: dry %s != yes %s" % (c(d), c(y)); print(sys.argv[3], s); sys.exit(s != "ok")' ~/r2-<env>/dry/purge-$a.json ~/r2-<env>/yes/purge-$a.json $a || break; done
   ```
   Each `--yes` writes `~/home/purged/<asset>-price_usd[+1]-<UTCstamp>.json`: keep them all. Each deleted count must
   equal its dry run's.
9. **Save `after/`:**
   ```
   for a in $A; do
     ssh orion-<env> report yield $a --day $(day $a) > ~/r2-<env>/after/$a.json || echo "STOP: $a exit $?"
     ssh orion-<env> report yield $a --day $(d91 $a) > ~/r2-<env>/after/$a-91.json || echo "STOP: $a-91 exit $?"
   done
   ```
10. **The gate: `after/` against `before/`, within Task 10's signed table:**
    ```
    for a in $A; do for f in $a $a-91; do
      python3 tools/phase3-proof/flatdiff.py ~/r2-<env>/before/$f.json ~/r2-<env>/after/$f.json \
        --allow tools/phase3-proof/r2-allowlist.json --asset $a || echo "STOP: $f flatdiff exit $?"
    done; done
    ```
    Every report must exit 0: USD figures move only within the bounds (each = max(2x the signed proof's measured
    move, ruling R41's class floor from the measured 90-day hourly chain-vs-CoinGecko gaps); README `r2-allowlist.json`),
    the price-basis / provenance text moves as listed, and token amounts, supply, grades and every
    non-USD field are unchanged. Exit 1 (an unallowed path) or 2 (bad input): stop, paste the output, bring both files
    (and `mid/`, to tell the switch and backfill from steps 6-8) to Mike; on stage: no prod deploy.

Stage: steps 0-10 under the release go, then the soak (one scheduled 02:45 UTC nightly on the tag, section 3).
Prod: on Mike's go after the soak passes, steps 0-10 with `<env>` = `prod`, each `--yes` (steps 6, 7, 8a, 8b) only
on Mike's go for prod, given at that step's "Stop here" line: never paste a prod `--yes` block before the go.

**Soak note.** Through the stage soak stage's USD figures differ from prod's by the re-pricing (prod is still on
CoinGecko until its own block): stage-vs-prod report parity is not the check. The soak verdict is the section 3 gate
(no source failed on stage that is not failed in prod's last nightly) plus stage's figures compared against the Task 10
signed table (not against prod), no failed source, and no `ORION WATCH stage price ...` breach without a stated
cause. The controller updates Raymond's soak cron prompt (outside
the repo) for this before the stage deploy; nothing in the repo changes for it.

**Rollback across this release** (section 5): allowed, and short-lived by design. 0008 is expand-only, so
`orion-2026.11.12.1` runs on schema 8. It reads `flow_usd_v`, which prefers a CoinGecko `prices` row but falls back to
a stored price of any source (the newest within 6 h at or before the hour, `0005_tokens_prices.sql`). Its report takes
that view USD for a row with every hour priced (`usd_basis` `hourly`) whose day starts within 90 days of its
`fetched_at` (`pricedHourlyAtIngest`), and the stored `value` for every other row. After step 8a (no CoinGecko rows
left) the view prices those hourly rows from the chain rows the backfill wrote, and `value` elsewhere is the one step 6
repriced: the figures stay chain-priced until that release's own nightly scans and hourly `levels` write CoinGecko
prices and `price_usd` rows again (which the view then prefers). A rollback between steps 3 and 8 (CoinGecko rows still
present): the old view prefers them, so the old reports show CoinGecko-priced figures again on those hourly rows, over a
`value` that step 6 may have partly repriced; no data is lost (the chain rows stay, and every `--yes` wrote its export).
On the roll-forward, save `before/` again (step 0) on the rolled-back release, since its reports are the new base.
So a rollback is fixed forward within days (a new R2 tag, then steps 3-10 again for the days it wrote). Before
`rollback`: `ssh orion-<env> jobs` and wait until the prices backfill is `done` (a running one holds the worker; the
drain waits for the current run's budget, at most 10 min plus one chain-day). A prices backfill still `queued` or
deferred when the older release takes over fails silently there (it has no handler for op `prices`): after rolling
forward, queue it again with `job run-now backfill-prices --from 2025-10-13` (it skips every stored hour). The older
release's orion-remote verbs are unchanged; the four R2 verbs fail with Orion's own unknown command error on it.

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
