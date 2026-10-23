import { sha256 } from '../util/canonical.js';
import type { Db } from './connection.js';

export const DOC_KINDS = ['machine_transcript', 'transcript', 'post', 'filing', 'article'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** A stored source document (a call transcript, a post, a filing): the exact text a citation is checked against. */
export interface StoredDocument {
  id: number;
  assetId: string;
  kind: DocKind;
  sourceUrl: string;
  /** The watcher's dedupe key, e.g. 'x:2113065839352336774'; stored for display. */
  sourceId: string | null;
  title: string | null;
  publishedAt: string | null;
  addedAt: string;
  /** sha256 of `text`, which is already normalized (normalizeDocText). */
  sha256: string;
  /** UTF-8 length of `text`. */
  bytes: number;
  text: string;
  meta: Record<string, string>;
}

export type NewDocument = Omit<StoredDocument, 'id' | 'sha256' | 'bytes' | 'text'> & { text: string };

/**
 * The one form a document is stored and hashed in: a leading BOM stripped, CRLF as LF, exactly one trailing LF. The
 * watcher writes its transcript in this form, so both sides compute the same hash from bytes that differ invisibly.
 */
export function normalizeDocText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
}

/** The fixed label shown wherever a document is displayed or cited (spec 5.3). */
export function docLabel(doc: Pick<StoredDocument, 'kind' | 'meta'>): string {
  if (doc.kind === 'machine_transcript') {
    return `machine transcript (${doc.meta.asr_model ?? 'unknown model'}): names and numbers may be misheard; every figure in it is the speaker's dated claim, not a fact`;
  }
  if (doc.kind === 'post') return "the issuer's own post: a dated claim";
  return doc.kind;
}

interface Row {
  id: number;
  asset_id: string;
  kind: DocKind;
  source_url: string;
  source_id: string | null;
  title: string | null;
  published_at: string | null;
  added_at: string;
  sha256: string;
  bytes: number;
  text: string;
  meta_json: string;
}

const fromRow = (r: Row): StoredDocument => ({
  id: r.id, assetId: r.asset_id, kind: r.kind, sourceUrl: r.source_url, sourceId: r.source_id, title: r.title,
  publishedAt: r.published_at, addedAt: r.added_at, sha256: r.sha256, bytes: r.bytes, text: r.text,
  meta: JSON.parse(r.meta_json) as Record<string, string>,
});

/**
 * Stores a document, normalized and hashed. Idempotent on (asset, sha256): the same text again returns the stored row
 * with `existing: true`, whatever the other fields say. A different text from the same URL (a re-transcription) is a new row.
 */
export function insertDocument(db: Db, input: NewDocument): { doc: StoredDocument; existing: boolean } {
  const text = normalizeDocText(input.text);
  const hash = sha256(text);
  const found = db.prepare('SELECT * FROM documents WHERE asset_id = ? AND sha256 = ?').get(input.assetId, hash) as Row | undefined;
  if (found) return { doc: fromRow(found), existing: true };
  const info = db
    .prepare('INSERT INTO documents (asset_id, kind, source_url, source_id, title, published_at, added_at, sha256, bytes, text, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      input.assetId, input.kind, input.sourceUrl, input.sourceId, input.title, input.publishedAt, input.addedAt, hash,
      Buffer.byteLength(text, 'utf8'), text, JSON.stringify(input.meta),
    );
  return { doc: getDocument(db, Number(info.lastInsertRowid))!, existing: false };
}

export function getDocument(db: Db, id: number): StoredDocument | null {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/**
 * Newest first, without the text (`text` is ''). `supersededByNewer`: a later row of the same asset has the same source
 * URL, i.e. the document was stored again (a re-transcription) and this row is the older reading.
 */
export function listDocuments(db: Db, opts: { assetId?: string } = {}): (StoredDocument & { supersededByNewer: boolean })[] {
  const columns = `d.id, d.asset_id, d.kind, d.source_url, d.source_id, d.title, d.published_at, d.added_at, d.sha256, d.bytes, '' AS text, d.meta_json,
    EXISTS (SELECT 1 FROM documents n WHERE n.asset_id = d.asset_id AND n.source_url = d.source_url AND n.id > d.id) AS superseded`;
  const rows = (
    opts.assetId === undefined
      ? db.prepare(`SELECT ${columns} FROM documents d ORDER BY d.id DESC`).all()
      : db.prepare(`SELECT ${columns} FROM documents d WHERE d.asset_id = ? ORDER BY d.id DESC`).all(opts.assetId)
  ) as (Row & { superseded: number })[];
  return rows.map((r) => ({ ...fromRow(r), supersededByNewer: r.superseded === 1 }));
}
