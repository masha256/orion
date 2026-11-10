import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * The manifest signature (spec 9.2): Ed25519 over the exact bytes of `manifest.json`, base64. The private key is
 * `ORION_SIGN_KEY_FILE` (PEM, `openssl genpkey -algorithm ed25519`); the site holds the public half.
 *
 * What the site checks before it trusts a snapshot (and otherwise keeps serving what it has):
 *  1. `verifyManifest(manifest.json bytes, manifest.json.sig, public key)` is true;
 *  2. every file the manifest names (`full.path`, `levels.path`, `assets.path`) has the sha256 the manifest gives,
 *     over its exact bytes;
 *  3. `schema` is one it knows (`orion.snapshot/2` since Task 11b; `/1` for an envelope queued before it), in the
 *     manifest and in each envelope;
 *  4. `full.seq` / `levels.seq` is newer than the one it holds (per kind).
 */

export function signManifest(bytes: Buffer, keyPem: string): string {
  return sign(null, bytes, createPrivateKey(keyPem)).toString('base64');
}

/** A PEM public key, or the bare base64 of its SPKI DER (what the site may store). */
function publicKey(key: string): KeyObject {
  const text = key.trim();
  if (text.startsWith('-----BEGIN')) return createPublicKey(text);
  return createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
}

/** Whether `sigB64` is a valid signature of `bytes` by the key's private half. Never throws on a malformed signature. */
export function verifyManifest(bytes: Buffer, sigB64: string, publicKeyPem: string): boolean {
  const sig = sigB64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return false;
  try {
    return verify(null, bytes, publicKey(publicKeyPem), Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}
