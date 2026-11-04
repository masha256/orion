#!/usr/bin/env bash
# shellcheck shell=bash
# Shared helpers for scripts/provision/*.sh (plan 1.5a). Sourced, never run on its own.
#
# Contract: every state change goes through run / write_file / write_file_once / ensure_* so that
#   * --dry-run prints "would: ..." instead of acting, needs no root, and never fails on a root-only probe;
#   * a state that already holds prints "ok: ..." and changes nothing (a second real run prints only ok: lines);
#   * a real change prints "do: ..." before it happens.
# Nothing here prints file contents of secrets: the only files written through write_file are configuration and
# templates; generated keys are made by ssh-keygen/openssl in place and only their public halves are printed.

DRY_RUN=${DRY_RUN:-0}
FORCE_OS=${FORCE_OS:-0}
CHANGED=0              # write_file / ensure_*: 1 when the last call changed (or, in a dry run, would change) something
APT_UPDATED=0
APT_UPDATE_NEEDED=0
SELFCHECK_PASSES=0
SELFCHECK_FAILS=0
PG_MAJOR=18
PG_CLUSTER=main
# test hook (test/run.sh): another config directory, so a dry run on a host that has a cluster sees a fresh box; never
# set it on a server
PG_ETC=${ORION_PROVISION_PG_ETC:-/etc/postgresql/$PG_MAJOR/$PG_CLUSTER}
PG_DEFAULT_DATADIR=/var/lib/postgresql/$PG_MAJOR/$PG_CLUSTER
PG_SERVICE=postgresql@$PG_MAJOR-$PG_CLUSTER
PGDG_KEY_URL=https://www.postgresql.org/media/keys/ACCC4CF8.asc
PGDG_KEY_FPR=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
PGDG_KEYRING=/etc/apt/keyrings/pgdg.asc

log_ok()   { printf 'ok: %s\n' "$*"; }
log_do()   { if ((DRY_RUN)); then printf 'would: %s\n' "$*"; else printf 'do: %s\n' "$*"; fi; }
log_note() { printf 'note: %s\n' "$*"; }
log_warn() { printf 'warn: %s\n' "$*" >&2; }
die()      { printf 'error: %s\n' "$*" >&2; exit 1; }

is_root() { [[ $(id -u) -eq 0 ]]; }

# Root-only probes (reading root-only files, psql as postgres, ufw status) are skipped in a non-root dry run; the
# caller then reports the step as a change, so the dry run lists a superset of what the real run does.
can_probe() { is_root; }

quote_cmd() {
  local out='' a
  for a in "$@"; do out+="$(printf '%q' "$a") "; done
  printf '%s' "${out% }"
}

# run <cmd...>: print the command, then run it unless --dry-run.
run() {
  log_do "$(quote_cmd "$@")"
  ((DRY_RUN)) && return 0
  "$@"
}

# require_root: real runs need root; dry runs do not.
require_root() {
  ((DRY_RUN)) && return 0
  is_root || die "run with sudo (or pass --dry-run to only print the plan)"
}

os_codename() {
  # shellcheck disable=SC1091
  (. /etc/os-release && printf '%s' "${VERSION_CODENAME:-unknown}")
}

# require_codename <name>: refuse any other Ubuntu codename unless --force-os.
require_codename() {
  local want=$1 have
  have=$(os_codename)
  if [[ $have == "$want" ]]; then
    log_ok "OS codename $have"
  elif ((FORCE_OS)); then
    log_warn "this host is '$have', the script targets '$want'; continuing because of --force-os"
  else
    die "this script is for Ubuntu '$want'; this host is '$have' (pass --force-os to override)"
  fi
}

# path_state <path>: prints exists | absent | unknown (unknown = an ancestor is not searchable by this user, which
# happens only in a non-root dry run).
path_state() {
  local p=$1 d
  if [[ -e $p || -L $p ]]; then echo exists; return; fi
  d=$(dirname "$p")
  while [[ ! -e $d ]]; do d=$(dirname "$d"); done
  if [[ -x $d ]]; then echo absent; else echo unknown; fi
}

