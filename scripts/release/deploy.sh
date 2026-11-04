#!/usr/bin/env bash
# deploy.sh: install and switch a release on venus (spec §3, plan 1.5c Task 15). Runs on the dev host as hermes.
#
#   deploy.sh <stage|prod> <tag> [--branch <name>] [--tarball <file>] [--no-soak] [--breaking]
#   deploy.sh <stage|prod> --rollback
#
# Every call to venus is `ssh -i ~/.ssh/orion-<env>_ed25519 -o IdentitiesOnly=yes orion-<env>@192.168.0.12 <verb>`; the
# key's forced command is /usr/local/bin/orion-remote, so there is no scp: the tarball is streamed on stdin to
# `install <tag> <sha256>`.
#   1. git fetch https://github.com/masha256/orion.git (branches into refs/remotes/origin/*, tags into refs/tags/*; the
#      dev host has no SSH key for GitHub, I-8) with a one-shot credential helper: GH_PAT is read from the one line
#      `GH_PAT=` of $DEPLOY_CRED_FILE (default ~/.hermes/profiles/raymond/.env; the file is never sourced), exported only
#      to the git children that talk to GitHub, never printed and never on argv. Refuse unless the tag is on origin
#      (git ls-remote), the tarball's RELEASE names the tag and the tag's commit, <tarball>.sha256 exists and matches
#      the tarball (M-9), and the commit is reachable from
#      origin/main. Stage only (R-c1): --branch <name> accepts a commit reachable from origin/<name> instead (pre-cutover
#      staging deploys from a branch tag); prod refuses --branch.
#   2. prod only, unless --no-soak: staging's `status --json` must show release.tag == <tag> and a soak (a done,
#      scheduler-made nightly on that tag, R-c14), and every source the soak lists failed must also be failed in prod's
#      last nightly; else refuse, naming the sources. --no-soak prints SOAK SKIPPED (--no-soak) in the report.
#   3. install <tag> <sha256> < tarball (prints its JSON); 4. only if that exited 0: switch <tag> [--breaking].
#   5. Report: before/after tag, migrations applied, registry changes, the next scheduled job, the soak line.
# --rollback: `rollback` only (orion-remote goes back to the `from` of the last switch).
#
# Default tarball: $DEPLOY_RELEASES/<tag>.tgz (DEPLOY_RELEASES defaults to ~/orion-releases, build.sh's output).
# Overrides for tests (never needed for a real deploy): DEPLOY_SSH (the ssh program), DEPLOY_HOST, DEPLOY_CRED_FILE;
# and, only with DEPLOY_TEST=1, DEPLOY_REPO (the git checkout to check tags in; default the one holding this script)
# and DEPLOY_ORIGIN (the URL fetched instead of GitHub's). Exit 0 only when everything asked for worked.
set -euo pipefail

die() {
  printf 'deploy.sh: %s\n' "$1" >&2
  exit 1
}
usage="usage: deploy.sh <stage|prod> <tag> [--branch <name>] [--tarball <file>] [--no-soak] [--breaking] | deploy.sh <stage|prod> --rollback"

env=${1-}
[[ $env == stage || $env == prod ]] || die "$usage"
shift
tag='' branch='' tarball='' no_soak=0 breaking=0 rollback=0
while (($# > 0)); do
  case $1 in
    --rollback) rollback=1 ;;
    --no-soak) no_soak=1 ;;
    --breaking) breaking=1 ;;
    --branch | --tarball)
      (($# >= 2)) && [[ -n $2 ]] || die "$1 needs a value"
      if [[ $1 == --branch ]]; then branch=$2; else tarball=$2; fi
      shift
      ;;
    -*) die "unknown option $1 ($usage)" ;;
    *)
      [[ -z $tag ]] || die "one tag only ($usage)"
      tag=$1
      ;;
  esac
  shift
done

if [[ ${DEPLOY_TEST-} != 1 && -n ${DEPLOY_REPO-}${DEPLOY_ORIGIN-} ]]; then
  # a checkout or URL of one's choosing would quietly defeat the "tag on GitHub" check
  die "DEPLOY_REPO and DEPLOY_ORIGIN are for tests only (DEPLOY_TEST=1)"
