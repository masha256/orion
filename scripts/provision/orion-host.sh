#!/usr/bin/env bash
# orion-host.sh: set up the Orion server (Ubuntu 26.04 resolute) for the prod and staging environments.
# Spec §2.4 item 2, plan 1.5a Task 2 (rulings R1-R7). Mike runs it from a copy of scripts/provision:
#   sudo ./orion-host.sh --hostname <h> [--pg-datadir <dir>] --ssh-from <ip|cidr> [--ssh-from ...] \
#        [--deploy-key-stage <pubkey file>] [--deploy-key-prod <pubkey file>] [--backup-disk <dir>] [--nut] \
#        [--with-watcher]
# then, once /etc/pgbackrest/pgbackrest.conf has no REPLACE_ME left:
#   sudo ./orion-host.sh --hostname <h> --ssh-from ... --enable-backups --dump-recipient <age public key>
#
#   --hostname <h>          this server's hostname; the script refuses to run on a host with another name
#   --pg-datadir <dir>      the 18/main cluster's data directory (absolute; default: the package's
#                           /var/lib/postgresql/18/main). A fresh package-default cluster is dropped and re-created
#                           there (never a symlink); a cluster holding databases, or elsewhere, is refused.
#                           Pass the same value on every run.
#   --ssh-from <ip|cidr>    allow SSH (22/tcp) from here; repeatable; required to enable ufw (without it ufw is skipped)
#   --deploy-key-stage <f>  public key for orion-stage's authorized_keys (forced command /usr/local/bin/orion-remote)
#   --deploy-key-prod <f>   same for orion-prod
#   --backup-disk <dir>     second disk: a local pgBackRest repo 2 under <dir>/pgbackrest (only when the conf is created;
#                           off by default; on a one-disk box it gives no protection against disk failure)
#   --nut                   install nut-client (UPS signalling)
#   --with-watcher          also build each user's ~/watcher-venv (python3 -m venv + pip install of the pinned
#                           files/watcher-requirements.txt: faster-whisper, yt-dlp, PyYAML; needs the network).
#                           Off by default until the disclosure watcher ships (plan 1.5c Task 11)
#   --enable-backups        step 2: stanza-create, WAL archiving on, pgbackrest check, root backup/dump timers
#   --dump-recipient <age1...>  age public key the nightly pg_dump is encrypted to (kept in /etc/orion/dump-recipient)
#   --dry-run               print every command and file it would write; changes nothing; needs no root
#   --force-os              run on another Ubuntu codename than resolute
#
# Phase 1.5c (Task 15) adds, on every run: the full /usr/local/bin/orion-remote (Python), group orion-refresh (both
# Orion users) owning /home/orion-refresh, and per user ~/incoming, ~/home/disclosure, ~/shared/predeploy,
# ~/.ssh/known_hosts with github.com's pinned host keys, and the orion-daemon systemd user unit (installed and enabled
# through the user's own manager, never started here: the first `orion-remote switch` starts it).
#
# Idempotent: a second run prints only ok: lines (plus public keys and the self-check) and exits 0.
set -euo pipefail
# `cmd | write_file ...; ((CHANGED))`: the last stage of a pipeline runs in this shell, so CHANGED is write_file's
shopt -s lastpipe
# shellcheck source-path=SCRIPTDIR
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=SCRIPTDIR/lib.sh
source "$here/lib.sh"

NODE_VERSION=v26.13.0
NODE_TARBALL=node-$NODE_VERSION-linux-x64.tar.xz
NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997 # nodejs.org/dist/v26.13.0/SHASUMS256.txt
NODE_URL=https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL
NODE_DIR=/opt/node-$NODE_VERSION
NODE_LINK=/opt/node-v26
ENVS=(prod stage)
ORION_REMOTE=/usr/local/bin/orion-remote
# test hook (test/run.sh): another path for the pgBackRest config; never set it on the server
PGBR_CONF=${ORION_PROVISION_PGBACKREST_CONF:-/etc/pgbackrest/pgbackrest.conf}
RECIPIENT_FILE=/etc/orion/dump-recipient
SYSTEMD_DIR=/etc/systemd/system
REFRESH_DIR=/home/orion-refresh
REFRESH_GROUP=orion-refresh
DAEMON_UNIT=orion-daemon.service

usage() { sed -n '2,/^set -euo/{/^#/s/^# \{0,1\}//p}' "${BASH_SOURCE[0]}"; }

