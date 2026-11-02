import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type OrionDb } from '../../src/db/connection.js';
import { OrionError } from '../../src/types.js';

const opened: OrionDb[] = [];
function open(opts?: { txWaitMs?: number }): OrionDb {
  const db = openDb(':memory:', opts);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  opened.push(db);
  return db;
}
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const count = async (db: OrionDb): Promise<number> => (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM t'))!.n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sqlite compat Db', () => {
  it('compat: $n placeholders bind by number, repeat, and skip quoted text', async () => {
    const db = open();
    const row = await db.one("SELECT $2 AS b, $1 AS a, $1 AS a2, '$1' AS lit", ['x', 'y']);
    expect(row).toEqual({ b: 'y', a: 'x', a2: 'x', lit: '$1' });
    expect(await db.all('SELECT $1 AS a', ['z'])).toEqual([{ a: 'z' }]);
    expect(await db.one('SELECT v FROM t WHERE id = $1', [99])).toBeUndefined();
  });

  it('compat: run returns RETURNING rows and rowCount', async () => {
    const db = open();
    const ins = await db.run<{ id: number }>('INSERT INTO t (v) VALUES ($1) RETURNING id', ['a']);
    expect(ins.rows[0]!.id).toBe(1);
    expect(ins.rowCount).toBe(1);
    const none = await db.run('UPDATE t SET v = $1 WHERE id = $2', ['b', 42]);
    expect(none).toEqual({ rowCount: 0, rows: [] });
    const one = await db.run('UPDATE t SET v = $1 WHERE id = $2', ['b', 1]);
    expect(one).toEqual({ rowCount: 1, rows: [] });
  });

  it('compat: tx commits, rolls back on throw, nested tx is a savepoint', async () => {
    const db = open();
    const boom = new Error('boom');
    const got = await db.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES ($1)', ['outer']);
      await expect(
        t.tx(async (n) => {
          await n.run('INSERT INTO t (v) VALUES ($1)', ['inner']);
          throw boom;
        }),
      ).rejects.toBe(boom);
      await t.tx(async (n) => n.run('INSERT INTO t (v) VALUES ($1)', ['inner2']), { lockAsset: 'hype' });
      return 'ok';
    });
    expect(got).toBe('ok');
    expect((await db.all<{ v: string }>('SELECT v FROM t ORDER BY id')).map((r) => r.v)).toEqual(['outer', 'inner2']);

    await expect(
      db.tx(async (t) => {
        await t.run('INSERT INTO t (v) VALUES ($1)', ['doomed']);
        await t.tx(async (n) => n.run('INSERT INTO t (v) VALUES ($1)', ['doomed inner']));
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await count(db)).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it('compat: legacy prepare inside an async tx joins it', async () => {
    const db = open();
    await expect(
      db.tx(async (t) => {
        t.prepare('INSERT INTO t (v) VALUES (?)').run('legacy');
        expect((await t.one<{ n: number }>('SELECT COUNT(*) AS n FROM t'))!.n).toBe(1);
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await count(db)).toBe(0);
  });

  it('guard: a root-handle query inside tx rejects db_pool_timeout', async () => {
    const db = open({ txWaitMs: 100 });
    const err = await db.tx(async () => db.one('select 1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrionError);
    expect((err as OrionError).code).toBe('db_pool_timeout');
    expect((err as OrionError).message).toBe('waited 100 ms for a connection: inside db.tx, query through the tx handle');
    expect(db.inTransaction).toBe(false);
    expect(await db.one('select 1 AS one')).toEqual({ one: 1 });
  });

  it('guard: a root-handle query from another chain waits and then runs', async () => {
    const db = open({ txWaitMs: 2000 });
    const order: string[] = [];
    const writer = db.tx(async (t) => {
      await t.run('INSERT INTO t (v) VALUES ($1)', ['w']);
      await sleep(50);
      order.push('commit');
    });
    const reader = db.one<{ n: number }>('SELECT COUNT(*) AS n FROM t').then((r) => {
      order.push('read');
      return r!.n;
    });
    await writer;
    expect(await reader).toBe(1);
    expect(order).toEqual(['commit', 'read']);
  });
});