octal() { printf '%o' "$((8#$1))"; }

# ensure_mode_owner <path> <mode> <user:group>: fix mode/owner when they differ (sets CHANGED=1 if so).
ensure_mode_owner() {
  local path=$1 mode=$2 owner=$3 have_mode have_owner
  have_mode=$(stat -c '%a' "$path")
  have_owner=$(stat -c '%U:%G' "$path")
  if [[ $(octal "$have_mode") != "$(octal "$mode")" ]]; then
    run chmod "$mode" "$path"
    CHANGED=1
  fi
  if [[ $have_owner != "$owner" ]]; then
    run chown "$owner" "$path"
    CHANGED=1
  fi
}

# show_diff <old file or /dev/null> <new content file>: dry-run only; prints changed lines indented as "    + x" /
# "    - x". Only used for configuration files (no secrets are ever written through write_file).
show_diff() {
  diff -U0 "$1" "$2" | sed -n -e '/^+++/d' -e '/^---/d' -e 's/^\([+-]\)/    \1 /p' || true
}

# write_file <path> <mode> <user:group> [quiet]  (content on stdin)
# Writes only when the content differs (atomically: temp file in the same directory, chmod/chown, rename); fixes
# mode/owner when only those differ. A dry run prints a summary and the changed lines ("quiet": the summary only, for
# long templates and scripts).
write_file() {
  local path=$1 mode=$2 owner=$3 quiet=${4:-} state new tmp added removed
  new=$(mktemp)
  cat >"$new"
  CHANGED=0
  state=$(path_state "$path")
  if [[ $state == exists && ! -r $path ]]; then
    state=unreadable
  fi
  case $state in
    exists)
      if cmp -s "$path" "$new"; then
        ensure_mode_owner "$path" "$mode" "$owner"
        ((CHANGED)) || log_ok "$path"
        rm -f "$new"
        return 0
      fi
      added=$(diff "$path" "$new" | grep -c '^>' || true)
      removed=$(diff "$path" "$new" | grep -c '^<' || true)
      log_do "update $path (+$added -$removed lines; $mode $owner)"
      ((DRY_RUN)) && [[ -z $quiet ]] && show_diff "$path" "$new"
      ;;
    absent)
      log_do "create $path ($(wc -l <"$new") lines; $mode $owner)"
      ((DRY_RUN)) && [[ -z $quiet ]] && show_diff /dev/null "$new"
      ;;
    unknown | unreadable)
      ((DRY_RUN)) || { rm -f "$new"; die "cannot read $path"; }
      log_do "write $path if it differs ($(wc -l <"$new") lines; $mode $owner; current file not readable without root)"
      [[ -z $quiet ]] && show_diff /dev/null "$new"
      ;;
  esac
  CHANGED=1
  if ((DRY_RUN)); then rm -f "$new"; return 0; fi
  tmp=$(mktemp "$(dirname "$path")/.$(basename "$path").XXXXXX")
  cat "$new" >"$tmp"
  rm -f "$new"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$path"
}

# write_file_once <path> <mode> <user:group> [quiet]  (content on stdin)
# Creates the file only if it does not exist; an existing file is never rewritten (it may hold what Mike filled in),
# only its mode/owner are corrected.
write_file_once() {
  local path=$1 mode=$2 owner=$3 quiet=${4:-} state
  state=$(path_state "$path")
  CHANGED=0
  case $state in
    exists)
      cat >/dev/null
      ensure_mode_owner "$path" "$mode" "$owner"
      ((CHANGED)) || log_ok "$path exists (kept; never overwritten)"
      ;;
    absent)
      write_file "$path" "$mode" "$owner" "$quiet"
      ;;
    unknown)
      cat >/dev/null
      log_do "create $path from template if missing ($mode $owner; existence not checkable without root)"
      CHANGED=1
      ;;
  esac
}

