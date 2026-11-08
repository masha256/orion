# Phase 2 cross-release proof harness

Proves, after each Phase 2 task that touches the report, that the legacy `report yield <a> --json` output is
byte-identical between the old release and this branch for all 13 assets, and that the new `incomeStatement` figures
match the parity map (Task 3) or the Reclassification Table (plan, global constraints). Run by the controller, never
by an implementer subagent. Python is `/usr/bin/python3`, stdlib only.

| File | Does |
|---|---|
| `prod_copy.py <P> <old release dir> <new worktree>` | A read-only copy of prod (Postgres on venus) into a fresh local schema `p2proof_<UTC stamp>` in `orion_dev`, named in `<P>/schema` first. Reads prod only through `ssh <P2_PROD_SSH> sql-ro '<query>'` (`prod_ro.py`: a READ ONLY transaction as `orion_prod_ro`). Homes `<P>/old` (the OLD release's assets/personas/skills) and `<P>/new` (the worktree's), each with a two-line mode-600 `.env` (`ORION_DATABASE_URL`, `ORION_DB_SCHEMA`, the same schema). The schema is migrated by the OLD release's `db migrate --json` (`<P>/migrate-old.json`) and must then sit at prod's `max(schema_migrations.id)`, with the same tables and columns. Every table is paged by id up to prod's `max(id)` read first (the page halves only when a reply is cut at orion-remote's 1 MB output cap: exit 0 with its `output truncated at 1 MB` stderr line, or exactly 1 MB; an ssh or transport failure, e.g. exit 255 with no output, aborts the copy at once and is never retried; a `json_agg` arrives as a string and is unwrapped), buffered, and inserted in one transaction (`observations.superseded_by` references `observations`); local count must equal prod's per table; sequences are set to max. Then, on `observations` per asset, `count`, `sum(value order by id)` and `max(id)` must be equal prod vs local. Everything is in `<P>/copy.json`; any mismatch exits 1. |
| `prod_ro.py '<query>'` | One read-only prod query (the same `sql-ro` path), rows printed as JSON. |
| `reports.sh <old-dist> <new-dist> <home-old> <home-new> <D> <out>` | Both homes must name the same schema. Per asset of `<home-new>/assets/*.yaml` (>= 13): `report yield <a> --day D --json` (new side adds `--legacy` only if its `--help` lists it) -> `<out>/{old,new}/<a>.json`; then `anomalies.json` (`data anomalies --all --json`) and `proposals.json` (`proposals list --json`). stderr beside each file; every exit code in `<out>/status.tsv`. |
| `compare.py <out> [--parity p.json] [--reclass expected.json]` | One `PASS`/`FAIL` line per asset and list file, exit 0 only on a full pass. New side minus `incomeStatement` must equal old exactly (key order, types, numbers; raw bytes too when there is no `incomeStatement`); first differing path reported. Empty/unparseable fails, < 13 assets fails, a non-zero exit in `status.tsv` fails, a report whose top-level `asset` is not its file name or whose `day` is not the D in `run.txt` fails. Once the new side has `incomeStatement`, `--parity` and `--reclass` are both required (see below). |
| `expected.py <out>/old [--new <out>/new] [--ycrv-styc-separate]` | Writes `<out>/expected.json`: the Reclassification Table for sdCRV, yCRV, LIT from the old side's JSON, keyed by v2 dotted path. yCRV (Task 7b): mix = the new side's `holders.lines[id=ybs_payout].apportion.mix` (refused unless in (0, 1) and the `incentives_to_holders` mix is 1 − mix within 1e-9); revenue = `volume` × mix; `belowLine.toHolders` = `ybs_payout` × (1 − mix); `unreconciled` = revenue − (`ybs_payout` + `treasury`) × mix (ruling R6: the st-yCRV fee has no v2 line, so it is never subtracted); `holderFlow.gross`/`net` = `buckets.cash` (unchanged). With `--ycrv-styc-separate`, revenue adds `styc_fee` and unreconciled subtracts it too. |
| `cleanup.py <P>` | `DROP SCHEMA "<P/schema>" CASCADE` in `orion_dev`, then `shutil.rmtree(<P>)`. Refuses a `<P>` outside `$TMPDIR` or a schema not matching `^p2proof_[0-9a-z_]+$`. |

