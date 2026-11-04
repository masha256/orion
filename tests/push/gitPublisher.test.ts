import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { insertRegistryRow } from '../../src/db/registry.js';
import { insertSnapshot, pendingSnapshots } from '../../src/db/snapshotsOut.js';
import { makeSnapshotPushHandler } from '../../src/daemon/jobs/snapshotPush.js';
import { buildEnvelope } from '../../src/push/envelope.js';
import { gitPublisher, gitSshCommand, runGit, type GitRun } from '../../src/push/gitPublisher.js';
import { verifyManifest } from '../../src/push/sign.js';
import { useTestDb } from '../helpers/db.js';
import { pushContext, pushJob } from '../helpers/pushWorld.js';

const db = useTestDb();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'orion-git-'));
  dirs.push(d);
  return d;
}

const ISOLATED = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ISOLATED, encoding: 'utf8' }).trim();

/** An empty bare repo (default branch main) and its file:// URL. */
function bareRepo(): { dir: string; url: string; root: string } {
  const root = scratch();
  const dir = join(root, 'data.git');
  git(root, 'init', '-q', '--bare', dir);
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  return { dir, url: `file://${dir}`, root };
}

/** A fresh clone of `url`'s main, as a reader would see it: path -> content. */
function cloneFiles(url: string): Record<string, string> {
  const d = join(scratch(), 'clone');
  git(tmpdir(), 'clone', '-q', '--branch', 'main', url, d);
  const out: Record<string, string> = {};
  const walk = (p: string): void => {
    for (const name of readdirSync(p)) {
      if (name === '.git') continue;
      const f = join(p, name);
      if (statSync(f).isDirectory()) walk(f);
      else out[relative(d, f)] = readFileSync(f, 'utf8');
    }
  };
  walk(d);
  return out;
}

const commits = (bare: string): string[] => git(bare, 'log', '--format=%H %an <%ae> %s', 'main').split('\n').filter(Boolean);

const keys = generateKeyPairSync('ed25519');
const PRIVATE_PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const FILES = {
  'manifest.json': '{"a":1}\n', 'manifest.json.sig': 'c2ln', 'full/latest.json': '{"f":1}\n', 'full/2026/2026-11-02.json': '{"f":1}\n',
  'levels/latest.json': '{"l":1}\n', 'assets.json': '{}\n',
};