fi
ssh_bin=${DEPLOY_SSH:-ssh}
dest=orion-$env@${DEPLOY_HOST:-192.168.0.12}
remote() { "$ssh_bin" -i "$HOME/.ssh/orion-${env}_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes "$dest" "$@"; }
remote_to() { # remote_to <env> <verb...>: the same, to the other environment (prod's soak gate reads staging)
  local e=$1
  shift
  "$ssh_bin" -i "$HOME/.ssh/orion-${e}_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes "orion-$e@${DEPLOY_HOST:-192.168.0.12}" "$@"
}

if ((rollback)); then
  [[ -z $tag && -z $branch && -z $tarball && $no_soak == 0 && $breaking == 0 ]] || die "--rollback takes no tag or other option"
  printf '== rollback %s\n' "$env"
  remote rollback </dev/null
  exit 0
fi

[[ -n $tag ]] || die "$usage"
[[ $tag =~ ^orion-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] || die "bad tag '$tag': a release tag is orion-YYYY.MM.DD.N"
if [[ $env == prod && -n $branch ]]; then
  die "prod deploys only from origin/main; --branch is for staging (R-c1)"
fi
branch=${branch:-main}

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=${DEPLOY_REPO:-$(git -C "$here" rev-parse --show-toplevel)}
origin_url=${DEPLOY_ORIGIN:-https://github.com/masha256/orion.git}
g() { git -C "$repo" "$@"; }

# GH_PAT: the one key, read without sourcing the file (it holds every other secret of the profile too).
cred_file=${DEPLOY_CRED_FILE:-$HOME/.hermes/profiles/raymond/.env}
gh_pat=''
if [[ -r $cred_file ]]; then
  gh_pat=$(grep -m1 '^GH_PAT=' "$cred_file" | cut -d= -f2- | tr -d '\r') || gh_pat=''
  gh_pat=${gh_pat#\"} gh_pat=${gh_pat%\"} gh_pat=${gh_pat#\'} gh_pat=${gh_pat%\'}
fi
[[ -n $gh_pat ]] || die "no GH_PAT in $cred_file (deploy.sh fetches GitHub over HTTPS with it)"
# git talking to GitHub: GH_PAT in this child's environment only; the helper text names $GH_PAT, never its value.
# shellcheck disable=SC2016  # expanded by the helper's shell, from the environment, not here
github_git() { GH_PAT=$gh_pat git -C "$repo" -c credential.helper= -c 'credential.helper=!f(){ echo username=retrobitbot; echo "password=$GH_PAT"; }; f' "$@"; }

# ---- 1. the tag, the tarball, the commit
github_git fetch --quiet "$origin_url" '+refs/heads/*:refs/remotes/origin/*' 'refs/tags/*:refs/tags/*' || die "git fetch $origin_url failed"
remote_tag=$(github_git ls-remote --tags "$origin_url" "refs/tags/$tag" "refs/tags/$tag^{}") || die "git ls-remote $origin_url failed"
[[ -n $remote_tag ]] || die "tag $tag is not on origin (git push origin $tag first)"
# an annotated tag lists its object and, as <tag>^{}, the commit; a lightweight one only the commit
commit=$(awk -v r="refs/tags/$tag^{}" '$2 == r { print $1 }' <<<"$remote_tag")
[[ -n $commit ]] || commit=$(awk -v r="refs/tags/$tag" '$2 == r { print $1 }' <<<"$remote_tag")

tarball=${tarball:-${DEPLOY_RELEASES:-$HOME/orion-releases}/$tag.tgz}
[[ -f $tarball ]] || die "no tarball $tarball (scripts/release/build.sh $tag)"
tar -xzOf "$tarball" "$tag/RELEASE" >"$work/RELEASE" 2>/dev/null || die "$tarball has no $tag/RELEASE"
read -r rel_tag rel_commit < <(python3 -c '
import json, sys
r = json.load(open(sys.argv[1]))
print(r.get("tag", "-"), r.get("commit", "-"))' "$work/RELEASE") || die "$tarball: $tag/RELEASE is not valid JSON"
[[ $rel_tag == "$tag" ]] || die "$tarball: RELEASE.tag is $rel_tag, not $tag"
[[ $rel_commit == "$commit" ]] || die "$tarball: RELEASE.commit $rel_commit differs from the commit tag $tag is $commit on origin"
sha=$(sha256sum "$tarball" | cut -d' ' -f1)
[[ -f $tarball.sha256 ]] || die "$tarball.sha256 is missing (build.sh writes it beside the tarball)"
[[ $(cut -d' ' -f1 "$tarball.sha256") == "$sha" ]] || die "$tarball's sha256 $sha does not match $tarball.sha256"

g rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null || die "origin/$branch does not exist"
g cat-file -e "$commit^{commit}" 2>/dev/null || die "commit $commit (tag $tag) is not in $repo after the fetch"
g merge-base --is-ancestor "$commit" "refs/remotes/origin/$branch" ||
  die "the commit of $tag ($commit) is not on origin/$branch$([[ $branch == main && $env == stage ]] && printf ' (a staging deploy from a branch: --branch <name>)')"
printf '== deploy %s %s (commit %s on origin/%s, sha256 %s)\n' "$env" "$tag" "$commit" "$branch" "$sha"

# ---- 2. the staging soak gate (prod)
if [[ $env == stage ]]; then
  soak_line='soak: not gated (stage)'
elif ((no_soak)); then
  soak_line='SOAK SKIPPED (--no-soak)'
else
  remote_to stage status --json </dev/null >"$work/stage.json" || die "cannot read staging's status (ssh orion-stage status --json)"
  remote_to prod status --json </dev/null >"$work/prod.json" || die "cannot read prod's status (ssh orion-prod status --json)"
  soak_line=$(python3 - "$tag" "$work/stage.json" "$work/prod.json" <<'EOF'
import json, sys
tag, stage, prod = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
running = (stage.get('release') or {}).get('tag')
if running != tag:
    sys.exit(f'staging runs {running or "no release"}, not {tag}: deploy {tag} to staging and let it soak first (or --no-soak)')
soak = stage.get('soak')
if not soak or soak.get('tag') != tag:
    sys.exit(f'no scheduled nightly has completed on staging for {tag} yet (soak is null): wait for it (or --no-soak)')
failed = sorted(soak.get('failed_sources') or [])
on_prod = set(((prod.get('last_nightly') or {}).get('failed_sources')) or [])
extra = [s for s in failed if s not in on_prod]
if extra:
    sys.exit(f'staging soak of {tag} has failed sources that prod\'s last nightly does not: {", ".join(extra)} (fix them, or --no-soak)')
shown = ', '.join(f'{s} (also failing on prod)' for s in failed) or 'none'
print(f'SOAK OK: staging ran {tag} through the scheduled nightly of {soak.get("nightly_slot")}; failed sources: {shown}')
EOF
  ) || die "prod refused: see above"
fi

# ---- 3. install over stdin, 4. switch only after a clean install
printf '== install %s on %s\n' "$tag" "$env"
rc=0
remote install "$tag" "$sha" <"$tarball" >"$work/install.json" || rc=$?
cat "$work/install.json"
((rc == 0)) || die "install failed (exit $rc); nothing was switched"

printf '== switch %s to %s\n' "$env" "$tag"
switch_args=(switch "$tag")
((breaking)) && switch_args+=(--breaking)
rc=0
remote "${switch_args[@]}" </dev/null >"$work/switch.json" || rc=$?
cat "$work/switch.json"
((rc == 0)) || die "switch failed (exit $rc); see above (to go back: deploy.sh $env --rollback)"

remote status --json </dev/null >"$work/status.json" 2>/dev/null || printf '{}' >"$work/status.json"

# ---- 5. the report
printf '== deploy report (%s)\n' "$env"
python3 - "$work/install.json" "$work/switch.json" "$work/status.json" <<'EOF'
import json, sys
def load(p):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return {}
install, switch, status = (load(p) for p in sys.argv[1:4])
print(f'before: {switch.get("from") or "none"}')
print(f'after:  {switch.get("to")}')
print(f'migrations applied: {", ".join(str(m) for m in switch.get("migrations") or []) or "none"}')
diff = install.get('registry') if isinstance(install.get('registry'), dict) else {}
parts = [f'{label} {", ".join(diff[k])}' for k, label in
         (('added', 'added'), ('missing', 'missing'), ('returned', 'returned'), ('configChanged', 'config changed')) if diff.get(k)]
print(f'registry changes: {"; ".join(parts) or "none"}')
nxt = sorted(status.get('next') or [], key=lambda n: n.get('slot', ''))
print(f'next: {nxt[0]["key"]} {nxt[0]["slot"]}' if nxt else 'next: unknown (status --json gave no next slots)')
nightly = [n for n in nxt if n.get('key') == 'nightly']
if nightly:
    print(f'next nightly: {nightly[0]["slot"]}')
EOF
printf '%s\n' "$soak_line"
