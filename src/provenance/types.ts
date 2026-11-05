import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRelease } from '../cli/paths.js';
import type { SourceType } from '../report/sourceTypes.js';
import { OrionError } from '../types.js';
import { sha256 } from '../util/canonical.js';
import { scrubLocator } from './scrub.js';

/**
 * Structured provenance on every observation (spec 2026-10-28 §3). Every writer fills one: the `NewObservation` type
 * makes it required, which is what makes provenance mandatory while the 0004 columns are still nullable (plan
 * correction 2). `value`, `source` and `source_detail` are written exactly as before, next to it.
 */

/** How the value came to be (spec §2): read directly, a formula over measured inputs, or a citation (constants too). */
export type ProvenanceMethod = 'measured' | 'derived' | 'disclosed';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Where the value was read, one shape per source type (spec §3): contracts and call, an event with its senders, an
 * API endpoint and request (never a key: see `scrubLocator`), a citation, a formula's inputs, a config path.
 */
export type Locator = { [key: string]: Json };

export interface Provenance {
  method: ProvenanceMethod;
  sourceType: SourceType;
  /** CAIP-2 (`eip155:1`, `solana:mainnet`, `hyperliquid:core`); null off chain. */
  chain: string | null;
  locator: Locator;
  /** First and last block (EVM) or slot read; for a contract read, the block it was read at. */
  blockFrom?: number | null;
  blockTo?: number | null;
  /** Transfers counted into the value. */
  txCount?: number | null;
  /** At most MAX_TX_REFS `txhash:logIndex` refs, the first of the sorted list. */
  txRefs?: string[] | null;
  /** sha256 of the full sorted ref list (`txRefsProvenance`). */
  txDigest?: string | null;
  /** An API row: sha256 of the normalized slice of the response the value came from. */
  responseDigest?: string | null;
  /** A derived row: what it was computed from. */
  inputs?: Json | null;
  /** A derived row: `<function>@<version>`, e.g. `flow_annualized@1`. */
  formula?: string | null;
  /** A pool scan's coverage (Phase 3): null today. */
  coverage?: Json | null;
  /** The orion commit that wrote the row: RELEASE.commit, else `dev`; `pre-v2` on backfilled history. */
  codeVersion: string;
  /** The asset config hash in force; `pre-v2` on backfilled history. */
  configHash: string;
}

export const PROVENANCE_METHODS: readonly ProvenanceMethod[] = ['measured', 'derived', 'disclosed'];
export const MAX_TX_REFS = 50;
/** code_version and config_hash of history the backfill mapped (plan correction 1: there is no config_versions table). */
export const PRE_V2 = 'pre-v2';

/** `txCount`, `txRefs` (sorted, capped at MAX_TX_REFS) and `txDigest` = sha256 of the JSON of the full sorted list. */
export function txRefsProvenance(refs: readonly string[]): Pick<Provenance, 'txCount' | 'txRefs' | 'txDigest'> {
  const sorted = [...refs].sort();
  return {
    txCount: sorted.length,
    txRefs: sorted.length === 0 ? null : sorted.slice(0, MAX_TX_REFS),
    txDigest: sorted.length === 0 ? null : sha256(JSON.stringify(sorted)),
  };
}

/**
 * response_digest: sha256 of the normalized (key-sorted) raw response slice the value was read from; null when the
 * source did not expose one.
 */
export function responseDigest(slice: Json | undefined): string | null {
  return slice === undefined ? null : sha256(JSON.stringify(sortKeys(slice)));
}

/** An API reply's sub-tree as JSON (a parsed reply already is; `undefined` becomes null). */
export const asJson = (v: unknown): Json => (v === undefined ? null : (v as Json));

function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k]!)]));
  return v;
}

let cachedCodeVersion: string | null = null;

/**
 * The commit of the running code: the RELEASE file at the root two levels above this module (`<release>/dist/provenance`),
 * else `dev`. A git checkout is never a release (as `resolvePaths` rules), so a checkout's stray RELEASE is ignored.
 */
export function codeVersion(): string {
  if (cachedCodeVersion === null) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    cachedCodeVersion = existsSync(join(root, '.git')) ? 'dev' : (readRelease(root)?.commit ?? 'dev');
  }
  return cachedCodeVersion;
}

/** A figure a person or the analyst entered from a citation: `disclosed`, rung `disclosure`; the citation is required. */
export function disclosedProvenance(
  configHash: string,
  d: { citationUrl: string | null | undefined; approvedBy: string | null; approvedAt: string | null; proposedBy?: string },
): Provenance {
  if (!d.citationUrl) throw new OrionError('citation_required', 'a disclosed observation requires a citation url (--citation)');
  return {
    method: 'disclosed', sourceType: 'disclosure', chain: null,
    locator: scrubLocator({ citation_url: d.citationUrl, approved_by: d.approvedBy, approved_at: d.approvedAt, ...(d.proposedBy ? { proposed_by: d.proposedBy } : {}) }),
    codeVersion: codeVersion(), configHash,
  };
}
