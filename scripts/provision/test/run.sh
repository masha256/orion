#!/usr/bin/env bash
# Dry-run test harness for scripts/provision (plan 1.5a, ruling R8: no Docker, so shellcheck + dry runs are the gate).
#
# Runs every provisioning script with --dry-run as a NON-ROOT user and asserts that it exits as expected and that its
# output names every change a real run would make. Never runs a script without --dry-run.
#
#   scripts/provision/test/run.sh            all cases
#   SHELLCHECK=/path/to/shellcheck ...       shellcheck binary (default: shellcheck on PATH; missing = FAIL)
#   PG_BINDIR=/usr/lib/postgresql/18/bin ... also run the SQL files against a throwaway cluster (optional)
#
# Exit 0 only when every case passes. Prints one PASS/FAIL line per assertion and a count at the end.
set -uo pipefail
# shellcheck source-path=SCRIPTDIR

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
prov=$(dirname "$here")
SHELLCHECK=${SHELLCHECK:-shellcheck}

if [[ $(id -u) -eq 0 ]]; then
  echo "test/run.sh: run as a non-root user (the dry runs must work without root)" >&2
  exit 2
fi

tmp=$(mktemp -d)
cleanup() { python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "$tmp" 2>/dev/null || true; }
trap cleanup EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [[ -n ${2:-} ]] && printf '     %s\n' "$2"; return 0; }

# run_case <name> <expected exit: 0 | nonzero> <cmd...>; output (stdout+stderr) kept in $tmp/<name>.out
run_case() {
  local name=$1 want=$2 rc
  shift 2
  "$@" >"$tmp/$name.out" 2>&1
  rc=$?
  if [[ $want == 0 && $rc -eq 0 ]] || [[ $want == nonzero && $rc -ne 0 ]]; then
    ok "$name: exit $rc"
  else
    bad "$name: exit $rc, wanted $want" "$(tail -n 5 "$tmp/$name.out" | tr '\n' '|')"
  fi
}

# expect <name> <extended regex>: some output line of case <name> matches
expect() {
  if grep -Eq -- "$2" "$tmp/$1.out"; then ok "$1 names /$2/"; else bad "$1 names /$2/"; fi
}
# expect_not <name> <extended regex>: no output line matches
expect_not() {
  if grep -Eq -- "$2" "$tmp/$1.out"; then bad "$1 must not print /$2/" "$(grep -E -m1 -- "$2" "$tmp/$1.out")"; else ok "$1 does not print /$2/"; fi
}
# expect_before <name> <regex A> <regex B>: the first A line comes before any B line (B may be absent)
expect_before() {
  local a b
  a=$(grep -En -m1 -- "$2" "$tmp/$1.out" | cut -d: -f1)
  b=$(grep -En -m1 -- "$3" "$tmp/$1.out" | cut -d: -f1)
  if [[ -n $a && ( -z $b || $a -lt $b ) ]]; then ok "$1: /$2/ before /$3/"; else bad "$1: /$2/ before /$3/ (lines ${a:-none} ${b:-none})"; fi
}

# --- shellcheck ---------------------------------------------------------------------------------------------------
shell_files=()
while IFS= read -r f; do shell_files+=("$f"); done < <(
  cd "$prov" && shopt -s nullglob && {
    for f in ./*.sh test/*.sh files/*; do head -n1 "$f" | grep -Eq '^#!.*(bash|/sh)' && echo "${f#./}"; done
    echo lib.sh
  } | sort -u
)
if ! command -v "$SHELLCHECK" >/dev/null 2>&1; then
  bad "shellcheck available (set SHELLCHECK=...)"
else
  for f in "${shell_files[@]}"; do
    if (cd "$prov" && "$SHELLCHECK" -x "$f") >"$tmp/shellcheck.out" 2>&1; then
      ok "shellcheck -x $f"
    else
      bad "shellcheck -x $f" "$(head -n 8 "$tmp/shellcheck.out" | tr '\n' '|')"
    fi
  done
fi

# --- lib.sh in real mode on $tmp files (no root needed) -------------------------------------------------------------
# shellcheck source=SCRIPTDIR/lib-test.sh
source "$here/lib-test.sh"

# --- dev-postgres.sh ----------------------------------------------------------------------------------------------
dev=$prov/dev-postgres.sh
me=$(id -un)
run_case dev 0 env -u SUDO_USER "$dev" --dry-run --force-os --os-user "$me"
for re in \
  '/etc/apt/keyrings/pgdg\.asc' \
  'ACCC4CF8' \
  '/etc/apt/sources\.list\.d/pgdg\.sources' \
  'Suites: [a-z]+-pgdg' \
  '/etc/apt/preferences\.d/pgdg\.pref' \
  'postgresql-18' \
  'postgresql-client-18' \
  'pgbackrest' \
  '/etc/postgresql/18/main/conf\.d/orion\.conf' \
  "listen_addresses = ''" \
  "timezone = 'UTC'" \
  "shared_buffers = 256MB" \
  '/etc/postgresql/18/main/pg_hba\.conf' \
  '^ *\+ *local +all +orion_dev +peer +map=dev' \
  '^ *\+ *local +all +postgres +peer' \
  '^ *\+ *local +all +all +reject' \
  '/etc/postgresql/18/main/pg_ident\.conf' \
  "^ *\+ *dev +$me +orion_dev" \
  'restart postgresql@18-main' \
  'role orion_dev' \
  'database orion_dev' \
  'database orion_test' \
  'SKIP: .*version' \
  'SKIP: .*schema.*orion_test'; do
  expect dev "$re"
done
expect_not dev '^do: '
expect_not dev 'node-v26'

run_case dev-no-user nonzero env -u SUDO_USER "$dev" --dry-run --force-os --os-user no-such-user-orion-test
expect dev-no-user 'no-such-user-orion-test'
run_case dev-bad-flag nonzero "$dev" --dry-run --force-os --no-such-flag

# --- optional: the SQL files against a throwaway cluster ----------------------------------------------------------
if [[ -n ${PG_BINDIR:-} ]]; then
  # shellcheck source=SCRIPTDIR/sql.sh
  source "$here/sql.sh"
fi

# ------------------------------------------------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