`P2_PROD_SSH` (required, no default: both scripts refuse without it) holds the ssh arguments of the prod forced-command
key, split like a shell would, e.g. `-i ~/.ssh/<prod key> -o IdentitiesOnly=yes orion-prod@<host>`; `-o BatchMode=yes`
is always added. No key path or host is built into the scripts. Nothing reads the old SQLite database (Mike's rule):
the SQLite `.backup` + `tools/import-sqlite` path this harness used before the cutover is gone.

**The copy is not a snapshot** (Task 8 review M-4). Each table is read in pages over many `sql-ro` calls, each its own
READ ONLY transaction, while the prod daemon keeps running. Rows the daemon adds meanwhile are left out (every table is
read up to a `max(id)` taken first), and the per-asset `count` / `sum(value order by id)` / `max(id)` check catches a
value written or changed under the copy. It does not catch a status change: an UPDATE of `superseded_by` or `status` on
an observation already copied (which decides which rows are active) goes unnoticed. So run `prod_copy.py` outside prod's
write slots (`schedule.yaml`: the nightly at 00:45 UTC until it finishes, the hourly `levels` read at :15, retention at
03:30 UTC) and away from any hand `data set` / `data fetch` on prod, and re-run it if one may have overlapped.

Every `reports.sh` run, both sides and the `--help` probe, gets `ORION_HOME=<home>` and `ORION_ENV_FILE=<home>/.env`:
a release refuses to run without both. When the old side is an extracted release (a directory holding `RELEASE` beside
`dist/`, e.g. `orion-2026.11.04.2/dist`), its config root is the release directory itself (`src/cli/paths.ts`
`resolvePaths`), so it reads its own `assets/`, `personas/` and `skills/`, not the copy in the old home: the old home
then supplies the `.env` (the database) and the data home; `prod_copy.py` fills its config from the same release
anyway, so an old dist that is not a release still reads the release's config, never the worktree's.

## Run (controller)

Order: `prod_copy.py` -> migrate with the NEW dist -> `reports.sh` -> `expected.py` -> `compare.py` -> `cleanup.py`.

```bash
P=$TMPDIR/p2proof-$(date -u +%Y%m%dT%H%M%SZ)
OLD=<extracted release, e.g. .worktrees/rel-<tag>>    # the release prod runs: its db migrate reaches prod's level
WT=$PWD                                         # this worktree
npm run build                                   # the new side: $WT/dist
P2_PROD_SSH='-i ~/.ssh/<prod key> -o IdentitiesOnly=yes orion-prod@<host>' \
  /usr/bin/python3 tools/phase2-proof/prod_copy.py "$P" "$OLD" "$WT"    # read $P/copy.json; stop on any mismatch
# The NEW dist's migrations on the copy (an older release opens a newer schema); no other ORION_* in the environment.
(cd "$P/new" && ORION_HOME="$P/new" ORION_ENV_FILE="$P/new/.env" node "$WT/dist/cli/index.js" db migrate --json) \
  >"$P/migrate-new.json" 2>"$P/migrate-new.stderr"
tools/phase2-proof/reports.sh "$OLD/dist" dist "$P/old" "$P/new" <D> "$P/out"
/usr/bin/python3 tools/phase2-proof/expected.py "$P/out/old"          # once incomeStatement exists (reads yCRV's mix from $P/out/new)
/usr/bin/python3 tools/phase2-proof/compare.py "$P/out" [--parity <map>] [--reclass "$P/out/expected.json"] >"$P/compare.txt"
/usr/bin/python3 tools/phase2-proof/cleanup.py "$P"
```

Every script writes its results to files: read them, do not re-run a script to view its output (that copies prod again
and leaves a second schema behind).

Both `db migrate` runs get `ORION_HOME=<home>` and `ORION_ENV_FILE=<home>/.env`, like every `reports.sh` run.

### The two maps (required once the new side has `incomeStatement`)

If any new-side report has `incomeStatement`, `compare.py` fails unless both `--parity` and `--reclass` are given, and
together they cover the 13 assets exactly once each: AERO, CAKE, CRV, cvxCRV, HYPE, LINK, PUMP, SKY, UNI and VVV in
`--parity`; sdCRV, yCRV and LIT in `--reclass`; no asset in both, none missing, no other key (keys starting `_` are
ignored). Tolerance for both: rel 1e-12. G2 decision 2 (Mike, 2026-11-07): the residual-type fields, listed in
`compare.py` `RESIDUAL_USD_PATHS` (only `incomeStatement.unreconciled.annualized`), also pass at an absolute gap of
$0.01 or less; `unreconciled.pct` is a share (no USD floor) and `unreconciled.basis` a string, and nothing else is
loosened.

`--parity` (ruling R7; Task 3 writes `tools/phase2-proof/parity.json`) is a **path map**, not values: compare reads both
values from this run's reports, the v2 path in `new/<a>.json` and the v1 path in `old/<a>.json`.

```json
{
  "cake": [
    ["revenue", "incomeStatement.revenue.annualized", "income.revenue.annualized"],
    ["burn line", "incomeStatement.lines[id=burn].annualized", "income.lines[id=burn].annualized"]
  ]
}
```

A path missing on either side fails; `null` equals `null` only when both sides are `null`; a pair that is not three
non-empty strings (e.g. an old `[label, a, b]` value triple) fails.

`--reclass` is `expected.json` from `expected.py`: `{"<asset>": {"<v2 path>": value}}`, read on the new side.

Paths are dotted keys. A step `key[field=value]` selects the single element of the list at `key` whose `field` equals
`value` (a string), e.g. `income.lines[id=vecrv_fees].annualized`; no match or several matches count as a missing
path.

Tests: `/usr/bin/python3 -m unittest tools/phase2-proof/test_compare.py tools/phase2-proof/test_prod_copy.py` (synthetic
temp dirs, a fake `sql_ro` and a fake `psql`; no ssh, no Postgres, no live DB).
