#!/usr/bin/env bash
# Phase 3 R4 history step (spec section 6; docs/ops/deploy.md "Phase 3 R4 release"), run on an env AFTER it is on the
# R4 release: purge AERO's retired DefiLlama series `flow_usd.fees` (sql-ro counts, the dry run, then --yes only on an
# interactive `yes`; the export file is printed), then backfill the five pool-scan metrics 2026-10-22 -> yesterday as
# daemon `backfill` jobs (each scans the 7 oldest missing days: pool.ts max_scan_days), waiting for each job, then
# verify over sql-ro that every metric has exactly one active row per day. Rerunnable: a purge already done is
# skipped, and the backfill resumes from the days still missing.
#   tools/phase3-proof/r4-backfill.sh <stage|prod> [--expect-fees <n>] [--fake <dir>]
# --expect-fees <n>: the purge dry run must find exactly n rows (prod at scoping, 2026-11-27: 308 = 306 third_party +
#   2 derived); without it the sql-ro count is the expectation, shown before the prompt.
# Refuses to start (and to queue each further job) inside the env's backfill gate (nightly -4 h / +2 h: prod 00:45
# UTC, stage 02:45 UTC) or an RPC quiet window (16:30-17:15 and 05:00-06:30 PT), or within 15 min before one opens.
# Every check prints `ok` or `STOP: <reason>`; the first STOP exits 1. Checks: tools/phase3-proof/r4_check.py.
# Work dir ~/r4-<env>/ (sql-ro results, the purge JSON, each job's queue and jobs reads, exports.txt).
#
# --fake <dir>: no ssh. Every remote call `R <verb> <args...>` reads a file, by r3-lib.sh's slug rule (the words joined
# with `_`, every character outside [A-Za-z0-9._=-] replaced by `-`; a sql-ro call's slug is `sql-ro_<query name>`):
# the n-th call (from 1) of a slug reads the first that exists of <dir>/<slug>.<n>.json, <dir>/<slug>.json, and
# <slug>.<n>.exit / <slug>.exit its exit code (default 0); no file: exit 127. Calls are logged to
# ~/r4-<env>/.fake/calls.log; no sleep. R4_NOW (an ISO instant) fixes "now"; R4_POLLS caps the polls per job.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK="python3 $HERE/r4_check.py"
METRICS=flow_usd.voter_fees,flow_usd.lp_fees,flow_usd.pool_fees_gross,flow_usd.vote_incentives,flow_usd.protocol_subsidy

stop() { echo "STOP: $*"; exit 1; }
say() { echo "== $* $(date -u +%T)"; }

ENV=""; FAKE=""; EXPECT=""; POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fake) [ $# -ge 2 ] || stop "--fake needs a dir"; FAKE=$(cd "$2" && pwd) || stop "--fake $2: no such dir"; shift 2 ;;
    --expect-fees) [ $# -ge 2 ] || stop "--expect-fees needs a count"; EXPECT=$2; shift 2
      case "$EXPECT" in ''|*[!0-9]*) stop "--expect-fees takes a whole number, not $EXPECT" ;; esac ;;
    -*) stop "unknown option $1" ;;
    *) POS+=("$1"); shift ;;
  esac
done
ENV=${POS[0]:-}
[ ${#POS[@]} -eq 1 ] || stop "usage: r4-backfill.sh <stage|prod> [--expect-fees <n>] [--fake <dir>]"
case "$ENV" in stage|prod) ;; *) stop "usage: r4-backfill.sh <stage|prod> [--expect-fees <n>] [--fake <dir>]" ;; esac
W=~/r4-$ENV
mkdir -p "$W" || stop "cannot make $W"
if [ -n "$FAKE" ]; then FS=$W/.fake; rm -rf "$FS"; mkdir -p "$FS" || stop "cannot make $FS"; fi
# A chunk (7 chain-days x 8 chains, plus incentives) takes ~5-10 min; poll `jobs` every 60 s, at most 3 h per job (a
# job waits behind the hourly levels job and defers through a gate the loop did not foresee).
NAP=60; POLLS=${R4_POLLS:-180}; [ -n "$FAKE" ] && NAP=0

now_iso() { if [ -n "${R4_NOW:-}" ]; then echo "$R4_NOW"; else date -u +%Y-%m-%dT%H:%M:%SZ; fi; }

fake_call() {
  local slug f n
  slug=$(printf '%s_' "$@"); slug=${slug%_}; slug=$(printf '%s' "$slug" | tr -c 'A-Za-z0-9._=-' '-')
  echo "$*" >> "$FS/calls.log"
  n=$(( $(cat "$FS/$slug.n" 2>/dev/null || echo 0) + 1 )); echo $n > "$FS/$slug.n"
  for f in "$FAKE/$slug.$n" "$FAKE/$slug"; do
    if [ -f "$f.json" ]; then
      cat "$f.json"
      if [ -f "$f.exit" ]; then return "$(cat "$f.exit")"; fi
      return 0
    fi
  done
  echo "fake: no $FAKE/$slug.json" >&2
  return 127
}

