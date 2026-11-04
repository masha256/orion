import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { emptySourceOutcome, insertFetchRun, listFetchRuns, recentSourceStatuses, type SourceStatus } from '../../src/db/fetchRuns.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

let db: Db;
beforeEach(() => {
  db = testDb();
});

async function run(at: string, sources: [string, SourceStatus][], assetId = 'mini'): Promise<number> {
  return await insertFetchRun(db, {
    assetId, startedAt: at, endedAt: at, outcome: sources.every(([, s]) => s === 'ok') ? 'ok' : 'partial',
    detail: { sources: sources.map(([id, status]) => ({ ...emptySourceOutcome(id), status })) },
  });
}

describe('fetch runs', () => {
  it('round-trips the detail JSON and lists newest first', async () => {
    const first = await run('2026-09-18T00:00:00.000Z', [['coingecko', 'ok']]);
    const second = await insertFetchRun(db, {
      assetId: 'mini', startedAt: '2026-09-19T00:00:00.000Z', endedAt: '2026-09-19T00:00:05.000Z', outcome: 'partial',
      detail: { sources: [{ ...emptySourceOutcome('chain_levels'), status: 'failed', error: 'boom', notes: ['n'] }] },
    });
    const list = await listFetchRuns(db, 'mini', 10);
    expect(list.map((r) => r.id)).toEqual([second, first]);
    expect(list[0].outcome).toBe('partial');
    expect(list[0].endedAt).toBe('2026-09-19T00:00:05.000Z');
    expect(list[0].detail.sources[0]).toEqual({ ...emptySourceOutcome('chain_levels'), status: 'failed', error: 'boom', notes: ['n'] });
    expect(await listFetchRuns(db, 'mini', 1)).toHaveLength(1);
    expect(await listFetchRuns(db, 'other', 10)).toEqual([]);
  });

  it('reports the recent statuses of one source, newest first', async () => {
    await run('2026-09-16T00:00:00.000Z', [['coingecko', 'ok'], ['chain_levels', 'ok']]);
    await run('2026-09-17T00:00:00.000Z', [['coingecko', 'failed'], ['chain_levels', 'ok']]);
    await run('2026-09-18T00:00:00.000Z', [['coingecko', 'failed']]);
    expect(await recentSourceStatuses(db, 'mini', 'coingecko', 2)).toEqual(['failed', 'failed']);
    expect(await recentSourceStatuses(db, 'mini', 'coingecko', 5)).toEqual(['failed', 'failed', 'ok']);
  });

  it('skips runs that did not include the source, and skipped entries', async () => {
    await run('2026-09-16T00:00:00.000Z', [['flow', 'failed']]);
    await run('2026-09-17T00:00:00.000Z', [['coingecko', 'ok']]); // a --metric run that never touched "flow"
    await run('2026-09-18T00:00:00.000Z', [['flow', 'skipped']]);
    await run('2026-09-19T00:00:00.000Z', [['flow', 'failed']]);
    expect(await recentSourceStatuses(db, 'mini', 'flow', 5)).toEqual(['failed', 'failed']);
    expect(await recentSourceStatuses(db, 'other', 'flow', 5)).toEqual([]);
  });

  it('fetchRuns: recentSourceStatuses on Postgres equals the JS scan', async () => {
    // The scan the SQL replaced: per run, newest first, the FIRST entry for the source; skipped entries and runs without
    // the source are passed over.
    const jsScan = async (assetId: string, sourceId: string, limit: number): Promise<SourceStatus[]> => {
      const out: SourceStatus[] = [];
      for (const r of await listFetchRuns(db, assetId, 1000)) {
        const entry = r.detail.sources.find((s) => s.sourceId === sourceId);
        if (!entry || entry.status === 'skipped') continue;
        out.push(entry.status);
        if (out.length >= limit) break;
      }
      return out;
    };
    await run('2026-09-10T00:00:00.000Z', [['flow', 'ok'], ['coingecko', 'ok']]);
    await run('2026-09-11T00:00:00.000Z', [['flow', 'failed'], ['flow', 'ok']]); // the source twice: the first entry counts
    await run('2026-09-12T00:00:00.000Z', [['coingecko', 'failed']]); // a run without the source
    await run('2026-09-13T00:00:00.000Z', [['flow', 'skipped'], ['flow', 'failed']]); // first entry skipped: the run is passed over
    await run('2026-09-14T00:00:00.000Z', [['coingecko', 'ok'], ['flow', 'ok']]);
    await run('2026-09-15T00:00:00.000Z', [['flow', 'failed']], 'other');
    await run('2026-09-16T00:00:00.000Z', [['flow', 'skipped']]);
    await run('2026-09-17T00:00:00.000Z', [['flow', 'ok'], ['flow', 'failed']]);
    for (const [assetId, sourceId] of [['mini', 'flow'], ['mini', 'coingecko'], ['other', 'flow'], ['mini', 'absent']] as const) {
      for (const limit of [1, 2, 3, 10]) {
        expect(await recentSourceStatuses(db, assetId, sourceId, limit), `${assetId} ${sourceId} ${limit}`).toEqual(await jsScan(assetId, sourceId, limit));
      }
    }
    expect(await recentSourceStatuses(db, 'mini', 'flow', 10)).toEqual(['ok', 'ok', 'failed', 'ok']);
  });
});
