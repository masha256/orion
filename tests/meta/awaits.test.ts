import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every async db-layer function must be awaited (or its promise handed on) wherever it is called: a floating promise
// would run outside the caller's transaction and lose its errors. The check is per line, so a call that is awaited on
// an earlier line of a multi-line expression must be reflowed to keep the `await` on the call's line.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function tsFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

function asyncDbFunctions(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(join(root, 'src/db')).filter((n) => n.endsWith('.ts'))) {
    for (const m of readFileSync(join(root, 'src/db', f), 'utf8').matchAll(/export async function (\w+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

const HANDED_ON = ['await ', 'return ', 'Promise.all', '.then('];

describe('await guard', () => {
  it('every call of an async db function is awaited, returned or chained', () => {
    const names = asyncDbFunctions();
    expect(names).toContain('insertObservation');
    const call = new RegExp(`(?<![\\w$.])(${names.join('|')})\\(`);
    const definition = new RegExp(`function (${names.join('|')})\\(`);
    const bad: string[] = [];
    for (const file of [...tsFiles('src'), ...tsFiles('tests')]) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!call.test(line)) return;
        if (definition.test(line)) return;
        if (HANDED_ON.some((h) => line.includes(h))) return;
        bad.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, `calls not awaited:\n${bad.join('\n')}`).toEqual([]);
  });
});
