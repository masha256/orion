# Phase 2 cross-release proof harness

Proves, after each Phase 2 task that touches the report, that `report yield <a> --json` agrees between the old release
and this branch for the 13 named assets. Since Task 11b (G4) there is no v1 report and no `--legacy`: against an old
release that prints v2, the check is "old side's v2 == new side's v2" (whole object, rel 1e-12 on numbers, everything
else exact). The parity map (Task 3) and the Reclassification Table are kept only for an old release that still prints
v1 only. Run by the controller, never
by an implementer subagent. Python is `/usr/bin/python3`, stdlib only.

| File | Does |
|---|---|
| `prod_copy.py <P> <old release dir> <new worktree>` | A read-only copy of prod (Postgres on venus) into a fresh local schema `p2proof_<UTC stamp>` in `orion_dev`, named in `<P>/schema` first. Reads prod only through `ssh <P2_PROD_SSH> sql-ro '<query>'` (`prod_ro.py`: a READ ONLY transaction as `orion_prod_ro`). Homes `<P>/old` (the OLD release's assets/personas/skills) and `<P>/new` (the worktree's), each with a two-line mode-600 `.env` (`ORION_DATABASE_URL`, `ORION_DB_SCHEMA`, the same schema). The schema is migrated by the OLD release's `db migrate --breaking --json` (`<P>/migrate-old.json`; `--breaking` because 0006 is `-- breaking` and refuses a fresh schema without it, the target is always a fresh `p2proof_*` scratch schema and prod already applied 0006) and must then sit at prod's `max(schema_migrations.id)`, with the same tables and columns. Every table is paged by id up to prod's `max(id)` read first (the page halves only when a reply is cut at orion-remote's 1 MB output cap: exit 0 with its `output truncated at 1 MB` stderr line, or exactly 1 MB; an ssh or transport failure, e.g. exit 255 with no output, aborts the copy at once and is never retried; a `json_agg` arrives as a string and is unwrapped), buffered, and inserted in one transaction (`observations.superseded_by` references `observations`); local count must equal prod's per table; sequences are set to max. Then, on `observations` per asset, `count`, `sum(value order by id)` and `max(id)` must be equal prod vs local. Everything is in `<P>/copy.json`; any mismatch exits 1. |
| `prod_ro.py '<query>'` | One read-only prod query (the same `sql-ro` path), rows printed as JSON. |
| `reports.sh <old-dist> <new-dist> <home-old> <home-new> <D> <out>` | Refuses (exit 2, before any run) unless `<out>` and both homes are strictly inside `$TMPDIR` (T0 M4), both homes name the same `p2proof_*` schema, D is `YYYY-MM-DD`, both dists exist, `<home-new>/assets` has >= 13 YAMLs and `<out>` holds no earlier output. Per asset: `report yield <a> --day D --json` with identical flags on both sides (no `--legacy`, no `--help` probe since Task 11b) -> `<out>/{old,new}/<a>.json`; then `anomalies.json` (`data anomalies --all --json`) and `proposals.json` (`proposals list --json`). stderr beside each file; every exit code in `<out>/status.tsv`. |
| `compare.py <out> [--parity p.json] [--reclass expected.json] [--json]` | One `PASS`/`FAIL` line per asset and list file, exit 0 only on a full pass; `--json` prints `{"ok": bool, "lines": [...]}` instead (T0 M6: read the result from the exit code or that object, never by grep). Per asset, by what the sides print: new side without v1 keys and old side with `incomeStatement` -> v2 vs v2, whole objects, numbers at rel 1e-12, key order/strings/null exact; new side without v1 and old side v1 only -> the header (`asset`, `day`, `windowDays`, `price`, `marketCap`, `fdv`) exactly, the figures through the maps; new side still printing v1 (a Tasks 4-10 release with `--legacy`) -> new minus `incomeStatement` equals old exactly. First differing path reported. Empty/unparseable fails, any of the 13 named assets missing on either side fails (`FAIL coverage`), a non-zero exit in `status.tsv` fails, a report whose top-level `asset` is not its file name or whose `day` is not the D in `run.txt` fails. |
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
# Task 10 (0006 drops observations.source): while the copy still has it, every row's derived origin must equal it.
# tsx from the worktree's own node_modules ($P/new has none, and npx would try the registry): no network needed.
(cd "$P/new" && ORION_DATABASE_URL=<the copy's url> ORION_DB_SCHEMA="$(cat "$P/schema")" "$WT/node_modules/.bin/tsx" "$WT/tools/phase2-proof/origin-check.ts") \
  >"$P/origin-check.json"                       # exit 0 and equal == rows; else stop: the mismatching shapes are listed
# The NEW dist's migrations on the copy (an older release opens a newer schema); no other ORION_* in the environment.
# From 0006 on the new side needs --breaking (it drops observations.source; the copy is scratch). prod_copy.py's
# old-side migrate of the fresh schema passes --breaking itself (0006 refuses a fresh schema without it).
(cd "$P/new" && ORION_HOME="$P/new" ORION_ENV_FILE="$P/new/.env" node "$WT/dist/cli/index.js" db migrate --breaking --json) \
  >"$P/migrate-new.json" 2>"$P/migrate-new.stderr"
tools/phase2-proof/reports.sh "$OLD/dist" dist "$P/old" "$P/new" <D> "$P/out"
/usr/bin/python3 tools/phase2-proof/expected.py "$P/out/old"          # only for a v1-only old side (reads yCRV's mix from $P/out/new)
/usr/bin/python3 tools/phase2-proof/compare.py "$P/out" --json [--parity <map>] [--reclass "$P/out/expected.json"] >"$P/compare.json"   # exit code = result
/usr/bin/python3 tools/phase2-proof/cleanup.py "$P"
```

Every script writes its results to files: read them, do not re-run a script to view its output (that copies prod again
and leaves a second schema behind).

Both `db migrate` runs get `ORION_HOME=<home>` and `ORION_ENV_FILE=<home>/.env`, like every `reports.sh` run.

### The two maps (only for an old release that prints v1 only)

If any new-side report has `incomeStatement` while its old side has none, `compare.py` fails unless both `--parity` and `--reclass` are given, and
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

Tests: `cd tools/phase2-proof && /usr/bin/python3 -m unittest test_compare.py test_prod_copy.py` (synthetic temp dirs,
a fake `sql_ro`, a fake `psql` and fake release CLIs; no ssh, no Postgres, no live DB). They cover every `reports.sh`
refusal (T0 M7) and the `$TMPDIR` confinement (T0 M4).
