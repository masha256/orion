#!/usr/bin/env bash
# Phase 3 R3 release block, script s2: step 5 (stale-definition coverage) and step 6 (rebuild: 13 dry runs and their
# checks, then --yes, yes == dry, a second dry run, and step 5's re-check). One script = one approval: on prod it runs
# only on Mike's go (or under his conditional pre-approval of this stage). docs/ops/deploy.md; --fake: r3-lib.sh.
#   tools/phase3-proof/r3-s2.sh <stage|prod> [--resume] [--fake <dir>]
# --resume (only after a STOP part way through the --yes loop, on Mike's go): instead of step 5's "stale = step 1's"
# check, per asset the rows already rebuilt since step 1 (active rows whose locator carries `rebuilt`, less step 1's
# count of them) + the stale rows left = step 1's stale count; each dry run must show step 1's counts less those already
# rebuilt; --yes runs only where rows are left to rebuild; then the same yes == dry, second dry runs and re-check. Its
# files are dry/resume-*, yes/resume-* (the first run's stay).
set -u
. "$(dirname "$0")/r3-lib.sh"
r3_args "$@"
[ ${#POS[@]} -eq 1 ] || stop "usage: r3-s2.sh <stage|prod> [--resume] [--fake <dir>]"
need_expected
E=$W/expected.json
P=""; [ -n "$RESUME" ] && P=resume-

if [ -n "$RESUME" ]; then
  say "5 stale coverage on --resume (already rebuilt since step 1 + remaining stale = step 1's stale, per asset)"
  Q supply > "$W/dry/supply-resume.json" || stop "sql-ro supply exit $?"
  $CHECK stale "$W/dry/supply-resume.json" "$E" resume || exit 1
else
  say "5 stale-definition coverage (exempt: step 1's market_data and wrapper old-locator rows; kept rows = step 1's, R15)"
  Q supply > "$W/dry/supply-pre.json" || stop "sql-ro supply exit $?"
  $CHECK stale "$W/dry/supply-pre.json" "$E" pre || exit 1
fi

say "6 rebuild dry runs (13)"
for a in $A; do
  R data rebuild-supply-levels $a > "$W/dry/${P}rebuild-$a.json"; rc=$?
  if [ -n "$RESUME" ]; then
    $CHECK rebuild-dry-resume "$W/dry/${P}rebuild-$a.json" $rc $a "$E" "$W/dry/supply-resume.json" || exit 1
  else
    $CHECK rebuild-dry "$W/dry/${P}rebuild-$a.json" $rc $a "$E" || exit 1
  fi
done

say "6 rebuild --yes"
for a in $A; do
  if [ -n "$RESUME" ]; then
    n=$($CHECK field "$W/dry/${P}rebuild-$a.json" rebuilt) || stop "$n"
    if [ "$n" = 0 ]; then echo "$a rebuild --yes skipped (resume: nothing left to rebuild)"; continue; fi
  fi
  R data rebuild-supply-levels $a --yes > "$W/yes/${P}rebuild-$a.json"; rc=$?
  $CHECK same-rebuild "$W/dry/${P}rebuild-$a.json" "$W/yes/${P}rebuild-$a.json" $rc $a || exit 1
done

say "6 second dry runs (rebuild 0)"
for a in $A; do
  R data rebuild-supply-levels $a > "$W/yes/${P}rebuild-again-$a.json"; rc=$?
  $CHECK rebuild-again "$W/yes/${P}rebuild-again-$a.json" $rc $a "$E" || exit 1
done

say "5 re-check after --yes (left: the notRebuildable market_data rows, cleared by step 7)"
Q supply > "$W/yes/${P}supply-rebuilt.json" || stop "sql-ro supply exit $?"
$CHECK stale "$W/yes/${P}supply-rebuilt.json" "$E" rebuilt || exit 1
echo "s2 done"
