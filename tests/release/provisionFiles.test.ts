import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = join(ROOT, 'scripts', 'provision', 'files');
const WATCHER_REQS = join(ROOT, 'tools', 'disclosure-watcher', 'requirements.txt');

describe('provision files', () => {
  it('provisionFiles: the unit file has the spec values', () => {
    const unit = readFileSync(join(FILES, 'orion-daemon.service'), 'utf8');
    const lines = unit.split('\n');
    for (const want of [
      // Global Constraints, verbatim
      'Type=notify', 'NotifyAccess=all', 'Restart=always', 'RestartSec=30', 'WatchdogSec=120', 'TimeoutStopSec=15min',
      'ExecStart=/opt/node-v26/bin/node %h/current/dist/cli/index.js daemon', 'Environment=ORION_HOME=%h/home',
      // Task 15
      'Environment=ORION_ENV=@ORION_ENV@', 'Environment=ORION_ENV_FILE=%h/shared/.env',
      'Environment=ORION_SIGN_KEY_FILE=%h/shared/snapshot-sign.key', 'Environment=ORION_PUBLISH_SSH_KEY=%h/shared/publish_ed25519',
      'Environment=ORION_PUBLISH_DIR=%h/home/publish', 'Environment=ORION_WATCHER_VENV=%h/watcher-venv',
      '[Install]', 'WantedBy=default.target',
    ]) expect(lines).toContain(want);
    expect(unit).toContain('@ORION_ENV@');
    // no other placeholder, and no secret in the unit
    expect(unit.replace(/@ORION_ENV@/g, '')).not.toMatch(/@[A-Z_]+@/);
    expect(unit).not.toMatch(/DATABASE_URL|WEBHOOK|API_KEY/);
  });

  it('provisionFiles: watcher-requirements.txt equals tools/disclosure-watcher/requirements.txt', () => {
    const reqs = readFileSync(join(FILES, 'watcher-requirements.txt'), 'utf8');
    // every requirement pinned exactly (the venv is reproducible)
    const pkgs = reqs.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
    expect(pkgs.length).toBeGreaterThan(0);
    for (const p of pkgs) expect(p).toMatch(/^[A-Za-z0-9._-]+==[0-9][A-Za-z0-9.]*$/);
    expect(pkgs.map((p) => p.split('==')[0]!.toLowerCase()).sort()).toEqual(['faster-whisper', 'numpy', 'pyyaml', 'yt-dlp']);
    // The watcher's real pins (R-c18): this copy is byte-identical to the one beside the watcher
    expect(existsSync(WATCHER_REQS)).toBe(true);
    expect(reqs).toBe(readFileSync(WATCHER_REQS, 'utf8'));
  });

  it('provisionFiles: github-known-hosts pins the three published github.com host keys (R-c12)', () => {
    const text = readFileSync(join(FILES, 'github-known-hosts'), 'utf8');
    const keys = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    expect(keys).toEqual([
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
      'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
      'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
    ]);
    expect(text).toMatch(/^# .*api\.github\.com\/meta.*verified 2026-11-04/m);
  });
});
