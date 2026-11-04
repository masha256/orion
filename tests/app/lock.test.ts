import { beforeEach, describe, expect, it } from 'vitest';
import { lockHolder, withRunLock } from '../../src/app/lock.js';
import { getAgentRun, startAgentRun } from '../../src/db/agentRuns.js';
import { openDb, type OrionDb } from '../../src/db/connection.js';
import { testDatabaseConfig, testDbPair } from '../helpers/db.js';

const T0 = new Date('2026-09-21T00:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const pair = testDbPair();
let A: OrionDb;
let B: OrionDb;
beforeEach(() => {
  [A, B] = pair();
});

const startRun = async (db: OrionDb, assetId = 'mini') =>
  await startAgentRun(db, { assetId, persona: 'p', runType: 'deep', trigger: 'schedule', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: T0.toISOString() });

describe('withRunLock', () => {
  it('holds the lock while the body runs and releases it after, returning the body\'s value', async () => {
    const value = await withRunLock(A, 'mini', 'tick pid 1', T0, async () => {
      expect((await B.assetRunLockHolder('mini'))!.holder).toBe('tick pid 1');
      expect(await B.assetRunLockHolder('other')).toBeNull();
      return 42;
    });
    expect(value).toBe(42);
    expect(await B.assetRunLockHolder('mini')).toBeNull();
  });

  it('lock: a second holder gets run_in_progress naming the holder and since', async () => {
    let ran = false;
    await withRunLock(A, 'mini', 'tick pid 1', T0, async () => {
      const held = (await B.assetRunLockHolder('mini'))!;
      expect(held.since).toMatch(ISO);
      const err = await withRunLock(B, 'mini', 'agent run pid 2', later(1), async () => { ran = true; }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'run_in_progress', message: `asset mini is locked by tick pid 1 since ${held.since}` });
      // the holder's own handle is refused too: the lock belongs to its dedicated connection, not to the process
      await expect(withRunLock(A, 'mini', 'tick pid 1', later(2), async () => { ran = true; })).rejects.toMatchObject({ code: 'run_in_progress' });
    });
    expect(ran).toBe(false);
  });

  it('releases the lock when the body throws, and rethrows', async () => {
    await expect(withRunLock(A, 'mini', 'tick pid 1', T0, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await A.assetRunLockHolder('mini')).toBeNull();
  });

  it('lock: after the holder\'s handle closes, the next acquire succeeds and abandons the asset\'s running agent runs (onTakeover 1)', async () => {
    const stuck = await startRun(A);
    const other = await startRun(A, 'other');
    // The holder: its own handle takes the lock and goes away without releasing it, as a killed process does.
    const dying = await openDb(testDatabaseConfig());
    expect(await dying.tryAssetRunLock('mini', 'tick pid 1')).not.toBeNull();
    await expect(withRunLock(B, 'mini', 'tick pid 2', later(1), async () => undefined)).rejects.toMatchObject({ code: 'run_in_progress' });
    expect(await getAgentRun(A, stuck)).toMatchObject({ outcome: 'running' }); // a refused acquire marks nothing
    await dying.close();
    const takeovers: number[] = [];
    let holderDuring: string | null = null;
    await withRunLock(B, 'mini', 'tick pid 2', later(5), async () => {
      holderDuring = (await A.assetRunLockHolder('mini'))?.holder ?? null;
    }, { onTakeover: (n) => takeovers.push(n) });
    expect(takeovers).toEqual([1]);
    expect(holderDuring).toBe('tick pid 2');
    expect(await getAgentRun(A, stuck)).toMatchObject({ outcome: 'error', error: 'abandoned', endedAt: later(5).toISOString() });
    expect(await getAgentRun(A, other)).toMatchObject({ outcome: 'running' }); // another asset's run is not this lock's
    // with no orphan left, onTakeover is not called
    await withRunLock(B, 'mini', 'tick pid 3', later(6), async () => undefined, { onTakeover: (n) => takeovers.push(n) });
    expect(takeovers).toEqual([1]);
  });

  it('lock: a release that throws never masks the body', async () => {
    // A handle whose run lock fails to release (as when the unlock query errors on a live connection).
    const failingRelease = (db: OrionDb): OrionDb =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === 'tryAssetRunLock') {
            return async (assetId: string, holder: string) => {
              const lock = await target.tryAssetRunLock(assetId, holder);
              return lock && {
                ping: () => lock.ping(),
                release: async () => {
                  await lock.release();
                  throw new Error('simulated: the unlock failed');
                },
              };
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    const errors: string[] = [];
    const value = await withRunLock(failingRelease(A), 'mini', 'tick pid 1', T0, async () => 42, {
      onReleaseError: (err) => errors.push((err as Error).message),
    });
    expect(value).toBe(42);
    expect(errors).toEqual(['simulated: the unlock failed']);

    await expect(
      withRunLock(failingRelease(A), 'mini', 'agent run pid 2', T0, async () => { throw new Error('boom'); }, { onReleaseError: (err) => errors.push((err as Error).message) }),
    ).rejects.toThrow('boom'); // the body's error, not the release's
    expect(errors).toHaveLength(2);
    // without a callback the release error is dropped, and the body's value still comes back
    await expect(withRunLock(failingRelease(A), 'mini', 'tick pid 3', T0, async () => 'ok')).resolves.toBe('ok');
  });

  it('names the command and the pid in the holder', () => {
    expect(lockHolder('tick')).toBe(`tick pid ${process.pid}`);
  });
});
