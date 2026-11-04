#!/usr/bin/env bash
# shellcheck shell=bash
# Sourced by test/run.sh: lib.sh helpers in REAL mode (DRY_RUN=0) on files under $tmp owned by the current user, so
# the write/skip/never-overwrite logic is exercised without root and without running a provisioning script.
# Uses ok/bad/tmp/prov from run.sh.
: "${tmp:?}" "${prov:?}"

lib_case() { # lib_case <name> <bash snippet run with lib.sh sourced, set -euo pipefail, DRY_RUN=0>
  local name=$1 snippet=$2
  # shellcheck disable=SC2016  # expanded by the inner bash
  if bash -c 'set -euo pipefail; DRY_RUN=0; source "$1/lib.sh"; T=$2; ME=$(id -un):$(id -gn); eval "$3"' \
    lib-test "$prov" "$tmp/lib" "$snippet" >"$tmp/lib-$name.out" 2>&1; then
    ok "lib: $name"
  else
    bad "lib: $name" "$(tail -n 4 "$tmp/lib-$name.out" | tr '\n' '|')"
  fi
}
mkdir -p "$tmp/lib"

# shellcheck disable=SC2016  # the snippets are evaluated later, with lib.sh loaded
{
lib_case "write_file creates (do:), mode applied" '
  out=$(printf "a\nb\n" | write_file "$T/f" 640 "$ME")
  [[ $out == "do: create $T/f (2 lines; 640 $ME)" ]]
  [[ $(cat "$T/f") == $(printf "a\nb") ]] && [[ $(stat -c %a "$T/f") == 640 ]]'
lib_case "write_file same content again prints only ok:" '
  out=$(printf "a\nb\n" | write_file "$T/f" 640 "$ME"); [[ $out == "ok: $T/f" ]]'
lib_case "write_file repairs a mode change only" '
  chmod 644 "$T/f"; out=$(printf "a\nb\n" | write_file "$T/f" 640 "$ME")
  [[ $out == "do: chmod 640 $T/f" ]] && [[ $(stat -c %a "$T/f") == 640 ]]'
lib_case "write_file updates changed content (+1 -1)" '
  out=$(printf "a\nc\n" | write_file "$T/f" 640 "$ME"); [[ $out == "do: update $T/f (+1 -1 lines; 640 $ME)" ]]
  [[ $(cat "$T/f") == $(printf "a\nc") ]]'
lib_case "write_file_once never overwrites a filled file" '
  printf "KEY=secret\n" >"$T/env"; chmod 600 "$T/env"
  out=$(printf "# KEY=\n" | write_file_once "$T/env" 600 "$ME")
  [[ $out == "ok: $T/env exists (kept; never overwritten)" ]] && [[ $(cat "$T/env") == "KEY=secret" ]]'
lib_case "write_file_once output never shows file content" '
  out=$(printf "# KEY=\n" | write_file_once "$T/env" 600 "$ME"); [[ $out != *secret* ]]'
lib_case "write_file_once creates a missing file" '
  out=$(printf "# KEY=\n" | write_file_once "$T/env2" 600 "$ME")
  [[ $out == "do: create $T/env2 (1 lines; 600 $ME)" ]] && [[ $(stat -c %a "$T/env2") == 600 ]]'
lib_case "ensure_dir creates then ok:" '
  out=$(ensure_dir "$T/d" 750 "$ME"); [[ $out == "do: install -d -m 750 -o ${ME%%:*} -g ${ME##*:} $T/d" ]]
  [[ -d $T/d ]] && [[ $(ensure_dir "$T/d" 750 "$ME") == "ok: directory $T/d" ]]'
lib_case "ensure_symlink creates then ok:" '
  ensure_symlink "$T/l" "d" >/dev/null; [[ $(readlink "$T/l") == d ]]
  [[ $(ensure_symlink "$T/l" "d") == "ok: symlink $T/l -> d" ]]'
lib_case "run executes and prints do:" '
  out=$(run touch "$T/ran"); [[ $out == "do: touch $T/ran" ]] && [[ -f $T/ran ]]'
lib_case "dry run: write_file and run change nothing" '
  DRY_RUN=1; printf "z\n" | write_file "$T/f" 640 "$ME" >/dev/null; [[ $(cat "$T/f") == $(printf "a\nc") ]]
  run touch "$T/never" >/dev/null; [[ ! -e $T/never ]]'
mkdir -p "$tmp/lib/fakedf"
cat >"$tmp/lib/fakedf/df" <<'EOF_DF'
#!/bin/bash
# fake df -Pk: $ROOT_KIB for /, $DATA_KIB for anything else
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
if [[ ${!#} == / ]]; then echo "/dev/sda2 1 1 $ROOT_KIB 1% /"; else echo "/dev/sda3 1 1 $DATA_KIB 1% /home"; fi
EOF_DF
chmod +x "$tmp/lib/fakedf/df"
lib_case "check_free_space: ok line with both figures" '
  out=$(PATH=$T/fakedf:$PATH ROOT_KIB=4089446 DATA_KIB=95420416 check_free_space /home/postgres/18/main 2>&1)
  [[ $out == "ok: free space: / 3.9 GiB, /home/postgres/18/main (on /home) 91.0 GiB (warn below 2 GiB on / or 20 GiB for the data directory)" ]]'
lib_case "check_free_space: warns (exit 0) under 2 GiB on the root fs" '
  out=$(PATH=$T/fakedf:$PATH ROOT_KIB=1048576 DATA_KIB=95420416 check_free_space /home/x 2>&1)
  [[ $out == "warn: free space: / 1.0 GiB, /home/x (on /home) 91.0 GiB"* ]]'
lib_case "check_free_space: warns (exit 0) under 20 GiB for the data directory" '
  out=$(PATH=$T/fakedf:$PATH ROOT_KIB=4089446 DATA_KIB=10485760 check_free_space /home/x 2>&1)
  [[ $out == "warn: free space: / 3.9 GiB, /home/x (on /home) 10.0 GiB"* ]]'
lib_case "selfcheck counts and summary fails on FAIL" '
  selfcheck yes true >/dev/null; selfcheck no false >/dev/null; selfcheck refused expect_fail false >/dev/null
  [[ $SELFCHECK_PASSES == 2 && $SELFCHECK_FAILS == 1 ]]; ! selfcheck_summary >/dev/null'
}
