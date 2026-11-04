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

# --- fake host state for the dry runs ------------------------------------------------------------------------------
# The dry runs read the host's real state, and this host has Postgres 18 itself. So every dry run below sees a fresh
# box through: a dpkg-query that knows only $FAKE_INSTALLED, a pg_lsclusters that lists 18/main only when
# $FAKE_CLUSTER_DIR is set, a psql that prints $FAKE_DBS (fails with FAKE_PSQL_FAIL=1), and an empty config directory
# (ORION_PROVISION_PG_ETC). None of them is ever the real tool.
pgfake=$tmp/pgfake
mkdir -p "$pgfake"
cat >"$pgfake/dpkg-query" <<'EOF_FAKE'
#!/bin/bash
pkg=${!#}
for p in ${FAKE_INSTALLED:-}; do
  if [[ $p == "$pkg" ]]; then
    case $* in *Status*) printf 'install ok installed' ;; *) printf '1.0-fake' ;; esac
    exit 0
  fi
done
exit 1
EOF_FAKE
cat >"$pgfake/pg_lsclusters" <<'EOF_FAKE'
#!/bin/bash
[[ -n ${FAKE_CLUSTER_DIR:-} ]] && printf '18  main    5432 online postgres %s /var/log/postgresql/postgresql-18-main.log\n' "$FAKE_CLUSTER_DIR"
exit 0
EOF_FAKE
cat >"$pgfake/psql" <<'EOF_FAKE'
#!/bin/bash
[[ ${FAKE_PSQL_FAIL:-0} == 1 ]] && { echo 'psql: fake connection refused' >&2; exit 2; }
[[ -n ${FAKE_DBS:-} ]] && printf '%s\n' $FAKE_DBS
exit 0
EOF_FAKE
chmod +x "$pgfake"/*
PG_ETC_FAKE=$tmp/fakeroot/etc/postgresql/18/main # never created: the dry runs see no configuration yet
F=(PATH="$pgfake:$PATH" ORION_PROVISION_PG_ETC="$PG_ETC_FAKE")

# --- dev-postgres.sh ----------------------------------------------------------------------------------------------
dev=$prov/dev-postgres.sh
me=$(id -un)
run_case dev 0 env -u SUDO_USER "${F[@]}" "$dev" --dry-run --force-os --os-user "$me"
for re in \
  '/etc/apt/keyrings/pgdg\.asc' \
  'ACCC4CF8' \
  '/etc/apt/sources\.list\.d/pgdg\.sources' \
  'Suites: [a-z]+-pgdg|^ok: /etc/apt/sources\.list\.d/pgdg\.sources$' \
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

run_case dev-no-user nonzero env -u SUDO_USER "${F[@]}" "$dev" --dry-run --force-os --os-user no-such-user-orion-test
expect dev-no-user 'no-such-user-orion-test'
run_case dev-bad-flag nonzero env "${F[@]}" "$dev" --dry-run --force-os --no-such-flag

# --- orion-host.sh ------------------------------------------------------------------------------------------------
host=$prov/orion-host.sh
hn=$(uname -n)
ssh-keygen -q -t ed25519 -N '' -C test-stage -f "$tmp/stage_key" && ssh-keygen -q -t ed25519 -N '' -C test-prod -f "$tmp/prod_key"
recipient=age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq # syntactically valid; not anyone's key
printf '[global]\nrepo1-s3-key=REPLACE_ME\n' >"$tmp/pgbr-placeholder.conf"
printf '[global]\nrepo1-s3-key=filled\n[orion]\npg1-path=/var/lib/postgresql/18/main\n' >"$tmp/pgbr-filled.conf"
H=(env -u SSH_CONNECTION "${F[@]}" SSH_CLIENT="192.168.0.201 50000 22" "$host" --dry-run --force-os --hostname "$hn")

run_case host-os nonzero env -u SSH_CLIENT "${F[@]}" "$host" --dry-run --hostname "$hn" --ssh-from 192.168.0.201
expect host-os "resolute"
expect_not host-os '^would: '

run_case host 0 "${H[@]}" --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 \
  --deploy-key-stage "$tmp/stage_key.pub" --deploy-key-prod "$tmp/prod_key.pub" --nut
for re in \
  '/etc/apt/sources\.list\.d/pgdg\.sources' \
  'apt-get install .*postgresql-18 .*postgresql-client-18 .*pgbackrest .*python3-venv .*ufw .*age' \
  'nut-client' \
  'nodejs\.org/dist/v26\.13\.0/node-v26\.13\.0-linux-x64\.tar\.xz' \
  'sha256 d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997' \
  '/opt/node-v26\.13\.0' \
  'ln -sfn node-v26\.13\.0 /opt/node-v26' \
  'useradd .*orion-prod$' \
  'useradd .*orion-stage$' \
  'enable-linger orion-prod' \
  'enable-linger orion-stage' \
  '/home/orion-prod/releases' \
  '/home/orion-stage/shared$' \
  '/home/orion-prod/home/publish' \
  '/home/orion-stage/\.config/systemd/user' \
  '/home/orion-prod/deploys\.log' \
  'create /home/orion-prod/shared/\.env .*600' \
  'create /home/orion-stage/shared/\.env .*600' \
  'ssh-keygen .*-t ed25519 .*orion-prod@.* publish.* -f /home/orion-prod/shared/publish_ed25519' \
  'ssh-keygen .*orion-stage@.*/home/orion-stage/shared/publish_ed25519' \
  'genpkey .*ed25519.*/home/orion-prod/shared/snapshot-sign\.key' \
  'genpkey .*ed25519.*/home/orion-stage/shared/snapshot-sign\.key' \
  '/home/orion-prod/\.ssh/authorized_keys .*600' \
  '^ *\+ restrict,command="/usr/local/bin/orion-remote" ssh-ed25519 [A-Za-z0-9+/=]+ test-prod$' \
  '^ *\+ restrict,command="/usr/local/bin/orion-remote" ssh-ed25519 [A-Za-z0-9+/=]+ test-stage$' \
  'create /usr/local/bin/orion-remote .*755 root:root' \
  "shared_buffers = 2GB" \
  "listen_addresses = ''" \
  '^ *\+ *local +orion_prod +orion_prod,orion_prod_ro +peer +map=prod$' \
  '^ *\+ *local +orion_stage +orion_stage +peer +map=stage$' \
  '^ *\+ *local +all +postgres +peer$' \
  '^ *\+ *local +all +all +reject$' \
  '^ *\+ *prod +orion-prod +orion_prod$' \
  '^ *\+ *prod +orion-prod +orion_prod_ro$' \
  '^ *\+ *stage +orion-stage +orion_stage$' \
  'ensure role orion_prod ' \
  'ensure role orion_stage ' \
  'ensure role orion_prod_ro ' \
  'ensure database orion_prod ' \
  'ensure database orion_stage ' \
  'REVOKE CONNECT.*FROM PUBLIC' \
  'schema orion in orion_prod' \
  'create /etc/pgbackrest/pgbackrest\.conf .*640 root:postgres' \
  'backups not enabled' \
  'ufw default deny incoming|ufw default deny incoming' \
  'ufw allow from 192\.168\.0\.201 to any port 22 proto tcp' \
  'ufw allow from 100\.109\.70\.114 to any port 22 proto tcp' \
  'ufw --force enable' \
  'SKIP: .*orion-stage -> orion_prod' \
  'SKIP: SET ROLE orion_prod as orion_stage is refused' \
  'SKIP: orion_prod_ro cannot write' \
  'SKIP: pgbackrest check'; do
  expect host "$re"
