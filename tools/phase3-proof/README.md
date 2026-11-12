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

No two values share a path. A backslash, `.` or `[` inside a key is escaped with a backslash (`{"a.b": 1}` is
`a\.b`, `{"a": {"b": 1}}` is `a.b`). A number id is tagged `#` (`[id=#1]`); a string id escapes a backslash, `]`
and a leading `#` (`[id=1]` is the string `"1"`). Should two values still flatten to one path, or a file repeat a key,
flatdiff exits 2. Real reports use identifier keys and string ids, so their paths carry no escapes.

## Allowlist format

```json
{
  "_comment": "keys starting with _ are ignored",
  "*":   [ { "glob": "<path glob>", "reason": "<why>" } ],
  "lit": [ { "glob": "incomeStatement.dilution.releases[id=unlocks].tokensPerYear", "rel": 0.0007, "reason": "<why>" } ]
}
```

- Keys: an asset id, or `*` (applies to every asset). Entry keys: `glob` (required), `reason` (required, non-empty),
  `rel` / `abs` (optional, finite, >= 0), `old` / `new` (optional, any JSON value), `absent` (optional, `"old"` or
  `"new"`), `todo` (optional bool). Any other key, a malformed value, a duplicate key
  (an asset listed twice, say: JSON would keep only the last) or a glob that is blank or starts with `*` (a bare `*`
  would allow everything; name the first path segment literally) exits 2.
- Glob: only `*` is special and matches any run of characters including `.` and `[...]`; brackets are literal; the
  glob must match the whole path. `incomeStatement.volume.*` does not match `incomeStatement.volume` itself (list both
  when the object itself may become null).
- A differing path is allowed when at least one applicable entry (`<asset>`'s or `*`'s) matches it and every matching
  entry holds. An entry without `rel`/`abs` holds for any change (added, removed, any type). A bounded entry holds only
  for a numeric change with `|new - old| <= abs` or `|new - old| / |old| <= rel` (either, when both are given; with
  old = 0, rel holds only when nothing changed). So a broad unbounded glob never loosens a bounded entry on the same
  path, and a bounded path that turns null fails.
- Value pins (any entry, checked before a bound): `old` / `new` require that side to be present and equal to the
  value (numbers by value, `2` == `2.0`; anything else by type and value, so `[]` is not `{}`; `"old": null` pins the
  value null). `"absent": "old"` requires the path to be `added`, `"absent": "new"` `removed`; `absent` naming a side
  that also carries a value exits 2. So `{"glob": "incomeStatement.flags[0]", "old": "third_party: x", "absent":
  "new"}` allows only the removal of exactly that flag: a replacement value at `[0]` fails.
- Positional paths: an index (`flags[3]`, `provenance.sources[2]`) is where the entry sits in the prod-copy run's
  report. Another env may hold it at another index (the golden fixture has VVV's flag at `[2]`, prod at `[3]`): there
  flatdiff fails closed (the pinned value doesn't match, or the path has no entry). Re-derive the index from that env's
  pre-deploy report (`before/<a>.json`), keep the pinned value, and re-run; never drop the pin.
- `"todo": true` marks a placeholder: inert (allows nothing), listed as `WARN todo`. The controller replaces each one
  with the exact paths the first diff run shows (each with its reason) and removes the flag.
- An applicable entry that matched no differing path is listed as `WARN unmatched` (no effect on the exit code).

`r1-allowlist.json` (brief Step 2): CAKE, UNI `incomeStatement.volume` and `incomeStatement.volume.*` (volume becomes
not_measured); LIT the unlocks line's `tokensPerYear` at rel 0.0007 (the +0.066%: Lighter's 500M vs DefiLlama's
499.67M). LIT has no unbounded dilution glob (fix round 1): `dilution.releases[id=unlocks].id`,
`dilution.emissionsPerYear` and `dilution.supply.burnedPerYear` (buyback burns: holder flow) are exact (abs 0),
`dilution.supply.addedPerYear` is rel 0.0007 and `dilution.supply.netPct` abs 0.00013 (final review I-2), so a release line added or
removed has no entry and fails. Ruling R21: the change flows into every dilution-derived field, so
LIT also bounds at rel 0.0007 `yields.dilution`, `perToken.dilution`, `perToken.perTokenFdv.dilution`,
`dilution.pct`, `dilution.tokensPerYear`, the unlocks line's `yield` (`dilution.releases[id=unlocks]`) and both fields
of `yields.dilutionLines[id=unlocks]` (all under `incomeStatement.`), and `dilution.supply.netPerYear` at abs 120000
tokens (added minus burned, so its relative change can exceed 0.07%). The two abs bounds are date-bound: the delta is
~9,210 tokens per monthly tranche in the (now, now + 365 d] window, 10 tranches on 2026-11-12, 11 from 2026-11-29, 12
from 2026-12-29 (netPerYear 92,100 / 101,310 / 110,520; netPct 9.38e-5 / 1.03e-4 / 1.13e-4). abs 120000 / 0.00013
cover the 10-12 tranche range and are valid for a release run through 2027-01-28; re-derive them after that. The four net-of-dilution fields
(`holderFlow.netOfDilution`, `perToken.holderFlow.netOfDilution`, `perToken.perTokenFdv.holderFlow.netOfDilution`,
`yields.netShareholder`) each get their own rel 0.0008: net = holder flow - dilution, so the +0.066% moves the net by
~0.073% (the prod-copy run: rel 0.000729). PUMP has the R21 paths at rel 1e-12. VVV the business line's `crossCheck`
fields. Provenance / flags (controller addendum, from the prod-copy run; exact paths, no globs): LIT
`incomeStatement.flags`, `flags[0]`, `provenance.thirdParty`, `provenance.thirdParty[0]`; VVV `flags[3]`,
`provenance.sources[2]`, `provenance.thirdParty`, `provenance.thirdParty[0]`, `provenance.thirdParty[1]`. Each is
value-pinned to the run's value (final review Minor 1): LIT `flags[0]` old `"third_party: holders.buyback.cross_checks"`
and `provenance.thirdParty[0]` old `"holders.buyback.cross_checks"`, each absent in new; LIT `flags` and
`provenance.thirdParty` absent in old, new `[]`; VVV `flags[3]` old `"third_party: revenue.business.cross_check,
holders.burn.cross_checks"`, `provenance.sources[2]` old `"third_party:api.llama.fi"`, `provenance.thirdParty[0]` old
`"revenue.business.cross_check"`, `[1]` old `"holders.burn.cross_checks"`, each absent in new; VVV
`provenance.thirdParty` absent in old, new `[]`. Every other
asset showed no provenance / flags / checks diff and has no entry there. No `todo` placeholder remains. AERO has no entry (its report
must be `cmp`-identical); revenue, cost of revenue, holder flow and grades get none beyond the R21 dilution-derived
fields.

## Run (controller)

```bash
python3 tools/phase3-proof/flatdiff.py before/<a>.json after/<a>.json --allow tools/phase3-proof/r1-allowlist.json \
  --asset <a> --json > flatdiff/<a>.json    # exit code = result; 2 means an input was missing/empty/not a report
```

Run it per asset over both windows (D and D-91), and `cmp` AERO's two files as well. On the release itself
(docs/ops/deploy.md, Phase 3 R1 release) it runs right after the switch, before any refresh: a refresh writes level
observations inside report day D's asOf (the end of D + 1) and moves price, market cap and every yield.
