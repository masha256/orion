# Phase 3 R1 proof: flattening diff + allowlist

The R1 release proof (plan Task 7) compares each asset's `report yield <a> --day D --json` before (prod's current
release) and after (this branch) on a read-only prod copy. Most fields must be identical; a known set may differ
within bounds, listed in `r1-allowlist.json`. Python is `/usr/bin/python3`, stdlib only. Steps 3-8 (the copy, the
fetches, the runs, the purge and backfill rehearsals) are the controller's; this directory holds only the tools.

| File | Does |
|---|---|
| `flatdiff.py <old.json> <new.json> --allow <allowlist.json> --asset <a> [--json]` | Flattens both reports to `path -> scalar` and lists every differing path (`added`, `removed`, `changed`, old -> new) as ALLOWED or NOT ALLOWED, then warnings for allowlist entries that matched nothing and for `todo` placeholders. Exit 0 iff every differing path is allowed, 1 otherwise, 2 on bad input. |
| `test_flatdiff.py` | Unit tests: `python3 -m unittest tools/phase3-proof/test_flatdiff.py` |
| `r1-allowlist.json` | The R1 allowlist (brief Step 2). |

## Paths

Dict keys are joined with `.` (`incomeStatement.volume.annualized`). A list whose elements are all objects with a
unique scalar `id` is keyed by it (`incomeStatement.dilution.releases[id=unlocks].tokensPerYear`,
`incomeStatement.revenue.lines[id=business].crossCheck.metric`), any other list by index
(`incomeStatement.provenance.thirdParty[0]`). An empty object or list is a leaf (`{}` / `[]`), so a list emptied by
R1 shows as `[0]` removed plus the `[]` leaf added. Two numbers of equal value are equal (`2` vs `2.0`); `true` is not
`1`. The top-level `asset` of both files must be `--asset`.

## Allowlist format

```json
{
  "_comment": "keys starting with _ are ignored",
  "*":   [ { "glob": "<path glob>", "reason": "<why>" } ],
  "lit": [ { "glob": "incomeStatement.dilution.releases[id=unlocks].tokensPerYear", "rel": 0.0007, "reason": "<why>" } ]
}
```

- Keys: an asset id, or `*` (applies to every asset). Entry keys: `glob` (required), `reason` (required, non-empty),
  `rel` / `abs` (optional, finite, >= 0), `todo` (optional bool). Any other key, or a malformed value, exits 2.
- Glob: only `*` is special and matches any run of characters including `.` and `[...]`; brackets are literal; the
  glob must match the whole path. `incomeStatement.volume.*` does not match `incomeStatement.volume` itself (list both
  when the object itself may become null).
- A differing path is allowed when at least one applicable entry (`<asset>`'s or `*`'s) matches it and every matching
  entry holds. An entry without `rel`/`abs` holds for any change (added, removed, any type). A bounded entry holds only
  for a numeric change with `|new - old| <= abs` or `|new - old| / |old| <= rel` (either, when both are given; with
  old = 0, rel holds only when nothing changed). So a broad unbounded glob never loosens a bounded entry on the same
  path, and a bounded path that turns null fails.
- `"todo": true` marks a placeholder: inert (allows nothing), listed as `WARN todo`. The controller replaces each one
  with the exact paths the first diff run shows (each with its reason) and removes the flag.
- An applicable entry that matched no differing path is listed as `WARN unmatched` (no effect on the exit code).

`r1-allowlist.json` (brief Step 2): CAKE, UNI `incomeStatement.volume` and `incomeStatement.volume.*` (volume becomes
not_measured); LIT `incomeStatement.dilution.*` (no bound) and the unlocks line's `tokensPerYear` at rel 0.0007 (the
+0.066%: Lighter's 500M vs DefiLlama's 499.67M). Ruling R21: the change flows into every dilution-derived field, so
LIT also bounds at rel 0.0007 `yields.dilution`, `yields.netShareholder`, `holderFlow.netOfDilution`,
`perToken.dilution`, `perToken.holderFlow.netOfDilution`, `perToken.perTokenFdv.*`, `dilution.pct`,
`dilution.tokensPerYear`, the unlocks line's `yield` (`dilution.releases[id=unlocks]`) and both fields of
`yields.dilutionLines[id=unlocks]` (all under `incomeStatement.`), and `dilution.supply.netPerYear` at abs 100000
tokens (added minus burned, so its relative change can exceed 0.07%). PUMP has the same paths at rel 1e-12. VVV the
business line's `crossCheck` fields. All 12 changed assets: TODO placeholders for the provenance / flags / checks
listing paths (`incomeStatement.provenance.thirdParty*`, `incomeStatement.provenance.sources*`,
`incomeStatement.flags*`, `incomeStatement.checks*`), filled from the first diff run. AERO has no entry (its report
must be `cmp`-identical); revenue, cost of revenue, holder flow and grades get none beyond the R21 dilution-derived
fields.

## Run (controller)

```bash
python3 tools/phase3-proof/flatdiff.py before/<a>.json after/<a>.json --allow tools/phase3-proof/r1-allowlist.json \
  --asset <a> --json > flatdiff/<a>.json    # exit code = result; 2 means an input was missing/empty/not a report
```

Run it per asset over both windows (D and D-91), and `cmp` AERO's two files as well.