# ensure_dir <path> <mode> <user:group>
ensure_dir() {
  local path=$1 mode=$2 owner=$3 state
  CHANGED=0
  state=$(path_state "$path")
  case $state in
    exists)
      [[ -d $path ]] || die "$path exists and is not a directory"
      ensure_mode_owner "$path" "$mode" "$owner"
      ((CHANGED)) || log_ok "directory $path"
      ;;
    absent | unknown)
      run install -d -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$path"
      CHANGED=1
      ;;
  esac
}

# ensure_empty_file <path> <mode> <user:group>: create empty if missing, never truncate.
ensure_empty_file() {
  local path=$1 mode=$2 owner=$3
  write_file_once "$path" "$mode" "$owner" </dev/null
}

# ensure_symlink <link> <target>
ensure_symlink() {
  local link=$1 target=$2
  CHANGED=0
  if [[ -L $link && $(readlink "$link") == "$target" ]]; then
    log_ok "symlink $link -> $target"
  else
    [[ -e $link && ! -L $link ]] && die "$link exists and is not a symlink"
    run ln -sfn "$target" "$link"
    CHANGED=1
  fi
}

pkg_installed() {
  [[ $(dpkg-query -W -f='${Status}' "$1" 2>/dev/null) == "install ok installed" ]]
}