describe('git publisher', () => {
  it('git publisher: first publish to an empty bare repo creates the branch with the six files', async () => {
    const repo = bareRepo();
    const p = gitPublisher({ url: repo.url, branch: 'main', dir: join(repo.root, 'publish'), sshKeyFile: undefined, author: 'orion-dev@testhost', run: runGit });
    const { ref } = await p.publish(FILES, 'levels seq 1 day - release -');
    expect(cloneFiles(repo.url)).toEqual(FILES);
    const log = commits(repo.dir);
    expect(log).toEqual([`${ref} orion-dev@testhost <orion-dev@testhost> levels seq 1 day - release -`]);

    // A second publish adds to history: a new day's file stays beside the old one, nothing is deleted.
    const next = { ...FILES, 'full/2026/2026-11-03.json': '{"f":2}\n', 'full/latest.json': '{"f":2}\n' };
    delete (next as Record<string, string>)['full/2026/2026-11-02.json'];
    const second = await p.publish(next, 'full seq 2 day 2026-11-03 release -');
    expect(cloneFiles(repo.url)).toEqual({ ...FILES, ...next });
    expect(commits(repo.dir).map((l) => l.split(' ')[0])).toEqual([second.ref, ref]);
  });

  it('git publisher: nothing changed means no new commit', async () => {
    const repo = bareRepo();
    const p = gitPublisher({ url: repo.url, branch: 'main', dir: join(repo.root, 'publish'), sshKeyFile: undefined, author: 'orion-dev@testhost', run: runGit });
    const a = await p.publish(FILES, 'levels seq 1 day - release -');
    const b = await p.publish(FILES, 'levels seq 2 day - release -');
    expect(b.ref).toBe(a.ref);
    expect(commits(repo.dir)).toHaveLength(1);
  });

  it('git publisher: a failed push keeps the local commit and the next publish pushes it without a new commit', async () => {
    const repo = bareRepo();
    const dir = join(repo.root, 'publish');
    let refusePush = true;
    const run: GitRun = async (args, o) => (refusePush && args[0] === 'push' ? { code: 1, stdout: '', stderr: 'fatal: network unreachable\n' } : await runGit(args, o));
    const p = gitPublisher({ url: repo.url, branch: 'main', dir, sshKeyFile: undefined, author: 'orion-dev@testhost', run });
    await expect(p.publish(FILES, 'm1')).rejects.toMatchObject({ code: 'publish_git_failed', message: expect.stringContaining('network unreachable') });
    expect(git(repo.dir, 'branch', '--list')).toBe(''); // nothing reached the remote
    const local = git(dir, 'rev-parse', 'HEAD');
    refusePush = false;
    const { ref } = await p.publish(FILES, 'm2');
    expect(ref).toBe(local);
    expect(commits(repo.dir).map((l) => l.split(' ').slice(-1)[0])).toEqual(['m1']);
  });

  it('git publisher: a lost clone directory is rebuilt from the remote, not refused', async () => {
    const repo = bareRepo();
    const dir = join(repo.root, 'publish');
    const p = gitPublisher({ url: repo.url, branch: 'main', dir, sshKeyFile: undefined, author: 'orion-dev@testhost', run: runGit });
    const a = await p.publish(FILES, 'm1');
    rmSync(dir, { recursive: true, force: true });
    const b = await p.publish({ ...FILES, 'assets.json': '{"x":1}\n' }, 'm2');
    expect(git(repo.dir, 'rev-parse', `${b.ref}~1`)).toBe(a.ref);
  });

  it('git publisher: a clone of another repo in the publish directory is refused', async () => {
    const one = bareRepo();
    const two = bareRepo();
    const dir = join(one.root, 'publish');
    await gitPublisher({ url: one.url, branch: 'main', dir, sshKeyFile: undefined, author: 'a', run: runGit }).publish(FILES, 'm1');
    await expect(gitPublisher({ url: two.url, branch: 'main', dir, sshKeyFile: undefined, author: 'a', run: runGit }).publish(FILES, 'm1'))
      .rejects.toMatchObject({ code: 'publish_dir_mismatch' });
  });

  it('git publisher: the deploy key goes into GIT_SSH_COMMAND with the pinned host keys (StrictHostKeyChecking=yes, R-c12); never --force', async () => {
    expect(gitSshCommand('/home/orion-stage/shared/publish_ed25519'))
      .toBe("ssh -i '/home/orion-stage/shared/publish_ed25519' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes");
    expect(gitSshCommand("/tmp/it's")).toBe("ssh -i '/tmp/it'\\''s' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes");
    const repo = bareRepo();
    const calls: { args: string[]; ssh: string | undefined }[] = [];
    const run: GitRun = async (args, o) => {
      calls.push({ args, ssh: o.env.GIT_SSH_COMMAND });
      return await runGit(args, o);
    };
    await gitPublisher({ url: repo.url, branch: 'main', dir: join(repo.root, 'publish'), sshKeyFile: '/keys/k', author: 'a', run }).publish(FILES, 'm');
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(c.ssh).toBe(gitSshCommand('/keys/k'));
    for (const c of calls) expect(c.args.join(' ')).not.toMatch(/--force|\s-f(\s|$)|\+refs\/heads\/main:refs\/heads/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
  });

  it('git publisher: a moved remote is refused, alerted once, outbox kept', async () => {
    const repo = bareRepo();
    const dir = join(repo.root, 'publish');
    const keyFile = join(repo.root, 'sign.key');
    writeFileSync(keyFile, PRIVATE_PEM);
    await insertRegistryRow(db(), 'mini', 'active', 'h', { at: '2026-09-01T00:00:00.000Z', by: 'test', reason: null, releaseTag: null });
    const envVars = { ORION_PUBLISH: `git:${repo.url}#main`, ORION_PUBLISH_DIR: dir, ORION_SIGN_KEY_FILE: keyFile };
    const env = { env: 'stage' as const, seq: 0, releaseTag: 'orion-2026.11.03.1' };
    const handler = makeSnapshotPushHandler({ host: 'testhost' });

    // A first, good publish.
    await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { assets: {} }, { ...env, now: new Date('2026-11-03T01:15:00.000Z') }) });
    const ok = pushContext(db(), repo.root, '2026-11-03T01:16:00.000Z', envVars);
    expect(await handler(pushJob(1), ok.ctx)).toMatchObject({ status: 'done', result: { pushed: 1 } });
    const files = cloneFiles(repo.url);
    expect(verifyManifest(Buffer.from(files['manifest.json']), files['manifest.json.sig'], PUBLIC_PEM)).toBe(true);
    expect(commits(repo.dir)[0]).toMatch(/ orion-stage@testhost <orion-stage@testhost> levels seq 1 day - release orion-2026\.11\.03\.1$/);

    // Someone edits the repo.
    const outside = join(scratch(), 'outside');
    git(tmpdir(), 'clone', '-q', '--branch', 'main', repo.url, outside);
    writeFileSync(join(outside, 'README.md'), 'hand edit\n');
    git(outside, 'add', 'README.md');
    git(outside, 'commit', '-q', '-m', 'hand edit');
    git(outside, 'push', '-q', 'origin', 'main');
    const theirs = git(repo.dir, 'rev-parse', 'main');

    await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { assets: { n: 2 } }, { ...env, now: new Date('2026-11-03T02:15:00.000Z') }) });
    const first = pushContext(db(), repo.root, '2026-11-03T02:16:00.000Z', envVars);
    const out = await handler(pushJob(2), first.ctx);
    expect(out).toMatchObject({ status: 'failed', error: expect.stringContaining('remote main has moved') });
    expect(first.posts).toHaveLength(1);
    expect(first.posts[0]).toMatch(/^ORION ALERT stage snapshot publish failing since 2026-11-03T02:15:00\.000Z: .*remote main has moved/);
    expect(git(repo.dir, 'rev-parse', 'main')).toBe(theirs); // never merged, never forced
    expect(git(dir, 'log', '--format=%s')).not.toContain('hand edit');
    const pending = await pendingSnapshots(db());
    expect(pending.map((r) => [r.seq, r.attempts])).toEqual([[2, 1]]);
    expect(pending[0].alertedAt).toBe('2026-11-03T02:16:00.000Z');
    expect(first.enqueued).toEqual([{ kind: 'snapshot_push', assetId: null, slot: '2026-11-03T02:17:00.000Z', requestedBy: 'snapshot_push retry' }]);

    const second = pushContext(db(), repo.root, '2026-11-03T02:17:00.000Z', envVars);
    expect(await handler(pushJob(3), second.ctx)).toMatchObject({ status: 'failed' });
    expect(second.posts).toEqual([]);
    expect((await pendingSnapshots(db())).map((r) => [r.seq, r.attempts])).toEqual([[2, 2]]);
    expect(git(repo.dir, 'rev-parse', 'main')).toBe(theirs);
  });
});
