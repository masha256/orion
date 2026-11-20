#!/usr/bin/env bash
# Phase 3 R3 release block, script s2: step 5 (stale-definition coverage) and step 6 (rebuild: 13 dry runs and their
# checks, then --yes, yes == dry, a second dry run, and step 5's re-check). One script = one approval: on prod it runs
# only on Mike's go (or under his conditional pre-approval of this stage). docs/ops/deploy.md; --fake: r3-lib.sh.
#   tools/phase3-proof/r3-s2.sh <stage|prod> [--fake <dir>]
set -u
. "$(dirname "$0")/r3-lib.sh"
r3_args "$@"
[ ${#POS[@]} -eq 1 ] || stop "usage: r3-s2.sh <stage|prod> [--fake <dir>]"
need_expected
E=$W/expected.json

say "5 stale-definition coverage (exempt: step 1's market_data and wrapper old-locator rows)"
Q supply > "$W/dry/supply-pre.json" || stop "sql-ro supply exit $?"
$CHECK stale "$W/dry/supply-pre.json" "$E" pre || exit 1

say "6 rebuild dry runs (13)"
for a in $A; do
  R data rebuild-supply-levels $a > "$W/dry/rebuild-$a.json"; rc=$?
  $CHECK rebuild-dry "$W/dry/rebuild-$a.json" $rc $a "$E" || exit 1
done

say "6 rebuild --yes (13)"
for a in $A; do
  R data rebuild-supply-levels $a --yes > "$W/yes/rebuild-$a.json"; rc=$?
  $CHECK same-rebuild "$W/dry/rebuild-$a.json" "$W/yes/rebuild-$a.json" $rc $a || exit 1
done

say "6 second dry runs (rebuild 0)"
for a in $A; do
  R data rebuild-supply-levels $a > "$W/yes/rebuild-again-$a.json"; rc=$?
  $CHECK rebuild-again "$W/yes/rebuild-again-$a.json" $rc $a "$E" || exit 1
done

say "5 re-check after --yes (left: the notRebuildable market_data rows, cleared by step 7)"
Q supply > "$W/yes/supply-rebuilt.json" || stop "sql-ro supply exit $?"
$CHECK stale "$W/yes/supply-rebuilt.json" "$E" rebuilt || exit 1
echo "s2 done"
