# scripts/provision: runbook

Provisioning for Orion's Postgres hosts (spec §2.4, plan 1.5a). Raymond writes and dry-runs these scripts; **Mike runs
them with sudo**. Each one is idempotent: running it again changes nothing and says `ok:` for every step.

| file | what |
|---|---|
| `dev-postgres.sh` | dev host (Ubuntu 24.04 noble): PGDG PostgreSQL 18 + pgBackRest, role `orion_dev`, databases `orion_dev` and `orion_test`, peer map from your Unix user |
| `orion-host.sh` | Orion server (Ubuntu 26.04 resolute): packages, Node 26, users `orion-prod` / `orion-stage`, home layout, `.env` templates, keys, Postgres roles/databases, pgBackRest scaffold, `orion-remote`, ufw; `--enable-backups` for step 2 |
| `sql/dev-roles.sql`, `sql/host-roles.sql` | the roles/databases/grants, guarded (a re-run is a no-op); usable alone: `sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -f <file>` |
| `files/orion-remote` | forced-command entry point, installed as `/usr/local/bin/orion-remote` (Phase 1.5a: `status` only) |
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

1. Copy the directory to the server (from this host):
   `scp -r scripts/provision <you>@<server>:provision`
2. If you want the forced-command deploy keys installed now, copy their **public** halves too (Raymond creates the key
   pairs on this host only on your go; spec §3.4): `~/.ssh/orion-stage_ed25519.pub`, `~/.ssh/orion-prod_ed25519.pub`.
3. On the server, preview, then run:

```
cd ~/provision
./orion-host.sh --dry-run --hostname <h> --ssh-from 192.168.0.201 --ssh-from 100.109.70.114 --ssh-from <your machine>
sudo ./orion-host.sh --hostname <h> \
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
- `--backup-disk <dir>`: adds a local pgBackRest repo 2 under `<dir>/pgbackrest` (only when `pgbackrest.conf` is first
  created). `--nut`: installs `nut-client` (configuring NUT is not part of this script).

What it does: PGDG apt + `postgresql-18`, `postgresql-client-18`, `pgbackrest`, `python3-venv`, `ffmpeg`, `ufw`, `age`;
Node v26.13.0 (official tarball, sha256-checked) in `/opt/node-v26.13.0` with `/opt/node-v26` pointing at it; users
`orion-prod` and `orion-stage` (no password, no sudo, linger on) with the layout of spec §2.1; `~/shared/.env` per user
(600, every key commented out; never overwritten, never read); per user an ed25519 publish key
`~/shared/publish_ed25519` and a snapshot signing key `~/shared/snapshot-sign.key` (both 600, generated once, never
overwritten); `/usr/local/bin/orion-remote` (root 755); Postgres conf (`listen_addresses = ''`, UTC,
`shared_buffers = 2GB`), `pg_hba.conf`/`pg_ident.conf` of spec §9.3, roles `orion_prod`, `orion_stage`,
`orion_prod_ro`, databases `orion_prod`/`orion_stage` with schema `orion`, CONNECT revoked from PUBLIC;
`/etc/pgbackrest/pgbackrest.conf` from the template (root:postgres 640, `REPLACE_ME` placeholders); ufw.

**Paste back:**
- the `pubkey:` lines. For each env: the `publish` key goes into that env's snapshot repo as a deploy key **with write
  access** (`masha256/orion-data` for prod, `masha256/orion-data-staging` for staging; N11/N12); the `snapshot-sign`
  key is what the site will use to verify `manifest.json.sig`.
- the `PASS:`/`FAIL:` lines and `SELF-CHECK: ...`. They prove: PGDG build, socket only, UTC, 2GB, Node version,
  `orion-remote` ownership, no sudo + linger + key/`.env` modes per user, each env user connects to its own database,
  `orion-stage` → `orion_prod` refused as each of the three roles, `orion-prod` → `orion_stage` refused, CONNECT revoked
  for both databases, `SET ROLE orion_prod` as `orion_stage` refused, `orion_prod_ro` read-only and unable to write,
  `orion-remote status` working (and refusing `status; id`) for both users, ufw active.
- `SKIP: pgbackrest check` is expected on this first run.

Then fill in the secrets in `/home/orion-prod/shared/.env` and `/home/orion-stage/shared/.env` (spec §4) as root,
keeping mode 600. Nothing needs restarting (there is no daemon yet; Phase 1.5c).

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

It refuses while any `REPLACE_ME` remains. Then: stores the recipient in `/etc/orion/dump-recipient`,
`pgbackrest stanza-create`, `conf.d/orion-backup.conf` (`archive_mode = on`,
`archive_command = 'pgbackrest --stanza=orion archive-push %p'`, `archive_timeout = 300`), restarts Postgres, installs
`/usr/local/sbin/orion-pg-dump` and three root systemd timers (all times UTC):

| timer | when | what (as `postgres`) |
|---|---|---|
| `orion-pg-dump.timer` | daily 08:30 | `pg_dump -Fc` of `orion_prod` and `orion_stage`, `age`-encrypted, to `/var/backups/orion/dumps/<env>/YYYY/MM/DD.dump.age` and Spaces `dumps/<env>/YYYY/MM/DD.dump.age`; prod also unencrypted at `/srv/orion-refresh/latest.dump` |
| `orion-backup-full.timer` | Sun 09:00 | `pgbackrest --type=full backup`, then `pgbackrest check` |
| `orion-backup-diff.timer` | Mon-Sat 09:00 | `pgbackrest --type=diff backup`, then `pgbackrest check` |

**Paste back:** the `PASS:`/`FAIL:` lines, now including `archive_mode is on`, `pgbackrest check` and the three timers.
Then set the Spaces lifecycle rule for `dumps/` (30 days) yourself; the 12 monthlies of spec §10.1 are not automated
yet.

## 4. Later

- Phase 1.5c replaces `/usr/local/bin/orion-remote` with the full verb set and adds the `orion-daemon` user unit and the
  watcher venv, by re-running `orion-host.sh` from the newer branch (same flags).
- Re-running either script at any time is safe; on a configured box it prints only `ok:` lines (plus `pubkey:`, notes
  and the self-check).

## Tests (Raymond, no root)

```
SHELLCHECK=/path/to/shellcheck scripts/provision/test/run.sh
SHELLCHECK=... PG_BINDIR=/usr/lib/postgresql/18/bin scripts/provision/test/run.sh   # + SQL files and hba/ident against a throwaway cluster
```

The harness never runs a script without `--dry-run`. What it cannot prove (only a real run on the box can): package
installation, the PGDG pin, Node download/unpack, user creation, linger, ufw, systemd timers, pgBackRest against Spaces,
and peer authentication with the real `orion-prod`/`orion-stage` users (it simulates each by mapping the test user).