HOST_NAME=''
SSH_FROM=()
declare -A DEPLOY_KEY_FILE=() DEPLOY_KEY=()
BACKUP_DISK=''
PG_DATADIR=''
NUT=0
WITH_WATCHER=0
ENABLE_BACKUPS=0
DUMP_RECIPIENT=''
need_arg() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }
while (($#)); do
  case $1 in
    --hostname) need_arg "$@"; HOST_NAME=$2; shift ;;
    --ssh-from) need_arg "$@"; SSH_FROM+=("$2"); shift ;;
    --deploy-key-stage) need_arg "$@"; DEPLOY_KEY_FILE[stage]=$2; shift ;;
    --deploy-key-prod) need_arg "$@"; DEPLOY_KEY_FILE[prod]=$2; shift ;;
    --backup-disk) need_arg "$@"; BACKUP_DISK=$2; shift ;;
    --pg-datadir) need_arg "$@"; PG_DATADIR=$2; shift ;;
    --nut) NUT=1 ;;
    --with-watcher) WITH_WATCHER=1 ;;
    --enable-backups) ENABLE_BACKUPS=1 ;;
    --dump-recipient) need_arg "$@"; DUMP_RECIPIENT=$2; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --force-os) FORCE_OS=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# ================================================================== preflight: every refusal happens here, before
# the first change, so a refused run changes nothing.
((DRY_RUN)) && printf 'DRY RUN: nothing is changed; "would:" lines are what a real run does.\n'
require_codename resolute
require_root

