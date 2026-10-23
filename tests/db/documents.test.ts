import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import { getDocument, insertDocument, listDocuments, normalizeDocText } from '../../src/db/documents.js';
import { sha256 } from '../../src/util/canonical.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const input = (over: Partial<Parameters<typeof insertDocument>[1]> = {}): Parameters<typeof insertDocument>[1] => ({
  assetId: 'lit', kind: 'machine_transcript', sourceUrl: 'https://x.com/Lighter_xyz/status/1', sourceId: 'x:1',
  title: 'LIT investor update 2026Q3', publishedAt: '2026-10-20T16:00:00.000Z', addedAt: '2026-10-23T09:40:00.000Z',
  meta: { asr_model: 'small.en' }, text: '[00:01] hello\n', ...over,
});

describe('documents', () => {
  it('normalizes BOM, CRLF and the trailing newline before hashing', () => {
    expect(normalizeDocText('\uFEFFa\r\nb')).toBe('a\nb\n');
    expect(normalizeDocText('a\nb\n\n\n')).toBe('a\nb\n');
    expect(normalizeDocText('a\nb\n')).toBe('a\nb\n');
    const a = insertDocument(db, input({ text: '\uFEFFa\r\nb' })).doc;
    const b = insertDocument(db, input({ text: 'a\nb\n' }));
    expect(b.existing).toBe(true);
    expect(b.doc.id).toBe(a.id);
    expect(a.sha256).toBe(sha256('a\nb\n'));
    expect(a.text).toBe('a\nb\n');
    expect(a.bytes).toBe(4);
    expect(insertDocument(db, input({ text: 'é\n' })).doc.bytes).toBe(3); // UTF-8 bytes, not characters
  });

  it('is idempotent on the same asset and text', () => {
    const first = insertDocument(db, input());
    expect(first.existing).toBe(false);
    expect(first.doc).toEqual({
      id: 1, assetId: 'lit', kind: 'machine_transcript', sourceUrl: 'https://x.com/Lighter_xyz/status/1', sourceId: 'x:1',
      title: 'LIT investor update 2026Q3', publishedAt: '2026-10-20T16:00:00.000Z', addedAt: '2026-10-23T09:40:00.000Z',
      sha256: sha256('[00:01] hello\n'), bytes: 14, text: '[00:01] hello\n', meta: { asr_model: 'small.en' },
    });
    const second = insertDocument(db, input({ addedAt: '2026-10-24T09:40:00.000Z' }));
    expect(second).toEqual({ doc: first.doc, existing: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(1);
    expect(getDocument(db, 1)).toEqual(first.doc);
    expect(getDocument(db, 2)).toBeNull();
    // The same text on another asset is another document.
    expect(insertDocument(db, input({ assetId: 'hype' })).existing).toBe(false);
  });

  it('stores a re-transcription of the same URL as a new row; list marks the older superseded_by_newer', () => {
    const older = insertDocument(db, input({ text: '[00:01] helo\n' })).doc;
    const newer = insertDocument(db, input({ text: '[00:01] hello\n' })).doc;
    insertDocument(db, input({ sourceUrl: 'https://x.com/Lighter_xyz/status/2', text: 'other\n' }));
    expect(newer.id).toBeGreaterThan(older.id);
    const byId = new Map(listDocuments(db, { assetId: 'lit' }).map((d) => [d.id, d.supersededByNewer]));
    expect(byId).toEqual(new Map([[3, false], [2, false], [1, true]]));
  });

  it('lists newest first, filtered by asset, without text', () => {
    insertDocument(db, input({ text: 'one\n' }));
    insertDocument(db, input({ assetId: 'hype', kind: 'post', sourceId: null, title: null, publishedAt: null, meta: {}, text: 'two\n' }));
    insertDocument(db, input({ sourceUrl: 'https://x.com/Lighter_xyz/status/3', text: 'three\n' }));
    expect(listDocuments(db, {}).map((d) => d.id)).toEqual([3, 2, 1]);
    const lit = listDocuments(db, { assetId: 'lit' });
    expect(lit.map((d) => d.id)).toEqual([3, 1]);
    expect(lit.every((d) => d.text === '')).toBe(true);
    expect(lit[0]!.bytes).toBe(6);
    expect(lit[0]!.sha256).toBe(sha256('three\n'));
    const hype = listDocuments(db, { assetId: 'hype' });
    expect(hype).toEqual([{
      id: 2, assetId: 'hype', kind: 'post', sourceUrl: 'https://x.com/Lighter_xyz/status/1', sourceId: null, title: null,
      publishedAt: null, addedAt: '2026-10-23T09:40:00.000Z', sha256: sha256('two\n'), bytes: 4, text: '', meta: {},
      supersededByNewer: false,
    }]);
  });
});
