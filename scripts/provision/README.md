# scripts/provision: runbook

Provisioning for Orion's Postgres hosts (spec §2.4, plan 1.5a). Raymond writes and dry-runs these scripts; **Mike runs
them with sudo**. Each one is idempotent: running it again changes nothing and says `ok:` for every step.

| file | what |
|---|---|
| `dev-postgres.sh` | dev host (Ubuntu 24.04 noble): PGDG PostgreSQL 18 + pgBackRest, role `orion_dev`, databases `orion_dev` and `orion_test`, peer map from your Unix user |
| `orion-host.sh` | Orion server (Ubuntu 26.04 resolute): packages, Node 26, users `orion-prod` / `orion-stage`, home layout, `.env` templates, keys, Postgres roles/databases, pgBackRest scaffold, `orion-remote`, ufw; `--enable-backups` for step 2 |
| `sql/dev-roles.sql`, `sql/host-roles.sql` | the roles/databases/grants, guarded (a re-run is a no-op); usable alone: `sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -f <file>` |
| `files/orion-remote` | forced-command entry point (Python 3, stdlib only; verbs in its header), installed as `/usr/local/bin/orion-remote`; unit tests `test/test_orion_remote.py` |
| `files/orion-daemon.service` | the daemon's systemd user unit template (`@ORION_ENV@`), installed per Orion user |
| `files/github-known-hosts` | github.com's pinned SSH host keys, installed as each Orion user's `~/.ssh/known_hosts` |
| `files/watcher-requirements.txt` | the disclosure watcher's pinned Python requirements (`--with-watcher`) |
| `files/orion-pg-dump` | nightly encrypted `pg_dump`, installed by `--enable-backups` as `/usr/local/sbin/orion-pg-dump` |
| `files/env.template`, `files/pgbackrest.conf.tmpl` | templates for `~/shared/.env` and `/etc/pgbackrest/pgbackrest.conf` (created once, never overwritten) |
| `lib.sh` | shared helpers |
| `test/run.sh` | the test harness (shellcheck + every script with `--dry-run` as non-root) |

## Output you will see

Every line starts with one of:

- `ok: ...` the state already holds; nothing was done.
- `do: ...` a change being made (a command, or `create`/`update <file>`; file contents are never printed).
- `would: ...` (only with `--dry-run`) a change a real run would make, followed by the lines it would write.
- `note: ...` a step deliberately skipped, and why. `warn: ...` something to look at (on stderr).
- `pubkey: ...` (server only) a public key for you to install somewhere; never a private key.
- `PASS: ...` / `FAIL: ...` self-check lines, then `SELF-CHECK: N passed, M failed`.
- `error: ...` the script stopped. Refusals (wrong OS, wrong hostname, lockout risk, placeholders left) all happen
  before the first change.

Any script can be previewed without root and without changing anything: add `--dry-run`.

## 1. Dev host (this machine, Ubuntu 24.04)

```
cd /path/to/orion            # any checkout of the branch with scripts/provision
sudo scripts/provision/dev-postgres.sh
```

The Unix user that ran `sudo` (`$SUDO_USER`, here `hermes`) is peer-mapped to role `orion_dev`; override with
`--os-user <user>`. What it does: PGDG apt key (fingerprint-checked) + `/etc/apt/sources.list.d/pgdg.sources` +
an apt pin so PostgreSQL/pgBackRest never come from the Ubuntu archive; installs `postgresql-18`,
`postgresql-client-18`, `pgbackrest`; writes `/etc/postgresql/18/main/conf.d/orion.conf` (`listen_addresses = ''`,
`timezone = 'UTC'`, `shared_buffers = 256MB`), `pg_hba.conf` and `pg_ident.conf` (originals kept as `*.dist`); restarts
Postgres; creates `orion_dev` (LOGIN, CREATEDB) and the databases `orion_dev`, `orion_test`.

**Paste back:** the whole output, or at least the `PASS:`/`FAIL:` lines and `SELF-CHECK: ...`. The self-check proves
the PGDG build, socket-only, UTC, `select version()` as you through `orion_dev` (18.x), a schema create/drop in
`orion_test`, and that you cannot connect as `postgres`.

Afterwards, as `hermes`: `psql -U orion_dev -d orion_dev` (or
`ORION_DATABASE_URL=postgresql://orion_dev@/orion_dev?host=/var/run/postgresql`).

## 2. Orion server (Ubuntu 26.04), first run

Before: the OS is installed, the hostname is set (`hostnamectl set-hostname <h>`), the box has its fixed LAN address,
and you are logged in with your admin account.

### The server: venus

`venus` (192.168.0.12, Ubuntu 26.04) has **one physical disk** `sda`: `/` is `sda2`, 9.8G (3.9G free), and `/home` is
`sda3`, 870G (91G free). So everything that is big or grows goes on `/home`, not on the root filesystem:

