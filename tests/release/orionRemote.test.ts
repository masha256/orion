import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROD_LOAD_DUMP, UPLOADED_DUMP } from '../../src/daemon/jobs/stagingRefresh.js';
import { JOB_KINDS } from '../../src/db/jobs.js';
import { SOURCE_TYPES } from '../../src/db/purge.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REMOTE = join(ROOT, 'scripts', 'provision', 'files', 'orion-remote');
const TESTS = join(ROOT, 'scripts', 'provision', 'test');
/** The interpreter orion-remote's shebang names (Ubuntu's); ORION_REMOTE_PYTHON overrides. */
const PYTHON = process.env.ORION_REMOTE_PYTHON ?? '/usr/bin/python3';

describe('orion-remote', () => {
  it('orion-remote: the Python unit tests pass (injection, install, switch, rollback, verbs)', () => {
    const r = spawnSync(PYTHON, ['-B', '-m', 'unittest', 'discover', '-s', TESTS, '-p', 'test_orion_remote.py'], {
      encoding: 'utf8', timeout: 240_000, env: {
        PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/nonexistent', TMPDIR: process.env.TMPDIR ?? '/tmp',
        // the C-1 reproduction runs the real psql against the test database
        ...(process.env.ORION_TEST_DATABASE_URL ? { ORION_TEST_DATABASE_URL: process.env.ORION_TEST_DATABASE_URL } : {}),
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.stderr).toMatch(/\nOK\n?$/);
    expect(r.status).toBe(0);
  }, 300_000);

  it('orion-remote: compiles; its job kinds are JOB_KINDS and its rungs SOURCE_TYPES', () => {
    execFileSync(PYTHON, ['-B', '-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', REMOTE]); // py_compile, writing nothing
    const src = readFileSync(REMOTE, 'utf8');
    expect(src.startsWith('#!/usr/bin/python3 -I\n')).toBe(true);
    const m = /^JOB_KINDS = \(([^)]*)\)$/m.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '')).toEqual([...JOB_KINDS]);
    // data purge --source-type: the rungs are purge's SOURCE_TYPES, same order (M-3; the tuple spans lines).
    const r = /^RUNGS = \(([^)]*)\)$/m.exec(src);
    expect(r).not.toBeNull();
    expect(r![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '')).toEqual([...SOURCE_TYPES]);
    // refresh-staging --stdin writes the dump where the daemon's staging_refresh job looks for an upload (ORION_HOME = ~/home).
    const u = /^UPLOADED_DUMP = \(([^)]*)\)/m.exec(src);
    expect(u).not.toBeNull();
    expect(u![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '')).toEqual(['home', ...UPLOADED_DUMP.split('/')]);
    // load-prod --stdin writes prod's initial-load dump where the job looks for it on prod.
    const p = /^PROD_LOAD_DUMP = \(([^)]*)\)/m.exec(src);
    expect(p).not.toBeNull();
    expect(p![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '')).toEqual(['home', ...PROD_LOAD_DUMP.split('/')]);
  });
});
