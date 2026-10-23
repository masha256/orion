import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { docLabel, normalizeDocText } from '../../src/db/documents.js';
import { sha256 } from '../../src/util/canonical.js';
import { AGENT_ASSET_YAML } from '../helpers/agentWorld.js';
import { AS_OF } from '../helpers/obs.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/disclosure/lit-q3-2026-call-transcript.txt', import.meta.url));
const SOURCE_URL = 'https://x.com/Lighter_xyz/status/2113065839352336774';
const LABEL = (model: string) =>
  `machine transcript (${model}): names and numbers may be misheard; every figure in it is the speaker's dated claim, not a fact`;

let home: string;
let exitCode: number | undefined;

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  exitCode = undefined;
  const program = buildProgram({ home, stdout: (l) => lines.push(l), now: () => new Date(AS_OF), setExitCode: (c) => (exitCode = c) });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const json = async (...args: string[]) => JSON.parse(await orion(...args, '--json')) as Record<string, unknown>;
const file = (name: string, content: string | Buffer): string => {
  const path = join(home, name);
  writeFileSync(path, content);
  return path;
};
const add = (path: string, ...extra: string[]) =>
  json('doc', 'add', 'mini', '--url', SOURCE_URL, '--file', path, '--kind', 'machine_transcript', ...extra);
const errorOf = (out: Record<string, unknown>) => out.error as { code: string; message: string };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-doc-cli-'));
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), AGENT_ASSET_YAML.trimStart());
});

describe('docLabel', () => {
  it('labels each kind with the fixed copy', () => {
    expect(docLabel({ kind: 'machine_transcript', meta: { asr_model: 'faster-whisper large-v3' } })).toBe(LABEL('faster-whisper large-v3'));
    expect(docLabel({ kind: 'machine_transcript', meta: {} })).toBe(LABEL('unknown model'));
    expect(docLabel({ kind: 'post', meta: {} })).toBe("the issuer's own post: a dated claim");
    expect(docLabel({ kind: 'filing', meta: {} })).toBe('filing');
    expect(docLabel({ kind: 'transcript', meta: {} })).toBe('transcript');
    expect(docLabel({ kind: 'article', meta: {} })).toBe('article');
  });
});

