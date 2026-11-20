#!/usr/bin/env bash
# Phase 3 R3 release block, script s3: step 7 (purge the market_data circulating rows: dry runs and their checks, then
# --yes, yes == dry, the export files) and step 8 (the re-checks with no exemption). One script = one approval (prod:
# Mike's go). docs/ops/deploy.md "Phase 3 R3 release"; --fake: r3-lib.sh.
#   tools/phase3-proof/r3-s3.sh <stage|prod> [--resume] [--fake <dir>]
# --resume (only after a STOP part way through the --yes loop, on Mike's go): per asset, already purged since step 1
# (step 1's market_data total - the market_data rows now, from sql-ro supply) + remaining = step 1's total; dry runs
# only on the assets with rows left, each finding exactly the rows now; --yes on those; then the same step 8 re-checks.
# Its files are dry/resume-*, yes/resume-* (the first run's stay); exports.txt is appended to.
set -u
. "$(dirname "$0")/r3-lib.sh"
r3_args "$@"
[ ${#POS[@]} -eq 1 ] || stop "usage: r3-s3.sh <stage|prod> [--resume] [--fake <dir>]"
need_expected
E=$W/expected.json
P=""
if [ -n "$RESUME" ]; then
  P=resume-
  say "7 purge --resume (already purged since step 1 + remaining = step 1's market_data total, per asset)"
  Q supply > "$W/dry/supply-resume.json" || stop "sql-ro supply exit $?"
  out=$($CHECK purge-resume "$W/dry/supply-resume.json" "$E"); rc=$?
  [ $rc -eq 0 ] || { echo "$out"; exit 1; }
  echo "${out%left:*}"; PA=${out##*left:}
  [ -n "$PA" ] || echo "purge resume: no market_data circulating rows left on any asset; step 8 below"
else
  PA=$($CHECK purge-assets "$E") || stop "expected.json unreadable"
  [ -n "$PA" ] || stop "step 1 found no market_data circulating rows: nothing for step 7 (wrong env or expected.json?)"
fi

say "7 purge dry runs ($PA)"
for a in $PA; do
  R data purge $a --metrics circulating_supply --source-type market_data > "$W/dry/${P}purge-$a.json"; rc=$?
  if [ -n "$RESUME" ]; then
    $CHECK purge-dry-resume "$W/dry/${P}purge-$a.json" $rc $a "$E" "$W/dry/supply-resume.json" || exit 1
  else
    $CHECK purge-dry "$W/dry/${P}purge-$a.json" $rc $a "$E" || exit 1
  fi
done

say "7 purge --yes"
for a in $PA; do
  R data purge $a --metrics circulating_supply --source-type market_data --yes > "$W/yes/${P}purge-$a.json"; rc=$?
  out=$($CHECK same-purge "$W/dry/${P}purge-$a.json" "$W/yes/${P}purge-$a.json" $rc $a); rc=$?
  echo "$out"; echo "$out" >> "$W/yes/exports.txt"
  [ $rc -eq 0 ] || exit 1
done

say "8 re-check with no exemption"
Q market_data > "$W/yes/${P}market-data.json" || stop "sql-ro market_data exit $?"
$CHECK zero-market-data "$W/yes/${P}market-data.json" || exit 1
Q levels > "$W/yes/${P}levels.json" || stop "sql-ro levels exit $?"
$CHECK levels-zero "$W/yes/${P}levels.json" || exit 1
Q supply > "$W/yes/${P}supply-purged.json" || stop "sql-ro supply exit $?"
$CHECK stale "$W/yes/${P}supply-purged.json" "$E" purged || exit 1
echo "s3 done: the export files and sha256 are in $W/yes/exports.txt (keep them)"
