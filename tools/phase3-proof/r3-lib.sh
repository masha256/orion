# Phase 3 R3 release block: what r3-s0.sh .. r3-s4.sh share (docs/ops/deploy.md "Phase 3 R3 release"). Sourced, not run.
#
# Arguments of every script: <env> (stage|prod) first, then the script's own, then optionally `--fake <dir>`.
# Work dir: ~/r3-<env>/{before,after,dry,yes}; ~/r3-<env>/expected.json (step 1) and ~/r3-<env>/days.json (step 0) are
# written by r3-s0.sh only and read by the others. Every check prints `ok` or `STOP: <reason>`; the first STOP exits 1.
#
# --fake <dir>: no ssh and no deploy.sh. Every remote call `R <verb> <args...>` (and `deploy.sh <env> <tag>`) reads a
# file instead. Slug rule: the call's words joined with `_`, then every character outside [A-Za-z0-9._=-] replaced by
# `-` (`report yield cake --day 2026-11-18` -> `report_yield_cake_--day_2026-11-18`; `jobs --since
# 2026-11-20T12:00:00Z` -> `jobs_--since_2026-11-20T12-00-00Z`); a `sql-ro` call's slug is `sql-ro_<query name>`
# (r3_check.py's QUERIES), not the SQL. The n-th call (from 1) of a slug in one script run reads the first that exists
# of <dir>/<script>/<slug>.<n>.json, <dir>/<script>/<slug>.json, <dir>/<slug>.<n>.json, <dir>/<slug>.json (<script> =
# r3-s0 .. r3-s4) as its stdout; the same names with `.exit` instead of `.json` hold its exit code (default 0). No file:
# exit 127 (a STOP). Each call is logged to ~/r3-<env>/.fake/<script>/calls.log; no sleep. R3_NOW (an ISO instant)
# fixes "now" (today, D, the switch time) in either mode.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK="python3 $HERE/r3_check.py"
A="aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv"
SCRIPT=$(basename "$0" .sh)

stop() { echo "STOP: $*"; exit 1; }
say() { echo "== $* $(date -u +%T)"; }

ENV=""; FAKE=""; TOOLS=""; POS=()
r3_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --fake) [ $# -ge 2 ] || stop "--fake needs a dir"; FAKE=$(cd "$2" && pwd) || stop "--fake $2: no such dir"; shift 2 ;;
      --tools) [ $# -ge 2 ] || stop "--tools needs a dir"; TOOLS=$(cd "$2" && pwd) || stop "--tools $2: no such dir"; shift 2 ;;
      -*) stop "unknown option $1" ;;
      *) POS+=("$1"); shift ;;
    esac
  done
  ENV=${POS[0]:-}
  case "$ENV" in stage|prod) ;; *) stop "usage: $SCRIPT.sh <stage|prod> ... [--fake <dir>]" ;; esac
  W=~/r3-$ENV
  mkdir -p "$W/before" "$W/after" "$W/dry" "$W/yes" || stop "cannot make $W"
  if [ -n "$FAKE" ]; then
    FS=$W/.fake/$SCRIPT
    rm -rf "$FS"; mkdir -p "$FS" || stop "cannot make $FS"
  fi
}

now_iso() { if [ -n "${R3_NOW:-}" ]; then echo "$R3_NOW"; else date -u +%Y-%m-%dT%H:%M:%SZ; fi; }

fake_call() {
  local slug f n
  slug=$(printf '%s_' "$@"); slug=${slug%_}; slug=$(printf '%s' "$slug" | tr -c 'A-Za-z0-9._=-' '-')
  echo "$*" >> "$FS/calls.log"
  n=$(( $(cat "$FS/$slug.n" 2>/dev/null || echo 0) + 1 )); echo $n > "$FS/$slug.n"
  for f in "$FAKE/$SCRIPT/$slug.$n" "$FAKE/$SCRIPT/$slug" "$FAKE/$slug.$n" "$FAKE/$slug"; do
    if [ -f "$f.json" ]; then
      cat "$f.json"
      if [ -f "$f.exit" ]; then return "$(cat "$f.exit")"; fi
      return 0
    fi
  done
  echo "fake: no $FAKE/$slug.json" >&2
  return 127
}

# R <verb> <args...>: one orion-remote call over the env's deploy key (ST / PR of docs/ops/deploy.md).
R() {
  if [ -n "$FAKE" ]; then fake_call "$@"; return; fi
  ssh -i ~/.ssh/orion-"$ENV"_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes orion-"$ENV"@192.168.0.12 "$@"
}

# Q <name>: one named sql-ro query (r3_check.py QUERIES); the query goes as ONE quoted argument (orion-remote shlex).
Q() {
  if [ -n "$FAKE" ]; then fake_call sql-ro "$1"; return; fi
  local q; q=$($CHECK sql "$1") || return 2
  R sql-ro "'$q'"
}

need_expected() { [ -f "$W/expected.json" ] || stop "$W/expected.json missing: run r3-s0.sh $ENV first"; }
need_days() { [ -f "$W/days.json" ] || stop "$W/days.json missing: run r3-s0.sh $ENV first"; }
day_of() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$W/days.json" "$1"; }

# save_reports <dir>: the 26 reports at D and D-91 (days.json) into <dir>/<a>.json and <dir>/<a>-91.json.
save_reports() {
  local d D D91 a
  d=$1; D=$(day_of D) || stop "days.json unreadable"; D91=$(day_of D91) || stop "days.json unreadable"
  for a in $A; do
    R report yield $a --day "$D" > "$d/$a.json" || stop "$a report --day $D exit $?"
    R report yield $a --day "$D91" > "$d/$a-91.json" || stop "$a report --day $D91 exit $?"
  done
  echo "reports ok (26 saved in $d: D $D, D-91 $D91)"
}
