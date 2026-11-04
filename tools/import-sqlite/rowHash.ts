import { createHash } from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * One value's canonical encoding: `null` → `n`; a number → `d:` + its shortest round-trip text (`-0` kept);
 * a string → `s:` + its length + `:` + the text. Anything else (a boolean, a Date, a Buffer, a bigint) throws: both
 * sides of the proof must read every value as one of these three, and a value of another type means a reader changed.
 */
function encode(v: unknown): string {
  if (v === null) return 'n';
  if (typeof v === 'number') return `d:${Object.is(v, -0) ? '-0' : String(v)}`;
  if (typeof v === 'string') return `s:${v.length}:${v}`;
  throw new TypeError(`rowHash: cannot encode a value of type ${v instanceof Object ? v.constructor.name : typeof v}`);
}

/** sha256 hex of a row's values, encoded and joined by U+001F. */
export function rowHash(values: readonly unknown[]): string {
  return sha256(values.map(encode).join('\u001f'));
}

/** A table's hash: sha256 of its row hashes (rows in primary-key order) joined by `\n`. */
export function tableHash(rowHashes: readonly string[]): string {
  return sha256(rowHashes.join('\n'));
}