done
expect_not host '^do: '
expect_not host 'pg_dropcluster|pg_createcluster -d'
expect host '^(ok|warn): free space: / [0-9]+\.[0-9] GiB, /var/lib/postgresql/18/main \(on [^)]+\) [0-9]+\.[0-9] GiB'
expect host 'cluster 18/main \(created by the postgresql-18 package'
expect_not host 'BEGIN OPENSSH PRIVATE KEY|PRIVATE KEY'
expect_before host 'ufw allow from 100\.109' 'ufw --force enable'

run_case host-noufw 0 env -u SSH_CLIENT "${F[@]}" "$host" --dry-run --force-os --hostname "$hn"
expect host-noufw 'ufw step skipped'
expect host-noufw 'no --deploy-key-stage'
expect_not host-noufw '(would|do): ufw '

# R3: an SSH caller outside --ssh-from is refused before any change (no would: line at all)
run_case host-lockout nonzero env "${F[@]}" SSH_CLIENT="10.9.9.9 50000 22" "$host" --dry-run --force-os --hostname "$hn" \
  --ssh-from 192.168.0.201 --ssh-from 100.109.70.114
expect host-lockout 'refusing to enable ufw.*10\.9\.9\.9'
expect_not host-lockout '^(would|do): '
run_case host-cidr 0 env "${F[@]}" SSH_CLIENT="192.168.0.77 50000 22" "$host" --dry-run --force-os --hostname "$hn" \
  --ssh-from 192.168.0.0/24
