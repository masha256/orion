import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = join(ROOT, 'scripts', 'release', 'deploy.sh');
const TAG = 'orion-2026.11.03.1';

const dirs: string[] = [];
/** The origin URL of each fixture checkout (deploy.sh fetches it by URL, as it fetches GitHub's in real use). */
const repos = new Map<string, string>();
const TOKEN = 'ghp_FAKE_TOKEN_never_printed_0123456789';
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

/**
 * A dev checkout whose origin is a file:// bare repo (no network): main has one commit, feat/x one more on top.
 * `tags` are created annotated on the given commits and pushed unless listed in `localOnly`.
 */
function fixtureRepo(): { repo: string; main: string; feat: string; origin: string } {
  const base = scratch('orion-deploy-repo-');
  const origin = join(base, 'origin.git');
  const repo = join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', `file://${origin}`, repo);
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'main 1');
  const main = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', 'b.txt');
  git(repo, 'commit', '-qm', 'feat 1');
  const feat = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', 'feat/x');
  git(repo, 'checkout', '-q', 'main');
  repos.set(repo, `file://${origin}`);
  return { repo, main, feat, origin: `file://${origin}` };
}

function tag(repo: string, name: string, commit: string, push = true): void {
  git(repo, 'tag', '-a', name, '-m', name, commit);
  if (push) git(repo, 'push', '-q', 'origin', `refs/tags/${name}`);
}

/** <dir>/<tag>.tgz holding <tag>/RELEASE (and some bulk, so the stdin byte count means something). */
function tarball(dir: string, name: string, commit: string, withSha = true): string {
  const src = scratch('orion-deploy-tgz-');
  mkdirSync(join(src, name, 'dist'), { recursive: true });
  writeFileSync(join(src, name, 'RELEASE'), JSON.stringify({ tag: name, commit, schema: 2, built_at: '2026-11-03T10:00:00Z', node: 'v26.7.0' }));
  writeFileSync(join(src, name, 'dist', 'bulk.bin'), Buffer.alloc(200_000, 7));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}.tgz`);
  execFileSync('tar', ['-czf', out, '-C', src, name]);
  if (withSha) writeFileSync(`${out}.sha256`, `${execFileSync('sha256sum', [out], { encoding: 'utf8' }).split(' ')[0]}  ${name}.tgz\n`);
  return out;
}

interface Fake { dir: string; log: string; bin: string }

/**
 * A fake ssh: appends one JSON line per call ({argv, stdin: byte count}) to <dir>/calls.jsonl and answers by verb:
 * status --json prints <dir>/status-<user>.json; install / switch exit FAKE_INSTALL_RC / FAKE_SWITCH_RC.
 */
function fakeSsh(): Fake {
  const dir = scratch('orion-deploy-ssh-');
  const bin = join(dir, 'ssh');
  writeFileSync(bin, `#!/usr/bin/python3
import json, os, sys
d = ${JSON.stringify(dir)}
args = sys.argv[1:]
data = sys.stdin.buffer.read()
with open(os.path.join(d, 'calls.jsonl'), 'a') as f:
    f.write(json.dumps({'argv': args, 'stdin': len(data)}) + '\\n')
dest = next(a for a in args if '@' in a)
user = dest.split('@')[0]
verb = args[args.index(dest) + 1:]
if verb[:2] == ['status', '--json']:
    p = os.path.join(d, 'status-' + user + '.json')
    if not os.path.exists(p):
        sys.stderr.write('orion-remote: no status\\n'); sys.exit(1)
    sys.stdout.write(open(p).read()); sys.exit(0)
if verb[:1] == ['install']:
    rc = int(os.environ.get('FAKE_INSTALL_RC', '0'))
    print(json.dumps({'tag': verb[1], 'registry': {'added': ['newa'], 'missing': [], 'returned': [], 'configChanged': ['uni']}}))
    sys.exit(rc)
if verb[:1] == ['switch']:
    rc = int(os.environ.get('FAKE_SWITCH_RC', '0'))
    print(json.dumps({'from': 'orion-2026.11.01.1', 'to': verb[1], 'migrations': [2], 'registry': [], 'next': 'soak'}))
    sys.exit(rc)
if verb[:1] == ['rollback']:
    print(json.dumps({'from': 'orion-2026.11.03.1', 'to': 'orion-2026.11.01.1'})); sys.exit(0)
