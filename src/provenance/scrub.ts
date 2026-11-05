import type { Json, Locator } from './types.js';

/**
 * Scrubbing (spec §3, Review Focus 4): a locator never holds a key. No imports beyond the types, so the observation store
 * can use it without pulling in the source registry.
 */

/** Query keys that carry a credential: `key`, `apikey`, `api_key`, `api-key`, `token`, and anything ending in key/token/secret. */
const SECRET_NAME = /^(key|apikey|token|secret|password|auth|authorization|dkey)$|(key|token|secret)$/;
const normalized = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
export const isSecretName = (name: string): boolean => SECRET_NAME.test(normalized(name));

/** Hosts whose path carries the RPC key (`/v2/<key>`, `/v3/<key>`, `/<network>/<key>`): every segment but a version is dropped. */
const KEYED_PATH_HOST = /(^|\.)(alchemy\.com|infura\.io|drpc\.org|publicnode\.com|quiknode\.pro|ankr\.com|blastapi\.io|chainstack\.com|helius-rpc\.com|nodereal\.io|getblock\.io)$/;
/** A path segment that looks like a key wherever it appears: 20+ characters of key alphabet with a digit in them. */
const KEY_LIKE_SEGMENT = /^(?=.*[0-9])[A-Za-z0-9_-]{20,}$/;

/**
 * A URL with every credential removed: user info, query keys named like a key or token, the key path segments of a
 * keyed RPC host (every non-version segment on a known provider; elsewhere a key-shaped last segment after `/vN/`) and
 * any key-like segment, and the fragment. A string that is not a URL is returned unchanged.
 */
export function scrubUrl(text: string): string {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return text;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return text;
  u.username = '';
  u.password = '';
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (isSecretName(k)) u.searchParams.delete(k);
  const segments = u.pathname.split('/').filter((s) => s !== '');
  const kept: string[] = [];
  const keyedHost = KEYED_PATH_HOST.test(u.hostname);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    // `/v2/<key>` on a host not listed: the last segment after a version, when it has a key's shape (a digit or `_`).
    if (i === segments.length - 1 && i > 0 && /^v\d+$/.test(segments[i - 1]!) && /^[A-Za-z0-9_-]{8,}$/.test(s) && /[0-9_]/.test(s)) continue;
    if (keyedHost && !/^v\d+$/.test(s)) continue;
    if (KEY_LIKE_SEGMENT.test(s)) continue;
    kept.push(s);
  }
  u.pathname = `/${kept.join('/')}`;
  return u.toString();
}

/** The locator with every credential removed: keys named like a secret dropped, every URL string scrubbed (recursively). */
export function scrubLocator(l: Locator): Locator {
  return scrubJson(l) as Locator;
}

/** Every URL inside a text (a note that quotes one, a whole-string URL) scrubbed. */
export function scrubText(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, (u) => scrubUrl(u));
}

function scrubJson(v: Json): Json {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubJson);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) if (!isSecretName(k)) out[k] = scrubJson(x);
    return out;
  }
  return v;
}

