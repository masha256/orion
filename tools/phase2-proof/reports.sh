#!/usr/bin/env bash
# Phase 2 proof, step 2: run both releases against the one p2proof_* schema and save every output to files.
#
#   reports.sh <old-dist> <new-dist> <home-old> <home-new> <D> <out>
#
# For each asset id in <home-new>/assets/*.yaml (13 required): `report yield <a> --day <D> --json` with each release,
# into <out>/old/<a>.json and <out>/new/<a>.json, with identical flags on both sides (Task 11b retired --legacy: no
# side gets it, whatever its release prints; compare.py decides v1-vs-v2 or v2-vs-v2 from the JSON itself). Then `data anomalies --all --json` -> anomalies.json and `proposals list --json` -> proposals.json per side.
# stderr goes beside each output as <name>.stderr; every run's exit code is a row of <out>/status.tsv
# (side TAB file TAB exit), which compare.py reads: a non-zero exit is a failure there, never a silent skip.
# <out>, <home-old> and <home-new> must be inside $TMPDIR (T0 M4: proof outputs and the homes' .env never land in the
# repo or a home that outlives scratch). Exits 1 if any run exited non-zero, 2 on a refusal. Compare with compare.py <out>.
set -uo pipefail

die() { echo "reports.sh: $*" >&2; exit 2; }

[ $# -eq 6 ] || die "usage: reports.sh <old-dist> <new-dist> <home-old> <home-new> <D> <out>"
OLD_CLI="$(realpath -m "$1")/cli/index.js"
NEW_CLI="$(realpath -m "$2")/cli/index.js"
HOME_OLD="$(realpath -m "$3")"
HOME_NEW="$(realpath -m "$4")"
D="$5"
OUT="$(realpath -m "$6")"

[ -n "${TMPDIR:-}" ] || die "TMPDIR is not set: cannot confine the proof outputs to scratch"
TMP_ROOT="$(realpath -m "$TMPDIR")"
for p in "$OUT" "$HOME_OLD" "$HOME_NEW"; do
  case "$p/" in "$TMP_ROOT"/?*) ;; *) die "$p is not inside \$TMPDIR ($TMP_ROOT)" ;; esac
done
[ -f "$OLD_CLI" ] || die "no $OLD_CLI (old dist missing)"
[ -f "$NEW_CLI" ] || die "no $NEW_CLI (new dist missing)"
[[ "$D" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "D must be YYYY-MM-DD, got '$D'"
for h in "$HOME_OLD" "$HOME_NEW"; do
  [ -f "$h/.env" ] || die "no $h/.env"
  [ -d "$h/assets" ] || die "no $h/assets"
done
dbline() { grep -E "^$1=" "$2/.env" || true; }
for k in ORION_DATABASE_URL ORION_DB_SCHEMA; do
  a="$(dbline "$k" "$HOME_OLD")"; b="$(dbline "$k" "$HOME_NEW")"
  [ -n "$a" ] || die "$HOME_OLD/.env has no $k"
  [ "$a" = "$b" ] || die "the homes name different databases ($k differs): both must read the same schema"
done
schema="$(dbline ORION_DB_SCHEMA "$HOME_NEW")"
[[ "${schema#ORION_DB_SCHEMA=}" =~ ^p2proof_[0-9a-z_]+$ ]] || die "the homes' schema is not a p2proof_* schema: $schema"

shopt -s nullglob
yamls=("$HOME_NEW"/assets/*.yaml)
shopt -u nullglob
assets=()
for y in "${yamls[@]}"; do assets+=("$(basename "$y" .yaml)"); done
[ "${#assets[@]}" -ge 13 ] || die "only ${#assets[@]} assets in $HOME_NEW/assets, need 13"

[ ! -e "$OUT/old" ] && [ ! -e "$OUT/new" ] && [ ! -e "$OUT/status.tsv" ] || die "$OUT already holds outputs: use a fresh directory"
mkdir -p "$OUT/old" "$OUT/new" || die "cannot create $OUT"

# Only the home's .env decides the database: no ORION_* variable of the caller is passed on.
# Each run gets ORION_HOME=<home> and ORION_ENV_FILE=<home>/.env: a release (a RELEASE beside its dist/) refuses to
# run without both (src/cli/paths.ts resolvePaths, release_env_required).
for v in $(compgen -e); do case "$v" in ORION_*) unset "$v" ;; esac; done

: >"$OUT/status.tsv"
failures=0
# run <side> <cli> <home> <file> <args...>
run() {
  local side="$1" cli="$2" home="$3" name="$4" code=0
  shift 4
  (cd "$home" && ORION_HOME="$home" ORION_ENV_FILE="$home/.env" node "$cli" "$@") >"$OUT/$side/$name" 2>"$OUT/$side/$name.stderr" || code=$?
  printf '%s\t%s\t%s\n' "$side" "$name" "$code" >>"$OUT/status.tsv"
  if [ "$code" -ne 0 ]; then
    failures=$((failures + 1))
    echo "reports.sh: $side $name exited $code (see $OUT/$side/$name.stderr)" >&2
  fi
}

printf 'assets=%s\nday=%s\n%s\n' "${assets[*]}" "$D" "$schema" >"$OUT/run.txt"

for a in "${assets[@]}"; do
  run old "$OLD_CLI" "$HOME_OLD" "$a.json" report yield "$a" --day "$D" --json
  run new "$NEW_CLI" "$HOME_NEW" "$a.json" report yield "$a" --day "$D" --json
done
for side in old new; do
  cli="$OLD_CLI"; home="$HOME_OLD"
  [ "$side" = new ] && { cli="$NEW_CLI"; home="$HOME_NEW"; }
  run "$side" "$cli" "$home" anomalies.json data anomalies --all --json
  run "$side" "$cli" "$home" proposals.json proposals list --json
done

echo "reports.sh: ${#assets[@]} assets, $failures failed run(s); outputs in $OUT"
[ "$failures" -eq 0 ]