sys.exit(64)
`);
  chmodSync(bin, 0o755);
  return { dir, log: join(dir, 'calls.jsonl'), bin };
}

const calls = (f: Fake): { argv: string[]; stdin: number }[] =>
  existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: number }) : [];
/** The orion-remote verb of each call (what follows user@host). */
const verbs = (f: Fake): string[][] => calls(f).map((c) => c.argv.slice(c.argv.findIndex((a) => a.includes('@')) + 1));

function status(f: Fake, user: string, s: unknown): void {
  writeFileSync(join(f.dir, `status-${user}.json`), JSON.stringify(s));
}

const NEXT = [{ key: 'nightly', slot: '2026-11-04T00:45:00.000Z' }, { key: 'levels', slot: '2026-11-03T19:15:00.000Z' }];

/** A fake credentials file (the real one is the raymond profile's .env: tests never read it). */
function credFile(text = `OTHER=x\nGH_PAT=${TOKEN}\nLATER=y\n`): string {
  const p = join(scratch('orion-deploy-cred-'), '.env');
  writeFileSync(p, text);
  return p;
}

function deploy(repo: string, releases: string, f: Fake, args: string[], extra: Record<string, string | undefined> = {}): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch('orion-deploy-home-'), TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    DEPLOY_TEST: '1', DEPLOY_SSH: f.bin, DEPLOY_REPO: repo, DEPLOY_ORIGIN: repos.get(repo) ?? 'file:///nonexistent', DEPLOY_RELEASES: releases,
    DEPLOY_CRED_FILE: credFile(), ...extra,
  })) if (v !== undefined) env[k] = v;
  const r = spawnSync('bash', [DEPLOY, ...args], { encoding: 'utf8', env });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe('deploy.sh', () => {
  it('deploy: refuses a tag that is not on origin', () => {
    const { repo, main } = fixtureRepo();
    tag(repo, TAG, main, false);
    const rel = scratch('orion-deploy-rel-');
    tarball(rel, TAG, main);
    const f = fakeSsh();
    const r = deploy(repo, rel, f, ['stage', TAG]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(new RegExp(`tag ${TAG.replace(/\./g, '\\.')} is not on origin`));
    expect(calls(f)).toEqual([]);
  });

  it('deploy: refuses a tarball whose commit differs from the tag', () => {
    const { repo, main, feat } = fixtureRepo();
    tag(repo, TAG, main);
    const rel = scratch('orion-deploy-rel-');
    tarball(rel, TAG, feat);
    const f = fakeSsh();
    const r = deploy(repo, rel, f, ['stage', TAG]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`RELEASE.commit ${feat}`);
    expect(r.stderr).toContain(`tag ${TAG} is ${main}`);
    expect(calls(f)).toEqual([]);
  });

  it('deploy: stage --branch accepts a commit reachable from origin/<branch> (R-c1); without it origin/main is required; prod refuses --branch', () => {
    const { repo, feat } = fixtureRepo();
    tag(repo, TAG, feat);
    const rel = scratch('orion-deploy-rel-');
    tarball(rel, TAG, feat);
    const f = fakeSsh();

    const noBranch = deploy(repo, rel, f, ['stage', TAG]);
    expect(noBranch.status).not.toBe(0);
    expect(noBranch.stderr).toContain('is not on origin/main');
    expect(calls(f)).toEqual([]);

    const prod = deploy(repo, rel, f, ['prod', TAG, '--branch', 'feat/x']);
    expect(prod.status).not.toBe(0);
    expect(prod.stderr).toContain('prod deploys only from origin/main');
    expect(calls(f)).toEqual([]);

    const gone = deploy(repo, rel, f, ['stage', TAG, '--branch', 'no-such']);
    expect(gone.status).not.toBe(0);
    expect(gone.stderr).toContain('origin/no-such does not exist');

    status(f, 'orion-stage', { env: 'stage', release: { tag: TAG }, next: NEXT, soak: null, last_nightly: null });
    const ok = deploy(repo, rel, f, ['stage', TAG, '--branch', 'feat/x']);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(verbs(f).map((v) => v[0])).toEqual(['install', 'switch', 'status']);
    const first = calls(f)[0]!.argv;
    expect(first.slice(0, first.indexOf('orion-stage@192.168.0.12'))).toEqual(
      expect.arrayContaining(['-o', 'IdentitiesOnly=yes', '-i', expect.stringMatching(/\/\.ssh\/orion-stage_ed25519$/)]),
    );
    expect(ok.stdout).toContain('soak: not gated (stage)');
  });

  it('deploy: prod refuses without a staging soak on the same tag, names the extra failed source, and --no-soak overrides with the SOAK SKIPPED line', () => {
    const { repo, main } = fixtureRepo();
    tag(repo, TAG, main);
    const rel = scratch('orion-deploy-rel-');
    tarball(rel, TAG, main);
    const f = fakeSsh();
    status(f, 'orion-prod', { env: 'prod', release: { tag: 'orion-2026.11.01.1' }, next: NEXT, soak: null,
      last_nightly: { tag: 'orion-2026.11.01.1', nightly_slot: '2026-11-03T00:45:00.000Z', status: 'done', failed_sources: ['pump:solana.supply_burn_daily'] } });

    // staging runs another tag
    status(f, 'orion-stage', { env: 'stage', release: { tag: 'orion-2026.11.02.1' }, next: NEXT, soak: null, last_nightly: null });
    let r = deploy(repo, rel, f, ['prod', TAG]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`staging runs orion-2026.11.02.1, not ${TAG}`);
    // the right tag, no soak yet
    status(f, 'orion-stage', { env: 'stage', release: { tag: TAG }, next: NEXT, soak: null, last_nightly: null });
    r = deploy(repo, rel, f, ['prod', TAG]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`no scheduled nightly has completed on staging for ${TAG}`);
    // soaked, but with a failed source prod does not have
    status(f, 'orion-stage', { env: 'stage', release: { tag: TAG }, next: NEXT,
      soak: { tag: TAG, nightly_slot: '2026-11-03T02:45:00.000Z', status: 'done', failed_sources: ['pump:solana.supply_burn_daily', 'uni:defillama.fees'] },
      last_nightly: null });
    r = deploy(repo, rel, f, ['prod', TAG]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('uni:defillama.fees');
    expect(r.stderr).not.toContain('pump:');
    expect(verbs(f).every((v) => v[0] === 'status')).toBe(true);

    // --no-soak: no gate, the report says so
    const before = calls(f).length;
    r = deploy(repo, rel, f, ['prod', TAG, '--no-soak']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(verbs(f).slice(before).map((v) => v[0])).toEqual(['install', 'switch', 'status']);
    expect(r.stdout).toContain('SOAK SKIPPED (--no-soak)');
    expect(calls(f).slice(before).every((c) => c.argv.includes('orion-prod@192.168.0.12'))).toBe(true);

    // soaked, and the only failed source also fails on prod: passes
    status(f, 'orion-stage', { env: 'stage', release: { tag: TAG }, next: NEXT,
      soak: { tag: TAG, nightly_slot: '2026-11-03T02:45:00.000Z', status: 'done', failed_sources: ['pump:solana.supply_burn_daily'] }, last_nightly: null });
    r = deploy(repo, rel, f, ['prod', TAG]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`SOAK OK: staging ran ${TAG} through the scheduled nightly of 2026-11-03T02:45:00.000Z`);
    expect(r.stdout).toContain('pump:solana.supply_burn_daily (also failing on prod)');
  });

  it('deploy: the tarball goes to install on stdin and switch follows only after install exits 0', () => {
    const { repo, main } = fixtureRepo();
    tag(repo, TAG, main);
    const rel = scratch('orion-deploy-rel-');
    const tgz = tarball(rel, TAG, main);
    const size = statSync(tgz).size;
    const sha = execFileSync('sha256sum', [tgz], { encoding: 'utf8' }).split(' ')[0]!;
    const f = fakeSsh();
    status(f, 'orion-stage', { env: 'stage', release: { tag: TAG }, next: NEXT, soak: null, last_nightly: null });

    const bad = deploy(repo, rel, f, ['stage', TAG], { FAKE_INSTALL_RC: '1' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('install failed (exit 1); nothing was switched');
    expect(verbs(f)).toEqual([['install', TAG, sha]]);
    expect(calls(f)[0]!.stdin).toBe(size);

    const before = calls(f).length;
    const r = deploy(repo, rel, f, ['stage', TAG, '--breaking']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(verbs(f).slice(before)).toEqual([['install', TAG, sha], ['switch', TAG, '--breaking'], ['status', '--json']]);
    expect(calls(f)[before]!.stdin).toBe(size);
    expect(calls(f)[before + 1]!.stdin).toBe(0);
    expect(r.stdout).toMatch(/^before: orion-2026\.11\.01\.1$/m);
    expect(r.stdout).toMatch(new RegExp(`^after: +${TAG.replace(/\./g, '\\.')}$`, 'm'));
    expect(r.stdout).toMatch(/^migrations applied: 2$/m);
    expect(r.stdout).toMatch(/^registry changes: added newa; config changed uni$/m);
    expect(r.stdout).toMatch(/^next: levels 2026-11-03T19:15:00\.000Z$/m);

    // a sha256 file that disagrees with the tarball is refused before any call
    writeFileSync(`${tgz}.sha256`, `${'0'.repeat(64)}  ${TAG}.tgz\n`);
    const n = calls(f).length;
    const mism = deploy(repo, rel, f, ['stage', TAG]);
    expect(mism.status).not.toBe(0);
    expect(mism.stderr).toContain('does not match');
    expect(calls(f).length).toBe(n);
  });

  it('deploy (I-8): fetches the origin URL with a one-shot GH_PAT credential helper; the token is never on argv or printed', () => {
    const { repo, main, origin } = fixtureRepo();
    tag(repo, TAG, main);
    const rel = scratch('orion-deploy-rel-');
    tarball(rel, TAG, main);
    const f = fakeSsh();
    status(f, 'orion-stage', { env: 'stage', release: { tag: TAG }, next: NEXT, soak: null, last_nightly: null });
    // a git on PATH that records argv and whether GH_PAT is in its environment, then runs the real git
    const wrap = scratch('orion-deploy-git-');
    const log = join(wrap, 'git.jsonl');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(wrap, 'git'), `#!/usr/bin/python3
