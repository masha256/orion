#!/usr/bin/env bash
# Phase 3 R3 release block, script s0 (read-only, no --yes): the N6 check, step 0 (save before/) and step 1 (the
# expected-counts file). docs/ops/deploy.md "Phase 3 R3 release"; shared rules, --fake and the slug rule: r3-lib.sh.
#   tools/phase3-proof/r3-s0.sh <stage|prod> [--fake <dir>]
# Run on the release still current, before r3-s1.sh, with no nightly slot between s0 and s1's switch (a nightly on the
# old release adds a market_data row per CoinGecko asset, and s2 then stops on step 1's counts).
set -u
. "$(dirname "$0")/r3-lib.sh"
r3_args "$@"
[ ${#POS[@]} -eq 1 ] || stop "usage: r3-s0.sh <stage|prod> [--fake <dir>]"
[ -f "$W/expected.json" ] && stop "$W/expected.json exists: s0 already ran on $ENV (to start over, move $W away first)"

say "N6 orion-remote of the R3 snapshot"
R data rebuild-supply-levels > "$W/dry/n6-usage.txt" 2>&1; rc=$?
$CHECK usage64 "$W/dry/n6-usage.txt" $rc || exit 1
Q whoami > "$W/dry/n6-whoami.json" || stop "sql-ro whoami exit $?"
$CHECK whoami "$W/dry/n6-whoami.json" "$ENV" || exit 1

say "0 save before/ (D = today-2 UTC and D-91, saved once in days.json)"
$CHECK days "$W/days.json" "$(now_iso)" || exit 1
save_reports "$W/before"

say "1 expected counts (sql-ro)"
Q supply > "$W/before/supply.json" || stop "sql-ro supply exit $?"
Q levels > "$W/before/levels.json" || stop "sql-ro levels exit $?"
$CHECK expected "$W/before/supply.json" "$W/before/levels.json" "$W/expected.json" "$ENV" "$(now_iso)" || { rm -f "$W/expected.json"; exit 1; }
echo "s0 done: paste the per-asset lines above into the thread"
