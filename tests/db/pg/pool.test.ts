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

const at = '2026-10-28T00:00:00.000Z';
const addCoverage = (h: PgDb, asset: string) =>
  h.run("INSERT INTO coverage (asset_id, persona, assigned_at) VALUES ($1, 'p', $2)", [asset, at]);
const assets = async (h: PgDb) =>
  (await h.all<{ asset_id: string }>('SELECT asset_id FROM coverage ORDER BY asset_id')).map((r) => r.asset_id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('pool', () => {
  it('pool: tx commits, rolls back, nested savepoint; the tx handle sees its own writes', async () => {
    await db.run('DELETE FROM coverage');
    const seen = await db.tx(async (t) => {
      await addCoverage(t, 'a');
      return assets(t);
    });
    expect(seen).toEqual(['a']);
    expect(await assets(db)).toEqual(['a']);

    const boom = new Error('boom');
    await expect(
      db.tx(async (t) => {
        await addCoverage(t, 'b');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await assets(db)).toEqual(['a']);

    await db.tx(async (t) => {
      await addCoverage(t, 'c');
      await expect(
        t.tx(async (t2) => {
          await addCoverage(t2, 'd');
          expect(await assets(t2)).toEqual(['a', 'c', 'd']);
          throw boom;
        }),
      ).rejects.toBe(boom);
      await t.tx(async (t2) => addCoverage(t2, 'e'));
      expect(await assets(t)).toEqual(['a', 'c', 'e']);
    });
    expect(await assets(db)).toEqual(['a', 'c', 'e']);

    // a SQL error inside the transaction rolls it back and leaves the pool usable
    await expect(db.tx(async (t) => t.run('SELECT * FROM no_such_table'))).rejects.toThrow(/no_such_table/);
    expect(await assets(db)).toEqual(['a', 'c', 'e']);
  });

  it('pool: run returns RETURNING rows and rowCount', async () => {
    const ins = await db.run<{ id: number }>(
      "INSERT INTO fetch_runs (asset_id, started_at, ended_at, outcome, detail_json) VALUES ('x', $1, $1, 'ok', '{}') RETURNING id",
      [at],
    );
    expect(ins.rowCount).toBe(1);
    expect(typeof ins.rows[0]?.id).toBe('number');
    const none = await db.run("UPDATE fetch_runs SET outcome = 'failed' WHERE asset_id = 'nobody'");
    expect(none).toEqual({ rowCount: 0, rows: [] });
  });

  it('pool: lockAsset serialises two pools\' transactions on one asset, not on two assets', async () => {
    const other = await openPgDb(config);
    try {
      const events: string[] = [];
      let releaseA!: () => void;
      const holdA = new Promise<void>((r) => (releaseA = r));
      let aLocked!: () => void;
      const aIn = new Promise<void>((r) => (aLocked = r));
      const a = db.tx(
        async () => {
          events.push('a:in');
          aLocked();
          await holdA;
          events.push('a:out');
        },
        { lockAsset: 'one' },
      );
      await aIn;
      // another asset proceeds while A holds 'one'
      await other.tx(async () => void events.push('two:in'), { lockAsset: 'two' });
      // the same asset waits for A
      const b = other.tx(async () => void events.push('b:in'), { lockAsset: 'one' });
      await sleep(400);
      expect(events).toEqual(['a:in', 'two:in']);
      releaseA();
      await a;
      await b;
      expect(events).toEqual(['a:in', 'two:in', 'a:out', 'b:in']);
    } finally {
      await other.close();
    }
  });

  it('pool: a nested tx can take its asset lock again (re-entrant)', async () => {
    const r = await db.tx(async (t) => t.tx(async (t2) => (await t2.one<{ n: number }>('SELECT 1::bigint AS n'))?.n, { lockAsset: 'one' }), {
      lockAsset: 'one',
    });
    expect(r).toBe(1);
  });

  it('pool: a tx handle refuses queries after its transaction ended', async () => {
    let leaked: PgDb | undefined;
    await db.tx(async (t) => {
      leaked = t;
    });
    await expect(leaked!.one('SELECT 1')).rejects.toThrow(/transaction has ended/);
  });

  it('guard: a pool query inside tx rejects db_pool_timeout', async () => {
    const small = await openPgDb(config, { max: 1, connectionTimeoutMillis: 2000 });
    try {
      const started = Date.now();
      await expect(small.tx(async () => small.one('SELECT 1'))).rejects.toMatchObject({
        name: 'OrionError',
        code: 'db_pool_timeout',
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      // the transaction rolled back and the pool works again
      expect((await small.one<{ n: number }>('SELECT 1::bigint AS n'))?.n).toBe(1);
    } finally {
      await small.close();
    }
  });

  it('pool: opening names the database and schema, never the URL', async () => {
    await expect(openPgDb({ url: config.url, schema: 'Bad-Schema' })).rejects.toMatchObject({ code: 'invalid_db_schema' });
    const url = config.url.replace(/orion_test/, 'orion_no_such_db');
    const err = await openPgDb({ url, schema: 'public' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'db_connect_failed' });
    expect(String((err as Error).message)).toContain('orion_no_such_db');
    expect(String((err as Error).message)).not.toContain(url);
  });
});
