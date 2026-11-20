#!/usr/bin/env bash
# Phase 3 R3 release block, script s3: step 7 (purge the market_data circulating rows: dry runs and their checks, then
# --yes, yes == dry, the export files) and step 8 (the re-checks with no exemption). One script = one approval (prod:
# Mike's go). docs/ops/deploy.md "Phase 3 R3 release"; --fake: r3-lib.sh.
#   tools/phase3-proof/r3-s3.sh <stage|prod> [--fake <dir>]
set -u
. "$(dirname "$0")/r3-lib.sh"
r3_args "$@"
[ ${#POS[@]} -eq 1 ] || stop "usage: r3-s3.sh <stage|prod> [--fake <dir>]"
need_expected
E=$W/expected.json
PA=$($CHECK purge-assets "$E") || stop "expected.json unreadable"
[ -n "$PA" ] || stop "step 1 found no market_data circulating rows: nothing for step 7 (wrong env or expected.json?)"

say "7 purge dry runs ($PA)"
for a in $PA; do
  R data purge $a --metrics circulating_supply --source-type market_data > "$W/dry/purge-$a.json"; rc=$?
  $CHECK purge-dry "$W/dry/purge-$a.json" $rc $a "$E" || exit 1
done

say "7 purge --yes"
for a in $PA; do
  R data purge $a --metrics circulating_supply --source-type market_data --yes > "$W/yes/purge-$a.json"; rc=$?
  out=$($CHECK same-purge "$W/dry/purge-$a.json" "$W/yes/purge-$a.json" $rc $a); rc=$?
  echo "$out"; echo "$out" >> "$W/yes/exports.txt"
  [ $rc -eq 0 ] || exit 1
done

say "8 re-check with no exemption"
Q market_data > "$W/yes/market-data.json" || stop "sql-ro market_data exit $?"
$CHECK zero-market-data "$W/yes/market-data.json" || exit 1
Q levels > "$W/yes/levels.json" || stop "sql-ro levels exit $?"
$CHECK levels-zero "$W/yes/levels.json" || exit 1
Q supply > "$W/yes/supply-purged.json" || stop "sql-ro supply exit $?"
$CHECK stale "$W/yes/supply-purged.json" "$E" purged || exit 1
echo "s3 done: the export files and sha256 are in $W/yes/exports.txt (keep them)"
