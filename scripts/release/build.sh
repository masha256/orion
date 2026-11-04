#!/usr/bin/env bash
# build.sh <tag> [--out <dir>]: build, test and pack a release from an annotated tag (spec §3.1, plan Task 13).
#
# Runs on the dev host. Refuses before touching anything when ORION_TEST_DATABASE_URL is unset (the full suite needs
# the local test Postgres; a red suite stops the build, there is no skip flag), when the tag is malformed, missing or
# not annotated, or when the checkout has uncommitted changes to tracked files. Then, in a detached worktree of the
# tag under $TMPDIR: npm ci, npm run build, the full suite, typecheck, and pack.sh into <dir> (default ~/orion-releases).
# The worktree is removed on every exit path. Prints the tarball path, its sha256 and the RELEASE record.
set -euo pipefail

die() {
  printf 'build.sh: %s\n' "$1" >&2
  exit 1
}

if [[ -z ${ORION_TEST_DATABASE_URL:-} ]]; then
  die "ORION_TEST_DATABASE_URL is not set: the release build runs the full suite against the local test Postgres"
fi

tag=${1-}
[[ -n $tag ]] || die "usage: build.sh <tag> [--out <dir>]"
shift
out=${HOME:?}/orion-releases
while (($# > 0)); do
  case $1 in
    --out)
      (($# >= 2)) || die "--out needs a directory"
      out=$2
      shift 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done
if ! [[ $tag =~ ^orion-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]]; then
  die "bad tag '$tag': a release tag is orion-YYYY.MM.DD.N"
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
if ! git -C "$repo" diff --quiet || ! git -C "$repo" diff --cached --quiet; then
  die "$repo has uncommitted changes: commit or stash them first"
fi
git -C "$repo" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null || die "no tag $tag"
[[ $(git -C "$repo" cat-file -t "refs/tags/$tag") == tag ]] || die "tag $tag is not annotated (git tag -a)"
commit=$(git -C "$repo" rev-parse "refs/tags/$tag^{commit}")

wt=${TMPDIR:-/tmp}/orion-build-$tag
[[ ! -e $wt ]] || die "$wt already exists (a previous build still running, or left behind: git worktree remove --force $wt)"
mkdir -p "$out"
out=$(cd "$out" && pwd)

cleanup() {
  if [[ -e $wt ]]; then
    git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || printf 'build.sh: could not remove the worktree %s\n' "$wt" >&2
  fi
  git -C "$repo" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$repo" worktree add --quiet --detach "$wt" "refs/tags/$tag"
(
  cd "$wt"
  npm ci
  npm run build
  npx vitest run --maxWorkers=2
  npm run typecheck
)
tarball=$("$here/pack.sh" "$wt" "$tag" "$commit" "$out")

printf 'tarball: %s\n' "$tarball"
printf 'sha256:  %s\n' "$(cut -d' ' -f1 "$tarball.sha256")"
printf 'RELEASE: %s\n' "$(cat "$wt/RELEASE")"
