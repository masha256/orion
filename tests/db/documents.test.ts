import { beforeEach, describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/db/connection.js';
import { getDocument, insertDocument, listDocuments, normalizeDocText } from '../../src/db/documents.js';
import { sha256 } from '../../src/util/canonical.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

let db: Db;
beforeEach(() => {
  db = testDb();
});

const input = (over: Partial<Parameters<typeof insertDocument>[1]> = {}): Parameters<typeof insertDocument>[1] => ({
  assetId: 'lit', kind: 'machine_transcript', sourceUrl: 'https://x.com/Lighter_xyz/status/1', sourceId: 'x:1',
  title: 'LIT investor update 2026Q3', publishedAt: '2026-10-20T16:00:00.000Z', addedAt: '2026-10-23T09:40:00.000Z',
  meta: { asr_model: 'small.en' }, text: '[00:01] hello\n', ...over,
});

describe('documents', () => {
  it('normalizes BOM, CRLF and the trailing newline before hashing', async () => {
    expect(normalizeDocText('\uFEFFa\r\nb')).toBe('a\nb\n');
    expect(normalizeDocText('a\nb\n\n\n')).toBe('a\nb\n');
    expect(normalizeDocText('a\nb\n')).toBe('a\nb\n');
    const a = (await insertDocument(db, input({ text: '\uFEFFa\r\nb' }))).doc;
    const b = await insertDocument(db, input({ text: 'a\nb\n' }));
    expect(b.existing).toBe(true);
    expect(b.doc.id).toBe(a.id);
    expect(a.sha256).toBe(sha256('a\nb\n'));
    expect(a.text).toBe('a\nb\n');
    expect(a.bytes).toBe(4);
    expect((await insertDocument(db, input({ text: 'é\n' }))).doc.bytes).toBe(3); // UTF-8 bytes, not characters
  });

  it('is idempotent on the same asset and text', async () => {
    const first = await insertDocument(db, input());
    expect(first.existing).toBe(false);
    expect(first.doc).toEqual({
      id: 1, assetId: 'lit', kind: 'machine_transcript', sourceUrl: 'https://x.com/Lighter_xyz/status/1', sourceId: 'x:1',
      title: 'LIT investor update 2026Q3', publishedAt: '2026-10-20T16:00:00.000Z', addedAt: '2026-10-23T09:40:00.000Z',
      sha256: sha256('[00:01] hello\n'), bytes: 14, text: '[00:01] hello\n', meta: { asr_model: 'small.en' },
    });
    const second = await insertDocument(db, input({ addedAt: '2026-10-24T09:40:00.000Z' }));
    expect(second).toEqual({ doc: first.doc, existing: true });
    expect((await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM documents'))!.n).toBe(1);
    expect(await getDocument(db, 1)).toEqual(first.doc);
    expect(await getDocument(db, 2)).toBeNull();
    // The same text on another asset is another document.
    expect((await insertDocument(db, input({ assetId: 'hype' }))).existing).toBe(false);
  });

  it('stores a re-transcription of the same URL as a new row; list marks the older superseded_by_newer', async () => {
    const older = (await insertDocument(db, input({ text: '[00:01] helo\n' }))).doc;
    const newer = (await insertDocument(db, input({ text: '[00:01] hello\n' }))).doc;
    await insertDocument(db, input({ sourceUrl: 'https://x.com/Lighter_xyz/status/2', text: 'other\n' }));
    expect(newer.id).toBeGreaterThan(older.id);
    const byId = new Map((await listDocuments(db, { assetId: 'lit' })).map((d) => [d.id, d.supersededByNewer]));
    expect(byId).toEqual(new Map([[3, false], [2, false], [1, true]]));
  });

  it('a writer that stores the same text between the read and the insert yields existing: true, not a UNIQUE error', async () => {
    // Another process (the watcher and a hand-run `doc add`) lands the same row just before this insert runs.
    let raced = false;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'run') return Reflect.get(target, prop, receiver);
        return async (sql: string, params?: readonly SqlParam[]) => {
          if (!raced && sql.startsWith('INSERT INTO documents')) {
            raced = true;
            await insertDocument(db, input({ title: 'the other writer' }));
          }
          return target.run(sql, params);
        };
      },
    });
    const r = await insertDocument(racing, input());
    expect(raced).toBe(true);
    expect(r.existing).toBe(true);
    expect(r.doc.title).toBe('the other writer');
    expect(await listDocuments(db)).toHaveLength(1);
  });

  it('validates at the store: meta keys and values, published_at as an ISO date or instant', async () => {
    const code = async (over: Partial<Parameters<typeof insertDocument>[1]>) => {
      try {
        await insertDocument(db, input(over));
      } catch (err) {
        return (err as { code?: string }).code;
      }
      return 'stored';
    };
    const bad: Record<string, string>[] = [{ 'asr-model': 'x' }, { ASR: 'x' }, { ['a'.repeat(33)]: 'x' }, { '': 'x' }, { asr_model: 'x'.repeat(201) }, { asr_model: 5 as unknown as string }];
    for (const meta of bad) {
      expect(await code({ meta }), JSON.stringify(meta)).toBe('invalid_meta');
    }
    for (const publishedAt of ['yesterday', '2026-10-22 16:00', '2026-02-30', '2026-10-22T25:00:00Z', '2026-10-22T16:00:00', '22/10/2026']) {
      expect(await code({ publishedAt }), publishedAt).toBe('invalid_published_at');
    }
    expect(await code({ kind: 'tweet' as never })).toBe('invalid_doc_kind');
    let n = 0;
    for (const publishedAt of ['2026-10-22', '2026-10-22T16:00Z', '2026-10-22T16:00:00Z', '2026-10-22T00:32:09.000Z', '2026-10-22T09:00:00-07:00', null]) {
      expect(await code({ publishedAt, text: `[00:0${n++}] t\n` }), String(publishedAt)).toBe('stored');
    }
    expect(await code({ meta: { ['a'.repeat(32)]: 'x'.repeat(200) }, text: 'other\n' })).toBe('stored');
  });

  it('lists newest first, filtered by asset, without text', async () => {
    await insertDocument(db, input({ text: 'one\n' }));
    await insertDocument(db, input({ assetId: 'hype', kind: 'post', sourceId: null, title: null, publishedAt: null, meta: {}, text: 'two\n' }));
    await insertDocument(db, input({ sourceUrl: 'https://x.com/Lighter_xyz/status/3', text: 'three\n' }));
    expect((await listDocuments(db, {})).map((d) => d.id)).toEqual([3, 2, 1]);
    const lit = await listDocuments(db, { assetId: 'lit' });
    expect(lit.map((d) => d.id)).toEqual([3, 1]);
    expect(lit.every((d) => d.text === '')).toBe(true);
    expect(lit[0]!.bytes).toBe(6);
    expect(lit[0]!.sha256).toBe(sha256('three\n'));
    const hype = await listDocuments(db, { assetId: 'hype' });
    expect(hype).toEqual([{
      id: 2, assetId: 'hype', kind: 'post', sourceUrl: 'https://x.com/Lighter_xyz/status/1', sourceId: null, title: null,
      publishedAt: null, addedAt: '2026-10-23T09:40:00.000Z', sha256: sha256('two\n'), bytes: 4, text: '', meta: {},
      supersededByNewer: false,
    }]);
  });
});