expect host-cidr 'ufw allow from 192\.168\.0\.0/24 to any port 22'
run_case host-v6mapped 0 env "${F[@]}" SSH_CLIENT="::ffff:192.168.0.201 50000 22" "$host" --dry-run --force-os \
  --hostname "$hn" --ssh-from 192.168.0.201
run_case host-bad-cidr nonzero "${H[@]}" --ssh-from 192.168.0.300
expect_not host-bad-cidr '^(would|do): '
run_case host-wrong-hostname nonzero "${H[@]}" --hostname not-this-host-x --ssh-from 192.168.0.201
expect host-wrong-hostname 'not-this-host-x'
run_case host-no-hostname nonzero env -u SSH_CLIENT "${F[@]}" "$host" --dry-run --force-os
run_case host-private-key nonzero "${H[@]}" --deploy-key-prod "$tmp/prod_key"
expect_not host-private-key '^(would|do): '

# R2: --enable-backups refuses while placeholders remain or the conf is missing, or without a recipient
run_case host-backups-placeholder nonzero env ORION_PROVISION_PGBACKREST_CONF="$tmp/pgbr-placeholder.conf" \
  "${H[@]}" --enable-backups --dump-recipient "$recipient"
expect host-backups-placeholder 'REPLACE_ME'
expect_not host-backups-placeholder '^(would|do): '
run_case host-backups-missing nonzero env ORION_PROVISION_PGBACKREST_CONF="$tmp/no-such.conf" \
  "${H[@]}" --enable-backups --dump-recipient "$recipient"
run_case host-backups-no-recipient nonzero env ORION_PROVISION_PGBACKREST_CONF="$tmp/pgbr-filled.conf" \
  "${H[@]}" --enable-backups
run_case host-backups-bad-recipient nonzero env ORION_PROVISION_PGBACKREST_CONF="$tmp/pgbr-filled.conf" \
  "${H[@]}" --enable-backups --dump-recipient age1short
run_case host-backups 0 env ORION_PROVISION_PGBACKREST_CONF="$tmp/pgbr-filled.conf" \
  "${H[@]}" --ssh-from 192.168.0.201 --enable-backups --dump-recipient "$recipient"
for re in \
  'no REPLACE_ME left' \
  "create /etc/orion/dump-recipient" \
  "^ *\+ $recipient\$" \
  'pgbackrest --stanza=orion stanza-create' \
  'conf\.d/orion-backup\.conf' \
  '^ *\+ archive_mode = on$' \
  "^ *\+ archive_command = 'pgbackrest --stanza=orion archive-push %p'\$" \
  '^ *\+ archive_timeout = 300$' \
  'create /usr/local/sbin/orion-pg-dump .*755 root:root' \
  '^ *\+ OnCalendar=Sun \*-\*-\* 09:00:00 UTC$' \
  '^ *\+ OnCalendar=Mon\.\.Sat \*-\*-\* 09:00:00 UTC$' \
  '^ *\+ OnCalendar=\*-\*-\* 08:30:00 UTC$' \
  '^ *\+ User=postgres$' \
  'orion-backup-full\.timer' \
  'enable --now orion-backup-diff\.timer' \
  'enable --now orion-pg-dump\.timer' \
  'systemctl daemon-reload' \
  'install -d -m 700 -o postgres -g postgres /home/orion-backups$' \
  'install -d -m 700 -o postgres -g postgres /home/orion-backups/dumps$' \
  'install -d -m 750 -o postgres -g postgres /home/orion-refresh$' \
  '^ *\+ RequiresMountsFor=/home/orion-backups /home/orion-refresh$' \
  '^ *\+ RequiresMountsFor=/var/lib/postgresql/18/main$' \
  'SKIP: pgbackrest check'; do
  expect host-backups "$re"
