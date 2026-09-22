import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockHolder, withRunLock } from '../../src/app/lock.js';
import { getAgentRun, startAgentRun } from '../../src/db/agentRuns.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { getRunLock, LOCK_TTL_MS } from '../../src/db/runLocks.js';

const T0 = new Date('2026-09-21T00:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

let A: Db;
let B: Db;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'orion-lock-'));
  A = openDb(join(dir, 'orion.db'));
  B = openDb(join(dir, 'orion.db'));
});
afterEach(() => {
  A.close();
  B.close();
});

describe('withRunLock', () => {
  it('holds the lock while the body runs and releases it after, returning the body\'s value', async () => {
    const value = await withRunLock(A, 'mini', 'tick pid 1', T0, async () => {
      expect(getRunLock(B, 'mini')!.holder).toBe('tick pid 1');
      await expect(withRunLock(B, 'mini', 'agent run pid 2', later(1), async () => 'never')).rejects.toMatchObject({ code: 'run_in_progress' });
      return 42;
    });
    expect(value).toBe(42);
    expect(getRunLock(B, 'mini')).toBeNull();
  });

  it('releases the lock when the body throws, and rethrows', async () => {
    await expect(withRunLock(A, 'mini', 'tick pid 1', T0, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(getRunLock(A, 'mini')).toBeNull();
  });

  it('takes over an expired lock, abandons the stuck run, and tells the caller', async () => {
    const stuck = startAgentRun(A, { assetId: 'mini', persona: 'p', runType: 'deep', trigger: 'schedule', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: T0.toISOString() });
    let abandoned = 0;
    await withRunLock(A, 'mini', 'tick pid 1', T0, async () => {
      // The holder dies here: never releases. The next tick arrives after the TTL.
      await withRunLock(B, 'mini', 'tick pid 2', later(LOCK_TTL_MS), async () => undefined, { onTakeover: (n) => (abandoned = n) });
    });
    expect(abandoned).toBe(1);
    expect(getAgentRun(A, stuck)).toMatchObject({ outcome: 'error', error: 'abandoned' });
    expect(getRunLock(A, 'mini')).toBeNull(); // pid 2 released its own; pid 1's release found nothing of its own
  });

  it('a release that throws never masks the body\'s outcome, and is reported', async () => {
    // Proxy that fails DELETE statements for run_locks
    const failingDb = new Proxy(A, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop !== 'prepare') return typeof v === 'function' ? v.bind(target) : v;
        return (sql: string) => {
          if (sql.startsWith('DELETE FROM run_locks')) throw new Error('simulated: database is locked');
          return target.prepare(sql);
        };
      },
    }) as Db;

    // Body returns 42; release throws
    const value = await withRunLock(failingDb, 'mini', 'tick pid 1', T0, async () => 42, {
      onReleaseError: (err) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('simulated');
      },
    });
    expect(value).toBe(42);
    expect(getRunLock(B, 'mini')!.holder).toBe('tick pid 1'); // the row leaked

    // Body throws 'boom'; release also throws (use a different asset to avoid run_in_progress)
    await expect(
      withRunLock(failingDb, 'other', 'agent pid 2', T0, async () => { throw new Error('boom'); }, {
        onReleaseError: () => { /* no-op */ },
      }),
    ).rejects.toThrow('boom'); // the real error, not the release error
  });

  it('names the command and the pid in the holder', () => {
    expect(lockHolder('tick')).toBe(`tick pid ${process.pid}`);
  });
});