[[ -n $HOST_NAME ]] || die "--hostname <h> is required (this server's hostname)"
[[ $HOST_NAME =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "--hostname '$HOST_NAME' is not a valid host name"
[[ $(uname -n) == "$HOST_NAME" ]] ||
  die "this host is named '$(uname -n)', not '$HOST_NAME' (wrong box? or set the name first: hostnamectl set-hostname)"
log_ok "hostname $HOST_NAME"

# ssh_caller_ip: the address this run's SSH session comes from, or nothing. sudo resets the environment, so when
# SSH_CLIENT is not in ours, look in the ancestor processes' environment (readable as root).
ssh_caller_ip() {
  local v=${SSH_CLIENT:-${SSH_CONNECTION:-}} pid=$$ ppid
  if [[ -z $v ]]; then
    while [[ $pid -gt 1 ]]; do
      ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') || break
      [[ -n $ppid ]] || break
      pid=$ppid
      if [[ -r /proc/$pid/environ ]]; then
        v=$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | sed -n 's/^SSH_\(CLIENT\|CONNECTION\)=//p' | head -n 1) || v=''
        [[ -n $v ]] && break
      fi
    done
  fi
  printf '%s' "${v%% *}"
}

# R3 lockout guard: refuse to enable ufw when the caller's address is not covered by --ssh-from.
if ((${#SSH_FROM[@]})); then
  command -v python3 >/dev/null 2>&1 || die "python3 is needed to check --ssh-from"
  python3 -c '
import ipaddress, sys
for a in sys.argv[1:]:
    try:
        ipaddress.ip_network(a, strict=False)
    except ValueError:
        sys.exit("--ssh-from %r is not an IP address or CIDR" % a)
' "${SSH_FROM[@]}" || die "bad --ssh-from value"
  CALLER_IP=$(ssh_caller_ip)
  if [[ -n $CALLER_IP ]]; then
    if python3 -c '
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1].split("%")[0])
if getattr(ip, "ipv4_mapped", None):
    ip = ip.ipv4_mapped
sys.exit(0 if any(ip in ipaddress.ip_network(n, strict=False) for n in sys.argv[2:]) else 1)
' "$CALLER_IP" "${SSH_FROM[@]}"; then
      log_ok "this SSH session's address $CALLER_IP is covered by --ssh-from"
    else
      die "refusing to enable ufw: this SSH session comes from $CALLER_IP, which no --ssh-from (${SSH_FROM[*]}) covers; you would lock yourself out. Add --ssh-from $CALLER_IP (or its network)."
    fi
  else
    log_warn "could not determine an SSH caller address (not over SSH, or inside tmux/screen); make sure --ssh-from covers the address you administer this box from"
  fi
fi

# deploy keys: one public key per file, no options of its own (the forced command is added here)
for env in "${ENVS[@]}"; do
  f=${DEPLOY_KEY_FILE[$env]:-}
  [[ -n $f ]] || continue
  [[ -r $f ]] || die "--deploy-key-$env: cannot read $f"
  [[ $(grep -cv '^[[:space:]]*$' "$f") -eq 1 ]] || die "--deploy-key-$env: $f must hold exactly one public key line"
  line=$(grep -v '^[[:space:]]*$' "$f")
  key_re='^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|ssh-rsa) [A-Za-z0-9+/=]+( [^"]*)?$'
  [[ $line =~ $key_re ]] ||
    die "--deploy-key-$env: $f is not a plain OpenSSH public key line (no options, no private key)"
  ssh-keygen -l -f "$f" >/dev/null 2>&1 || die "--deploy-key-$env: ssh-keygen cannot read $f as a public key"
  DEPLOY_KEY[$env]=$line
done

if [[ -n $BACKUP_DISK ]]; then
  [[ $BACKUP_DISK == /* && -d $BACKUP_DISK ]] || die "--backup-disk $BACKUP_DISK is not an existing absolute directory"
fi

# --pg-datadir: checked (and refused) here, before any change; pg_ensure_cluster checks again just before acting
if [[ -n $PG_DATADIR ]]; then
  [[ $PG_DATADIR =~ ^(/[A-Za-z0-9._-]+){3,}$ && /$PG_DATADIR/ != */./* && /$PG_DATADIR/ != */../* ]] ||
    die "--pg-datadir $PG_DATADIR must be an absolute, normalised path at least three levels deep (e.g. /home/postgres/18/main)"
  pg_plan_datadir "$PG_DATADIR"
  log_ok "--pg-datadir $PG_DATADIR (plan: $PG_DATADIR_PLAN)"
fi
DATADIR=${PG_DATADIR:-$PG_DEFAULT_DATADIR}

if [[ -n $DUMP_RECIPIENT && ! $DUMP_RECIPIENT =~ ^age1[0-9a-z]{58}$ ]]; then
  die "--dump-recipient must be an age public key (age1 followed by 58 characters)"
fi
if ((ENABLE_BACKUPS)); then
  case $(path_state "$PGBR_CONF") in
    absent) die "--enable-backups: $PGBR_CONF does not exist yet; run once without --enable-backups, fill in its REPLACE_ME values, then retry" ;;
    unknown) ((DRY_RUN)) || die "cannot check $PGBR_CONF" ;;
  esac
  if [[ -r $PGBR_CONF ]]; then
    if grep -q REPLACE_ME "$PGBR_CONF"; then
      die "--enable-backups: $PGBR_CONF still has $(grep -c REPLACE_ME "$PGBR_CONF") REPLACE_ME value(s); fill them in first"
    fi
    log_ok "$PGBR_CONF has no REPLACE_ME left"
    pg1=$(sed -n 's/^pg1-path=//p' "$PGBR_CONF" | head -n 1)
    [[ $pg1 == "$DATADIR" ]] ||
      die "--enable-backups: $PGBR_CONF has pg1-path=$pg1, but the cluster's data directory is $DATADIR; fix pg1-path first"
  elif [[ -e $PGBR_CONF ]]; then
    ((DRY_RUN)) || die "cannot read $PGBR_CONF"
    log_note "$PGBR_CONF is not readable without root; the real run refuses if any REPLACE_ME remains"
  fi
  if [[ -z $DUMP_RECIPIENT && ! -s $RECIPIENT_FILE ]]; then
    die "--enable-backups needs --dump-recipient <age public key> (none stored in $RECIPIENT_FILE yet)"
  fi
fi

# ================================================================== packages
echo "== packages"
apt_pgdg
pkgs=("postgresql-$PG_MAJOR" "postgresql-client-$PG_MAJOR" pgbackrest python3-venv ffmpeg ufw age xz-utils)
((NUT)) && pkgs+=(nut-client)
apt_install "${pkgs[@]}"

echo "== node $NODE_VERSION"
if [[ -x $NODE_DIR/bin/node && $("$NODE_DIR/bin/node" --version 2>/dev/null) == "$NODE_VERSION" ]]; then
  log_ok "node $NODE_VERSION in $NODE_DIR"
else
  [[ -e $NODE_DIR ]] && die "$NODE_DIR exists but does not hold a working node $NODE_VERSION; move it away and re-run"
  log_do "download $NODE_URL, check sha256 $NODE_SHA256, unpack to $NODE_DIR (root:root)"
  if ! ((DRY_RUN)); then
    work=$(mktemp -d /opt/.orion-node.XXXXXX)
    curl -fsSL --proto '=https' -o "$work/$NODE_TARBALL" "$NODE_URL"
    printf '%s  %s\n' "$NODE_SHA256" "$work/$NODE_TARBALL" | sha256sum -c --quiet - ||
      die "sha256 mismatch for $NODE_TARBALL (left in $work for inspection)"
    mkdir "$work/node"
    tar -xJf "$work/$NODE_TARBALL" -C "$work/node" --strip-components=1 --no-same-owner
    chown -R root:root "$work/node"
    chmod 755 "$work/node"
    mv "$work/node" "$NODE_DIR"
    rm -f "$work/$NODE_TARBALL"
    rmdir "$work"
  fi
fi
ensure_symlink "$NODE_LINK" "node-$NODE_VERSION"

# ================================================================== the staging-refresh dump directory (1.5c)
# The nightly prod dump (orion-pg-dump, as postgres) lands in /home/orion-refresh/latest.dump 640; the directory is
# setgid orion-refresh, so the file's group is orion-refresh and both Orion users (members) can read it.
echo "== group $REFRESH_GROUP"
if getent group "$REFRESH_GROUP" >/dev/null; then
  log_ok "group $REFRESH_GROUP"
else
  run groupadd --system "$REFRESH_GROUP"
fi
ensure_dir "$REFRESH_DIR" 2750 "postgres:$REFRESH_GROUP"

# R-c12: GitHub's host keys are pinned (files/github-known-hosts); ssh-keyscan is only a cross-check, never trusted
if ((DRY_RUN)); then
  log_note "ssh-keyscan check skipped (dry-run): the real run compares files/github-known-hosts with ssh-keyscan github.com (a warning only)"
else
  scanned=$(timeout 30 ssh-keyscan -T 10 -t ed25519,ecdsa,rsa github.com 2>/dev/null | grep -v '^#' | sort) || scanned=''
  if [[ -z $scanned ]]; then
    log_warn "ssh-keyscan github.com gave nothing (no network?); the pinned keys are installed anyway"
  elif [[ $scanned == "$(grep -v '^#' "$here/files/github-known-hosts" | sort)" ]]; then
    log_ok "ssh-keyscan github.com matches the pinned host keys"
  else
    log_warn "ssh-keyscan github.com differs from files/github-known-hosts; the pinned keys are installed. Check docs.github.com (GitHub's SSH key fingerprints) before trusting either"
  fi
fi

# ================================================================== users, layout, .env, keys
# key_state <path>: like path_state, but an empty file (an interrupted earlier run) counts as missing
key_state() {
  local s
  s=$(path_state "$1")
  if [[ $s == exists && ! -s $1 ]]; then s=empty; fi
  printf '%s' "$s"
}
for env in "${ENVS[@]}"; do
  u=orion-$env
  h=/home/$u
  own=$u:$u
  echo "== user $u"
  if getent passwd "$u" >/dev/null; then
    log_ok "user $u"
  else
    run useradd --create-home --home-dir "$h" --shell /bin/bash --user-group --comment "Orion $env" "$u"
  fi
  if getent passwd "$u" >/dev/null; then
    for g in sudo admin; do
      if [[ " $(id -nG "$u") " == *" $g "* ]]; then run gpasswd -d "$u" "$g"; fi
    done
  fi
  if [[ -e /var/lib/systemd/linger/$u ]]; then
    log_ok "linger enabled for $u"
  else
    run loginctl enable-linger "$u"
  fi

  # layout (spec §2.1); ~/bin/orion-remote is /usr/local/bin/orion-remote instead (R1); the daemon unit is 1.5c (R4)
  ensure_dir "$h" 750 "$own"
  ensure_dir "$h/releases" 755 "$own"
  ensure_dir "$h/shared" 700 "$own"
  ensure_dir "$h/home" 750 "$own"
  ensure_dir "$h/home/publish" 750 "$own"
  ensure_dir "$h/.config" 700 "$own"
  ensure_dir "$h/.config/systemd" 755 "$own"
  ensure_dir "$h/.config/systemd/user" 755 "$own"
  ensure_dir "$h/.ssh" 700 "$own"
  ensure_empty_file "$h/deploys.log" 640 "$own"
  ensure_empty_file "$h/remote.log" 600 "$own"

  # R6: .env template, created once, never overwritten, never read
  sed -e "s/@ENV@/$env/g" -e "s/@DB@/orion_$env/g" "$here/files/env.template" | write_file_once "$h/shared/.env" 600 "$own" quiet

  # R5: keys generated here, never overwritten; only the public halves are printed
  key=$h/shared/publish_ed25519
  sk=$h/shared/snapshot-sign.key
  skpub=$h/shared/snapshot-sign.pub
  case $(key_state "$key") in
    exists) log_ok "$key exists (never overwritten)"; ensure_mode_owner "$key" 600 "$own" ;;
    *) [[ -e $key ]] && run rm -f "$key" "$key.pub"
      run runuser -u "$u" -- ssh-keygen -q -t ed25519 -N '' -C "orion-$env@$HOST_NAME publish" -f "$key" ;;
  esac
  case $(key_state "$sk") in
    exists) log_ok "$sk exists (never overwritten)"; ensure_mode_owner "$sk" 600 "$own" ;;
    *) # created 600 first: openssl then writes into it without changing the mode, so the key is never readable by others
      [[ -e $skpub ]] && run rm -f "$skpub"
      run install -m 600 -o "$u" -g "$u" /dev/null "$sk"
      run runuser -u "$u" -- openssl genpkey -algorithm ed25519 -out "$sk" ;;
  esac
  case $(key_state "$skpub") in
    exists) log_ok "$skpub" ;;
    *) run runuser -u "$u" -- openssl pkey -in "$sk" -pubout -out "$skpub" ;;
  esac
  if ! ((DRY_RUN)); then
    printf 'pubkey: %s publish (add to the %s snapshot repo as a deploy key with write access): %s\n' \
      "$u" "$env" "$(cat "$key.pub")"
    printf 'pubkey: %s snapshot-sign (Ed25519, SPKI base64; the site verifies manifest.json.sig with it): %s\n' \
      "$u" "$(sed -n 2p "$skpub")"
  fi

  # R5: forced-command deploy key
  if [[ -n ${DEPLOY_KEY[$env]:-} ]]; then
    printf 'restrict,command="%s" %s\n' "$ORION_REMOTE" "${DEPLOY_KEY[$env]}" | write_file "$h/.ssh/authorized_keys" 600 "$own"
  else
    log_note "no --deploy-key-$env: $h/.ssh/authorized_keys not touched"
  fi

  # 1.5c: group orion-refresh (reads latest.dump for the staging refresh)
  if getent passwd "$u" >/dev/null && [[ " $(id -nG "$u") " == *" $REFRESH_GROUP "* ]]; then
    log_ok "$u in group $REFRESH_GROUP"
  else
    run usermod -aG "$REFRESH_GROUP" "$u"
  fi

  # 1.5c: deploy directories, known_hosts, the daemon user unit (lib.sh orion_user_files)
  orion_user_files "$h" "$own" "$env" "$here/files"
  # The unit is loaded and enabled through the user's own systemd manager (running because of linger):
  #   runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user ...
  # systemctl --user reaches it on $XDG_RUNTIME_DIR/systemd/private; no D-Bus session or login is needed, and unlike
  # `machinectl shell` it needs no systemd-container package. Enabled = starts at boot; never started here.
  uid=$(id -u "$u" 2>/dev/null) || uid='<uid>'
  user_systemctl() { run runuser -u "$u" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$@"; }
  user_manager_ready() {
    ((DRY_RUN)) && return 0
    local _
    [[ -S /run/user/$uid/systemd/private ]] || run systemctl start "user@$uid.service"
    for _ in $(seq 1 30); do
      [[ -S /run/user/$uid/systemd/private ]] && return 0
      sleep 1
    done
    die "the systemd user manager of $u is not running (/run/user/$uid/systemd/private missing; is linger on?)"
  }
  if ((ORION_UNIT_CHANGED)); then
    user_manager_ready
    user_systemctl daemon-reload
  fi
  if [[ -L $h/.config/systemd/user/default.target.wants/$DAEMON_UNIT ]]; then
    log_ok "$DAEMON_UNIT enabled for $u"
  else
    user_manager_ready
    user_systemctl enable "$DAEMON_UNIT"
  fi

  # 1.5c: the disclosure watcher's venv, only with --with-watcher
  venv=$h/watcher-venv
  if ((WITH_WATCHER)); then
    if [[ -x $venv/bin/python ]]; then
      log_ok "venv $venv"
    else
      run runuser -u "$u" -- python3 -m venv "$venv"
    fi
    write_file "$venv/requirements.txt" 644 "$own" <"$here/files/watcher-requirements.txt"
    # installed = the copy pip last finished with; a failed pip run is retried by the next run
    if [[ -r $venv/.installed-requirements.txt ]] && cmp -s "$venv/requirements.txt" "$venv/.installed-requirements.txt"; then
      log_ok "$venv has the pinned requirements"
    else
      run runuser -u "$u" -- env HOME="$h" "$venv/bin/pip" install --require-virtualenv --no-input -r "$venv/requirements.txt"
      run runuser -u "$u" -- cp "$venv/requirements.txt" "$venv/.installed-requirements.txt"
    fi
  else
    log_note "watcher venv skipped for $u (pass --with-watcher once the disclosure watcher ships, plan 1.5c Task 11)"
  fi
done

# R1: the forced-command entry point; since 1.5c the full Python version (verbs in its header), a release-independent
# copy from this checkout, so neither a release nor the Orion user can change what a deploy key runs
echo "== orion-remote"
write_file "$ORION_REMOTE" 755 root:root quiet <"$here/files/orion-remote"

# ================================================================== Postgres
echo "== Postgres $PG_MAJOR/$PG_CLUSTER"
# before any conf.d drop-in, hba/ident or role: moving the data directory re-creates the cluster's configuration
pg_ensure_cluster "$PG_DATADIR"
pg_conf_dropin orion.conf <<'EOF'
# Orion server settings (scripts/provision/orion-host.sh). Unix socket only; nothing on the network reaches it.
listen_addresses = ''
timezone = 'UTC'
shared_buffers = 2GB
EOF

backup_once "$PG_ETC/pg_hba.conf"
write_file "$PG_ETC/pg_hba.conf" 640 postgres:postgres <<'EOF'
# Written by scripts/provision/orion-host.sh (Orion, spec §9.3). Local socket only; first match wins.
# TYPE  DATABASE     USER                      METHOD
local   orion_prod   orion_prod,orion_prod_ro  peer map=prod
local   orion_stage  orion_stage               peer map=stage
local   all          postgres                  peer
local   all          all                       reject
EOF
((CHANGED)) && PG_RELOAD_NEEDED=1

backup_once "$PG_ETC/pg_ident.conf"
write_file "$PG_ETC/pg_ident.conf" 640 postgres:postgres <<'EOF'
# Written by scripts/provision/orion-host.sh (Orion, spec §9.3). Unix names have a hyphen, role names an underscore.
# MAPNAME  SYSTEM-USERNAME  PG-USERNAME
prod       orion-prod       orion_prod
prod       orion-prod       orion_prod_ro
stage      orion-stage      orion_stage
EOF
((CHANGED)) && PG_RELOAD_NEEDED=1

pg_apply

echo "== roles, databases, schemas"
psql_file_as_postgres "$here/sql/host-roles.sql"

# ================================================================== pgBackRest scaffold (R2: backups are step 2)
echo "== pgBackRest"
ensure_dir "$(dirname "$PGBR_CONF")" 750 root:postgres
repo2=''
if [[ -n $BACKUP_DISK ]]; then
  log_note "--backup-disk: repo 2 protects against nothing if $BACKUP_DISK is on the same physical disk as the cluster"
  ensure_dir "$BACKUP_DISK/pgbackrest" 750 postgres:postgres
  repo2="# repo 2: local directory on the second disk (fast restores)
repo2-type=posix
repo2-path=$BACKUP_DISK/pgbackrest
repo2-retention-full-type=count
repo2-retention-full=2"
fi
tmpl=$(<"$here/files/pgbackrest.conf.tmpl")
tmpl=${tmpl//@PG1PATH@/$DATADIR}
printf '%s\n' "${tmpl//@REPO2@/$repo2}" | write_file_once "$PGBR_CONF" 640 root:postgres quiet
if [[ $CHANGED == 0 ]]; then
  if [[ -n $BACKUP_DISK ]]; then
    log_note "--backup-disk: $PGBR_CONF already existed and is never rewritten; add repo2-* to it by hand if it lacks them"
  fi
  if [[ -r $PGBR_CONF ]] && ! grep -Fxq "pg1-path=$DATADIR" "$PGBR_CONF"; then
    log_warn "$PGBR_CONF already existed and is never rewritten, and its pg1-path is not $DATADIR; set pg1-path=$DATADIR by hand (--enable-backups refuses until then)"
  fi
fi

if ((ENABLE_BACKUPS)); then
  echo "== backups (step 2)"
  ensure_dir /etc/orion 755 root:root
  if [[ -n $DUMP_RECIPIENT ]]; then
    printf '%s\n' "$DUMP_RECIPIENT" | write_file "$RECIPIENT_FILE" 644 root:root
  else
    log_ok "dump recipient from $RECIPIENT_FILE"
  fi

  stanza_code=''
  if can_probe && command -v pgbackrest >/dev/null 2>&1; then
    stanza_code=$( (cd / && runuser -u postgres -- pgbackrest --stanza=orion --output=json info 2>/dev/null) |
      python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["status"]["code"] if d else 1)' 2>/dev/null) || stanza_code=''
  fi
  # info status codes: 1 = missing stanza path, 3 = missing stanza data; anything else means the stanza exists
  if [[ -n $stanza_code && $stanza_code != 1 && $stanza_code != 3 ]]; then
    log_ok "pgBackRest stanza orion exists"
  else
    run runuser -u postgres -- pgbackrest --stanza=orion stanza-create
  fi

  pg_conf_dropin orion-backup.conf <<'EOF'
# Orion WAL archiving through pgBackRest (scripts/provision/orion-host.sh --enable-backups; spec §10.1)
archive_mode = on
archive_command = 'pgbackrest --stanza=orion archive-push %p'
archive_timeout = 300
EOF
  pg_apply

  write_file /usr/local/sbin/orion-pg-dump 755 root:root quiet <"$here/files/orion-pg-dump"
  # on /home, not the root filesystem (venus: / is 10G, /home 870G)
  ensure_dir /home/orion-backups 700 postgres:postgres
  ensure_dir /home/orion-backups/dumps 700 postgres:postgres

  units_changed=0
  # unit <name> <description> <OnCalendar> <paths it needs mounted> <ExecStart> [ExecStartPost]
  unit() {
    local name=$1 desc=$2 cal=$3 mounts=$4 exec=$5 post=${6:-}
    {
      printf '[Unit]\nDescription=%s (Orion, spec §10.1)\nAfter=%s.service\nRequiresMountsFor=%s\n\n' \
        "$desc" "$PG_SERVICE" "$mounts"
      printf '[Service]\nType=oneshot\nUser=postgres\nGroup=postgres\nExecStart=%s\n' "$exec"
      [[ -n $post ]] && printf 'ExecStartPost=%s\n' "$post"
      true
    } | write_file "$SYSTEMD_DIR/$name.service" 644 root:root
    ((CHANGED)) && units_changed=1
    printf '[Unit]\nDescription=%s timer (Orion)\n\n[Timer]\nOnCalendar=%s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' \
      "$desc" "$cal" | write_file "$SYSTEMD_DIR/$name.timer" 644 root:root
    ((CHANGED)) && units_changed=1
    return 0
  }
  unit orion-backup-full "pgBackRest full backup" "Sun *-*-* 09:00:00 UTC" "$DATADIR" \
    "/usr/bin/pgbackrest --stanza=orion --type=full backup" "/usr/bin/pgbackrest --stanza=orion check"
  unit orion-backup-diff "pgBackRest differential backup" "Mon..Sat *-*-* 09:00:00 UTC" "$DATADIR" \
    "/usr/bin/pgbackrest --stanza=orion --type=diff backup" "/usr/bin/pgbackrest --stanza=orion check"
  unit orion-pg-dump "encrypted pg_dump of orion_prod and orion_stage" "*-*-* 08:30:00 UTC" \
    "/home/orion-backups /home/orion-refresh" "/usr/local/sbin/orion-pg-dump"
  ((units_changed)) && run systemctl daemon-reload
  for t in orion-backup-full orion-backup-diff orion-pg-dump; do
    if [[ $(systemctl is-enabled "$t.timer" 2>/dev/null) == enabled ]] && systemctl is-active --quiet "$t.timer" 2>/dev/null; then
      log_ok "$t.timer enabled and active"
    else
      run systemctl enable --now "$t.timer"
    fi
  done
else
  log_note "backups not enabled yet (R2 step 2): fill in $PGBR_CONF, then re-run with --enable-backups --dump-recipient <age public key>"
fi

# ================================================================== firewall (R3)
echo "== firewall"
if ((${#SSH_FROM[@]} == 0)); then
  log_note "ufw step skipped: no --ssh-from given (pass --ssh-from <ip|cidr>, repeatable, to enable ufw with SSH from those only)"
else
  ufw_default() { sed -n "s/^$1=\"\{0,1\}\([A-Z]*\)\"\{0,1\}$/\1/p" /etc/default/ufw 2>/dev/null; }
  if [[ $(ufw_default DEFAULT_INPUT_POLICY) == DROP ]]; then log_ok "ufw default deny incoming"; else run ufw default deny incoming; fi
  if [[ $(ufw_default DEFAULT_OUTPUT_POLICY) == ACCEPT ]]; then log_ok "ufw default allow outgoing"; else run ufw default allow outgoing; fi
  added=''
  if can_probe && command -v ufw >/dev/null 2>&1; then added=$(ufw show added 2>/dev/null || true); fi
  for src in "${SSH_FROM[@]}"; do
    if grep -Fxq "ufw allow from $src to any port 22 proto tcp" <<<"$added"; then
      log_ok "ufw allows 22/tcp from $src"
    else
      run ufw allow from "$src" to any port 22 proto tcp
    fi
  done
  if grep -Eq '^ENABLED=yes' /etc/ufw/ufw.conf 2>/dev/null; then log_ok "ufw enabled"; else run ufw --force enable; fi
fi

# ================================================================== self-check
echo "== self-check"
check_free_space "$DATADIR"
as() { local u=$1; shift; (cd / && runuser -u "$u" -- "$@"); }
q() { as "$1" psql -X -qAt -v ON_ERROR_STOP=1 -U "$2" -d "$3" -c "$4"; }
check_pgdg() { dpkg-query -W -f='${Version}' "postgresql-$PG_MAJOR" | grep -q pgdg; }
check_eq() { [[ $("${@:2}") == "$1" ]]; }
check_node() { [[ $("$NODE_LINK/bin/node" --version) == "$NODE_VERSION" ]]; }
check_mode() { [[ $(stat -c '%a %U:%G' "$1") == "$2" ]]; }
check_not_sudo() { local g; g=" $(id -nG "$1") "; [[ $g != *" sudo "* && $g != *" admin "* ]]; }
check_remote_status() { local out; out=$(as "$1" env SSH_ORIGINAL_COMMAND=status "$ORION_REMOTE") && [[ $out == "env: $2"$'\n'* ]]; }
check_remote_refuses() { ! as "$1" env SSH_ORIGINAL_COMMAND='status; id' "$ORION_REMOTE" >/dev/null 2>&1; }
check_remote_full() { local out rc=0; out=$(as "$1" env SSH_ORIGINAL_COMMAND=bogus "$ORION_REMOTE" 2>&1) || rc=$?; [[ $rc == 64 && $out == *"'bogus' is not an allowed verb"* ]]; }
user_ctl() { local u=$1; shift; as "$u" env XDG_RUNTIME_DIR="/run/user/$(id -u "$u")" "$@"; }
check_unit_verify() { user_ctl "$1" systemd-analyze --user verify "/home/$1/.config/systemd/user/$DAEMON_UNIT"; }
check_unit_enabled() { [[ $(user_ctl "$1" systemctl --user is-enabled "$DAEMON_UNIT") == enabled ]]; }
check_in_group() { [[ " $(id -nG "$1") " == *" $2 "* ]]; }
check_known_hosts() { cmp -s "/home/$1/.ssh/known_hosts" "$here/files/github-known-hosts"; }
check_ro_reads() { [[ $(q orion-prod orion_prod_ro orion_prod 'show default_transaction_read_only') == on ]]; }
selfcheck "postgresql-$PG_MAJOR is the PGDG build" check_pgdg
selfcheck "listen_addresses is empty (socket only)" check_eq '' psql_as_postgres 'show listen_addresses'
selfcheck "timezone is UTC" check_eq UTC psql_as_postgres 'show timezone'
selfcheck "shared_buffers is 2GB" check_eq 2GB psql_as_postgres 'show shared_buffers'
selfcheck "data_directory is $DATADIR" check_eq "$DATADIR" psql_as_postgres 'show data_directory'
selfcheck "node $NODE_VERSION at $NODE_LINK" check_node
selfcheck "$ORION_REMOTE is root:root 755" check_mode "$ORION_REMOTE" "755 root:root"
selfcheck "$REFRESH_DIR is 2750 postgres:$REFRESH_GROUP" check_mode "$REFRESH_DIR" "2750 postgres:$REFRESH_GROUP"
for env in "${ENVS[@]}"; do
  u=orion-$env
  selfcheck "$u has no sudo" check_not_sudo "$u"
  selfcheck "$u has linger" test -e "/var/lib/systemd/linger/$u"
  selfcheck "$u ~/shared/.env is 600 $u" check_mode "/home/$u/shared/.env" "600 $u:$u"
  selfcheck "$u ~/shared/publish_ed25519 is 600" check_mode "/home/$u/shared/publish_ed25519" "600 $u:$u"
  selfcheck "$u ~/shared/snapshot-sign.key is 600" check_mode "/home/$u/shared/snapshot-sign.key" "600 $u:$u"
  selfcheck "$u connects to orion_$env as orion_$env" check_eq "orion_$env" q "$u" "orion_$env" "orion_$env" 'select current_user'
  selfcheck "orion-remote status works for $u" check_remote_status "$u" "$env"
  selfcheck "orion-remote refuses 'status; id' for $u" check_remote_refuses "$u"
  selfcheck "orion-remote is the full version for $u (bogus -> exit 64, not an allowed verb)" check_remote_full "$u"
  selfcheck "$u is in group $REFRESH_GROUP" check_in_group "$u" "$REFRESH_GROUP"
  selfcheck "$u ~/.ssh/known_hosts pins github.com" check_known_hosts "$u"
  selfcheck "$DAEMON_UNIT passes systemd-analyze --user verify for $u" check_unit_verify "$u"
  selfcheck "$DAEMON_UNIT is enabled for $u" check_unit_enabled "$u"
  if ((WITH_WATCHER)); then
    selfcheck "$u watcher venv imports yaml, faster_whisper" as "$u" "/home/$u/watcher-venv/bin/python" -c 'import yaml, faster_whisper'
    selfcheck "$u watcher venv runs yt-dlp --version" as "$u" "/home/$u/watcher-venv/bin/yt-dlp" --version
  fi
done
selfcheck "orion-stage -> orion_prod as orion_stage is refused" expect_fail q orion-stage orion_stage orion_prod 'select 1'
selfcheck "orion-stage -> orion_prod as orion_prod is refused (peer map)" expect_fail q orion-stage orion_prod orion_prod 'select 1'
selfcheck "orion-stage -> orion_prod as orion_prod_ro is refused (peer map)" expect_fail q orion-stage orion_prod_ro orion_prod 'select 1'
selfcheck "orion-prod -> orion_stage is refused" expect_fail q orion-prod orion_prod orion_stage 'select 1'
selfcheck "orion_stage has no CONNECT on orion_prod (PUBLIC revoked)" check_eq f psql_as_postgres \
  "select has_database_privilege('orion_stage', 'orion_prod', 'CONNECT')"
selfcheck "orion_prod has no CONNECT on orion_stage (PUBLIC revoked)" check_eq f psql_as_postgres \
  "select has_database_privilege('orion_prod', 'orion_stage', 'CONNECT')"
selfcheck "SET ROLE orion_prod as orion_stage is refused" expect_fail q orion-stage orion_stage orion_stage 'set role orion_prod'
selfcheck "orion_prod_ro connects (read-only session)" check_ro_reads
selfcheck "orion_prod_ro cannot write" expect_fail q orion-prod orion_prod_ro orion_prod 'create table orion.selfcheck_ro_write (x int)'
if ((${#SSH_FROM[@]})); then
  selfcheck "ufw is active" eval "ufw status | grep -q '^Status: active'"
fi
if ((ENABLE_BACKUPS)); then
  selfcheck "archive_mode is on" check_eq on psql_as_postgres 'show archive_mode'
  selfcheck "pgbackrest check" as postgres pgbackrest --stanza=orion check
  for t in orion-backup-full orion-backup-diff orion-pg-dump; do
    selfcheck "$t.timer is active" systemctl is-active --quiet "$t.timer"
  done
else
  printf 'SKIP: pgbackrest check (backups not enabled yet: --enable-backups)\n'
fi
selfcheck_summary
