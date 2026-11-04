import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { OrionError } from '../types.js';
import type { Publisher } from './publisher.js';

/**
 * The git driver (spec 9.2): the env's clone in `dir`, one commit per publish that changes something, pushed with the
 * env's deploy key. Orion is the only writer: a remote branch that is not an ancestor of the local head (someone
 * committed to the repo) is refused with `publish_remote_moved`, never merged or forced. The commit is made before the
 * push, so a push that fails is simply pushed again by the next publish.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd` with `env` added to the process environment. */
export type GitRun = (args: string[], opts: { cwd: string; env: Record<string, string> }) => Promise<GitResult>;

/** How long one git command may take (an ssh push to GitHub that hangs must not hold the worker for ever). */
export const GIT_TIMEOUT_MS = 120_000;

export const runGit: GitRun = (args, opts) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && typeof err.code !== 'number' ? err.message : '') });
    });
  });

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The ssh command git pushes and fetches with: only the deploy key, and only the github.com host keys orion-host.sh pins in ~/.ssh/known_hosts (R-c12). */
export function gitSshCommand(keyFile: string): string {
  return `ssh -i ${shellQuote(keyFile)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes`;
}

export interface GitPublisherOptions {
  url: string;
  branch: string;
  /** The working clone (created when missing). */
  dir: string;
  sshKeyFile: string | undefined;
  /** Committer and author name and email: `orion-<env>@<hostname>`. */
  author: string;
  run: GitRun;
}

export function gitPublisher(o: GitPublisherOptions): Publisher {
  const env: Record<string, string> = {
    // Only this repo's own config: no user or system config (hooks paths, signing, rewrites) changes what is written.
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    ...(o.sshKeyFile ? { GIT_SSH_COMMAND: gitSshCommand(o.sshKeyFile) } : {}),
  };
  const remoteRef = `refs/remotes/origin/${o.branch}`;
  const raw = async (args: string[]): Promise<GitResult> => await o.run(args, { cwd: o.dir, env });
  const git = async (args: string[], ok: number[] = [0]): Promise<GitResult> => {
    const r = await raw(args);
    if (!ok.includes(r.code)) {
      const why = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' | ');
      throw new OrionError('publish_git_failed', `git ${args[0]} failed (${r.code}): ${why}`);
    }
    return r;
  };
  const revision = async (ref: string): Promise<string | null> => {
    const r = await git(['rev-parse', '-q', '--verify', `${ref}^{commit}`], [0, 1]);
    return r.code === 0 ? r.stdout.trim() : null;
  };

  /** The clone: made on first use (an empty remote just leaves the branch unborn); a clone of another URL is refused. */
  const ensureClone = async (): Promise<void> => {
    if (!existsSync(join(o.dir, '.git'))) {
      mkdirSync(o.dir, { recursive: true });
      await git(['init', '-q']);
      await git(['remote', 'add', 'origin', o.url]);
      await git(['symbolic-ref', 'HEAD', `refs/heads/${o.branch}`]);
      return;
    }
    const url = (await git(['remote', 'get-url', 'origin'], [0, 2])).stdout.trim();
    if (url !== o.url) {
      throw new OrionError('publish_dir_mismatch', `${o.dir} is a clone of ${url || '(no origin)'}, not of ${o.url}: move it aside or set ORION_PUBLISH_DIR`);
    }
    const head = (await git(['symbolic-ref', '-q', 'HEAD'], [0, 1])).stdout.trim();
    if (head !== `refs/heads/${o.branch}`) {
      throw new OrionError('publish_dir_mismatch', `${o.dir} is on ${head || 'a detached HEAD'}, not on ${o.branch}`);
    }
  };

  /**
   * Fetches the remote branch into `origin/<branch>`; null when the remote has no such branch (a new, empty repo).
   * A clone with no commits of its own takes the remote's history (a lost clone directory is rebuilt, not refused).
   * Otherwise the remote must be an ancestor of the local head.
   */
  const fetchAndCheck = async (): Promise<string | null> => {
    const ls = await git(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${o.branch}`], [0, 2]);
    if (ls.code === 2) return null;
    // The tracking ref only mirrors the remote (a forced update of it is no write to the remote).
    await git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${o.branch}:${remoteRef}`]);
    const remote = (await revision(remoteRef))!;
    if ((await revision('HEAD')) === null) {
      await git(['reset', '-q', '--hard', remoteRef]);
      return remote;
    }
    const ancestor = await git(['merge-base', '--is-ancestor', remoteRef, 'HEAD'], [0, 1]);
    if (ancestor.code !== 0) {
      throw new OrionError(
        'publish_remote_moved',
        `remote ${o.branch} has moved: ${o.url} is at ${remote.slice(0, 12)}, which Orion did not write; refusing to merge or force (Orion is the repo's only writer: reset the remote to Orion's history, then the outbox is retried)`,
      );
    }
    return remote;
  };

  return {
    async publish(files, message) {
      await ensureClone();
      const remote = await fetchAndCheck();
      for (const [path, text] of Object.entries(files)) {
        const rel = normalize(path);
        if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..' || rel.split(sep)[0] === '.git') {
          throw new OrionError('publish_bad_path', `refusing to publish to ${JSON.stringify(path)}`);
        }
        mkdirSync(dirname(join(o.dir, rel)), { recursive: true });
        writeFileSync(join(o.dir, rel), text);
      }
      await git(['add', '-A']);
      const changed = (await git(['status', '--porcelain'])).stdout.trim() !== '';
      if (changed) {
        await git([
          '-c', `user.name=${o.author}`, '-c', `user.email=${o.author}`, '-c', 'commit.gpgsign=false',
          'commit', '-q', '--no-verify', '-m', message,
        ]);
      }
      const head = await revision('HEAD');
      if (head === null) throw new OrionError('publish_git_failed', 'nothing to publish: the file set is empty');
      if (head !== remote) await git(['push', '-q', '--no-verify', 'origin', `HEAD:refs/heads/${o.branch}`]);
      return { ref: head };
    },
  };
}
