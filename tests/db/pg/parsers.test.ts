import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../../../src/db/connection.js';
import { openPgDb, type PgDb } from '../../../src/db/pg/pool.js';
import { createTestSchema, dropTestSchema } from '../../setup/pgGlobal.js';

let config: DatabaseConfig;
let db: PgDb;

beforeAll(async () => {
  config = await createTestSchema();
  db = await openPgDb(config);
});
afterAll(async () => {
  await db?.close();
  if (config) await dropTestSchema(config);
});

describe('parsers', () => {
  it('parsers: timestamptz reads back the exact ISO string, whatever the session time zone', async () => {
    const iso = '2026-10-28T12:34:56.789Z';
    const utc = await db.one<{ t: string }>('SELECT $1::timestamptz AS t', [iso]);
    expect(utc?.t).toBe(iso);
    const la = await db.tx(async (t) => {
      await t.run("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      const zone = await t.one<{ z: string }>('SHOW TIME ZONE');
      expect(Object.values(zone ?? {})[0]).toBe('America/Los_Angeles');
      return t.one<{ t: string; raw: string }>('SELECT $1::timestamptz AS t, $1::timestamptz::text AS raw', [iso]);
    });
    expect(la?.raw).toBe('2026-10-28 05:34:56.789-07');
    expect(la?.t).toBe(iso);
    // and from a column
    await db.run(
      "INSERT INTO fetch_cursors (asset_id, scan_key, last_block, last_day, updated_at) VALUES ('a', 'k', 1, '2026-10-28', $1)",
      [iso],
    );
    expect((await db.one<{ updated_at: string }>('SELECT updated_at FROM fetch_cursors'))?.updated_at).toBe(iso);
  });

  it('parsers: date is the raw string; json keeps spacing, key order and duplicates', async () => {
    const raw = '{"b":1, "a":2,"a":3}';
    const row = await db.one<{ d: unknown; j: unknown }>("SELECT '2026-10-28'::date AS d, $1::json AS j", [raw]);
    expect(row?.d).toBe('2026-10-28');
    expect(row?.j).toBe(raw);
    expect((await db.one<{ last_day: unknown }>('SELECT last_day FROM fetch_cursors'))?.last_day).toBe('2026-10-28');
  });

  it('parsers: int8 is a Number and throws above 2^53', async () => {
    const ok = await db.one<{ n: unknown; c: unknown }>("SELECT $1::bigint AS n, count(*) AS c FROM (VALUES (1), (2)) v(x)", [
      '9007199254740991',
    ]);
    expect(ok?.n).toBe(9007199254740991);
    expect(ok?.c).toBe(2);
    await expect(db.one('SELECT $1::bigint AS n', ['9007199254740993'])).rejects.toThrow(/2\^53/);
    await expect(db.one('SELECT $1::bigint AS n', ['-9007199254740993'])).rejects.toThrow(/2\^53/);
    // the connection is still usable after a parser refusal
    expect((await db.one<{ one: number }>('SELECT 1::bigint AS one'))?.one).toBe(1);
  });

  it('parsers: doubles round-trip exactly', async () => {
    for (const v of [0.1, 5e-324, 1.7976931348623157e308, 123456789.123456789, -0]) {
      const row = await db.one<{ v: number }>('SELECT $1::double precision AS v', [v]);
      expect(Object.is(row?.v, v), `${v} came back as ${row?.v}`).toBe(true);
    }
  });

  it('parsers: are set on the pool, not on the global pg.types', async () => {
    const pg = (await import('pg')).default;
    expect(pg.types.getTypeParser(20, 'text')('9007199254740993')).toBe('9007199254740993');
    expect(pg.types.getTypeParser(1082, 'text')('2026-10-28')).toBeInstanceOf(Date);
  });
});

describe('collation', () => {
  it('collation: ORDER BY on text is byte order', async () => {
    for (const a of ['b', 'B', 'a', '_']) {
      await db.run("INSERT INTO coverage (asset_id, persona, assigned_at) VALUES ($1, 'p', '2026-10-28T00:00:00.000Z')", [a]);
    }
    const rows = await db.all<{ asset_id: string }>('SELECT asset_id FROM coverage ORDER BY asset_id');
    expect(rows.map((r) => r.asset_id)).toEqual(['B', '_', 'a', 'b']);
  });
});
