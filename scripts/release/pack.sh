#!/usr/bin/env bash
# pack.sh <srcdir> <tag> <commit> <outdir>: a built checkout -> <outdir>/<tag>.tgz + .sha256 (spec §3.1, plan Task 13).
# The tag is the whole name (orion-YYYY.MM.DD.N), so the spec's orion-<tag>.tgz and orion-<tag>/ are <tag>.tgz and <tag>/.
#
# Writes <srcdir>/RELEASE ({"tag","commit","schema","built_at","node"}), then tars the release paths, and only those,
# under a top directory <tag>/:
#   RELEASE dist/ assets/ personas/ skills/ schedule.yaml package.json package-lock.json
#   scripts/provision/ (minus test/: the host files orion-host.sh installs from the release that ships them)
#   tools/disclosure-watcher/ when present (minus tests/ and __pycache__/)
# Never src/, tests/, node_modules/ (the server runs npm ci --omit=dev), tools/import-sqlite/ (dev host only), the
# build/release/probe scripts, .env* or *.db: a path like that among the release paths is refused, not skipped.
#
# Reproducible: two packs of the same tree are byte-identical. Entries are sorted, owned 0/0, mode-normalised and
# stamped with the commit's time; gzip -n stores no name or time; built_at is the commit time too (not the wall clock).
set -euo pipefail
umask 022

die() {
  printf 'pack.sh: %s\n' "$1" >&2
  exit 1
}

if (($# != 4)); then
  die "usage: pack.sh <srcdir> <tag> <commit> <outdir>"
fi
src=$1 tag=$2 commit=$3 out=$4

if ! [[ $tag =~ ^orion-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]]; then
  die "bad tag '$tag': a release tag is orion-YYYY.MM.DD.N"
fi
[[ -d $src ]] || die "no such source directory: $src"
[[ -d $out ]] || die "no such output directory: $out"
[[ -f $src/dist/cli/index.js ]] || die "$src/dist/cli/index.js is missing: run npm run build first"
[[ -d $src/dist/db/pg/migrations ]] || die "$src/dist/db/pg/migrations/ is missing: run npm run build first"

# The schema the release ships: the highest NNNN in dist/db/pg/migrations.
schema=$(find "$src/dist/db/pg/migrations" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' |
  sort | tail -n 1 | cut -c1-4)
[[ -n $schema ]] || die "$src/dist/db/pg/migrations/ holds no NNNN_*.sql migration"
schema=$((10#$schema))

full=$(git -C "$src" rev-parse --verify --quiet "$commit^{commit}") || die "commit $commit is not in $src's git history"
epoch=$(git -C "$src" show -s --format=%ct "$full")
built_at=$(date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ)
node_version=$(node -v)

# The release paths, one per line, relative to $src, directories included (tar runs with --no-recursion).
list=$(mktemp)
tarball=
cleanup() {
  rm -f "$list"
  if [[ -n $tarball ]]; then rm -f "$tarball.partial"; fi
}
trap cleanup EXIT

for f in schedule.yaml package.json package-lock.json; do
  [[ -f $src/$f ]] || die "$src/$f is missing"
done
for d in dist assets personas skills scripts/provision; do
  [[ -d $src/$d ]] || die "$src/$d/ is missing"
done
{
  printf '%s\n' RELEASE schedule.yaml package.json package-lock.json
  (cd "$src" && find dist assets personas skills \( -type f -o -type d -o -type l \) -print)
  printf 'scripts\n'
  (cd "$src" && find scripts/provision \( -path scripts/provision/test -o -name __pycache__ \) -prune -o \
    \( -type f -o -type d -o -type l \) -print)
  if [[ -d $src/tools/disclosure-watcher ]]; then
    printf 'tools\n'
    (cd "$src" && find tools/disclosure-watcher \( -name tests -o -name __pycache__ \) -prune -o -name '*.pyc' -prune -o \
      \( -type f -o -type d -o -type l \) -print)
  fi
} | LC_ALL=C sort -u >"$list"

# Refuse, never skip: a secret, a database or source/test code among the release paths means the tree is wrong.
bad=$(grep -E '(^|/)\.env[^/]*$|\.db$|(^|/)(src|tests)(/|$)' "$list" || true)
if [[ -n $bad ]]; then
  die "refusing to pack: these paths would be in the release (.env*, *.db, src/ or tests/): $(printf '%s' "$bad" | tr '\n' ' ')"
fi

printf '{"tag":"%s","commit":"%s","schema":%d,"built_at":"%s","node":"%s"}\n' \
  "$tag" "$full" "$schema" "$built_at" "$node_version" >"$src/RELEASE"

name=$tag.tgz
tarball=$out/$name
LC_ALL=C tar -C "$src" --create --no-recursion --verbatim-files-from --files-from="$list" \
  --format=gnu --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" \
  --mode='u+rwX,go+rX,go-w' --transform="s,^,$tag/,S" |
  gzip -n -9 >"$tarball.partial"
mv -f "$tarball.partial" "$tarball"
(cd "$out" && sha256sum "$name" >"$name.sha256.partial" && mv -f "$name.sha256.partial" "$name.sha256")
printf '%s\n' "$tarball"