done
expect_not host-backups '/srv/|/var/backups'
if grep -REn '/srv/|/var/backups' "$prov/orion-host.sh" "$prov/lib.sh" "$prov/files" >"$tmp/oldpaths.out"; then
  bad "no /srv or /var/backups path left in orion-host.sh, lib.sh, files/" "$(head -n 3 "$tmp/oldpaths.out" | tr '\n' '|')"
else
  ok "no /srv or /var/backups path left in orion-host.sh, lib.sh, files/"
fi
for re in 'out=/home/orion-backups/dumps$' 'refresh=/home/orion-refresh$'; do
  if grep -Eq -- "$re" "$prov/files/orion-pg-dump"; then ok "orion-pg-dump has /$re/"; else bad "orion-pg-dump has /$re/"; fi
done
if grep -Fxq 'pg1-path=@PG1PATH@' "$prov/files/pgbackrest.conf.tmpl"; then ok "pgbackrest.conf.tmpl takes pg1-path from the data directory"; else bad "pgbackrest.conf.tmpl takes pg1-path from the data directory"; fi

# --pg-datadir (spec §2.4: venus has a 10G root, so the cluster lives on /home). A fresh box: the package creates
# 18/main at the default, then the script drops and re-creates it in the new place, before any drop-in, hba or role.
dd=$tmp/pgroot/18/main
run_case host-datadir 0 "${H[@]}" --ssh-from 192.168.0.201 --pg-datadir "$dd"
for re in \
  "ok: --pg-datadir $dd \\(plan: later\\)" \
  "install -d -m 700 -o postgres -g postgres $tmp/pgroot\$" \
  "install -d -m 700 -o postgres -g postgres $tmp/pgroot/18\$" \
  'the postgresql-18 package creates cluster 18/main in /var/lib/postgresql/18/main' \
  '^would: pg_dropcluster --stop 18 main$' \
  "^would: pg_createcluster -d $dd 18 main\$" \
  '^would: systemctl start postgresql@18-main$' \
  "^(ok|warn): free space: / .* GiB, $dd \\(on [^)]+\\) .* GiB"; do
  expect host-datadir "$re"
done
expect_not host-datadir 'ln -s.*(pgroot|18/main)'
expect_before host-datadir 'apt-get install .*postgresql-18' 'pg_dropcluster'
expect_before host-datadir "install -d .* $tmp/pgroot/18\$" 'pg_dropcluster'
expect_before host-datadir 'pg_dropcluster' 'pg_createcluster -d'
expect_before host-datadir 'pg_createcluster -d' 'conf\.d/orion\.conf'
expect_before host-datadir 'pg_createcluster -d' 'pg_hba\.conf'
expect_before host-datadir 'pg_createcluster -d' 'pg_ident\.conf'
expect_before host-datadir 'pg_createcluster -d' 'host-roles\.sql'
# installed, fresh cluster at the package default: dropped and re-created
run_case host-datadir-move 0 env FAKE_INSTALLED=postgresql-18 FAKE_CLUSTER_DIR=/var/lib/postgresql/18/main FAKE_DBS= \
  "${H[@]}" --pg-datadir "$dd"
expect host-datadir-move 'plan: move'
expect host-datadir-move 'cluster 18/main is at the package default /var/lib/postgresql/18/main with no database of its own'
expect host-datadir-move '^would: pg_dropcluster --stop 18 main$'
expect host-datadir-move "^would: pg_createcluster -d $dd 18 main\$"
# a dry run that cannot ask (non-root on the real box): lists the move, says the real run checks first
run_case host-datadir-unprobed 0 env FAKE_INSTALLED=postgresql-18 FAKE_CLUSTER_DIR=/var/lib/postgresql/18/main \
  FAKE_PSQL_FAIL=1 "${H[@]}" --pg-datadir "$dd"
