import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Postgres returns SUM and AVG over bigint/integer columns as `numeric`, which the pool's parsers leave as a string
// (only int8 becomes a Number: tests/db/pg/parsers.test.ts). Code that reads an aggregate as a number must cast it in
// the SQL (`::float8`, `::bigint`, `::int`). COUNT is int8, so it needs no cast.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGGREGATE = /\b(SUM|AVG)\(/gi; // no space before the paren: prose like "their sum (a ...)" is not SQL
const CAST = /^\s*::\s*(float8|double precision|bigint|int8|int|integer|int4)\b/i;

/** The text from `open` (an index just past an opening paren) to just past its matching close. */
function closeOf(text: string, open: number): number {
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

describe('aggregate guard', () => {
  it('every SUM/AVG in src is cast to a number type in the SQL', () => {
    const files = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(root, 'src', f), 'utf8');
      for (const m of text.matchAll(AGGREGATE)) {
        const end = closeOf(text, m.index! + m[0].length);
        if (!CAST.test(text.slice(end))) bad.push(`src/${f}:${text.slice(0, m.index).split('\n').length}: ${text.slice(m.index, end)}`);
      }
    }
    expect(bad, `aggregates without a cast:\n${bad.join('\n')}`).toEqual([]);
  });

  it('the guard catches an uncast aggregate and passes a cast one', () => {
    const uncast = 'SELECT sum(value) AS s FROM observations';
    const m = [...uncast.matchAll(AGGREGATE)][0]!;
    expect(CAST.test(uncast.slice(closeOf(uncast, m.index! + m[0].length)))).toBe(false);
    const cast = 'SELECT SUM(coalesce(value, 0))::float8 AS s FROM observations';
    const c = [...cast.matchAll(AGGREGATE)][0]!;
    expect(CAST.test(cast.slice(closeOf(cast, c.index! + c[0].length)))).toBe(true);
  });
});
