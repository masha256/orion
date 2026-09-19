import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import { advanceCursor, getCursor } from '../../src/db/fetchCursors.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('fetch cursors', () => {
  it('returns null before the first scan', () => {
    expect(getCursor(db, 'mini', 'scan-a')).toBeNull();
  });

  it('stores and advances one cursor per asset and scan key', () => {
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 100, lastDay: '2026-09-16' }, '2026-09-19T00:00:00.000Z');
    advanceCursor(db, 'mini', 'scan-b', { lastBlock: 7, lastDay: '2026-09-01' }, '2026-09-19T00:00:00.000Z');
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 200, lastDay: '2026-09-17' }, '2026-09-19T00:01:00.000Z');
    expect(getCursor(db, 'mini', 'scan-a')).toEqual({ lastBlock: 200, lastDay: '2026-09-17' });
    expect(getCursor(db, 'mini', 'scan-b')).toEqual({ lastBlock: 7, lastDay: '2026-09-01' });
  });

  it('never moves backwards, so a forced re-scan of old days leaves the cursor alone', () => {
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 200, lastDay: '2026-09-17' }, '2026-09-19T00:00:00.000Z');
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 50, lastDay: '2026-09-10' }, '2026-09-19T00:01:00.000Z');
    expect(getCursor(db, 'mini', 'scan-a')).toEqual({ lastBlock: 200, lastDay: '2026-09-17' });
  });
});