| what | where on venus |
|---|---|
| Postgres 18/main data directory (tables, indexes, WAL) | `/home/postgres/18/main` (`--pg-datadir`; `/home/postgres` and `/home/postgres/18` are `postgres:postgres` 700) |
| nightly encrypted dumps (local copies) | `/home/orion-backups/dumps/<env>/YYYY/MM/DD.dump.age` (`postgres` 700) |
| prod → staging refresh drop (spec §8.5) | `/home/orion-refresh/latest.dump` (`postgres:postgres` 750) |
| the two Orion users' homes (releases, data, logs) | `/home/orion-prod`, `/home/orion-stage` |

Small things stay where the packages put them: `/etc/postgresql/18/main` (config), `/var/log/postgresql`,
pgBackRest's spool and log directories. The UPS is attached to another server, so leave `--nut` off for now (NUT over
the network can be added later).

The exact command on venus (preview first with `--dry-run`, no sudo):

```
cd ~/provision
./orion-host.sh --dry-run --hostname venus --pg-datadir /home/postgres/18/main \
     --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from <your machine's address>
sudo ./orion-host.sh --hostname venus --pg-datadir /home/postgres/18/main \
     --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from <your machine's address>
```

Add `--deploy-key-stage orion-stage_ed25519.pub --deploy-key-prod orion-prod_ed25519.pub` on a later run, once the deploy
keys exist (same command otherwise). Pass `--pg-datadir /home/postgres/18/main` on **every** run, including the
`--enable-backups` step (section 3); without it the script assumes the package default and its checks fail.

What `--pg-datadir` does: installing `postgresql-18` creates cluster 18/main in `/var/lib/postgresql/18/main`. The
script then checks, as `postgres`, that the cluster holds no database but `postgres`, `template0`, `template1`, and only
then runs `pg_dropcluster --stop 18 main`, `pg_createcluster -d /home/postgres/18/main 18 main` and starts it, before
it writes any `conf.d` drop-in, `pg_hba.conf`/`pg_ident.conf` or role. No symlink is involved: the cluster's
`data_directory` is the `/home` path (the self-check prints `PASS: data_directory is /home/postgres/18/main`). It
refuses, changing nothing, when the cluster holds a database of its own, lives in a third place, or the target is not
empty. A re-run finds the cluster already there and prints `ok:`.

The self-check also prints one `free space:` line with the free space on `/` and on the filesystem holding the data
directory; it is a `warn:` (never a failure) below 2 GiB on `/` or below 20 GiB for the data directory.

### Any server

1. Copy the directory to the server (from this host):
   `scp -r scripts/provision <you>@<server>:provision`
2. If you want the forced-command deploy keys installed now, copy their **public** halves too (Raymond creates the key
   pairs on this host only on your go; spec §3.4): `~/.ssh/orion-stage_ed25519.pub`, `~/.ssh/orion-prod_ed25519.pub`.
3. On the server, preview, then run:

```
cd ~/provision
./orion-host.sh --dry-run --hostname <h> --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from <your machine>
sudo ./orion-host.sh --hostname <h> [--pg-datadir <dir>] \
     --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from <your machine's address> \
     [--deploy-key-stage orion-stage_ed25519.pub --deploy-key-prod orion-prod_ed25519.pub] \
     [--backup-disk /mnt/<second disk>] [--nut]
```

- `--hostname` must equal the server's current hostname; the script refuses on any other box.
- `--ssh-from` (repeatable): ufw is enabled with SSH allowed only from these. 192.168.0.201 is this dev host on the
  LAN, 100.109.70.114 its tailnet address; add your own machine. **Lockout guard:** if your SSH session comes from an
  address none of them covers, the script refuses before changing anything. Without any `--ssh-from` the ufw step is
  skipped with a note (everything else still runs).
- `--deploy-key-*`: each file must hold one OpenSSH public key; it is written as
  `restrict,command="/usr/local/bin/orion-remote" <key>` into that user's `~/.ssh/authorized_keys` (which the script
  then owns: re-running with another key replaces the line). Without the flags that step is skipped with a note.
- `--pg-datadir <dir>`: the cluster's data directory (absolute, at least three levels deep). Default: the package's
  `/var/lib/postgresql/18/main`, unchanged. See "The server: venus" above.
- `--backup-disk <dir>`: adds a local pgBackRest repo 2 under `<dir>/pgbackrest` (only when `pgbackrest.conf` is first
  created). **Off by default and not recommended on venus:** with one physical disk, a local repo 2 sits on the same
  disk as the cluster and gives no protection against disk failure (it only costs space on `/home`). The offsite
  Spaces repo 1 and the encrypted dumps in Spaces are what protect venus. Use it only on a box with a real second disk.
