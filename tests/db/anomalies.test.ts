import { beforeEach, describe, expect, it } from 'vitest';
import { decideAnomaly, getAnomaly, listAnomalies, listOpenAnomalies, raiseAnomaly, type RaiseAnomalyInput } from '../../src/db/anomalies.js';
import type { Db } from '../../src/db/connection.js';
import type { OrionError } from '../../src/types.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

let db: Db;
beforeEach(() => {
  db = testDb();
});

const mismatch = (over: Partial<RaiseAnomalyInput> = {}): RaiseAnomalyInput => ({
  assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'http_json:https://x.test/stats',
  severity: 'degrading', detail: { primary: 10, check: 11 }, seenAt: '2026-09-18T00:00:00.000Z', ...over,
});

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

describe('anomalies', () => {
  it('opens a row on first sight', async () => {
    const a = await raiseAnomaly(db, mismatch());
    expect(a).toMatchObject({
      assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', severity: 'degrading', status: 'open',
      occurrences: 1, firstSeenAt: '2026-09-18T00:00:00.000Z', lastSeenAt: '2026-09-18T00:00:00.000Z', note: null, decidedAt: null,
    });
    expect(a.detail).toEqual({ primary: 10, check: 11 });
    expect(await getAnomaly(db, a.id)).toEqual(a);
  });

  it('counts a repeat of an open anomaly instead of inserting a row', async () => {
    const first = await raiseAnomaly(db, mismatch());
    const again = await raiseAnomaly(db, mismatch({ seenAt: '2026-09-19T00:00:00.000Z', detail: { primary: 10, check: 12 }, severity: 'advisory' }));
    expect(again.id).toBe(first.id);
    expect(again.occurrences).toBe(2);
    expect(again.firstSeenAt).toBe('2026-09-18T00:00:00.000Z');
    expect(again.lastSeenAt).toBe('2026-09-19T00:00:00.000Z');
    expect(again.detail).toEqual({ primary: 10, check: 12 });
    expect(again.severity).toBe('advisory');
    expect(await listAnomalies(db)).toHaveLength(1);
  });

  it('keeps anomalies apart by asset, kind, metric, and dedupe key', async () => {
    await raiseAnomaly(db, mismatch());
    await raiseAnomaly(db, mismatch({ assetId: 'other' }));
    await raiseAnomaly(db, mismatch({ metricKey: 'total_supply' }));
    await raiseAnomaly(db, mismatch({ dedupeKey: 'coingecko' }));
    await raiseAnomaly(db, mismatch({ kind: 'unlisted_sender', dedupeKey: '0xabc' }));
    expect(await listAnomalies(db)).toHaveLength(5);
    expect(await listOpenAnomalies(db, 'mini')).toHaveLength(4);
  });

  it('resolves and acknowledges with a note, after which the anomaly is no longer open', async () => {
    const a = await raiseAnomaly(db, mismatch());
    const b = await raiseAnomaly(db, mismatch({ metricKey: 'total_supply' }));
    const resolved = await decideAnomaly(db, a.id, 'resolved', 'source fixed upstream', '2026-09-20T00:00:00.000Z');
    expect(resolved).toMatchObject({ status: 'resolved', note: 'source fixed upstream', decidedAt: '2026-09-20T00:00:00.000Z' });
    expect((await decideAnomaly(db, b.id, 'acknowledged', 'known lag', '2026-09-20T00:00:00.000Z')).status).toBe('acknowledged');
    expect(await listOpenAnomalies(db, 'mini')).toEqual([]);
    expect(await listAnomalies(db, { assetId: 'mini' })).toEqual([]);
    expect(await listAnomalies(db, { assetId: 'mini', includeDecided: true })).toHaveLength(2);
  });

  it('opens a new row when a resolved anomaly recurs: the cause was fixed, so this is news', async () => {
    const first = await raiseAnomaly(db, mismatch());
    await decideAnomaly(db, first.id, 'resolved', 'fixed', '2026-09-20T00:00:00.000Z');
    const second = await raiseAnomaly(db, mismatch({ seenAt: '2026-09-21T00:00:00.000Z' }));
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ status: 'open', occurrences: 1 });
    expect((await getAnomaly(db, first.id))!.status).toBe('resolved');
  });

  it('keeps an acknowledgement standing when the same condition is seen again', async () => {
    const first = await raiseAnomaly(db, mismatch());
    await decideAnomaly(db, first.id, 'acknowledged', 'venice lags by an hour', '2026-09-20T00:00:00.000Z');
    const again = await raiseAnomaly(db, mismatch({ seenAt: '2026-09-21T00:00:00.000Z', detail: { primary: 10, check: 12 } }));
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({
      status: 'acknowledged', note: 'venice lags by an hour', decidedAt: '2026-09-20T00:00:00.000Z',
      occurrences: 2, firstSeenAt: '2026-09-18T00:00:00.000Z', lastSeenAt: '2026-09-21T00:00:00.000Z',
    });
    expect(again.detail).toEqual({ primary: 10, check: 12 }); // the latest reading stays visible under --all
    expect(await listOpenAnomalies(db, 'mini')).toEqual([]);
    expect(await listAnomalies(db, { includeDecided: true })).toHaveLength(1);
  });

  it('judges a recurrence by the LATEST matching row, not by any older one', async () => {
    const old = await raiseAnomaly(db, mismatch({ dedupeKey: 'k' }));
    await decideAnomaly(db, old.id, 'resolved', 'fixed', '2026-09-19T00:00:00.000Z');
    const newer = await raiseAnomaly(db, mismatch({ dedupeKey: 'k', seenAt: '2026-09-22T00:00:00.000Z' }));
    expect(newer.id).not.toBe(old.id);
    await decideAnomaly(db, newer.id, 'acknowledged', 'accepted', '2026-09-23T00:00:00.000Z');
    const third = await raiseAnomaly(db, mismatch({ dedupeKey: 'k', seenAt: '2026-09-24T00:00:00.000Z' }));
    expect(third.id).toBe(newer.id); // the newest row is the acknowledged one, so the repeat counts there
    expect(await getAnomaly(db, old.id)).toMatchObject({ status: 'resolved', occurrences: 1 }); // history is left alone
  });

  it('keeps acknowledgements apart by key: another metric still opens', async () => {
    const first = await raiseAnomaly(db, mismatch());
    await decideAnomaly(db, first.id, 'acknowledged', 'accepted', '2026-09-20T00:00:00.000Z');
    expect((await raiseAnomaly(db, mismatch({ metricKey: 'total_supply' }))).status).toBe('open');
  });

  it('refuses a blank note, an unknown id, and deciding a closed anomaly again', async () => {
    const a = await raiseAnomaly(db, mismatch());
    expect(await codeOf(() => decideAnomaly(db, a.id, 'resolved', '  ', '2026-09-20T00:00:00.000Z'))).toBe('note_required');
    expect(await codeOf(() => decideAnomaly(db, 999, 'resolved', 'x', '2026-09-20T00:00:00.000Z'))).toBe('anomaly_not_found');
    await decideAnomaly(db, a.id, 'acknowledged', 'ok', '2026-09-20T00:00:00.000Z');
    expect(await codeOf(() => decideAnomaly(db, a.id, 'acknowledged', 'again', '2026-09-21T00:00:00.000Z'))).toBe('anomaly_not_open');
    await decideAnomaly(db, a.id, 'resolved', 'done', '2026-09-21T00:00:00.000Z');
    expect(await codeOf(() => decideAnomaly(db, a.id, 'resolved', 'again', '2026-09-22T00:00:00.000Z'))).toBe('anomaly_not_open');
    expect(await codeOf(() => decideAnomaly(db, a.id, 'acknowledged', 'again', '2026-09-22T00:00:00.000Z'))).toBe('anomaly_not_open');
  });

  it('lets an acknowledgement be withdrawn by resolving it, after which a recurrence opens a new anomaly', async () => {
    const a = await raiseAnomaly(db, mismatch());
    await decideAnomaly(db, a.id, 'acknowledged', 'accepted for now', '2026-09-20T00:00:00.000Z');
    const resolved = await decideAnomaly(db, a.id, 'resolved', 'tolerance tightened; watch it again', '2026-09-25T00:00:00.000Z');
    expect(resolved).toMatchObject({ status: 'resolved', note: 'tolerance tightened; watch it again', decidedAt: '2026-09-25T00:00:00.000Z' });
    const next = await raiseAnomaly(db, mismatch({ seenAt: '2026-09-26T00:00:00.000Z' }));
    expect(next.id).not.toBe(a.id);
    expect(next.status).toBe('open');
  });

  it('lists newest first, and open anomalies oldest first', async () => {
    const a = await raiseAnomaly(db, mismatch());
    const b = await raiseAnomaly(db, mismatch({ metricKey: 'total_supply', seenAt: '2026-09-19T00:00:00.000Z' }));
    expect((await listAnomalies(db)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await listOpenAnomalies(db, 'mini')).map((x) => x.id)).toEqual([a.id, b.id]);
  });
});