# apt_install <pkg...>: installs the missing ones (one apt-get call); apt-get update first when a source changed.
apt_install() {
  local p missing=()
  for p in "$@"; do
    if pkg_installed "$p"; then log_ok "package $p ($(dpkg-query -W -f='${Version}' "$p"))"; else missing+=("$p"); fi
  done
  ((${#missing[@]})) || return 0
  if ((APT_UPDATE_NEEDED || !APT_UPDATED)); then
    run apt-get update
    APT_UPDATED=1
    APT_UPDATE_NEEDED=0
  fi
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
}

key_fpr() {
  local gh fpr
  command -v gpg >/dev/null 2>&1 || return 0
  gh=$(mktemp -d)
  fpr=$(GNUPGHOME=$gh gpg --batch --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  rm -rf -- "$gh"
  printf '%s' "$fpr"
}

# apt_pgdg: PGDG signing key (fingerprint-checked), deb822 source for "<running codename>-pgdg", and an apt pin so
# postgresql*, libpq* and pgbackrest come from PGDG and never from the Ubuntu archive.
apt_pgdg() {
  local codename tmpkey
  codename=$(os_codename)
  apt_install ca-certificates curl gnupg
  if [[ -r $PGDG_KEYRING && $(key_fpr "$PGDG_KEYRING") == "$PGDG_KEY_FPR" ]]; then
    log_ok "PGDG signing key $PGDG_KEYRING ($PGDG_KEY_FPR)"
  else
    log_do "fetch PGDG signing key ACCC4CF8 from $PGDG_KEY_URL, check fingerprint $PGDG_KEY_FPR, install as $PGDG_KEYRING"
    if ! ((DRY_RUN)); then
      tmpkey=$(mktemp)
      curl -fsSL --proto '=https' -o "$tmpkey" "$PGDG_KEY_URL"
      [[ $(key_fpr "$tmpkey") == "$PGDG_KEY_FPR" ]] || { rm -f "$tmpkey"; die "PGDG key fingerprint mismatch"; }
      install -d -m 755 /etc/apt/keyrings
      install -m 644 -o root -g root "$tmpkey" "$PGDG_KEYRING"
      rm -f "$tmpkey"
    fi
    APT_UPDATE_NEEDED=1
  fi
  write_file /etc/apt/sources.list.d/pgdg.sources 644 root:root <<EOF
# PostgreSQL Global Development Group apt repository (written by scripts/provision; plan 1.5a)
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: $codename-pgdg
Components: main
Signed-By: $PGDG_KEYRING
EOF
  ((CHANGED)) && APT_UPDATE_NEEDED=1
  write_file /etc/apt/preferences.d/pgdg.pref 644 root:root <<'EOF'
# PostgreSQL and pgBackRest only from PGDG, never from the Ubuntu archive (written by scripts/provision; plan 1.5a)
Package: postgresql* libpq* pgbackrest*
Pin: release o=apt.postgresql.org
Pin-Priority: 900

Package: postgresql* libpq* pgbackrest*
Pin: release o=Ubuntu
Pin-Priority: -1
EOF
  ((CHANGED)) && APT_UPDATE_NEEDED=1
  return 0
}

# pg_conf_dropin <name> <content on stdin>: conf.d drop-in; sets PG_RESTART_NEEDED=1 when it changed.
PG_RESTART_NEEDED=0
PG_RELOAD_NEEDED=0
pg_conf_dropin() {
  write_file "$PG_ETC/conf.d/$1" 644 postgres:postgres
  ((CHANGED)) && PG_RESTART_NEEDED=1
  return 0
}

# pg_check_include: the cluster's postgresql.conf includes conf.d (Debian's default; the drop-ins depend on it).
pg_check_include() {
  grep -Eq "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf\.d'" "$PG_ETC/postgresql.conf" ||
    die "$PG_ETC/postgresql.conf has no include_dir = 'conf.d'"
}

# pg_cluster_datadir: the data directory pg_lsclusters lists for 18/main; nothing when there is no such cluster.
pg_cluster_datadir() {
  command -v pg_lsclusters >/dev/null 2>&1 || return 0
  pg_lsclusters -h 2>/dev/null | awk -v v="$PG_MAJOR" -v c="$PG_CLUSTER" '$1 == v && $2 == c { print $6; exit }'
}

# pg_extra_databases: the cluster's databases other than postgres, template0 and template1, one per line (none for a
# fresh cluster). Fails when it cannot ask: the cluster is down, or a non-root dry run may not connect.
pg_extra_databases() {
  local sql="select datname from pg_database where datname not in ('postgres', 'template0', 'template1') order by 1"
  if is_root; then
    psql_as_postgres "$sql"
  else
    (cd / && psql -X -w -qAt -v ON_ERROR_STOP=1 -d postgres -c "$sql") 2>/dev/null
  fi
}

# pg_plan_datadir <dir>: how cluster 18/main gets its data directory to <dir>; sets PG_DATADIR_PLAN to
#   ok      the cluster exists and its data directory is <dir>
#   create  the package is installed but there is no cluster: pg_createcluster -d <dir>
#   later   the package is not installed yet (dry run): it creates a fresh cluster at the package default, then "move"
#   move    the cluster is at the package default and fresh: pg_dropcluster --stop, pg_createcluster -d <dir>, start
# Dies, changing nothing, when the cluster is anywhere else, is at the package default but holds a database of its own,
# cannot be checked (real run), or <dir> is not absent/empty. Prints no would:/do: line: it is also the preflight check.
pg_plan_datadir() {
  local want=$1 have extra parent
  have=$(pg_cluster_datadir)
  if [[ -n $have ]]; then
    if [[ $have == "$want" ]]; then
      PG_DATADIR_PLAN=ok
      return 0
    fi
    [[ $have == "$PG_DEFAULT_DATADIR" ]] ||
      die "cluster $PG_MAJOR/$PG_CLUSTER keeps its data in $have, which is neither --pg-datadir $want nor the package default $PG_DEFAULT_DATADIR; refusing to touch it (move it by hand, or pass --pg-datadir $have)"
    if extra=$(pg_extra_databases); then
      [[ -z $extra ]] ||
        die "cluster $PG_MAJOR/$PG_CLUSTER in $have is not fresh: it holds database(s) ${extra//$'\n'/, }; refusing to drop it for --pg-datadir $want (move its data by hand after a pg_dump, or run without --pg-datadir)"
    elif ((DRY_RUN)); then
      log_note "cannot list the databases of cluster $PG_MAJOR/$PG_CLUSTER without root; the real run drops it only if it holds nothing but postgres, template0 and template1"
    else
      die "cannot list the databases of cluster $PG_MAJOR/$PG_CLUSTER in $have (is it running? systemctl start $PG_SERVICE); refusing to drop it unchecked"
    fi
    PG_DATADIR_PLAN=move
  elif pkg_installed "postgresql-$PG_MAJOR"; then
    PG_DATADIR_PLAN=create
  else
    PG_DATADIR_PLAN=later
  fi
  # pg_createcluster -d needs a missing or empty directory; never a symlink
  if [[ -L $want ]]; then die "--pg-datadir $want is a symlink; give the real directory"; fi
  if [[ $(path_state "$want") == exists ]]; then
    [[ -d $want ]] || die "--pg-datadir $want exists and is not a directory"
    if [[ -r $want && -x $want ]]; then
      [[ -z $(ls -A "$want") ]] || die "--pg-datadir $want is not empty; refusing to touch its contents (pg_createcluster needs a missing or empty directory)"
    elif ! ((DRY_RUN)); then
      die "cannot read $want"
    fi
  fi
  # its parent becomes postgres:postgres 700: created if missing, refused (not taken over) if it belongs to someone else
  parent=$(dirname "$want")
  if [[ $(path_state "$parent") == exists ]]; then
    [[ -d $parent && ! -L $parent ]] || die "$parent (parent of --pg-datadir) is not a plain directory"
    [[ $(stat -c %U "$parent") == postgres ]] ||
      die "$parent (parent of --pg-datadir) exists and is owned by $(stat -c %U:%G "$parent"), not postgres; refusing to take it over (pick a data directory whose parent is new or postgres's)"
  fi
  return 0
}

# pg_ensure_datadir_parent <dir>: <dir> (the data directory's parent; pg_plan_datadir has vetted it) is
# postgres:postgres 700. Missing ancestors are created postgres:postgres 700 too; existing ancestors are not touched.
pg_ensure_datadir_parent() {
  local dir=$1 d missing=()
  d=$dir
  while [[ $(path_state "$d") != exists ]]; do
    missing=("$d" "${missing[@]}")
    d=$(dirname "$d")
  done
  ((${#missing[@]})) || missing=("$dir")
  for d in "${missing[@]}"; do
    ensure_dir "$d" 700 postgres:postgres
  done
  return 0
}

# pg_ensure_cluster [data dir]: the 18/main cluster exists (the PGDG package creates it on install) and conf.d is
# included. With a data dir: the cluster's data lives there (pg_plan_datadir decides; a fresh package-default cluster
# is dropped and re-created there, never symlinked). Without one: wherever the package put it (unchanged behaviour).
pg_ensure_cluster() {
  local want=${1:-}
  if [[ -n $want ]]; then
    pg_plan_datadir "$want"
    if [[ $PG_DATADIR_PLAN == ok ]]; then
      log_ok "cluster $PG_MAJOR/$PG_CLUSTER in $want"
      [[ -f $PG_ETC/postgresql.conf ]] && pg_check_include
    else
      pg_ensure_datadir_parent "$(dirname "$want")"
      case $PG_DATADIR_PLAN in
        later)
          ((DRY_RUN)) || die "postgresql-$PG_MAJOR is still not installed"
          log_note "the postgresql-$PG_MAJOR package creates cluster $PG_MAJOR/$PG_CLUSTER in $PG_DEFAULT_DATADIR; the real run then checks it holds no database of its own and moves it:"
          run pg_dropcluster --stop "$PG_MAJOR" "$PG_CLUSTER"
          ;;
        move)
          log_note "cluster $PG_MAJOR/$PG_CLUSTER is at the package default $PG_DEFAULT_DATADIR with no database of its own; re-creating it (empty) in $want"
          run pg_dropcluster --stop "$PG_MAJOR" "$PG_CLUSTER"
          ;;
      esac
      run pg_createcluster -d "$want" "$PG_MAJOR" "$PG_CLUSTER"
      run systemctl start "$PG_SERVICE"
      if ! ((DRY_RUN)); then
        [[ $(pg_cluster_datadir) == "$want" ]] || die "cluster $PG_MAJOR/$PG_CLUSTER is not in $want after pg_createcluster"
        pg_check_include
      fi
    fi
  elif ((DRY_RUN)) && ! pkg_installed "postgresql-$PG_MAJOR"; then
    log_do "cluster $PG_MAJOR/$PG_CLUSTER (created by the postgresql-$PG_MAJOR package; pg_createcluster $PG_MAJOR $PG_CLUSTER only if it is missing after that)"
  elif [[ -f $PG_ETC/postgresql.conf ]]; then
    log_ok "cluster $PG_MAJOR/$PG_CLUSTER"
    pg_check_include
  else
    run pg_createcluster "$PG_MAJOR" "$PG_CLUSTER"
  fi
  ensure_dir "$PG_ETC/conf.d" 755 postgres:postgres
}

# free_kib <path>: available KiB, and the mount point, of the filesystem holding <path> (or its nearest existing
# ancestor, so it works before the path is created), as "<kib> <mount>".
free_kib() {
  local p=$1
  while [[ ! -e $p ]]; do p=$(dirname "$p"); done
  df -Pk -- "$p" | awk 'NR == 2 { print $4, $6 }'
}

# check_free_space <data dir>: one line with both figures; a warning (never a failure) when / has under 2 GiB free
# or the filesystem holding the data directory under 20 GiB.
check_free_space() {
  local dir=$1 root='' data='' data_mnt='' msg
  read -r root _ < <(free_kib /) || true
  read -r data data_mnt < <(free_kib "$dir") || true
  [[ $root =~ ^[0-9]+$ && $data =~ ^[0-9]+$ ]] || { log_warn "free space: df gave no figures for / or $dir"; return 0; }
  msg=$(awk -v r="$root" -v d="$data" -v dir="$dir" -v m="$data_mnt" 'BEGIN {
    printf "free space: / %.1f GiB, %s (on %s) %.1f GiB (warn below 2 GiB on / or 20 GiB for the data directory)", r / 1048576, dir, m, d / 1048576 }')
  if ((root < 2 * 1048576 || data < 20 * 1048576)); then log_warn "$msg"; else log_ok "$msg"; fi
}

# pg_apply: restart if a conf.d drop-in changed, reload if only hba/ident changed, start if stopped.
pg_apply() {
  if ((PG_RESTART_NEEDED)); then
    run systemctl restart "$PG_SERVICE"
  elif ! systemctl is-active --quiet "$PG_SERVICE" 2>/dev/null; then
    run systemctl start "$PG_SERVICE"
  elif ((PG_RELOAD_NEEDED)); then
    run systemctl reload "$PG_SERVICE"
  else
    log_ok "$PG_SERVICE running with current configuration"
  fi
  PG_RESTART_NEEDED=0
  PG_RELOAD_NEEDED=0
  # postgresql.service starts every cluster whose start.conf says auto (the package default)
  run_quiet_enable postgresql.service
}

# run_quiet_enable <unit>: systemctl enable unless already enabled.
run_quiet_enable() {
  if [[ $(systemctl is-enabled "$1" 2>/dev/null) == enabled ]]; then
    log_ok "$1 enabled"
  else
    run systemctl enable "$1"
  fi
}

# backup_once <path>: keep the distribution's original next to it before we first replace it.
backup_once() {
  local path=$1
  if [[ ! -e $path ]]; then return 0; fi
  if [[ -e $path.dist ]]; then return 0; fi
  run cp -p "$path" "$path.dist"
}

# psql_as_postgres <sql>: one statement as the postgres superuser over the local socket; prints unaligned rows.
psql_as_postgres() {
  (cd / && runuser -u postgres -- psql -X -qAt -v ON_ERROR_STOP=1 -d postgres -c "$1")
}

# psql_file_as_postgres <file> [psql -v assignments...]: runs a guarded SQL file (it prints its own ok:/do: lines).
# The file is fed on stdin so postgres needs no read access to the checkout. A dry run prints the file's
# "-- ensure:" lines instead (it never runs SQL).
psql_file_as_postgres() {
  local file=$1 v args=()
  shift
  for v in "$@"; do args+=(-v "$v"); done
  if ((DRY_RUN)); then
    log_do "run $(basename "$file") as postgres (each object below is created or fixed only if it differs):"
    sed -n 's/^-- ensure: /    ensure /p' "$file"
    return 0
  fi
  (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "${args[@]}" -d postgres -f - <"$file")
}

# selfcheck <name> <cmd...>: PASS when the command exits 0. Output of a failing check is shown (first lines).
selfcheck() {
  local name=$1 out
  shift
  if ((DRY_RUN)); then
    printf 'SKIP: %s (dry-run)\n' "$name"
    return 0
  fi
  if out=$("$@" 2>&1); then
    printf 'PASS: %s\n' "$name"
    SELFCHECK_PASSES=$((SELFCHECK_PASSES + 1))
  else
    printf 'FAIL: %s\n' "$name"
    [[ -n $out ]] && printf '%s\n' "$out" | head -n 3 | sed 's/^/      | /'
    SELFCHECK_FAILS=$((SELFCHECK_FAILS + 1))
  fi
  return 0
}

# expect_fail <cmd...>: succeeds when the command fails (for "must be refused" checks).
expect_fail() { ! "$@"; }

# selfcheck_summary: the last line Mike pastes back; non-zero exit when any check failed.
selfcheck_summary() {
  if ((DRY_RUN)); then
    printf 'SELF-CHECK: skipped (dry-run; nothing was changed)\n'
    return 0
  fi
  printf 'SELF-CHECK: %d passed, %d failed\n' "$SELFCHECK_PASSES" "$SELFCHECK_FAILS"
  ((SELFCHECK_FAILS == 0))
}

# orion_user_files <home> <user:group> <env> <files dir>: the Phase 1.5c files of one Orion user (plan 1.5c Task 15) on
# top of the 1.5a layout: the deploy directories (~/incoming for install, ~/home/disclosure, ~/shared/predeploy for
# the --breaking pg_dump), ~/.ssh/known_hosts with GitHub's pinned host keys (R-c12; the file is managed: written
# whole), and the daemon user unit from the template with @ORION_ENV@ substituted. Sets ORION_UNIT_CHANGED=1 when the
# unit file changed (the caller then runs systemctl --user daemon-reload as the user). Never enables or starts anything.
# shellcheck disable=SC2034  # read by orion-host.sh (and test/lib-test.sh)
ORION_UNIT_CHANGED=0
# shellcheck disable=SC2034  # ORION_UNIT_CHANGED is read by the caller
orion_user_files() {
  local h=$1 own=$2 env=$3 files=$4
  ORION_UNIT_CHANGED=0
  ensure_dir "$h/incoming" 700 "$own"
  ensure_dir "$h/home/disclosure" 700 "$own"
  ensure_dir "$h/shared/predeploy" 700 "$own"
  write_file "$h/.ssh/known_hosts" 644 "$own" <"$files/github-known-hosts"
  # not `sed | write_file`: a pipeline runs write_file in a subshell, and the CHANGED it sets would be lost
  write_file "$h/.config/systemd/user/orion-daemon.service" 644 "$own" < <(sed "s/@ORION_ENV@/$env/g" "$files/orion-daemon.service")
  ORION_UNIT_CHANGED=$CHANGED
  return 0
}
