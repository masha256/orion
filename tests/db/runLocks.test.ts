import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishAgentRun, getAgentRun, startAgentRun, ZERO_USAGE } from '../../src/db/agentRuns.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { acquireRunLock, getRunLock, LOCK_TTL_MS, releaseRunLock } from '../../src/db/runLocks.js';
import type { OrionError } from '../../src/types.js';

const T0 = '2026-09-21T00:00:00.000Z';
const later = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

// Two connections to one file: what a scheduled tick and a manual command are.
let A: Db;
let B: Db;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'orion-locks-'));
  A = openDb(join(dir, 'orion.db'));
  B = openDb(join(dir, 'orion.db'));
});
afterEach(() => {
  A.close();
  B.close();
});

const running = (db: Db, startedAt = T0) =>
  startAgentRun(db, { assetId: 'mini', persona: 'analyst', runType: 'weekly', trigger: 'manual', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt });

describe('run locks', () => {
  it('is taken once, refused to a second holder on another connection, and released by its holder', () => {
    expect(acquireRunLock(A, 'mini', 'tick pid 1', T0)).toEqual({ abandoned: 0, tookOver: false });
    expect(getRunLock(B, 'mini')).toEqual({ assetId: 'mini', holder: 'tick pid 1', acquiredAt: T0, expiresAt: later(LOCK_TTL_MS) });
    expect(codeOf(() => acquireRunLock(B, 'mini', 'agent run pid 2', later(60_000)))).toBe('run_in_progress');
    expect(acquireRunLock(B, 'other', 'agent run pid 2', T0)).toEqual({ abandoned: 0, tookOver: false }); // per asset
    expect(releaseRunLock(A, 'mini', 'tick pid 1')).toBe(true);
    expect(getRunLock(B, 'mini')).toBeNull();
    expect(acquireRunLock(B, 'mini', 'agent run pid 2', later(60_000))).toEqual({ abandoned: 0, tookOver: false });
  });

  it('names the holder and the time in the refusal', () => {
    acquireRunLock(A, 'mini', 'tick pid 1', T0);
    expect(() => acquireRunLock(B, 'mini', 'agent run pid 2', later(1))).toThrow('asset mini is locked by tick pid 1 since 2026-09-21T00:00:00.000Z');
  });

  it('takes over an expired lock and abandons every running run of the asset at that moment', () => {
    const stuck = running(A);
    const finished = running(A);
    finishAgentRun(A, finished, { outcome: 'completed', endedAt: later(1000), usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
    acquireRunLock(A, 'mini', 'tick pid 1', T0);
    expect(codeOf(() => acquireRunLock(B, 'mini', 'tick pid 2', later(LOCK_TTL_MS - 1)))).toBe('run_in_progress'); // still live
    expect(acquireRunLock(B, 'mini', 'tick pid 2', later(LOCK_TTL_MS))).toEqual({ abandoned: 1, tookOver: true });
    expect(getRunLock(A, 'mini')).toMatchObject({ holder: 'tick pid 2', acquiredAt: later(LOCK_TTL_MS) });
    expect(getAgentRun(A, stuck)).toMatchObject({ outcome: 'error', error: 'abandoned', endedAt: later(LOCK_TTL_MS) });
    expect(getAgentRun(A, finished)!.outcome).toBe('completed');
  });

  it('does not let a taken-over holder delete the new holder\'s row', () => {
    acquireRunLock(A, 'mini', 'tick pid 1', T0);
    acquireRunLock(B, 'mini', 'tick pid 2', later(LOCK_TTL_MS));
    expect(releaseRunLock(A, 'mini', 'tick pid 1')).toBe(false);
    expect(getRunLock(A, 'mini')!.holder).toBe('tick pid 2');
  });

  it('does not abandon runs when there was no lock to take over', () => {
    const live = running(A);
    expect(acquireRunLock(A, 'mini', 'tick pid 1', T0)).toEqual({ abandoned: 0, tookOver: false });
    expect(getAgentRun(A, live)!.outcome).toBe('running');
  });

  it('takes over an expired lock with no running runs and calls onTakeover with 0', () => {
    acquireRunLock(A, 'mini', 'tick pid 1', T0);
    let called = 0;
    // Simulate what withRunLock does
    const result = acquireRunLock(B, 'mini', 'tick pid 2', later(LOCK_TTL_MS));
    if (result.tookOver) called++;
    expect(called).toBe(1);
    expect(result.abandoned).toBe(0);
    expect(getRunLock(A, 'mini')!.holder).toBe('tick pid 2');
  });
});