describe('orion doc', () => {
  it('adds the Q3 fixture as a machine transcript and prints its sha256', async () => {
    const raw = readFileSync(FIXTURE, 'utf8');
    const out = await add(FIXTURE, '--published-at', '2026-10-22T16:00:00Z', '--title', 'Lighter Q3 2026 investor update', '--source-id', 'x:2113065839352336774',
      '--meta', 'asr_model=faster-whisper large-v3', '--meta', 'duration_s=2710');
    expect(exitCode).toBeUndefined();
    expect(out).toEqual({ id: 1, asset: 'mini', kind: 'machine_transcript', sha256: sha256(normalizeDocText(raw)), bytes: Buffer.byteLength(normalizeDocText(raw)), existing: false });
    // The fixture is already in the stored form, so the hash is over its bytes as they are.
    expect(out.sha256).toBe(sha256(raw));
    expect(await orion('doc', 'add', 'mini', '--url', SOURCE_URL, '--file', FIXTURE, '--kind', 'machine_transcript')).toContain(String(out.sha256));
  });

  it('a second add of the same file returns existing: true and exit 0', async () => {
    const first = await add(FIXTURE);
    // The same text with a BOM, CRLF line ends and no final newline is the same document.
    const raw = readFileSync(FIXTURE, 'utf8');
    const variant = file('variant.txt', '\uFEFF' + raw.replace(/\n/g, '\r\n').replace(/\r\n$/, ''));
    const second = await add(variant);
    expect(exitCode).toBeUndefined();
    expect(second).toEqual({ ...first, existing: true });
    expect((await json('doc', 'list')) as unknown as unknown[]).toHaveLength(1);
  });

  it('refuses a machine transcript with a line that has no [mm:ss] stamp', async () => {
    const out = await add(file('bad.txt', '[00:00] Hello there.\n\n[00:03] and then\n[0:05] no\n'));
    expect(exitCode).toBe(1);
    expect(errorOf(out).code).toBe('invalid_transcript');
    expect(errorOf(out).message).toContain('line 4');
    const missing = await add(file('bad2.txt', '[00:00] Hello there.\n[00:02] Two\nthree without a stamp\n'));
    expect(errorOf(missing)).toMatchObject({ code: 'invalid_transcript' });
    expect(errorOf(missing).message).toContain('line 3');
    // A stamp with nothing after it is not a segment either; three-digit minutes are.
    expect(errorOf(await add(file('bad3.txt', '[00:00] \n'))).code).toBe('invalid_transcript');
    expect((await add(file('long.txt', '[120:00] Two hours in.\n'))).existing).toBe(false);
    // Other kinds have no line rule.
    expect((await json('doc', 'add', 'mini', '--url', SOURCE_URL, '--file', file('post.txt', 'just a post\n'), '--kind', 'post')).existing).toBe(false);
    await expect(orion('doc', 'add', 'mini', '--url', SOURCE_URL, '--file', file('bad4.txt', 'no stamp\n'), '--kind', 'machine_transcript')).rejects.toMatchObject({ code: 'invalid_transcript' });
  });

  it('refuses a non-http url, an unknown kind, an unknown asset, an empty file and a file over 512 KiB', async () => {
    const ok = file('ok.txt', '[00:00] Fine.\n');
    const codeOf = async (...args: string[]) => {
      const out = await json('doc', 'add', ...args);
      expect(exitCode).toBe(1);
      return errorOf(out).code;
    };
    expect(await codeOf('mini', '--url', 'ftp://example.com/a', '--file', ok, '--kind', 'post')).toBe('invalid_url');
    expect(await codeOf('mini', '--url', 'not a url', '--file', ok, '--kind', 'post')).toBe('invalid_url');
    expect(await codeOf('mini', '--url', SOURCE_URL, '--file', ok, '--kind', 'tweet')).toBe('invalid_doc_kind');
    expect(await codeOf('ghost', '--url', SOURCE_URL, '--file', ok, '--kind', 'post')).toBe('asset_not_found');
    expect(await codeOf('mini', '--url', SOURCE_URL, '--file', file('empty.txt', ''), '--kind', 'post')).toBe('empty_document');
    expect(await codeOf('mini', '--url', SOURCE_URL, '--file', file('blank.txt', '\uFEFF\r\n\n'), '--kind', 'post')).toBe('empty_document');
    expect(await codeOf('mini', '--url', SOURCE_URL, '--file', join(home, 'missing.txt'), '--kind', 'post')).toBe('file_not_found');
    expect(await codeOf('mini', '--url', SOURCE_URL, '--file', file('big.txt', 'a'.repeat(512 * 1024 + 1)), '--kind', 'post')).toBe('document_too_large');
    expect(await codeOf('mini', '--url', SOURCE_URL, '--file', file('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), '--kind', 'post')).toBe('invalid_utf8');
    // Exactly 512 KiB is accepted.
    expect((await json('doc', 'add', 'mini', '--url', SOURCE_URL, '--file', file('max.txt', 'a'.repeat(512 * 1024 - 1) + '\n'), '--kind', 'post')).existing).toBe(false);
    expect((await json('doc', 'list')) as unknown as unknown[]).toHaveLength(1);
  });

  it('refuses a bad --meta key or a value over 200 characters', async () => {
    const ok = file('ok.txt', '[00:00] Fine.\n');
    for (const meta of ['ASR=x', 'asr-model=x', 'a'.repeat(33) + '=x', '=x', 'noequals', `asr_model=${'x'.repeat(201)}`]) {
      const out = await add(ok, '--meta', meta);
      expect(exitCode, meta).toBe(1);
      expect(errorOf(out).code, meta).toBe('invalid_meta');
    }
    expect(errorOf(await add(ok, '--meta', 'asr_model=a', '--meta', 'asr_model=b')).code).toBe('invalid_meta');
    const out = await add(ok, '--meta', `${'a'.repeat(32)}=${'x'.repeat(200)}`, '--meta', 'note=a=b');
    expect(out.existing).toBe(false);
    expect(((await json('doc', 'show', '1')).meta as Record<string, string>).note).toBe('a=b');
  });

  it('show prints the label; --text adds the text; list marks superseded_by_newer', async () => {
    await add(file('v1.txt', '[00:00] First reading.\n'), '--meta', 'asr_model=faster-whisper large-v3', '--title', 'Q3 call');
    await add(file('v2.txt', '[00:00] Second reading.\n'), '--meta', 'asr_model=faster-whisper large-v3', '--title', 'Q3 call');
    await json('doc', 'add', 'mini', '--url', 'https://x.com/Lighter_xyz/status/1', '--file', file('p.txt', 'A post.\n'), '--kind', 'post');

    const shown = await orion('doc', 'show', '1');
    expect(shown).toContain(LABEL('faster-whisper large-v3'));
    expect(shown).toContain(SOURCE_URL);
    expect(shown).toContain('Q3 call');
    expect(shown).not.toContain('First reading.');
    expect(await orion('doc', 'show', '1', '--text')).toContain('[00:00] First reading.');
    expect(await orion('doc', 'show', '3')).toContain("the issuer's own post: a dated claim");

    const shownJson = await json('doc', 'show', '1');
    expect(shownJson).toMatchObject({ id: 1, kind: 'machine_transcript', label: LABEL('faster-whisper large-v3') });
    expect(shownJson).not.toHaveProperty('text');
    expect((await json('doc', 'show', '1', '--text')).text).toBe('[00:00] First reading.\n');

    const missing = await json('doc', 'show', '99');
    expect(exitCode).toBe(1);
    expect(errorOf(missing).code).toBe('doc_not_found');

    const listed = await orion('doc', 'list');
    const lines = listed.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^#3 /);
    expect(lines[2]).toMatch(/^#1 .*superseded_by_newer/);
    expect(lines[1]).not.toContain('superseded_by_newer');
    const rows = (await json('doc', 'list', 'mini')) as unknown as { id: number; supersededByNewer: boolean }[];
    expect(rows.map((r) => [r.id, r.supersededByNewer])).toEqual([[3, false], [2, false], [1, true]]);
    expect(rows[0]).not.toHaveProperty('text');
    expect(await orion('doc', 'list', 'other')).toBe('no documents');
  });
});
