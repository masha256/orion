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
PG_ETC=/etc/postgresql/$PG_MAJOR/$PG_CLUSTER
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

# pg_ensure_cluster: the 18/main cluster exists (the PGDG package creates it on install) and conf.d is included.
pg_ensure_cluster() {
  if ((DRY_RUN)) && ! pkg_installed "postgresql-$PG_MAJOR"; then
    log_do "cluster $PG_MAJOR/$PG_CLUSTER (created by the postgresql-$PG_MAJOR package; pg_createcluster $PG_MAJOR $PG_CLUSTER only if it is missing after that)"
  elif [[ -f $PG_ETC/postgresql.conf ]]; then
    log_ok "cluster $PG_MAJOR/$PG_CLUSTER"
    grep -Eq "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf\.d'" "$PG_ETC/postgresql.conf" ||
      die "$PG_ETC/postgresql.conf has no include_dir = 'conf.d'"
  else
    run pg_createcluster "$PG_MAJOR" "$PG_CLUSTER"
  fi
  ensure_dir "$PG_ETC/conf.d" 755 postgres:postgres
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
