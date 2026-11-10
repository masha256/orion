import { createHash, randomUUID } from 'node:crypto';
import type { OrionEnv } from '../cli/paths.js';
import type { OutboxRow } from '../db/snapshotsOut.js';
import { OrionError } from '../types.js';
import { canonicalJson, sha256 } from '../util/canonical.js';
import { signManifest } from './sign.js';

/**
 * The snapshot format (spec 9.1), bumped when a body change breaks readers. 2 (Task 11b, G4): a `full` body's per-asset
 * `report` is the v2 `report yield --json` object, without the v1 keys (`flows`, `buckets`, `yields`, `holderFlowGrowth`,
 * `supply`, `income`, `revenue`, `volume`, `revenueDisclosed`) that 1 carried; the `levels` body is unchanged.
 */
export const SNAPSHOT_SCHEMA = 'orion.snapshot/2';
/** Envelopes the outbox may still hold: a row the previous release queued publishes as it was written. */
export const KNOWN_SNAPSHOT_SCHEMAS: readonly string[] = ['orion.snapshot/1', SNAPSHOT_SCHEMA];

export type SnapshotKind = 'full' | 'levels';

export interface SnapshotEnvelope {
  /** SNAPSHOT_SCHEMA when built; a queued row of the previous release may carry an older KNOWN_SNAPSHOT_SCHEMAS one. */
  schema: string;
  kind: SnapshotKind;
  /** uuid */
  snapshot_id: string;
  /** Per kind, increasing (assigned by the outbox). */
  seq: number;
  generated_at: string;
  env: OrionEnv;
  release_tag: string | null;
  /** sha256 of `canonicalJson(body)`. */
  sha256: string;
  body: unknown;
}

export function buildEnvelope(
  kind: SnapshotKind,
  body: unknown,
  o: { seq: number; env: OrionEnv; releaseTag: string | null; now: Date; uuid?: () => string },
): SnapshotEnvelope {
  return {
    schema: SNAPSHOT_SCHEMA, kind, snapshot_id: (o.uuid ?? randomUUID)(), seq: o.seq, generated_at: o.now.toISOString(), env: o.env,
    release_tag: o.releaseTag, sha256: sha256(canonicalJson(body)), body,
  };
}

/** The published bytes of a JSON file: canonical JSON and one newline. */
const fileText = (value: unknown): string => `${canonicalJson(value)}\n`;
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const MANIFEST_PATH = 'manifest.json';
export const SIGNATURE_PATH = 'manifest.json.sig';
export const FULL_LATEST_PATH = 'full/latest.json';
export const LEVELS_LATEST_PATH = 'levels/latest.json';
export const ASSETS_PATH = 'assets.json';
export const fullDayPath = (day: string): string => `full/${day.slice(0, 4)}/${day}.json`;

/**
 * The spec 9.2 file set for one publish: `full/latest.json` and `full/YYYY/YYYY-MM-DD.json` (from `full`, when there
 * is one), `levels/latest.json` (from `levels`), `assets.json`, then `manifest.json` (the sha256 of each file's exact
 * bytes) and `manifest.json.sig` (base64 Ed25519 over the manifest's exact bytes, no newline). A writer that cannot
 * replace all files at once (the S3 driver) must write the two manifest files last.
 *
 * The manifest also names `assets.json` and its hash (`assets: { path, sha256 }`), so every published file is covered
 * by the signature.
 */
export function buildFileSet(
  state: { full: OutboxRow | null; levels: OutboxRow | null; assets: unknown; env: OrionEnv; releaseTag: string | null; now: Date },
  signKeyPem: string,
): Record<string, string> {
  const files: Record<string, string> = {};
  let full: { seq: number; day: string; path: string; sha256: string } | null = null;
  let levels: { seq: number; generated_at: string; path: string; sha256: string } | null = null;
  if (state.full) {
    const envelope = parseEnvelope(state.full, 'full');
    const day = state.full.day ?? envelope.generated_at.slice(0, 10);
    const text = fileText(envelope);
    files[FULL_LATEST_PATH] = text;
    files[fullDayPath(day)] = text;
    full = { seq: envelope.seq, day, path: fullDayPath(day), sha256: hashOf(text) };
  }
  if (state.levels) {
    const envelope = parseEnvelope(state.levels, 'levels');
    const text = fileText(envelope);
    files[LEVELS_LATEST_PATH] = text;
    levels = { seq: envelope.seq, generated_at: envelope.generated_at, path: LEVELS_LATEST_PATH, sha256: hashOf(text) };
  }
  files[ASSETS_PATH] = fileText(state.assets);
  const manifest = fileText({
    schema: SNAPSHOT_SCHEMA, env: state.env, release_tag: state.releaseTag, generated_at: state.now.toISOString(), full, levels,
    assets: { path: ASSETS_PATH, sha256: hashOf(files[ASSETS_PATH]) },
  });
  files[MANIFEST_PATH] = manifest;
  files[SIGNATURE_PATH] = signManifest(Buffer.from(manifest, 'utf8'), signKeyPem);
  return files;
}

/** The row's envelope, checked against the row it came from (a hand-edited outbox row is refused, not published). */
function parseEnvelope(row: OutboxRow, kind: SnapshotKind): SnapshotEnvelope {
  const e = JSON.parse(row.body) as SnapshotEnvelope;
  if (row.kind !== kind || e.kind !== kind || e.seq !== row.seq || !KNOWN_SNAPSHOT_SCHEMAS.includes(e.schema) || e.sha256 !== row.sha256 || sha256(canonicalJson(e.body)) !== e.sha256) {
    throw new OrionError('snapshot_corrupt', `snapshots_out row ${row.id} (${row.kind} seq ${row.seq}) does not match its envelope`);
  }
  return e;
}