import json, os, sys
with open(${JSON.stringify(log)}, 'a') as f:
    f.write(json.dumps({'argv': sys.argv[1:], 'pat': os.environ.get('GH_PAT')}) + '\\n')
os.execv(${JSON.stringify(realGit)}, [${JSON.stringify(realGit)}] + sys.argv[1:])
`);
    chmodSync(join(wrap, 'git'), 0o755);
    const r = deploy(repo, rel, f, ['stage', TAG], { PATH: `${wrap}:${process.env.PATH ?? '/usr/bin:/bin'}` });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    const gitCalls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; pat: string | null });
    for (const c of gitCalls) expect(c.argv.join(' ')).not.toContain(TOKEN);
    const remoteCalls = gitCalls.filter((c) => c.argv.includes('fetch') || c.argv.includes('ls-remote'));
    expect(remoteCalls.map((c) => c.argv.find((a) => a === 'fetch' || a === 'ls-remote'))).toEqual(['fetch', 'ls-remote']);
    for (const c of remoteCalls) {
      expect(c.pat).toBe(TOKEN); // exported to the git child only
      expect(c.argv).toContain(origin);
      expect(c.argv).toContain('credential.helper=');
    }
    expect(gitCalls.filter((c) => !remoteCalls.includes(c)).every((c) => c.pat === null)).toBe(true);
    // the helper answers git's credential protocol with the token from its environment, and nothing else
    const helper = remoteCalls[0]!.argv.find((a) => a.startsWith('credential.helper=!'))!;
    expect(helper).not.toContain(TOKEN);
    const answer = execFileSync(realGit, ['-c', 'credential.helper=', '-c', helper, 'credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GH_PAT: TOKEN, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    expect(answer).toContain('username=retrobitbot');
    expect(answer).toContain(`password=${TOKEN}`);
  });

  it('deploy (I-8): DEPLOY_REPO / DEPLOY_ORIGIN need DEPLOY_TEST=1; a credentials file without GH_PAT is refused', () => {
    const { repo, main } = fixtureRepo();
    tag(repo, TAG, main);
    const rel = scratch('orion-deploy-rel-');
    tarball(rel, TAG, main);
    const f = fakeSsh();
    for (const extra of [{ DEPLOY_TEST: undefined }, { DEPLOY_TEST: '0' }]) {
      const r = deploy(repo, rel, f, ['stage', TAG], extra);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('DEPLOY_REPO and DEPLOY_ORIGIN are for tests only (DEPLOY_TEST=1)');
    }
    const noPat = deploy(repo, rel, f, ['stage', TAG], { DEPLOY_CRED_FILE: credFile('OTHER=x\n# GH_PAT=commented\n') });
    expect(noPat.status).not.toBe(0);
    expect(noPat.stderr).toMatch(/no GH_PAT in .*\.env/);
    const missing = deploy(repo, rel, f, ['stage', TAG], { DEPLOY_CRED_FILE: '/nonexistent/.env' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('no GH_PAT in /nonexistent/.env');
    expect(calls(f)).toEqual([]);
  });

  it('deploy (M-9): a tarball without its .sha256 is refused before any call', () => {
    const { repo, main } = fixtureRepo();
    tag(repo, TAG, main);
    const rel = scratch('orion-deploy-rel-');
    tarball(rel, TAG, main, false);
    const f = fakeSsh();
    const r = deploy(repo, rel, f, ['stage', TAG]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.sha256 is missing');
    expect(calls(f)).toEqual([]);
  });

  it('deploy: --rollback calls rollback only', () => {
    const f = fakeSsh();
    const r = deploy('/nonexistent', '/nonexistent', f, ['prod', '--rollback']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(verbs(f)).toEqual([['rollback']]);
    expect(calls(f)[0]!.argv).toContain('orion-prod@192.168.0.12');
    expect(r.stdout).toContain('"to": "orion-2026.11.01.1"');
    const both = deploy('/nonexistent', '/nonexistent', f, ['stage', TAG, '--rollback']);
    expect(both.status).not.toBe(0);
    expect(verbs(f)).toEqual([['rollback']]);
  });
});
