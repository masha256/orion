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
  it('normalizes timestamps to ISO', async () => {
    const o = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    expect(o.observedAt).toBe('2026-06-30T00:00:00.000Z');
    expect(o.status).toBe('confirmed');
  });

  it('rejects an invalid timestamp', async () => {
    await expect(insertObservation(db, { ...base, observedAt: 'not-a-date', value: 1 })).rejects.toThrow(/timestamp/);
  });

  it('supersedes an active row with the same metric and observed_at', async () => {
    const first = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    const second = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 11 });
    const active = await listActiveObservations(db, 'mini', 'price_usd');
    expect(active.map((o) => o.id)).toEqual([second.id]);
    expect((await getObservationsByIds(db, [first.id]))[0].supersededBy).toBe(second.id);
  });

  it('refuses a period length that is not a positive finite number', async () => {
    for (const periodDays of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(insertObservation(db, { ...base, observedAt: '2026-06-30', value: 1, periodDays })).rejects.toThrow(/period/);
    }
    expect((await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 1, periodDays: null })).periodDays).toBeNull();
  });

  it('requires a citation for provisional rows', async () => {
    await expect(insertObservation(db, { ...base, observedAt: '2026-06-30', value: 1, status: 'provisional' })).rejects.toThrow(/citation/);
  });

  it('confirm inserts a confirmed copy that supersedes the provisional row', async () => {
    const p = await insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a', quotedText: 'five',
    });
    const c = await confirmObservation(db, p.id, '2026-07-01T00:00:00Z');
    expect(c.status).toBe('confirmed');
    expect(c.value).toBe(5);
    expect(c.citationUrl).toBe('https://example.com/a');
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([c.id]);
  });

  it('reject removes a provisional row from the active set but keeps the row', async () => {
    const p = await insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a',
    });
    await rejectObservation(db, p.id);
    expect(await listActiveObservations(db, 'mini')).toEqual([]);
    expect((await getObservationsByIds(db, [p.id]))[0].status).toBe('rejected');
  });

  it('a provisional insert supersedes only provisional rows, never a confirmed one', async () => {
    const confirmed = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    const first = await insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 11, status: 'provisional', citationUrl: 'https://example.com/a',
    });
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([confirmed.id, first.id]);

    const second = await insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 12, status: 'provisional', citationUrl: 'https://example.com/b',
    });
    expect((await getObservationsByIds(db, [first.id]))[0].supersededBy).toBe(second.id);
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([confirmed.id, second.id]);

    // confirming still retires the provisional row, and the earlier confirmed row with it
    const c = await confirmObservation(db, second.id, '2026-07-01T00:00:00Z');
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([c.id]);
  });

  it('refuses to confirm a row that is not an active provisional row', async () => {
    const o = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    await expect(confirmObservation(db, o.id, '2026-07-01T00:00:00Z')).rejects.toThrow(/provisional/);
  });

  it('reject retires an active confirmed row so a bad entry can be taken out of the window', async () => {
    const o = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    await rejectObservation(db, o.id);
    expect(await listActiveObservations(db, 'mini')).toEqual([]);
    expect((await getObservationsByIds(db, [o.id]))[0].status).toBe('rejected');
  });

  it('refuses to reject a superseded or already rejected row', async () => {
    const first = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    const second = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 11 });
    await expect(rejectObservation(db, first.id)).rejects.toThrow(/not active/);
    await rejectObservation(db, second.id);
    await expect(rejectObservation(db, second.id)).rejects.toThrow(/not active/);
  });
});
