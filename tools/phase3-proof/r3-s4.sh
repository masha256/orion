#!/usr/bin/env bash
# Phase 3 R3 release block, script s4: step 9 (save after/ at days.json's D and D-91) and step 10 (the gate: flatdiff
# of the 26 reports with the tag's tools/phase3-proof/r3-allowlist.json). docs/ops/deploy.md; --fake: r3-lib.sh.
#   tools/phase3-proof/r3-s4.sh <stage|prod> --tools <release checkout> [--fake <dir>]
# --tools: the checkout of the release tag; flatdiff.py and r3-allowlist.json are read from its tools/phase3-proof/.
set -u
. "$(dirname "$0")/r3-lib.sh"
r3_args "$@"
[ ${#POS[@]} -eq 1 ] && [ -n "$TOOLS" ] || stop "usage: r3-s4.sh <stage|prod> --tools <release checkout> [--fake <dir>]"
need_days
FD=$TOOLS/tools/phase3-proof/flatdiff.py
AL=$TOOLS/tools/phase3-proof/r3-allowlist.json
[ -f "$FD" ] || stop "$FD missing"
[ -f "$AL" ] || stop "$AL missing (Task 7 writes it from Mike's sign-off; no gate without it)"
for a in $A; do for f in $a $a-91; do [ -s "$W/before/$f.json" ] || stop "$W/before/$f.json missing (s0 step 0)"; done; done

say "9 save after/"
save_reports "$W/after"

say "10 gate: flatdiff before/ -> after/ with r3-allowlist.json"
fails=0
for a in $A; do for f in $a $a-91; do
  python3 "$FD" "$W/before/$f.json" "$W/after/$f.json" --allow "$AL" --asset $a > "$W/after/gate-$f.txt" 2>&1; rc=$?
  if [ $rc -eq 0 ]; then echo "$f ok"; else echo "$f flatdiff exit $rc:"; cat "$W/after/gate-$f.txt"; fails=$((fails + 1)); fi
done; done
[ $fails -eq 0 ] || stop "$fails of 26 reports not allowed by r3-allowlist.json (every unallowed path above; no widening on the spot: an addendum on Mike's ruling)"
echo "gate ok (26/26 flatdiff exit 0)"