- `--nut`: installs `nut-client` (configuring NUT is not part of this script).

What it does: PGDG apt + `postgresql-18`, `postgresql-client-18`, `pgbackrest`, `python3-venv`, `ffmpeg`, `ufw`, `age`;
Node v26.13.0 (official tarball, sha256-checked) in `/opt/node-v26.13.0` with `/opt/node-v26` pointing at it; users
`orion-prod` and `orion-stage` (no password, no sudo, linger on) with the layout of spec §2.1; `~/shared/.env` per user
(600, every key commented out; never overwritten, never read); per user an ed25519 publish key
`~/shared/publish_ed25519` and a snapshot signing key `~/shared/snapshot-sign.key` (both 600, generated once, never
overwritten); `/usr/local/bin/orion-remote` (root 755); Postgres conf (`listen_addresses = ''`, UTC,
`shared_buffers = 2GB`), `pg_hba.conf`/`pg_ident.conf` of spec §9.3, roles `orion_prod`, `orion_stage`,
`orion_prod_ro`, databases `orion_prod`/`orion_stage` with schema `orion`, CONNECT revoked from PUBLIC;
`/etc/pgbackrest/pgbackrest.conf` from the template (root:postgres 640, `REPLACE_ME` placeholders, `pg1-path` = the
data directory); ufw.

**Paste back:**
- the `pubkey:` lines. For each env: the `publish` key goes into that env's snapshot repo as a deploy key **with write
  access** (`masha256/orion-data` for prod, `masha256/orion-data-staging` for staging; N11/N12); the `snapshot-sign`
  key is what the site will use to verify `manifest.json.sig`.
- the `free space:` line, the `PASS:`/`FAIL:` lines and `SELF-CHECK: ...`. They prove: PGDG build, socket only, UTC,
  2GB, the data directory, Node version,
  `orion-remote` ownership, no sudo + linger + key/`.env` modes per user, each env user connects to its own database,
  `orion-stage` → `orion_prod` refused as each of the three roles, `orion-prod` → `orion_stage` refused, CONNECT revoked
  for both databases, `SET ROLE orion_prod` as `orion_stage` refused, `orion_prod_ro` read-only and unable to write,
  `orion-remote status` working (and refusing `status; id`) for both users, ufw active.
- `SKIP: pgbackrest check` is expected on this first run.

Then fill in the secrets in `/home/orion-prod/shared/.env` and `/home/orion-stage/shared/.env` (spec §4) as root,
keeping mode 600. Nothing needs restarting (the daemon arrives with Phase 1.5c, section 4).

## 3. Orion server, backups (step 2)

1. Create the Spaces bucket (`orion-backups`) and an access key for it.
2. `sudo editor /etc/pgbackrest/pgbackrest.conf`: replace every `REPLACE_ME` (endpoint, bucket, region, key, secret,
   cipher passphrase; `openssl rand -base64 48` makes a good passphrase). Put the passphrase in your password manager
   too: without it the backups cannot be decrypted.
3. Make an `age` key pair **off the server** (`age-keygen -o orion-dumps.key` on your machine; keep the file in your
   password manager) and note its public key (`age1...`).
4. Run:

```
sudo ./orion-host.sh --hostname <h> --ssh-from ... (same as before) \
     --enable-backups --dump-recipient age1...
```

On venus:

```
sudo ./orion-host.sh --hostname venus --pg-datadir /home/postgres/18/main \
     --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from <your machine's address> \
     --enable-backups --dump-recipient age1...
```

It refuses while any `REPLACE_ME` remains, or while `pg1-path` in `pgbackrest.conf` is not the cluster's data
directory. Then: stores the recipient in `/etc/orion/dump-recipient`,
`pgbackrest stanza-create`, `conf.d/orion-backup.conf` (`archive_mode = on`,
`archive_command = 'pgbackrest --stanza=orion archive-push %p'`, `archive_timeout = 300`), restarts Postgres, installs
`/usr/local/sbin/orion-pg-dump` and three root systemd timers (all times UTC):

| timer | when | what (as `postgres`) |
|---|---|---|
| `orion-pg-dump.timer` | daily 08:30 | `pg_dump -Fc` of `orion_prod` and `orion_stage`, `age`-encrypted, to `/home/orion-backups/dumps/<env>/YYYY/MM/DD.dump.age` (35 days kept) and Spaces `dumps/<env>/YYYY/MM/DD.dump.age`; prod also unencrypted at `/home/orion-refresh/latest.dump` |
| `orion-backup-full.timer` | Sun 09:00 | `pgbackrest --type=full backup`, then `pgbackrest check` |
| `orion-backup-diff.timer` | Mon-Sat 09:00 | `pgbackrest --type=diff backup`, then `pgbackrest check` |

