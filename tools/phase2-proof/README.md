# Phase 2 cross-release proof harness

Proves, after each Phase 2 task that touches the report, that the legacy `report yield <a> --json` output is
byte-identical between the old release and this branch for all 13 assets, and that the new `incomeStatement` figures
match the parity map (Task 3) or the Reclassification Table (plan, global constraints). Run by the controller, never
by an implementer subagent. Python is `/usr/bin/python3`, stdlib only.

| File | Does |
|---|---|
| `snapshot.sh <P>` | `.backup` of live opened `mode=ro` -> `<P>/snap.db` (integrity_check `ok`); names `p2proof_<UTC stamp>` in `<P>/schema`; homes `<P>/old`, `<P>/new` (assets/personas/skills + mode-600 `.env` with only `ORION_DATABASE_URL`, `ORION_DB_SCHEMA`); `db migrate --json` with the NEW dist; `tools/import-sqlite` `import` then `proof` (refuses on any table or sequence mismatch). |
| `reports.sh <old-dist> <new-dist> <home-old> <home-new> <D> <out>` | Both homes must name the same schema. Per asset of `<home-new>/assets/*.yaml` (>= 13): `report yield <a> --day D --json` (new side adds `--legacy` only if its `--help` lists it) -> `<out>/{old,new}/<a>.json`; then `anomalies.json` (`data anomalies --all --json`) and `proposals.json` (`proposals list --json`). stderr beside each file; every exit code in `<out>/status.tsv`. |
| `compare.py <out> [--parity p.json] [--reclass expected.json]` | One `PASS`/`FAIL` line per asset and list file, exit 0 only on a full pass. New side minus `incomeStatement` must equal old exactly (key order, types, numbers; raw bytes too when there is no `incomeStatement`); first differing path reported. Empty/unparseable fails, < 13 assets fails, a non-zero exit in `status.tsv` fails, a report whose top-level `asset` is not its file name or whose `day` is not the D in `run.txt` fails. Once the new side has `incomeStatement`, `--parity` and `--reclass` are both required (see below). |
| `expected.py <out>/old [--ycrv-styc-separate]` | Writes `<out>/expected.json`: the Reclassification Table for sdCRV, yCRV, LIT from the old side's JSON, keyed by v2 dotted path. yCRV `unreconciled` = revenue − `ybs_payout` − `treasury` (ruling R6: the st-yCRV fee has no v2 line, so it is never subtracted); with `--ycrv-styc-separate`, revenue adds `styc_fee` and unreconciled subtracts it too. |
| `cleanup.py <P>` | `DROP SCHEMA "<P/schema>" CASCADE` in `orion_dev`, then `shutil.rmtree(<P>)`. Refuses a `<P>` outside `$TMPDIR` or a schema not matching `^p2proof_[0-9a-z_]+$`. |

Env overrides for `snapshot.sh`: `P2_NEW_DIST` (default `<worktree>/dist`), `P2_SOURCE_DB` (default the live
`orion.db`, only ever opened `mode=ro`), `P2_OLD_CONFIG` (source of the old home's `assets/ personas/ skills/`;
default the worktree).

Every `reports.sh` run, both sides and the `--help` probe, gets `ORION_HOME=<home>` and `ORION_ENV_FILE=<home>/.env`:
a release refuses to run without both. When the old side is an extracted release (a directory holding `RELEASE` beside
`dist/`, e.g. `orion-2026.11.04.2/dist`), its config root is the release directory itself (`src/cli/paths.ts`
`resolvePaths`), so it reads its own `assets/`, `personas/` and `skills/`, not the copy in the old home: the old home
then supplies only the `.env` (the database) and the data home, and `P2_OLD_CONFIG` only matters for an old dist that
is not a release.

## Run (controller)

```bash
P=$TMPDIR/p2proof-$(date -u +%Y%m%dT%H%M%SZ)
npm run build                                   # the new side: <worktree>/dist
tools/phase2-proof/snapshot.sh "$P"             # read $P/proof.json; stop on any mismatch
tools/phase2-proof/reports.sh <old>/dist dist "$P/old" "$P/new" <D> "$P/out"
/usr/bin/python3 tools/phase2-proof/expected.py "$P/out/old"          # once incomeStatement exists
/usr/bin/python3 tools/phase2-proof/compare.py "$P/out" [--parity <map>] [--reclass "$P/out/expected.json"] >"$P/compare.txt"
/usr/bin/python3 tools/phase2-proof/cleanup.py "$P"
```

Every script writes its results to files: read them, do not re-run a script to view its output (that imports again and
leaves a second schema behind).

`snapshot.sh`'s `db migrate` gets `ORION_HOME=<P>/new` and `ORION_ENV_FILE=<P>/new/.env`, like every `reports.sh` run.

### The two maps (required once the new side has `incomeStatement`)

If any new-side report has `incomeStatement`, `compare.py` fails unless both `--parity` and `--reclass` are given, and
together they cover the 13 assets exactly once each: AERO, CAKE, CRV, cvxCRV, HYPE, LINK, PUMP, SKY, UNI and VVV in
`--parity`; sdCRV, yCRV and LIT in `--reclass`; no asset in both, none missing, no other key (keys starting `_` are
ignored). Tolerance for both: rel 1e-12.

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

Tests: `/usr/bin/python3 -m unittest tools/phase2-proof/test_compare.py` (synthetic temp dirs; no Postgres, no live DB).
