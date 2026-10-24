import { OrionError } from '../types.js';
import { sha256 } from '../util/canonical.js';
import type { Db } from './connection.js';

export const DOC_KINDS = ['machine_transcript', 'transcript', 'post', 'filing', 'article'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/**
 * A verified citation, as it is stored (proposals, journal catalysts, dev findings). `locator` is a transcript's `mm:ss`
 * stamp; the doc fields are null for a page. The agent layer verifies it (guardrails); the db layer only stores it.
 */
export interface StoredCitation {
  source: string;
  quotedText: string;
  locator: string | null;
  docSha256: string | null;
  docKind: DocKind | null;
}

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

/** `meta` rules, shared by the store and `doc add`: keys of 1 to 32 characters a-z or _, string values of at most 200. */
export const META_KEY = /^[a-z_]{1,32}$/;
export const MAX_META_VALUE = 200;

/** A date `YYYY-MM-DD`, or an instant with a zone (`Z` or `+hh:mm`), seconds and milliseconds optional. */
const ISO_DATE_OR_INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

export function isIsoDateOrInstant(text: string): boolean {
  const m = ISO_DATE_OR_INSTANT.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && Number.isFinite(Date.parse(text));
}

/** Refuses what the store must never hold, whoever calls it (the CLI checks the same rules first, with flag names). */
function checkDocument(input: NewDocument): void {
  if (!(DOC_KINDS as readonly string[]).includes(input.kind)) throw new OrionError('invalid_doc_kind', `kind must be one of ${DOC_KINDS.join(', ')}, got "${input.kind}"`);
  if (input.publishedAt !== null && !isIsoDateOrInstant(input.publishedAt)) {
    throw new OrionError('invalid_published_at', `published_at must be an ISO date (YYYY-MM-DD) or an instant with a zone (e.g. 2026-10-22T16:00:00Z), got "${input.publishedAt}"`);
  }
  for (const [key, value] of Object.entries(input.meta)) {
    if (!META_KEY.test(key)) throw new OrionError('invalid_meta', `meta key "${key}" must be 1 to 32 characters a-z or _`);
    if (typeof value !== 'string') throw new OrionError('invalid_meta', `meta ${key}: the value must be a string`);
    if (value.length > MAX_META_VALUE) throw new OrionError('invalid_meta', `meta ${key}: the value is ${value.length} characters; the limit is ${MAX_META_VALUE}`);
  }
}

/**
 * Stores a document, normalized and hashed. Idempotent on (asset, sha256): the same text again returns the stored row
 * with `existing: true`, whatever the other fields say. A different text from the same URL (a re-transcription) is a new row.
 * The insert comes first and yields to the unique index, so a second writer storing the same text at the same moment
 * (the watcher beside a hand-run `doc add`) gets the stored row back rather than a UNIQUE error.
 */
export function insertDocument(db: Db, input: NewDocument): { doc: StoredDocument; existing: boolean } {
  checkDocument(input);
  const text = normalizeDocText(input.text);
  const hash = sha256(text);
  const info = db
    .prepare(
      'INSERT INTO documents (asset_id, kind, source_url, source_id, title, published_at, added_at, sha256, bytes, text, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (asset_id, sha256) DO NOTHING',
    )
    .run(
      input.assetId, input.kind, input.sourceUrl, input.sourceId, input.title, input.publishedAt, input.addedAt, hash,
      Buffer.byteLength(text, 'utf8'), text, JSON.stringify(input.meta),
    );
  if (info.changes === 0) {
    const found = db.prepare('SELECT * FROM documents WHERE asset_id = ? AND sha256 = ?').get(input.assetId, hash) as Row;
    return { doc: fromRow(found), existing: true };
  }
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