Each unit has `RequiresMountsFor=` on the paths it writes (the data directory; `/home/orion-backups`,
`/home/orion-refresh`).

**Paste back:** the `PASS:`/`FAIL:` lines, now including `archive_mode is on`, `pgbackrest check` and the three timers.
Then set the Spaces lifecycle rule for `dumps/` (30 days) yourself; the 12 monthlies of spec §10.1 are not automated
yet.

## 4. Phase 1.5c: the daemon (re-run, same flags)

Re-run `orion-host.sh` from a 1.5c checkout (or the `scripts/provision/` of a 1.5c release tarball) with the same flags
as before. On venus (Mike, with sudo; the stage/prod deploy public keys copied to `/tmp` first):

```
sudo ./orion-host.sh --hostname venus --pg-datadir /home/postgres/18/main \
     --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from 192.168.0.112 \
     --deploy-key-stage /tmp/deploy-stage.pub --deploy-key-prod /tmp/deploy-prod.pub
```

(add `--enable-backups` if backups are already on; it is idempotent.) What the re-run adds:

- `/usr/local/bin/orion-remote` becomes the full Python version (`files/orion-remote`, root:root 755; a copy from this
  checkout, independent of any release).
- Group `orion-refresh` (both Orion users are members); `/home/orion-refresh` becomes postgres:orion-refresh 2750
  (setgid: the nightly `latest.dump`, 640, gets group orion-refresh, so staging can read it). Always ensured now, not
  only with `--enable-backups`.
- Per user: `~/incoming/` (install's upload), `~/home/disclosure/`, `~/shared/predeploy/` (the `switch --breaking`
  pg_dump), all 700; `~/.ssh/known_hosts` = `files/github-known-hosts`, GitHub's published host keys (ed25519, ecdsa,
  rsa; the file is managed and rewritten whole). The snapshot publisher pushes with `StrictHostKeyChecking=yes`, so it
  trusts only these. A real run also compares them with `ssh-keyscan github.com` and only warns on a difference.
- Per user: `~/.config/systemd/user/orion-daemon.service` from `files/orion-daemon.service` (`@ORION_ENV@` substituted;
  `Type=notify`, `WatchdogSec=120`, `Restart=always`, `ExecStart=/opt/node-v26/bin/node %h/current/dist/cli/index.js
  daemon`, `ORION_HOME`, `ORION_ENV`, `ORION_ENV_FILE` and the key paths), loaded and **enabled, not started**, through
  the user's own systemd manager (running because of linger):
  `runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user daemon-reload` / `enable orion-daemon.service`.
  `systemctl --user` reaches the manager on `$XDG_RUNTIME_DIR/systemd/private`, so no login, D-Bus session or
  `machinectl` (systemd-container) is needed. The unit has `ConditionPathExists=%h/current/RELEASE`: before the first
  deploy it is skipped rather than restarting every 30 s. The first `orion-remote switch` starts it.
- `--with-watcher` (off by default until the disclosure watcher ships, plan 1.5c Task 11): `~/watcher-venv`
  (`python3 -m venv`, then `pip install -r` of the pinned `files/watcher-requirements.txt`; needs the network).
- New self-check lines: orion-remote is the full version (`SSH_ORIGINAL_COMMAND=bogus` exits 64 with "not an allowed
  verb"), group membership, the known_hosts pin, `systemd-analyze --user verify` of each unit, each unit enabled;
  with `--with-watcher`, each venv imports `yaml, faster_whisper` and runs `yt-dlp --version`.

Deploys then go from the dev host with `scripts/release/deploy.sh <stage|prod> <tag>` (staging before cutover:
`--branch <name>`; prod needs a staging soak or `--no-soak`; `--rollback`).

## 5. Later

- Re-running either script at any time is safe; on a configured box it prints only `ok:` lines (plus `pubkey:`, notes
  and the self-check).

## Tests (Raymond, no root)

```
SHELLCHECK=/path/to/shellcheck scripts/provision/test/run.sh
SHELLCHECK=... PG_BINDIR=/usr/lib/postgresql/18/bin scripts/provision/test/run.sh   # + SQL files and hba/ident against a throwaway cluster
```

The harness never runs a script without `--dry-run`. Its dry runs see a fresh box even on a host that has Postgres
itself: fake `dpkg-query`, `pg_lsclusters` and `psql` on `PATH` and an empty config directory
(`ORION_PROVISION_PG_ETC`, a test hook like `ORION_PROVISION_PGBACKREST_CONF`; never set either on a server). What it cannot prove (only a real run on the box can): package
installation, the PGDG pin, Node download/unpack, user creation, linger, ufw, systemd timers, pgBackRest against Spaces,
and peer authentication with the real `orion-prod`/`orion-stage` users (it simulates each by mapping the test user).
