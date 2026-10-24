import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { loadAsset } from '../../config/load.js';
import { DOC_KINDS, docLabel, getDocument, insertDocument, isIsoDateOrInstant, listDocuments, MAX_META_VALUE, META_KEY, normalizeDocText, type DocKind, type StoredDocument } from '../../db/documents.js';
import { OrionError } from '../../types.js';
import { guarded, output, parseNumber, withDb, type CliContext } from '../util.js';

const MAX_DOC_BYTES = 512 * 1024;
/** One Whisper segment per line: `[mm:ss] text`, minutes in two or three digits. */
const TRANSCRIPT_LINE = /^\[\d{2,3}:\d{2}\] \S/;

const collect = (value: string, previous: string[]): string[] => [...previous, value];
const isDocKind = (x: string): x is DocKind => (DOC_KINDS as readonly string[]).includes(x);

function checkUrl(text: string): void {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OrionError('invalid_url', `--url must be an http(s) URL, got "${text}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OrionError('invalid_url', `--url must be an http(s) URL, got "${text}"`);
}

/** The file's text, checked: present, at most 512 KiB, UTF-8, not blank. Normalization is left to the store. */
function readDocFile(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw new OrionError('file_not_found', `no file at ${path}`);
  const bytes = readFileSync(path);
  if (bytes.length > MAX_DOC_BYTES) throw new OrionError('document_too_large', `${path} is ${bytes.length} bytes; the limit is ${MAX_DOC_BYTES} (512 KiB)`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OrionError('invalid_utf8', `${path} is not valid UTF-8`);
  }
  if (normalizeDocText(text).trim() === '') throw new OrionError('empty_document', `${path} is empty`);
  return text;
}

function checkTranscript(text: string): void {
  const lines = normalizeDocText(text).split('\n');
  const bad = lines.findIndex((line) => line !== '' && !TRANSCRIPT_LINE.test(line));
  if (bad !== -1) {
    throw new OrionError('invalid_transcript', `line ${bad + 1} is not a "[mm:ss] text" segment: ${JSON.stringify(lines[bad]!.slice(0, 80))}`);
  }
}

function parseMeta(pairs: string[]): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (eq === -1 || !META_KEY.test(key)) throw new OrionError('invalid_meta', `--meta must be key=value with a key of 1 to 32 characters a-z or _, got "${pair}"`);
    const value = pair.slice(eq + 1);
    if (value.length > MAX_META_VALUE) throw new OrionError('invalid_meta', `--meta ${key}: the value is ${value.length} characters; the limit is ${MAX_META_VALUE}`);
    if (Object.hasOwn(meta, key)) throw new OrionError('invalid_meta', `--meta ${key} given twice`);
    meta[key] = value;
  }
  return meta;
}

const withoutText = <T extends StoredDocument>({ text: _text, ...rest }: T): Omit<T, 'text'> => rest;

function docLine(d: StoredDocument & { supersededByNewer: boolean }): string {
  return (
    `#${d.id}  ${d.addedAt}  ${d.assetId}  ${d.kind}  ${d.publishedAt ?? 'published ?'}  ${d.sha256.slice(0, 12)}  ${d.sourceUrl}` +
    `${d.title ? `  "${d.title}"` : ''}${d.supersededByNewer ? '  superseded_by_newer' : ''}`
  );
}

export function registerDoc(program: Command, ctx: CliContext): void {
  const doc = program.command('doc').description('stored source documents (call transcripts, posts, filings) that a run can cite; append-only');

  doc
    .command('add <asset>')
    .description('store a document; the same text again returns the stored row (existing: true)')
    .requiredOption('--url <url>', 'where the document comes from (http or https)')
    .requiredOption('--file <path>', 'the text, UTF-8, at most 512 KiB')
    .requiredOption('--kind <kind>', DOC_KINDS.join(' | '))
    .option('--published-at <iso>', 'when the source was published: YYYY-MM-DD, or an instant with a zone (2026-10-22T16:00:00Z)')
    .option('--title <text>', 'a title for display')
    .option('--source-id <platform:id>', "the watcher's dedupe key, e.g. x:2113065839352336774")
    .option('--meta <key=value>', 'metadata, e.g. asr_model=... (repeatable)', collect, [])
    .option('--json', 'JSON output')
    .action(
      (assetId: string, opts: { url: string; file: string; kind: string; publishedAt?: string; title?: string; sourceId?: string; meta: string[]; json?: boolean }) =>
        guarded(ctx, opts.json, () => {
          if (!isDocKind(opts.kind)) throw new OrionError('invalid_doc_kind', `--kind must be one of ${DOC_KINDS.join(', ')}, got "${opts.kind}"`);
          const kind = opts.kind;
          loadAsset(ctx.home, assetId);
          checkUrl(opts.url);
          if (opts.publishedAt !== undefined && !isIsoDateOrInstant(opts.publishedAt)) {
            throw new OrionError('invalid_published_at', `--published-at must be an ISO date (YYYY-MM-DD) or an instant with a zone (e.g. 2026-10-22T16:00:00Z), got "${opts.publishedAt}"`);
          }
          const text = readDocFile(opts.file);
          if (kind === 'machine_transcript') checkTranscript(text);
          const meta = parseMeta(opts.meta);
          const { doc: stored, existing } = withDb(ctx, (db) =>
            insertDocument(db, {
              assetId, kind, sourceUrl: opts.url, sourceId: opts.sourceId ?? null, title: opts.title ?? null,
              publishedAt: opts.publishedAt ?? null, addedAt: ctx.now().toISOString(), meta, text,
            }),
          );
          const result = { id: stored.id, asset: stored.assetId, kind: stored.kind, sha256: stored.sha256, bytes: stored.bytes, existing };
          output(ctx, opts.json, result, () => [
            `${existing ? 'already stored as' : 'stored'} doc #${stored.id}  ${stored.assetId}  ${stored.kind}  ${stored.bytes} bytes  sha256 ${stored.sha256}`,
          ]);
        }),
    );

  doc
    .command('list [asset]')
    .description('newest first; an older reading of a re-transcribed source is marked superseded_by_newer')
    .option('--json', 'JSON output')
    .action((assetId: string | undefined, opts: { json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const list = withDb(ctx, (db) => listDocuments(db, { assetId }));
        output(ctx, opts.json, list.map(withoutText), () => (list.length === 0 ? ['no documents'] : list.map(docLine)));
      }),
    );

  doc
    .command('show <id>')
    .description("metadata and the kind's label")
    .option('--text', 'include the stored text')
    .option('--json', 'JSON output')
    .action((id: string, opts: { text?: boolean; json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const docId = parseNumber(id, 'id');
        const found = withDb(ctx, (db) => getDocument(db, docId));
        if (!found) throw new OrionError('doc_not_found', `no document with id ${docId}`);
        const label = docLabel(found);
        output(ctx, opts.json, { ...(opts.text ? found : withoutText(found)), label }, () => [
          `#${found.id}  ${found.assetId}  ${found.kind}${found.title ? `  "${found.title}"` : ''}`,
          `label: ${label}`,
          `source ${found.sourceUrl}${found.sourceId ? `  (${found.sourceId})` : ''}`,
          `published ${found.publishedAt ?? 'unknown'}  added ${found.addedAt}`,
          `sha256 ${found.sha256}  ${found.bytes} bytes`,
          ...Object.entries(found.meta).map(([k, v]) => `meta ${k}: ${v}`),
          ...(opts.text ? ['', found.text.replace(/\n$/, '')] : []),
        ]);
      }),
    );
}