expect host-datadir-unprobed 'cannot list the databases .*the real run drops it only if'
expect host-datadir-unprobed '^would: pg_dropcluster --stop 18 main$'
# installed, no cluster: created in place
run_case host-datadir-create 0 env FAKE_INSTALLED=postgresql-18 "${H[@]}" --pg-datadir "$dd"
expect host-datadir-create 'plan: create'
expect host-datadir-create "^would: pg_createcluster -d $dd 18 main\$"
expect_not host-datadir-create 'pg_dropcluster'
# already there: nothing to do
run_case host-datadir-ok 0 env FAKE_INSTALLED=postgresql-18 FAKE_CLUSTER_DIR="$dd" "${H[@]}" --pg-datadir "$dd"
expect host-datadir-ok "ok: cluster 18/main in $dd"
expect_not host-datadir-ok 'pg_dropcluster|pg_createcluster'
# refusals: before any change (no would: line at all)
run_case host-datadir-nonfresh nonzero env FAKE_INSTALLED=postgresql-18 FAKE_CLUSTER_DIR=/var/lib/postgresql/18/main \
  FAKE_DBS='orion_prod orion_stage' "${H[@]}" --pg-datadir "$dd"
expect host-datadir-nonfresh 'is not fresh: it holds database\(s\) orion_prod, orion_stage; refusing to drop it'
expect_not host-datadir-nonfresh '^(would|do): '
run_case host-datadir-elsewhere nonzero env FAKE_INSTALLED=postgresql-18 FAKE_CLUSTER_DIR=/srv/pg/18/main FAKE_DBS= \
  "${H[@]}" --pg-datadir "$dd"
expect host-datadir-elsewhere 'keeps its data in /srv/pg/18/main, which is neither --pg-datadir .* nor the package default'
expect_not host-datadir-elsewhere '^(would|do): '
run_case host-datadir-relative nonzero "${H[@]}" --pg-datadir home/postgres/18/main
expect host-datadir-relative 'must be an absolute'
run_case host-datadir-dotdot nonzero "${H[@]}" --pg-datadir /home/postgres/../main
mkdir -p "$tmp/full/18/main" && touch "$tmp/full/18/main/PG_VERSION"
run_case host-datadir-nonempty nonzero "${H[@]}" --pg-datadir "$tmp/full/18/main"
expect host-datadir-nonempty 'is not empty'
expect_not host-datadir-nonempty '^(would|do): '
mkdir -p "$tmp/mine/18"
run_case host-datadir-foreign-parent nonzero "${H[@]}" --pg-datadir "$tmp/mine/18/main"
expect host-datadir-foreign-parent "owned by $me:.*not postgres; refusing to take it over"
expect_not host-datadir-foreign-parent '^(would|do): '
printf '[global]\nrepo1-s3-key=filled\n[orion]\npg1-path=%s\n' "$dd" >"$tmp/pgbr-datadir.conf"
# --enable-backups refuses a pgbackrest.conf whose pg1-path is not the data directory
run_case host-backups-pg1path nonzero env FAKE_INSTALLED=postgresql-18 FAKE_CLUSTER_DIR="$dd" \
  ORION_PROVISION_PGBACKREST_CONF="$tmp/pgbr-filled.conf" "${H[@]}" --pg-datadir "$dd" \
  --enable-backups --dump-recipient "$recipient"
expect host-backups-pg1path "pg1-path=/var/lib/postgresql/18/main, but the cluster's data directory is $dd"
expect_not host-backups-pg1path '^(would|do): '
run_case host-backups-datadir 0 env FAKE_INSTALLED=postgresql-18 FAKE_CLUSTER_DIR="$dd" \
  ORION_PROVISION_PGBACKREST_CONF="$tmp/pgbr-datadir.conf" "${H[@]}" --pg-datadir "$dd" \
  --enable-backups --dump-recipient "$recipient"
expect host-backups-datadir "^ *\\+ RequiresMountsFor=$dd\$"
# --backup-disk is documented as no protection on a one-disk box; the run says so too
run_case host-backup-disk 0 "${H[@]}" --backup-disk "$tmp"
expect host-backup-disk 'repo 2 protects against nothing if .* is on the same physical disk'
expect_before host-backups 'stanza-create' 'orion-backup\.conf'

