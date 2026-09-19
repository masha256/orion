import { beforeEach, describe, expect, it } from 'vitest';
import { decideAnomaly, getAnomaly, listAnomalies, listOpenAnomalies, raiseAnomaly, type RaiseAnomalyInput } from '../../src/db/anomalies.js';
import { openDb, type Db } from '../../src/db/connection.js';
import type { OrionError } from '../../src/types.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const mismatch = (over: Partial<RaiseAnomalyInput> = {}): RaiseAnomalyInput => ({
  assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'http_json:https://x.test/stats',
  severity: 'degrading', detail: { primary: 10, check: 11 }, seenAt: '2026-09-18T00:00:00.000Z', ...over,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

describe('anomalies', () => {
  it('opens a row on first sight', () => {
    const a = raiseAnomaly(db, mismatch());
    expect(a).toMatchObject({
      assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', severity: 'degrading', status: 'open',
      occurrences: 1, firstSeenAt: '2026-09-18T00:00:00.000Z', lastSeenAt: '2026-09-18T00:00:00.000Z', note: null, decidedAt: null,
    });
    expect(a.detail).toEqual({ primary: 10, check: 11 });
    expect(getAnomaly(db, a.id)).toEqual(a);
  });

  it('counts a repeat of an open anomaly instead of inserting a row', () => {
    const first = raiseAnomaly(db, mismatch());
    const again = raiseAnomaly(db, mismatch({ seenAt: '2026-09-19T00:00:00.000Z', detail: { primary: 10, check: 12 }, severity: 'advisory' }));
    expect(again.id).toBe(first.id);
    expect(again.occurrences).toBe(2);
    expect(again.firstSeenAt).toBe('2026-09-18T00:00:00.000Z');
    expect(again.lastSeenAt).toBe('2026-09-19T00:00:00.000Z');
    expect(again.detail).toEqual({ primary: 10, check: 12 });
    expect(again.severity).toBe('advisory');
    expect(listAnomalies(db)).toHaveLength(1);
  });

  it('keeps anomalies apart by asset, kind, metric, and dedupe key', () => {
    raiseAnomaly(db, mismatch());
    raiseAnomaly(db, mismatch({ assetId: 'other' }));
    raiseAnomaly(db, mismatch({ metricKey: 'effective_supply' }));
    raiseAnomaly(db, mismatch({ dedupeKey: 'coingecko' }));
    raiseAnomaly(db, mismatch({ kind: 'unlisted_sender', dedupeKey: '0xabc' }));
    expect(listAnomalies(db)).toHaveLength(5);
    expect(listOpenAnomalies(db, 'mini')).toHaveLength(4);
  });

  it('resolves and acknowledges with a note, after which the anomaly is no longer open', () => {
    const a = raiseAnomaly(db, mismatch());
    const b = raiseAnomaly(db, mismatch({ metricKey: 'effective_supply' }));
    const resolved = decideAnomaly(db, a.id, 'resolved', 'source fixed upstream', '2026-09-20T00:00:00.000Z');
    expect(resolved).toMatchObject({ status: 'resolved', note: 'source fixed upstream', decidedAt: '2026-09-20T00:00:00.000Z' });
    expect(decideAnomaly(db, b.id, 'acknowledged', 'known lag', '2026-09-20T00:00:00.000Z').status).toBe('acknowledged');
    expect(listOpenAnomalies(db, 'mini')).toEqual([]);
    expect(listAnomalies(db, { assetId: 'mini' })).toEqual([]);
    expect(listAnomalies(db, { assetId: 'mini', includeDecided: true })).toHaveLength(2);
  });

  it('opens a new row when a decided anomaly recurs', () => {
    const first = raiseAnomaly(db, mismatch());
    decideAnomaly(db, first.id, 'resolved', 'fixed', '2026-09-20T00:00:00.000Z');
    const second = raiseAnomaly(db, mismatch({ seenAt: '2026-09-21T00:00:00.000Z' }));
    expect(second.id).not.toBe(first.id);
    expect(second.occurrences).toBe(1);
    expect(getAnomaly(db, first.id)!.status).toBe('resolved');
  });

  it('refuses a blank note, an unknown id, and a second decision', () => {
    const a = raiseAnomaly(db, mismatch());
    expect(codeOf(() => decideAnomaly(db, a.id, 'resolved', '  ', '2026-09-20T00:00:00.000Z'))).toBe('note_required');
    expect(codeOf(() => decideAnomaly(db, 999, 'resolved', 'x', '2026-09-20T00:00:00.000Z'))).toBe('anomaly_not_found');
    decideAnomaly(db, a.id, 'acknowledged', 'ok', '2026-09-20T00:00:00.000Z');
    expect(codeOf(() => decideAnomaly(db, a.id, 'resolved', 'again', '2026-09-21T00:00:00.000Z'))).toBe('anomaly_not_open');
  });

  it('lists newest first, and open anomalies oldest first', () => {
    const a = raiseAnomaly(db, mismatch());
    const b = raiseAnomaly(db, mismatch({ metricKey: 'effective_supply', seenAt: '2026-09-19T00:00:00.000Z' }));
    expect(listAnomalies(db).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(listOpenAnomalies(db, 'mini').map((x) => x.id)).toEqual([a.id, b.id]);
  });
});
