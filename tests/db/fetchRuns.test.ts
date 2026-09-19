import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import { emptySourceOutcome, insertFetchRun, listFetchRuns, recentSourceStatuses, type SourceStatus } from '../../src/db/fetchRuns.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

function run(at: string, sources: [string, SourceStatus][], assetId = 'mini'): number {
  return insertFetchRun(db, {
    assetId, startedAt: at, endedAt: at, outcome: sources.every(([, s]) => s === 'ok') ? 'ok' : 'partial',
    detail: { sources: sources.map(([id, status]) => ({ ...emptySourceOutcome(id), status })) },
  });
}

describe('fetch runs', () => {
  it('round-trips the detail JSON and lists newest first', () => {
    const first = run('2026-09-18T00:00:00.000Z', [['coingecko', 'ok']]);
    const second = insertFetchRun(db, {
      assetId: 'mini', startedAt: '2026-09-19T00:00:00.000Z', endedAt: '2026-09-19T00:00:05.000Z', outcome: 'partial',
      detail: { sources: [{ ...emptySourceOutcome('chain_levels'), status: 'failed', error: 'boom', notes: ['n'] }] },
    });
    const list = listFetchRuns(db, 'mini', 10);
    expect(list.map((r) => r.id)).toEqual([second, first]);
    expect(list[0].outcome).toBe('partial');
    expect(list[0].endedAt).toBe('2026-09-19T00:00:05.000Z');
    expect(list[0].detail.sources[0]).toEqual({ ...emptySourceOutcome('chain_levels'), status: 'failed', error: 'boom', notes: ['n'] });
    expect(listFetchRuns(db, 'mini', 1)).toHaveLength(1);
    expect(listFetchRuns(db, 'other', 10)).toEqual([]);
  });

  it('reports the recent statuses of one source, newest first', () => {
    run('2026-09-16T00:00:00.000Z', [['coingecko', 'ok'], ['chain_levels', 'ok']]);
    run('2026-09-17T00:00:00.000Z', [['coingecko', 'failed'], ['chain_levels', 'ok']]);
    run('2026-09-18T00:00:00.000Z', [['coingecko', 'failed']]);
    expect(recentSourceStatuses(db, 'mini', 'coingecko', 2)).toEqual(['failed', 'failed']);
    expect(recentSourceStatuses(db, 'mini', 'coingecko', 5)).toEqual(['failed', 'failed', 'ok']);
  });

  it('skips runs that did not include the source, and skipped entries', () => {
    run('2026-09-16T00:00:00.000Z', [['flow', 'failed']]);
    run('2026-09-17T00:00:00.000Z', [['coingecko', 'ok']]); // a --metric run that never touched "flow"
    run('2026-09-18T00:00:00.000Z', [['flow', 'skipped']]);
    run('2026-09-19T00:00:00.000Z', [['flow', 'failed']]);
    expect(recentSourceStatuses(db, 'mini', 'flow', 5)).toEqual(['failed', 'failed']);
    expect(recentSourceStatuses(db, 'other', 'flow', 5)).toEqual([]);
  });
});
