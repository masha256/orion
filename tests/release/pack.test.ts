import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK = join(ROOT, 'scripts', 'release', 'pack.sh');
const BUILD = join(ROOT, 'scripts', 'release', 'build.sh');
const TAG = 'orion-2026.11.02.7';
/** The fixture commit's time: the tarball's mtimes and RELEASE's built_at. */
const COMMIT_TIME = '2026-11-02T10:00:00Z';

const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, text = `${rel}\n`): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: COMMIT_TIME, GIT_AUTHOR_DATE: COMMIT_TIME },
  }).trim();

/** A built checkout: a temp git repo with one commit, plus the untracked build output (dist/) and dev-only files. */
function fixtureTree(): { src: string; commit: string } {
  const src = scratch('orion-pack-src-');
  for (const rel of [
    'assets/mini.yaml', 'personas/analyst.md', 'skills/disclosure-review.md', 'schedule.yaml', 'package.json', 'package-lock.json',
    'scripts/provision/orion-host.sh', 'scripts/provision/files/orion-remote', 'scripts/provision/test/run.sh',
    'scripts/build/copy-migrations.mjs', 'scripts/release/build.sh', 'scripts/probe-web-fetch.mjs',
    'src/cli/index.ts', 'tests/cli/x.test.ts', 'tools/import-sqlite/cli.ts', 'docs/x.md', 'README.md',
    'tools/disclosure-watcher/bin/disclosure_watch.py', 'tools/disclosure-watcher/watch.yaml', 'tools/disclosure-watcher/tests/test_x.py',
  ]) put(src, rel);
  git(src, 'init', '-q');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'fixture');
  // Untracked: the build output, node_modules, a dev .env and database at the root (never packed).
  put(src, 'dist/cli/index.js', 'console.log(1);\n');
  put(src, 'dist/db/pg/migrate.js');
  put(src, 'dist/db/pg/migrations/0001_baseline.sql');
  put(src, 'dist/db/pg/migrations/0002_daemon.sql');
  put(src, 'node_modules/pg/index.js');
  put(src, 'tools/disclosure-watcher/__pycache__/x.pyc');
  put(src, '.env', 'SECRET=1\n');
  put(src, 'orion.db');
  return { src, commit: git(src, 'rev-parse', 'HEAD') };
}

function pack(src: string, tag: string, commit: string, out: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [PACK, src, tag, commit, out], { encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('release pack', () => {
  it('pack: the tarball holds exactly the release paths under orion-<tag>/ and a RELEASE with schema 2', () => {
    const { src, commit } = fixtureTree();
    const out = scratch('orion-pack-out-');
    const r = pack(src, TAG, commit, out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const tgz = join(out, `${TAG}.tgz`);
    expect(readdirSync(out).sort()).toEqual([`${TAG}.tgz`, `${TAG}.tgz.sha256`]);
    expect(readFileSync(`${tgz}.sha256`, 'utf8')).toBe(`${sha256(tgz)}  ${TAG}.tgz\n`);

    const listing = execFileSync('tar', ['-tzvf', tgz], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim().split('\n');
    const names = listing.map((l) => l.split(/\s+/).slice(5).join(' '));
    const top = `${TAG}/`;
    expect(names.every((n) => n.startsWith(top))).toBe(true);
    expect(names.filter((n) => !n.endsWith('/')).map((n) => n.slice(top.length))).toEqual([
      'RELEASE',
      'assets/mini.yaml',
      'dist/cli/index.js',
      'dist/db/pg/migrate.js',
      'dist/db/pg/migrations/0001_baseline.sql',
      'dist/db/pg/migrations/0002_daemon.sql',
      'package-lock.json',
      'package.json',
      'personas/analyst.md',
      'schedule.yaml',
      'scripts/provision/files/orion-remote',
      'scripts/provision/orion-host.sh',
      'skills/disclosure-review.md',
      'tools/disclosure-watcher/bin/disclosure_watch.py',
      'tools/disclosure-watcher/watch.yaml',
    ]);
    // Owner 0/0, mtime = the commit time, for every entry.
    for (const l of listing) {
      expect(l.split(/\s+/)[1]).toBe('0/0');
      expect(`${l.split(/\s+/)[3]} ${l.split(/\s+/)[4]}`).toBe('2026-11-02 10:00');
    }

    const release = JSON.parse(execFileSync('tar', ['-xzOf', tgz, `${TAG}/RELEASE`], { encoding: 'utf8' }));
    expect(release).toEqual({ tag: TAG, commit, schema: 2, built_at: '2026-11-02T10:00:00Z', node: process.version });
    expect(JSON.parse(readFileSync(join(src, 'RELEASE'), 'utf8'))).toEqual(release); // written into the tree too
  });

  it('pack: two packs of the same tree are byte-identical', () => {
    const { src, commit } = fixtureTree();
    const a = scratch('orion-pack-a-');
    const b = scratch('orion-pack-b-');
    expect(pack(src, TAG, commit, a).status).toBe(0);
    expect(pack(src, TAG, commit, b).status).toBe(0);
    expect(sha256(join(a, `${TAG}.tgz`))).toBe(sha256(join(b, `${TAG}.tgz`)));
    expect(readFileSync(join(a, `${TAG}.tgz.sha256`), 'utf8')).toBe(readFileSync(join(b, `${TAG}.tgz.sha256`), 'utf8'));
  });

  it('pack: a tree containing .env or src/ is refused', () => {
    for (const [rel, why] of [
      ['assets/.env', /\.env/],
      ['skills/.env.prod', /\.env/],
      ['dist/src/leak.js', /src\//],
      ['personas/tests/x.md', /tests\//],
      ['dist/orion.db', /\.db/],
    ] as const) {
      const { src, commit } = fixtureTree();
      put(src, rel);
      const out = scratch('orion-pack-out-');
      const r = pack(src, TAG, commit, out);
      expect(r.status, rel).not.toBe(0);
      expect(r.stderr, rel).toMatch(why);
      expect(r.stderr, rel).toContain(rel);
      expect(readdirSync(out), rel).toEqual([]);
    }
  });

  it('pack: a bad tag is refused', () => {
    const { src, commit } = fixtureTree();
    for (const tag of ['v1.0', 'orion-2026.11.02', 'orion-2026.11.2.1', 'orion-2026.11.02.1;id', 'orion-2026.11.02.x']) {
      const out = scratch('orion-pack-out-');
      const r = pack(src, tag, commit, out);
      expect(r.status, tag).not.toBe(0);
      expect(r.stderr, tag).toMatch(/tag/);
      expect(readdirSync(out), tag).toEqual([]);
    }
    // No build output: refused.
    const bare = fixtureTree();
    rmSync(join(bare.src, 'dist'), { recursive: true });
    const r = pack(bare.src, TAG, bare.commit, scratch('orion-pack-out-'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/dist\/cli\/index\.js/);
  });

  it('build: refuses when ORION_TEST_DATABASE_URL is unset', () => {
    const tmp = scratch('orion-build-tmp-');
    const before = execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmp, TMPDIR: tmp };
    const r = spawnSync('bash', [BUILD, 'orion-2026.11.02.98', '--out', join(tmp, 'out')], { encoding: 'utf8', env });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ORION_TEST_DATABASE_URL/);
    expect(readdirSync(tmp)).toEqual([]); // no worktree, no output dir
    expect(execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).toBe(before);
    expect(existsSync(join(tmp, 'orion-build-orion-2026.11.02.98'))).toBe(false);
  });
});
