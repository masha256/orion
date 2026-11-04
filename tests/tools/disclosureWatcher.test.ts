import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WATCHER = join(ROOT, 'tools', 'disclosure-watcher');
/** Phase 1 Task 0 Step 6: 110 tests; plus the 7 cases of test_platform.py (Phase 1.5c Task 11) and the 3 of
 * test_stage_dry_state.py (fix wave 2). */
const EXPECTED_TESTS = 120;

/**
 * The watcher's Python: `ORION_WATCHER_PYTHON`, else `python3` when it can import yaml. Neither: the test fails
 * loudly (never skips), naming the variable.
 */
function watcherPython(): string {
  const set = process.env.ORION_WATCHER_PYTHON?.trim();
  if (set) return set;
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`ORION_WATCHER_PYTHON is unset and python3 cannot import yaml (${(probe.stderr || String(probe.error)).trim()}): set ORION_WATCHER_PYTHON to a Python with PyYAML`);
  }
  return 'python3';
}

describe('disclosure watcher (tools/disclosure-watcher)', () => {
  it('watcher unit tests pass in the repo copy', () => {
    const python = watcherPython();
    const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests'], {
      cwd: WATCHER, encoding: 'utf8', timeout: 120_000,
      // No __pycache__ in the tree; no ORION_DW_* of the caller's shell (the tests set their own).
      env: Object.fromEntries(Object.entries({ ...process.env, PYTHONDONTWRITEBYTECODE: '1' }).filter(([k]) => !k.startsWith('ORION_DW_') && k !== 'ORION_NODE')),
    });
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-30).join('\n');
    expect(r.status, tail).toBe(0);
    expect(r.stderr, tail).toMatch(new RegExp(`^Ran ${EXPECTED_TESTS} tests in `, 'm'));
    expect(r.stderr, tail).toMatch(/^OK$/m);
  }, 150_000);

  it('the watcher requirements are pinned, numpy included', () => {
    const pkgs = readFileSync(join(WATCHER, 'requirements.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
    expect(pkgs.map((p) => p.split('==')[0]!.toLowerCase()).sort()).toEqual(['faster-whisper', 'numpy', 'pyyaml', 'yt-dlp']);
    for (const p of pkgs) expect(p).toMatch(/^[A-Za-z0-9._-]+==[0-9][A-Za-z0-9.]*$/);
  });
});
