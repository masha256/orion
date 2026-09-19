import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import {
  confirmObservation,
  getObservationsByIds,
  insertObservation,
  listActiveObservations,
  rejectObservation,
} from '../../src/db/observations.js';

const base = { assetId: 'mini', metricKey: 'price_usd', source: 'manual' as const, fetchedAt: '2026-06-30T00:00:00Z' };
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('observations', () => {
  it('normalizes timestamps to ISO', () => {
    const o = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    expect(o.observedAt).toBe('2026-06-30T00:00:00.000Z');
    expect(o.status).toBe('confirmed');
  });

  it('rejects an invalid timestamp', () => {
    expect(() => insertObservation(db, { ...base, observedAt: 'not-a-date', value: 1 })).toThrow(/timestamp/);
  });

  it('supersedes an active row with the same metric and observed_at', () => {
    const first = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    const second = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 11 });
    const active = listActiveObservations(db, 'mini', 'price_usd');
    expect(active.map((o) => o.id)).toEqual([second.id]);
    expect(getObservationsByIds(db, [first.id])[0].supersededBy).toBe(second.id);
  });

  it('requires a citation for provisional rows', () => {
    expect(() =>
      insertObservation(db, { ...base, observedAt: '2026-06-30', value: 1, status: 'provisional' }),
    ).toThrow(/citation/);
  });

  it('confirm inserts a confirmed copy that supersedes the provisional row', () => {
    const p = insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a', quotedText: 'five',
    });
    const c = confirmObservation(db, p.id, '2026-07-01T00:00:00Z');
    expect(c.status).toBe('confirmed');
    expect(c.value).toBe(5);
    expect(c.citationUrl).toBe('https://example.com/a');
    expect(listActiveObservations(db, 'mini').map((o) => o.id)).toEqual([c.id]);
  });

  it('reject removes a provisional row from the active set but keeps the row', () => {
    const p = insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a',
    });
    rejectObservation(db, p.id);
    expect(listActiveObservations(db, 'mini')).toEqual([]);
    expect(getObservationsByIds(db, [p.id])[0].status).toBe('rejected');
  });

  it('refuses to confirm or reject a row that is not an active provisional row', () => {
    const o = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    expect(() => confirmObservation(db, o.id, '2026-07-01T00:00:00Z')).toThrow(/provisional/);
    expect(() => rejectObservation(db, o.id)).toThrow(/provisional/);
  });
});