# R <verb> <args...>: one orion-remote call over the env's deploy key (ST / PR of docs/ops/deploy.md). `-n`: ssh never
# reads this script's stdin, which holds the purge confirmation (`echo yes | r4-backfill.sh ...` must reach `read`).
R() {
  if [ -n "$FAKE" ]; then fake_call "$@" < /dev/null; return; fi
  ssh -n -i ~/.ssh/orion-"$ENV"_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes orion-"$ENV"@192.168.0.12 "$@"
}

# Q <name>: one named sql-ro query (r4_check.py QUERIES), as ONE quoted argument (orion-remote re-splits with shlex).
Q() {
  if [ -n "$FAKE" ]; then fake_call sql-ro "$1"; return; fi
  local q; q=$($CHECK sql "$1") || return 2
  R sql-ro "'$q'"
}

say "0 timing ($ENV)"
$CHECK window "$ENV" "$(now_iso)" || exit 1

say "1 aero flow_usd.fees rows and open anomalies (sql-ro)"
Q fees > "$W/fees.json" || stop "sql-ro fees exit $?"
Q fees_anomalies > "$W/fees-anomalies.json" || stop "sql-ro fees_anomalies exit $?"
$CHECK fees "$W/fees.json" "$W/fees-anomalies.json" $EXPECT; rc=$?
[ $rc -eq 0 ] || [ $rc -eq 3 ] || exit 1
if [ $rc -eq 0 ]; then
  say "2 purge flow_usd.fees: dry run"
  R data purge aero --metrics flow_usd.fees > "$W/purge-dry.json"; rc=$?
  $CHECK purge-dry "$W/purge-dry.json" $rc "$W/fees.json" || exit 1
  n=$($CHECK fees-count "$W/fees.json") || { echo "$n"; exit 1; }
  printf 'Purge all %s aero flow_usd.fees rows on %s (exported to ~/home/purged/ first, then deleted)? Type yes: ' "$n" "$ENV"
  read -r answer || answer=""
  echo
  [ "$answer" = yes ] || stop "purge not confirmed (answer \"${answer}\"): nothing deleted"
  say "2 purge flow_usd.fees: --yes"
  R data purge aero --metrics flow_usd.fees --yes > "$W/purge-yes.json"; rc=$?
  out=$($CHECK same-purge "$W/purge-dry.json" "$W/purge-yes.json" $rc); rc=$?
  echo "$out"
  [ $rc -eq 0 ] || exit 1
  echo "$ENV $(now_iso) $out" >> "$W/exports.txt"
  Q fees > "$W/fees-after.json" || stop "sql-ro fees exit $?"
  $CHECK zero-fees "$W/fees-after.json" || exit 1
fi

say "3 backfill plan (sql-ro days)"
Q days > "$W/days-0.json" || stop "sql-ro days exit $?"
$CHECK plan "$W/days-0.json" "$(now_iso)" "$W/plan.json" || exit 1
N=$($CHECK field "$W/plan.json" chunks) || exit 1
BD=$($CHECK field "$W/plan.json" backfillDays) || exit 1

k=0
while [ "$k" -lt "$N" ]; do
  k=$((k + 1)); prev=$W/days-$((k - 1)).json
  say "4 chunk $k/$N"
  $CHECK chunk "$prev" "$(now_iso)" $k $N; rc=$?
  [ $rc -eq 3 ] && break
  [ $rc -eq 0 ] || exit 1
  $CHECK window "$ENV" "$(now_iso)" || exit 1
  R job run-now backfill aero --metrics $METRICS --backfill-days "$BD" > "$W/queued-$k.json"; rc=$?
  q=$($CHECK queued "$W/queued-$k.json" $rc) || { echo "$q"; exit 1; }
  id=${q%% *}; slot=${q#* }
  echo "queued job $id (slot $slot); waiting (jobs every ${NAP}s, at most $POLLS polls)"
  rc=3
  for i in $(seq 1 "$POLLS"); do
    R jobs --since "$slot" > "$W/jobs-$k.json" || stop "jobs exit $?"
    $CHECK job "$W/jobs-$k.json" "$id"; rc=$?
    [ $rc -eq 3 ] || break
    [ "$i" -lt "$POLLS" ] && sleep $NAP
  done
  [ $rc -eq 3 ] && stop "backfill job $id not finished after $POLLS polls (still queued or running: see \`jobs\` and \`logs\`; rerun this script once it ends)"
  [ $rc -eq 0 ] || exit 1
  Q days > "$W/days-$k.json" || stop "sql-ro days exit $?"
  $CHECK progress "$prev" "$W/days-$k.json" "$(now_iso)" || exit 1
done

say "5 verify (sql-ro days)"
Q days > "$W/verify.json" || stop "sql-ro days exit $?"
$CHECK verify "$W/verify.json" "$(now_iso)" || exit 1
echo "r4-backfill done on $ENV: paste the lines above into the thread$( [ -f "$W/exports.txt" ] && echo "; the export file is in $W/exports.txt (keep it)")"
