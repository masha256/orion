import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The type-aware check behind tests/meta/awaits.test.ts's line scan: oxlint's no-floating-promises over src, tests and
// tools, on the project's tsconfig (via tsgolint, which runs on TypeScript 7). It takes about a second; run it alone
// with `npm run lint:promises`. A promise that is neither awaited, returned, chained with a rejection handler nor
// explicitly `void`ed fails it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('floating promises', () => {
  it('no promise in src, tests or tools floats (type-aware)', () => {
    let out = '';
    let code = 0;
    try {
      out = execFileSync('npm', ['run', '--silent', 'lint:promises'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      code = e.status;
      out = `${e.stdout}\n${e.stderr}`;
    }
    expect(code, out).toBe(0); // a finding prints `file:line:col: error typescript(no-floating-promises): ...` and exits 1
  }, 60_000);
});