# --- orion-remote (1.5c, Python): caller text never reaches a shell ------------------------------------------------
# The full unit tests are test_orion_remote.py (tests/release/orionRemote.test.ts runs them); here: the dry-run user's
# view, with ORION_REMOTE_TEST=1 pretending to be orion-stage and fakes for pg_isready and anything a shell would run.
fakebin=$tmp/fakebin
mkdir -p "$fakebin" "$tmp/rhome"
marker=$tmp/PWNED
for c in id touch sh bash rm node npm psql pg_dump systemctl; do
  printf '#!/bin/sh\necho evaluated >"%s"\n' "$marker" >"$fakebin/$c"
  chmod +x "$fakebin/$c"
done
printf '#!/bin/sh\nexit 0\n' >"$fakebin/pg_isready"
chmod +x "$fakebin/pg_isready"
remote() { # remote <case name> <SSH_ORIGINAL_COMMAND>
  local rpath="$fakebin:/usr/bin:/bin"
  env -i HOME="$tmp/rhome" PATH="$rpath" SSH_CLIENT="192.168.0.201 50000 22" SSH_ORIGINAL_COMMAND="$2" \
    ORION_REMOTE_TEST=1 ORION_REMOTE_TEST_USER=orion-stage ORION_REMOTE_TEST_BIN="$fakebin" \
    /usr/bin/python3 -I -B "$prov/files/orion-remote" >"$tmp/$1.out" 2>&1
}
remote_case() { # remote_case <name> <want exit> <command>
  local rc
  rm -f "$marker"
  remote "$1" "$3"
  rc=$?
  if [[ $rc == "$2" ]]; then ok "orion-remote $1: exit $rc"; else bad "orion-remote $1: exit $rc, wanted $2" "$(tr '\n' '|' <"$tmp/$1.out")"; fi
  if [[ -e $marker ]]; then bad "orion-remote $1: caller text was evaluated"; else ok "orion-remote $1: nothing evaluated"; fi
}
remote_case r-status 0 'status'
expect r-status '^env: stage$'
expect r-status "^host: $hn\$"
expect r-status '^current: none$'
expect r-status '^postgres: accepting connections$'
remote_case r-semicolon 64 'status; id'
remote_case r-and 64 'status && touch x'
# shellcheck disable=SC2016  # the literal text is the point
remote_case r-subst 64 '$(id)'
# shellcheck disable=SC2016
remote_case r-backticks 64 '`id`'
remote_case r-quotes 64 "status 'x' \"y\""
remote_case r-install 64 'install x'
expect r-install "orion-remote: bad tag"
remote_case r-newline 64 "status
id"
remote_case r-empty 64 ''
remote_case r-glob 64 '*'
remote_case r-redirect 64 'status >/tmp/x'
if [[ $(wc -l <"$tmp/rhome/remote.log") -eq 11 ]]; then ok "orion-remote: every call logged (11 lines)"; else bad "orion-remote: every call logged" "$(wc -l <"$tmp/rhome/remote.log") lines"; fi
if [[ $(grep -c ' ok$' "$tmp/rhome/remote.log") -eq 1 && $(grep -c ' refused$' "$tmp/rhome/remote.log") -eq 10 ]]; then
  ok "orion-remote: log has 1 ok and 10 refusals"
else
  bad "orion-remote: log has 1 ok and 10 refusals"
fi
if [[ $(grep -c . "$tmp/rhome/remote.log") -eq $(wc -l <"$tmp/rhome/remote.log") ]] && ! grep -q $'\x1b' "$tmp/rhome/remote.log" &&
  ! grep -Eq 'id|touch|tmp' "$tmp/rhome/remote.log"; then
  ok "orion-remote: one line per call, no control characters and no argument text in the log"
else
  bad "orion-remote: one line per call, no control characters and no argument text in the log"
fi

# --- optional: the SQL files against a throwaway cluster ----------------------------------------------------------
if [[ -n ${PG_BINDIR:-} ]]; then
  # shellcheck source=SCRIPTDIR/sql.sh
  source "$here/sql.sh"
fi

# ------------------------------------------------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
