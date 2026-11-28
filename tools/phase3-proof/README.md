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
| `r2-allowlist.json` | The R2 (price swap) allowlist, from the Task 10 proof Mike signed 2026-11-15 (below). |
| `r2-allowlist-r43.json` | `r2-allowlist.json` plus Mike's R43 acceptances (2026-11-17, stage step 10): the allowlist prod's step 10 ran with (below). |
| `r2-prod-6to10.sh` | Reference only: the one script prod's R2 steps 6 (`--yes`) to 10 ran as, under Mike's conditional pre-approval (2026-11-18), stopping at the first deviation (below). |
| `r3-s0.sh` .. `r3-s4.sh`, `r3-lib.sh`, `r3_check.py` | The R3 release block's five scripts (docs/ops/deploy.md "Phase 3 R3 release": s0 steps 0-1, s1 2-4, s2 5-6, s3 7-8, s4 9-10), their shared shell part (arguments, the ssh calls, the `--fake <dir>` mode and its slug rule) and their checks (one subcommand each; expected counts only from step 1's `~/r3-<env>/expected.json`); s2 and s3 take `--resume` after a STOP inside their `--yes` loop. |
| `test_r3_scripts.py`, `fixtures/r3/` | The scripts in `--fake` mode: a happy path per script, one STOP per artifact (incl. the wrappers' old-locator count, leftovers after `--yes`, the step-4 pre-check), the step-4 levels race, and `--resume`. `python3 -m unittest tools/phase3-proof/test_r3_scripts.py`; `fixtures/r3/generate.py` rewrites the fixtures. |
| `r4-backfill.sh <stage\|prod> [--expect-fees <n>] [--fake <dir>]`, `r4_check.py` | Phase 3 R4's history step on an env already on the R4 release (docs/ops/deploy.md "Phase 3 R4 release" step 3): the `flow_usd.fees` purge (sql-ro counts, dry run, `--yes` only on a typed `yes`, the export printed), then `job run-now backfill aero` for the five pool metrics in 7-day chunks (at most ceil(missing / 7) + 1 jobs, each waited for), then the sql-ro check of one active row per metric per day 2026-10-22 -> yesterday; refuses the backfill gate and the RPC quiet windows. Its checks are `r4_check.py` subcommands; `--fake` follows r3-lib.sh's slug rule. |
| `r4_acceptance.py <orion rows> <defillama json> [--to D] [--dl-stamp end\|start]` | DEV-ONLY, offline (saved files only): per day 2026-10-23 -> D, `voter_fees + vote_incentives + protocol_subsidy` vs DefiLlama holders revenue, FAIL past ±3% (2026-10-22 exempt). `--print-sql` prints the sql-ro query whose saved result it reads. |
| `r4-allowlist.json` | The R4 gate skeleton: AERO paths only, every entry a `todo` placeholder (allows nothing); Task 10 fills it from the prod-copy proof. |
| `r4-gen-scan.py --scoping <dir> [--indent 10]` | Generates `assets/aero.yaml`'s pool-scan block from the R4 scoping files (`--indent 10` reproduces it byte for byte). |
| `test_r4.py`, `fixtures/r4/` | All of the above: the acceptance rules, the window and chunk rules, the backfill script in `--fake` mode (happy path, every STOP), the allowlist skeleton, and the generator (`R4_SCOPING_DIR=<scoping dir>` enables the byte-for-byte check). `python3 -m unittest tools/phase3-proof/test_r4.py` |

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
  `rel` / `abs` (optional, finite, >= 0), `ratio` (optional, `[lo, hi]`: two finite numbers, 0 < lo <= hi), `old` /
  `new` (optional, any JSON value), `absent` (optional, `"old"` or `"new"`), `todo` (optional bool). Any other key, a
  malformed value (a `ratio` that is not such a pair included), a duplicate key (an asset listed twice, say: JSON
  would keep only the last) or a glob that is blank or starts with `*` (a bare `*` would allow everything; name the
  first path segment literally) exits 2.
- Glob: only `*` is special and matches any run of characters including `.` and `[...]`; brackets are literal; the
  glob must match the whole path. `incomeStatement.volume.*` does not match `incomeStatement.volume` itself (list both
  when the object itself may become null).
- A differing path is allowed when at least one applicable entry (`<asset>`'s or `*`'s) matches it and every matching
  entry holds. An entry without `rel`/`abs`/`ratio` holds for any change (added, removed, any type). A bounded entry
  holds only for a numeric change with `|new - old| <= abs`, `|new - old| / |old| <= rel` or `lo <= new / old <= hi`
  (`ratio`): any one of its bounds, when several are given. The ratio is signed (old -10, new -9 is 0.9; a sign change
  never holds); with old = 0, rel and ratio hold only when nothing changed. So a broad unbounded glob never loosens a
  bounded entry on the same path, and a bounded path that turns null fails.
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

`r2-allowlist.json` (Phase 3 R2, used by docs/ops/deploy.md "Phase 3 R2 release" step 10 for D and D-91): built from
the Task 10 proof on the prod copy, old release `orion-2026.11.12.1` before any chain price vs this branch after the
prices backfill, `data reprice`, `data rebuild-price-levels` and both purges, report days 2026-11-13 and 2026-08-14
(13 assets x 2 = 26 reports; signed table: the proof's `C2/headline.txt`). flatdiff exits 0 on all 26 pairs.
- Bounds (ruling R41): every bound = max(the fitted bound, the class floor). The fitted bound is 2x the measured max
  |rel| over both days (rounded up to 3 significant figures; `growth.change`, `growth.annualized`, `yields.pegTrailing`
  and `unreconciled.*` use `abs` = 2x the measured max |abs|, since their base can be near or cross zero; five
  float-noise paths, measured rel <= 3.4e-16, floored at rel 1e-12). The class floors come from the measured 90-day
  hourly |chain/CoinGecko - 1| p99 on the copy (the proof's `gap-90d.txt`):
  - (a) single-instant price-derived (`price`, `marketCap`, `fdv`, `priceBasis.price`, `perToken` dilution and
    `netOfDilution`, `holderFlow.netOfDilution`, `yields.*`, line / bucket `yield`): rel = 2x the asset's price-token
    p99 rounded up to 0.5%: CAKE 0.06, CRV 0.06, LINK 0.055, SKY 0.035, UNI 0.075, VVV 0.07, SDCRV 0.07, YCRV 0.10;
    0.10 where no CoinGecko pair was measured (HYPE, LIT, PUMP, AERO, CVXCRV).
  - (b) USD flow aggregates (`revenue`, `costOfRevenue`, `grossProfit`, `holders`, `protocol`, `operatingCosts`,
    `holderFlow`, `belowLine`, `volume`, their lines and buckets: `annualized`, `gross`, `net`, `fromRevenue`,
    `fromBelowLine`, `windowSum`, `apportion.bySum` / `totalSum`, ...; the `perToken` flows; `unreconciled.annualized`):
    rel 0.02.
  - (c) growth: `.change` abs 0.05, `.annualized` abs 0.2, `.current` / `.prior` rel 0.02.
  - (d) `yields.pegTrailing`, `yields.multiple`, `multiples.*`: rel 0.25. Where the fitted bound is the other kind
    (`pegTrailing` abs, YCRV `unreconciled.annualized` abs) the entry keeps both (either holds).
  Each class entry is an exact path, one for every path of its class present in the asset's proof reports (old or
  new, either day), whether or not it moved there; each reason names the class, the floor and its source. Fitted
  entries outside the classes keep their 2x proof bound (`ratios.payoutRatio`, `provenance.methods.*`,
  `apportion.mix`, `unreconciled.pct`). Largest bounds: (a) rel 0.153 (PUMP `yields.netShareholder`, fitted); (b) rel
  0.022 (SDCRV bribes line, fitted); (c) rel 0.157 (CAKE `protocol.growth.prior` and treasury lines, fitted), abs 1.3
  (VVV burn `growth.annualized`, fitted); (d) rel 0.25 (floor).
- Text: `*` pins `incomeStatement.priceBasis.flows` (same old/new on all 13); per asset `priceBasis.source` /
  `sourceType` (market_data:coingecko -> contract_state / first_party_api `price.token`) and each line's `priceBasis`
  (`mixed` -> `hourly`; PUMP `legacy` -> `mixed`) are value-pinned to the proof's values.
- No entry for token amounts, supply, grades, counts or any non-USD field (`dilution.*`, `yields.dilution`,
  `yields.dilutionLines`, line `share` / `haircut`; none differed). AERO gets class (a) entries only (25 paths: its
  flows are not repriced in R2, so revenue, holder flow and growth stay exact; its `multiples.*` and `yields.*` are
  mcap over exact flows and take the (a) floor 0.10). No `todo` placeholder.
- The release compares the env's own default day `d` and `d` - 91. A move beyond a floor, a path absent from the
  proof's reports (a new line id), or a ratio outside the classes moving beyond its 2x proof bound fails closed (exit
  1: stop and bring it to Mike (deploy.md step 10), never widen a bound on the spot.

`r2-allowlist-r43.json` (ruling R43, Mike 2026-11-17 "Accepted"; prod's step 10 ran with it: 26/26 exit 0): every
entry of `r2-allowlist.json` at `orion-2026.11.15.1` unchanged, plus the 9 paths stage's step 10 stopped on (22/26
passed with `r2-allowlist.json`). Each changed entry's reason starts its R43 part with `R43 (Mike 2026-11-17`;
`test_flatdiff.py` pins that exactly these 9 differ from `r2-allowlist.json`:
- CAKE, LINK `incomeStatement.provenance.methods.measured`: abs 1e-12. Float rounding of a share that sums to 1
  (`1` <-> `1.0000000000000002`); the R2 proof never showed it, so it had no entry.
- PUMP `incomeStatement.ratios.payoutRatio`: rel 0.001. It follows PUMP's -0.04% flow reprice; stage moved -0.01%
  (0.45993 -> 0.45988). The proof showed no move there, so (R42: no class for ratios) it had no entry.
- SKY `growth.change` / `growth.annualized` of `holderFlow.lines[id=stakers]`, `holders.lines[id=stakers]` and
  `revenue.lines[id=surplus_usds]` (6 paths): the R41 abs floor kept, rel 0.001 added (either holds). The prior window
  is tiny (prior $24.3k vs current $7.05M, a ~289x change), so a 0.018% reprice moved `.change` 289.284 -> 289.336
  (abs 0.052 > the 0.05 floor) and `.annualized` (~7.56e9) far past its abs 0.2.

**Lesson (for every later allowlist): an abs floor on a growth figure needs a rel alternative when the prior period
is tiny.** `change` = current / prior - 1 and `annualized` compound it, so a tiny prior makes both huge, and the same
small relative reprice that the class floors were built for becomes a large absolute move. Give each `growth.change` /
`growth.annualized` class entry both bounds: the abs floor (it holds where the base is near or crosses zero, as R41
intended) and a rel alternative (R43: rel 0.1%, ~5x the measured 0.018-0.02%), since an entry holds when either
does. Before signing an allowlist, check the proof reports for any line whose prior window is under ~1% of its
current.

`r2-prod-6to10.sh` is kept as the worked example of the runbook rule "put pre-approved `--yes` steps and their
condition checks into ONE script that exits at the first deviation" (each separate call can raise its own approval
prompt). It is a record, not runnable as is: it sources the session file `$TMPDIR/r2prod.sh` (defines `A`, `day`,
`d91` and `PR`, as in deploy.md R2 step 0), writes under `~/r2-prod/`, reads the addendum from Raymond's workspace and
runs flatdiff from the release worktree `.worktrees/rel-r2-prod` (removed after the release). Its yCRV `compare-usd`
re-check after step 6 is the one deploy.md step 5 now documents.

## R3 (circulating supply): the `ratio` bound

Class S of the R3 allowlist (plan N4: the circulating-derived paths `marketCap`, `multiples.mcapTo*`,
`perToken.{revenue,grossProfit,holderFlow.*,dilution,circulatingSupply}` on the 12 changed assets) uses `ratio`: the
signed proof's new/old ratio +- 0.01, e.g. `{"glob": "marketCap", "ratio": [1.24, 1.26], "reason": "..."}`. It is
relative by construction, so a multiple over a near-zero base holds where an abs floor would not; class S has no
abs-only entry. Class L (source labels) uses exact `old`/`new` pins. The R43 lesson above still binds class G: a
growth `.change` / `.annualized` entry, should the proof ever force one, carries the abs floor AND a rel alternative.

## R4 (AERO revenue on chain): history and acceptance

`r4-backfill.sh` runs after the deploy (on the old release `data purge` refuses the still-configured `flow_usd.fees`,
`purge_configured_metric`): purge, backfill, verify in one call. It resumes: a purge already done is skipped, and each
job scans the oldest missing days, so a STOP mid-loop is fixed and rerun. The purge prompt reads stdin and the ssh
calls use `-n`, so `echo yes | r4-backfill.sh <env>` works once the dry-run lines were read. `r4_acceptance.py` is the
spec's ±3% DefiLlama comparison (dev reference only, never in `src/`): save Orion's rows (`data show aero --json`, or
`sql-ro` with its `--print-sql` query) and a DefiLlama holders-revenue download first; it reads nothing else. Its
default `--dl-stamp end` reads a row stamped D+1 as day D; the R4 scoping measured `api.llama.fi`'s `aero-protocol`
chart as stamped D for day D (`--dl-stamp start`), so check the saved file's convention before trusting a FAIL. The
live golden `tests/live/aeroPoolScan.live.test.ts` (`ORION_LIVE_RPC=1`, RPC URLs from the environment) re-reads
2026-11-26 against `tests/fixtures/poolscan/live-2026-11-26.json` (0.5% or $1 per chain and figure).

## Run (controller)

```bash
python3 tools/phase3-proof/flatdiff.py before/<a>.json after/<a>.json --allow tools/phase3-proof/r1-allowlist.json \
  --asset <a> --json > flatdiff/<a>.json    # exit code = result; 2 means an input was missing/empty/not a report
```

Run it per asset over both windows (D and D-91), and `cmp` AERO's two files as well. On the release itself
(docs/ops/deploy.md, Phase 3 R1 release) it runs right after the switch, before any refresh: a refresh writes level
observations inside report day D's asOf (the end of D + 1) and moves price, market cap and every yield.
