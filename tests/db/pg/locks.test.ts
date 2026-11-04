import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetLockKey, type DatabaseConfig } from '../../../src/db/connection.js';
import { openPgDb, type PgDb } from '../../../src/db/pg/pool.js';
import { createTestSchema, dropTestSchema } from '../../setup/pgGlobal.js';

let config: DatabaseConfig;
let db: PgDb;
let other: PgDb;

beforeAll(async () => {
  config = await createTestSchema();
  db = await openPgDb(config);
  other = await openPgDb(config);
});
afterAll(async () => {
  await db?.close();
  await other?.close();
  if (config) await dropTestSchema(config);
});

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe('assetLockKey', () => {
  it('locks: the key is the first 8 bytes of sha256(orion:<schema>:<space>:<id>) as a signed int64, one key per space and schema', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('orion:orion:run:aero').digest().readBigInt64BE(0).toString();
    expect(assetLockKey('run', 'aero', 'orion')).toBe(expected);
    expect(assetLockKey('asset', 'aero', 'orion')).not.toBe(assetLockKey('run', 'aero', 'orion'));
    expect(assetLockKey('run', 'aero', 'orion')).not.toBe(assetLockKey('run', 'aero', 'staging'));
    expect(assetLockKey('asset', 'aero', 'orion')).toMatch(/^-?\d+$/);
    expect(BigInt(assetLockKey('asset', 'aero', 'orion'))).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(BigInt(assetLockKey('asset', 'aero', 'orion'))).toBeLessThan(2n ** 63n);
  });
});

describe('locks', () => {
  it('locks: tryAssetRunLock gives one holder, names it, and frees it on release or when the holder\'s handle closes', async () => {
    expect(await other.assetRunLockHolder('aero')).toBeNull();
    const lock = await db.tryAssetRunLock('aero', 'tick pid 101');
    expect(lock).not.toBeNull();
    expect(await other.tryAssetRunLock('aero', 'agent run pid 202')).toBeNull();
    const holder = await other.assetRunLockHolder('aero');
    expect(holder?.holder).toBe('tick pid 101');
    expect(holder?.since).toMatch(ISO);
    // another asset is free
    const cake = await other.tryAssetRunLock('cake', 'agent run pid 202');
    expect(cake).not.toBeNull();
    expect((await db.assetRunLockHolder('cake'))?.holder).toBe('agent run pid 202');
    await cake!.release();

    await lock!.release();
    await lock!.release(); // idempotent
    expect(await other.assetRunLockHolder('aero')).toBeNull();
    const again = await other.tryAssetRunLock('aero', 'agent run pid 202');
    expect(again).not.toBeNull();
    await again!.release();

    // the holder's process is gone (its backend is killed): the lock frees at once
    const killed = await db.tryAssetRunLock('aero', 'tick pid 303');
    const pid = (
      await other.one<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = 'tick pid 303'")
    )?.pid;
    expect(pid).toBeTypeOf('number');
    await other.run('SELECT pg_terminate_backend($1)', [pid!]);
    for (let i = 0; i < 50 && (await other.assetRunLockHolder('aero')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await other.assetRunLockHolder('aero')).toBeNull();
    await killed!.release(); // releasing a dead lock does not throw

    // closing the database that holds the lock frees it
    const third = await openPgDb(config);
    expect(await third.tryAssetRunLock('aero', 'tick pid 404')).not.toBeNull();
    await third.close();
    const after = await other.tryAssetRunLock('aero', 'agent run pid 505');
    expect(after).not.toBeNull();
    await after!.release();
  });

  it('locks: ping runs SELECT 1 on the lock\'s own connection and throws lock_lost once its backend is gone', async () => {
    const lock = await db.tryAssetRunLock('aero', 'tick pid 1001');
    await lock!.ping();
    const pid = (await other.one<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = 'tick pid 1001'"))?.pid;
    await other.run('SELECT pg_terminate_backend($1)', [pid!]);
    for (let i = 0; i < 50 && (await other.assetRunLockHolder('aero')); i++) await new Promise((r) => setTimeout(r, 50));
    await expect(lock!.ping()).rejects.toMatchObject({ code: 'lock_lost' });
    await lock!.release();
    // A released lock is not live either.
    const again = await db.tryAssetRunLock('aero', 'tick pid 1002');
    await again!.release();
    await expect(again!.ping()).rejects.toMatchObject({ code: 'lock_lost' });
  });

  it('locks: the same asset in another schema of the database has its own run lock and transaction lock', async () => {
    const elsewhere = await createTestSchema({ migrate: false });
    const there = await openPgDb(elsewhere);
    try {
      const here = await db.tryAssetRunLock('aero', 'tick pid 808');
      expect(here).not.toBeNull();
      expect(await there.assetRunLockHolder('aero')).toBeNull();
      const theirs = await there.tryAssetRunLock('aero', 'tick pid 909');
      expect(theirs).not.toBeNull();
      // and a transaction lock held here does not block one there
      await db.tx(async () => {
        await there.tx(async () => undefined, { lockAsset: 'aero' });
      }, { lockAsset: 'aero' });
      await theirs!.release();
      await here!.release();
    } finally {
      await there.close();
      await dropTestSchema(elsewhere);
    }
  });

  it('locks: the run lock and a write transaction on the same asset do not block each other', async () => {
    const lock = await db.tryAssetRunLock('aero', 'tick pid 606');
    expect(lock).not.toBeNull();
    try {
      // the holder's own pool writes under the asset's transaction lock while it holds the run lock
      const n = await db.tx(
        async (t) => {
          await t.run("INSERT INTO coverage (asset_id, persona, assigned_at) VALUES ('aero', 'p', '2026-10-28T00:00:00.000Z')");
          return (await t.one<{ n: number }>("SELECT count(*) AS n FROM coverage WHERE asset_id = 'aero'"))?.n;
        },
        { lockAsset: 'aero' },
      );
      expect(n).toBe(1);
      // and while a transaction holds the asset's transaction lock, the run lock is still free to take elsewhere
      await db.tx(
        async () => {
          expect(await other.assetRunLockHolder('aero')).toMatchObject({ holder: 'tick pid 606' });
          await lock!.release();
          const second = await other.tryAssetRunLock('aero', 'agent run pid 707');
          expect(second).not.toBeNull();
          await second!.release();
        },
        { lockAsset: 'aero' },
      );
    } finally {
      await lock!.release();
    }
  });
});
