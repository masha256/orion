# Phase 2 cross-release proof harness

Proves, after each Phase 2 task that touches the report, that the legacy `report yield <a> --json` output is
byte-identical between the old release and this branch for all 13 assets, and that the new `incomeStatement` figures
match the parity map (Task 3) or the Reclassification Table (plan, global constraints). Run by the controller, never
by an implementer subagent. Python is `/usr/bin/python3`, stdlib only.

| File | Does |
|---|---|
| `snapshot.sh <P>` | `.backup` of live opened `mode=ro` -> `<P>/snap.db` (integrity_check `ok`); names `p2proof_<UTC stamp>` in `<P>/schema`; homes `<P>/old`, `<P>/new` (assets/personas/skills + mode-600 `.env` with only `ORION_DATABASE_URL`, `ORION_DB_SCHEMA`); `db migrate --json` with the NEW dist; `tools/import-sqlite` `import` then `proof` (refuses on any table or sequence mismatch). |
| `reports.sh <old-dist> <new-dist> <home-old> <home-new> <D> <out>` | Both homes must name the same schema. Per asset of `<home-new>/assets/*.yaml` (>= 13): `report yield <a> --day D --json` (new side adds `--legacy` only if its `--help` lists it) -> `<out>/{old,new}/<a>.json`; then `anomalies.json` (`data anomalies --all --json`) and `proposals.json` (`proposals list --json`). stderr beside each file; every exit code in `<out>/status.tsv`. |
| `compare.py <out> [--parity p.json] [--reclass expected.json]` | One `PASS`/`FAIL` line per asset and list file, exit 0 only on a full pass. New side minus `incomeStatement` must equal old exactly (key order, types, numbers; raw bytes too when there is no `incomeStatement`); first differing path reported. Empty/unparseable fails, < 13 assets fails, a non-zero exit in `status.tsv` fails. |
| `expected.py <out>/old [--ycrv-styc-separate]` | Writes `<out>/expected.json`: the Reclassification Table for sdCRV, yCRV, LIT from the old side's JSON, keyed by v2 dotted path. |
| `cleanup.py <P>` | `DROP SCHEMA "<P/schema>" CASCADE` in `orion_dev`, then `shutil.rmtree(<P>)`. Refuses a `<P>` outside `$TMPDIR` or a schema not matching `^p2proof_[0-9a-z_]+$`. |

Env overrides for `snapshot.sh`: `P2_NEW_DIST` (default `<worktree>/dist`), `P2_SOURCE_DB` (default the live
`orion.db`, only ever opened `mode=ro`), `P2_OLD_CONFIG` (source of the old home's `assets/ personas/ skills/`;
default the worktree).

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
leaves a second schema behind). `--parity` takes `{"<asset>": [[label, a, b], ...]}` and is required, once the new side
has `incomeStatement`, for AERO, CAKE, CRV, cvxCRV, HYPE, LINK, PUMP, SKY, UNI and VVV; `--reclass` for sdCRV, yCRV, LIT.
Tolerance for both: rel 1e-12.

Tests: `/usr/bin/python3 -m unittest tools/phase2-proof/test_compare.py` (synthetic temp dirs; no Postgres, no live DB).
