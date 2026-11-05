import type { Json, Locator } from './types.js';

/**
 * Scrubbing (spec §3, Review Focus 4): a locator never holds a key. No imports beyond the types, so the observation store
 * can use it without pulling in the source registry.
 */

/**
 * Secrets are dropped by context, not by a name's suffix (a `token` param holding a symbol is not a secret):
 * - URL query parameters named key, apikey, api_key, token, access_token, secret (any case; `api-key` is api_key), and
 *   drpc's `dkey`;
 * - locator object keys named authorization, password, secret, api_key, apikey, and every key inside a `headers` or
 *   `auth` object.
 */
const normalized = (name: string): string => name.toLowerCase().replace(/[-_]/g, '');
const SECRET_QUERY_KEYS: ReadonlySet<string> = new Set(['key', 'apikey', 'token', 'accesstoken', 'secret', 'dkey']);
const SECRET_OBJECT_KEYS: ReadonlySet<string> = new Set(['authorization', 'password', 'secret', 'apikey']);
/** Objects whose every key is a credential (or may be): emptied. */
const CREDENTIAL_OBJECTS: ReadonlySet<string> = new Set(['headers', 'auth']);
/** A URL query parameter that carries a credential. */
export const isSecretQueryKey = (name: string): boolean => SECRET_QUERY_KEYS.has(normalized(name));
/** A locator object key that carries a credential. */
export const isSecretName = (name: string): boolean => SECRET_OBJECT_KEYS.has(normalized(name));

/** Hosts whose path carries the RPC key (`/v2/<key>`, `/v3/<key>`, `/<network>/<key>`): every segment but a version is dropped. */
const KEYED_PATH_HOST = /(^|\.)(alchemy\.com|infura\.io|drpc\.org|publicnode\.com|quiknode\.pro|ankr\.com|blastapi\.io|chainstack\.com|helius-rpc\.com|nodereal\.io|getblock\.io)$/;
/** A path segment that looks like a key wherever it appears: 20+ characters of key alphabet with a digit in them. */
const KEY_LIKE_SEGMENT = /^(?=.*[0-9])[A-Za-z0-9_-]{20,}$/;
/** An EVM address or hash: where a value was read, never a key. */
const HEX_ADDRESS = /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * A URL with every credential removed: user info, the credential query parameters, the key path segments of a keyed
 * RPC host (every non-version segment on a known provider; elsewhere a key-shaped last segment after `/vN/`) and any
 * key-like segment (an EVM address or hash is kept off the keyed hosts), and the fragment. A string that is not a URL
 * is returned unchanged.
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
  for (const k of [...u.searchParams.keys()]) if (isSecretQueryKey(k)) u.searchParams.delete(k);
  const segments = u.pathname.split('/').filter((s) => s !== '');
  const kept: string[] = [];
  const keyedHost = KEYED_PATH_HOST.test(u.hostname);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (!keyedHost && HEX_ADDRESS.test(s)) {
      kept.push(s);
      continue;
    }
    // `/v2/<key>` on a host not listed: the last segment after a version, when it has a key's shape (a digit or `_`).
    if (i === segments.length - 1 && i > 0 && /^v\d+$/.test(segments[i - 1]!) && /^[A-Za-z0-9_-]{8,}$/.test(s) && /[0-9_]/.test(s)) continue;
    if (keyedHost && !/^v\d+$/.test(s)) continue;
    if (KEY_LIKE_SEGMENT.test(s)) continue;
    kept.push(s);
  }
  u.pathname = `/${kept.join('/')}`;
  return u.toString();
}

/** The locator with every credential removed: secret keys dropped, headers/auth emptied, every URL string scrubbed (recursively). */
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
    for (const [k, x] of Object.entries(v)) {
      if (isSecretName(k)) continue;
      out[k] = CREDENTIAL_OBJECTS.has(k.toLowerCase()) && x !== null && typeof x === 'object' && !Array.isArray(x) ? {} : scrubJson(x);
    }
    return out;
  }
  return v;
}

