#!/usr/bin/env bash
# Phase 2 proof, step 1: snapshot live into a fresh p2proof_<stamp> schema in orion_dev.
#
#   snapshot.sh <P>
#
# <P> (a directory inside $TMPDIR) receives:
#   snap.db          sqlite .backup of the source DB, opened read-only (mode=ro); PRAGMA integrity_check must be ok
#   schema           the schema name, p2proof_<UTC stamp, lowercase>, written before anything is created in Postgres
#   new/, old/       homes: assets/ personas/ skills/ and a mode-600 .env holding only ORION_DATABASE_URL and
#                    ORION_DB_SCHEMA (both homes name the same schema: an older release opens a newer schema)
#   migrate.json     `db migrate --json` by the NEW dist, with ORION_HOME=<P>/new
#   import.json, import-<stamp>.json (manifest), proof.json, and a .stderr beside each command's output
#
# Env overrides: P2_NEW_DIST (default <worktree>/dist), P2_SOURCE_DB (default the live orion.db, read-only),
# P2_OLD_CONFIG (where the old home's assets/ personas/ skills/ come from; default the worktree).
# Refuses on any failure, including any table mismatch in `tools/import-sqlite proof`. Undo with cleanup.py <P>.
set -euo pipefail

die() { echo "snapshot.sh: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: snapshot.sh <P>"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${P2_SOURCE_DB:-/home/hermes/git/orion/orion.db}"
DIST="${P2_NEW_DIST:-$WT/dist}"
OLD_CONFIG="${P2_OLD_CONFIG:-$WT}"
URL='postgresql://orion_dev@/orion_dev?host=/var/run/postgresql'

# Preconditions, all checked before anything is written.
[ -n "${TMPDIR:-}" ] || die "TMPDIR is not set"
TMPROOT="$(realpath -e "$TMPDIR")" || die "TMPDIR $TMPDIR does not exist"
P="$(realpath -m "$1")"
case "$P" in "$TMPROOT"/?*) ;; *) die "$P is not inside \$TMPDIR ($TMPROOT)" ;; esac
case "$P" in *[\'\"\\\$\`]*) die "$P has a quote, backslash, \$ or backtick" ;; esac
[ -f "$SRC" ] || die "source DB $SRC does not exist"
[ -f "$DIST/cli/index.js" ] || die "no $DIST/cli/index.js: build the new side first (npm run build)"
for d in assets personas skills; do
  [ -d "$WT/$d" ] || die "no $WT/$d"
  [ -d "$OLD_CONFIG/$d" ] || die "no $OLD_CONFIG/$d"
done
command -v sqlite3 >/dev/null || die "sqlite3 not found"
[ ! -e "$P/snap.db" ] && [ ! -e "$P/schema" ] || die "$P already holds a snapshot: use a fresh directory (cleanup.py the old one)"

# Only the home's .env decides the database: no ORION_* variable of the caller is passed on.
for v in $(compgen -e); do case "$v" in ORION_*) unset "$v" ;; esac; done

mkdir -p "$P"
cd "$P"

# 1. A read-only .backup of the source, and its integrity check.
sqlite3 "file:${SRC}?mode=ro" ".backup '$P/snap.db'" >"$P/backup.log" 2>&1 || die "sqlite .backup failed (see $P/backup.log)"
sqlite3 "$P/snap.db" 'PRAGMA integrity_check;' >"$P/integrity.txt" 2>&1 || die "integrity_check failed to run (see $P/integrity.txt)"
[ "$(cat "$P/integrity.txt")" = "ok" ] || die "integrity_check is not ok (see $P/integrity.txt)"

# 2. The schema name, then the homes.
S="p2proof_$(date -u +%Y%m%dt%H%M%Sz)"
[[ "$S" =~ ^p2proof_[0-9a-z_]+$ ]] || die "bad schema name $S"
printf '%s\n' "$S" >"$P/schema"
for side in new old; do
  src="$WT"; [ "$side" = old ] && src="$OLD_CONFIG"
  mkdir "$P/$side"
  for d in assets personas skills; do cp -R "$src/$d" "$P/$side/$d"; done
  (umask 077; printf 'ORION_DATABASE_URL=%s\nORION_DB_SCHEMA=%s\n' "$URL" "$S" >"$P/$side/.env")
  chmod 600 "$P/$side/.env"
done

# 3. Migrate with the NEW release, import, prove.
(cd "$P/new" && ORION_HOME="$P/new" node "$DIST/cli/index.js" db migrate --json) >"$P/migrate.json" 2>"$P/migrate.stderr" \
  || die "db migrate failed (see $P/migrate.json, $P/migrate.stderr)"
[ -s "$P/migrate.json" ] || die "db migrate printed nothing"

(cd "$WT" && npx tsx tools/import-sqlite/cli.ts import --from "$P/snap.db" --to "$URL" --schema "$S" --assets "$WT/assets" --manifest-dir "$P") \
  >"$P/import.json" 2>"$P/import.stderr" || die "import failed (see $P/import.json, $P/import.stderr)"
[ -s "$P/import.json" ] || die "import printed nothing"
shopt -s nullglob
manifests=("$P"/import-*.json)
shopt -u nullglob
[ "${#manifests[@]}" -eq 1 ] || die "expected one import-<stamp>.json manifest in $P, found ${#manifests[@]}"

(cd "$WT" && npx tsx tools/import-sqlite/cli.ts proof --from "$P/snap.db" --to "$URL" --schema "$S" --assets "$WT/assets" --manifest "${manifests[0]}") \
  >"$P/proof.json" 2>"$P/proof.stderr" || die "import proof FAILED: a table or sequence mismatch (see $P/proof.json)"
grep -q '^  "ok": true,$' "$P/proof.json" || die "import proof is not ok (see $P/proof.json)"

echo "snapshot ok: schema $S, homes $P/old and $P/new, manifest ${manifests[0]}"
