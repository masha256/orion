#!/usr/bin/env bash
# Phase 3 R3 release block, script s1: step 2 (deploy), step 3 (the switch checks), step 4 (levels coverage before and
# after the first hourly `levels` run on the tag). docs/ops/deploy.md "Phase 3 R3 release"; --fake: r3-lib.sh.
#   tools/phase3-proof/r3-s1.sh <stage|prod> <tag> --tools <release checkout> [--fake <dir>]
# --tools: the checkout of the release tag (its scripts/release/deploy.sh runs from there, and its
# tools/phase3-proof/r3-signed-circulating.json holds Task 7's signed circulating value per asset).
set -u
. "$(dirname "$0")/r3-lib.sh"
r3_args "$@"
TAG=${POS[1]:-}
[ ${#POS[@]} -eq 2 ] && [ -n "$TOOLS" ] || stop "usage: r3-s1.sh <stage|prod> <tag> --tools <release checkout> [--fake <dir>]"
need_expected
SIGNED=$TOOLS/tools/phase3-proof/r3-signed-circulating.json
[ -f "$SIGNED" ] || stop "$SIGNED missing (Task 7's signed circulating values; the tag must carry it)"
# levels runs every hour at :15 on prod and every 6 h on stage (schedule.yaml staging_overrides: 00:15, 06:15, 12:15,
# 18:15 UTC): poll `jobs` every 300 s, waiting at most 75 min (prod) or 6 h 30 min (stage). R3_POLLS overrides the count.
NAP=300; MAX_WAIT=4500; [ "$ENV" = stage ] && MAX_WAIT=23400
POLLS=${R3_POLLS:-$(( MAX_WAIT / NAP + 1 ))}; [ -n "$FAKE" ] && NAP=0

say "2 deploy $ENV $TAG"
SINCE=$(now_iso)
printf '{"tag": "%s", "switchStartedAt": "%s"}\n' "$TAG" "$SINCE" > "$W/switch.json"
if [ -n "$FAKE" ]; then
  fake_call deploy.sh "$ENV" "$TAG" > "$W/deploy-report.txt" 2>&1; rc=$?
else
  (cd "$TOOLS" && scripts/release/deploy.sh "$ENV" "$TAG") > "$W/deploy-report.txt" 2>&1; rc=$?
fi
cat "$W/deploy-report.txt"
[ $rc -eq 0 ] || stop "deploy.sh exit $rc"
$CHECK deploy "$W/deploy-report.txt" "$TAG" || exit 1

say "3 check the switch"
R status > "$W/after/status.txt" || stop "status exit $?"
R logs 30 > "$W/after/logs30.txt" || stop "logs exit $?"
$CHECK status "$W/after/status.txt" "$W/after/logs30.txt" "$TAG" || exit 1
Q migrations > "$W/after/migrations.json" || stop "sql-ro migrations exit $?"
$CHECK migrations "$W/after/migrations.json" || exit 1

say "4 levels coverage before the first hourly run (exempt: step 1's latest_levels market_data rows)"
# latest_levels first, THEN jobs: a levels job on the tag that started after the switch (running or ended) by the time
# of the jobs read may have overwritten rows already, so the pre-check is skipped (no false STOP); its re-check below
# has no exemption. A job that starts after the jobs read started after the latest_levels read too.
Q levels > "$W/after/levels-pre.json" || stop "sql-ro levels exit $?"
R jobs --since "$SINCE" > "$W/after/jobs-pre.json" || stop "jobs exit $?"
$CHECK levels-pre "$W/after/levels-pre.json" "$W/expected.json" "$W/after/jobs-pre.json" "$TAG" "$SINCE" || exit 1

say "4 wait for the first levels run on $TAG started after the switch to be done (jobs every ${NAP}s, at most $POLLS polls)"
# running / queued jobs, and any that started before the switch, are ignored; a failed one is a STOP.
rc=3
for i in $(seq 1 "$POLLS"); do
  R jobs --since "$SINCE" > "$W/after/jobs.json" || stop "jobs exit $?"
  $CHECK levels-job "$W/after/jobs.json" "$TAG" "$SINCE"; rc=$?
  [ $rc -eq 3 ] || break
  [ "$i" -lt "$POLLS" ] && sleep $NAP
done
[ $rc -eq 3 ] && stop "no levels run on $TAG finished after $POLLS polls"
[ $rc -eq 0 ] || exit 1

say "4 re-check with no exemption"
Q levels > "$W/after/levels.json" || stop "sql-ro levels exit $?"
$CHECK levels-post "$W/after/levels.json" "$W/expected.json" "$SIGNED" || exit 1
echo "s1 done: paste the deploy report and the lines above into the thread"
