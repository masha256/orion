import { listAssetIds, loadAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import {
  REGISTRY_LOCK, insertRegistryRow, listRegistry, lockRegistryRow, setConfigHash, setRegistryState, type RegistryRow,
} from '../db/registry.js';
import { OrionError } from '../types.js';

/**
 * YAML vs registry (spec 5.3, decision N4). A new YAML arrives `inactive` (it never runs until `orion asset activate`),
 * a row whose YAML is gone becomes `missing` (never run, history kept), a `missing` row whose YAML is back returns as
 * `inactive` (never straight back to running), and a changed YAML only moves `config_hash`. Nothing here makes an asset
 * active.
 */

export interface RegistryDiff {
  added: string[];
  missing: string[];
  returned: string[];
  configChanged: string[];
}

export interface AssetYaml {
  id: string;
  hash: string;
}

/** What `applyReconcile` would do. Pure; every list sorted. */
export function planReconcile(rows: RegistryRow[], yamls: AssetYaml[]): RegistryDiff {
  const byId = new Map(rows.map((r) => [r.assetId, r]));
  const hashes = new Map(yamls.map((y) => [y.id, y.hash]));
  const sorted = (xs: string[]): string[] => [...xs].sort();
  return {
    added: sorted(yamls.filter((y) => !byId.has(y.id)).map((y) => y.id)),
    missing: sorted(rows.filter((r) => r.state !== 'missing' && !hashes.has(r.assetId)).map((r) => r.assetId)),
    returned: sorted(rows.filter((r) => r.state === 'missing' && hashes.has(r.assetId)).map((r) => r.assetId)),
    configChanged: sorted(rows.filter((r) => hashes.has(r.assetId) && hashes.get(r.assetId) !== r.configHash).map((r) => r.assetId)),
  };
}

const releaseLabel = (tag: string | null): string => `release ${tag ?? '(dev checkout)'}`;

/**
 * Writes `diff` in one transaction under the registry lock, one `asset_state_events` row per state change. Each row is
 * re-read under lock first, so a diff that went stale (a concurrent reconcile) writes nothing twice.
 */
export async function applyReconcile(db: Db, diff: RegistryDiff, yamls: AssetYaml[], releaseTag: string | null, now: Date): Promise<void> {
  const hashes = new Map(yamls.map((y) => [y.id, y.hash]));
  const hashOf = (id: string): string => {
    const h = hashes.get(id);
    if (h === undefined) throw new OrionError('reconcile_no_yaml', `the diff names ${id}, but no YAML for it was given`);
    return h;
  };
  const at = now.toISOString();
  const release = releaseLabel(releaseTag);
  await db.tx(async (tx) => {
    for (const id of diff.added) {
      if (await lockRegistryRow(tx, id)) continue;
      await insertRegistryRow(tx, id, 'inactive', hashOf(id), { at, by: 'release', reason: `new in ${release}`, releaseTag });
    }
    for (const id of diff.missing) {
      const row = await lockRegistryRow(tx, id);
      if (!row || row.state === 'missing') continue;
      await setRegistryState(tx, id, row.state, 'missing', { at, by: 'release', reason: `YAML not in ${release}`, releaseTag });
    }
    for (const id of diff.returned) {
      const row = await lockRegistryRow(tx, id);
      if (row?.state !== 'missing') continue;
      await setRegistryState(tx, id, 'missing', 'inactive', { at, by: 'release', reason: `back in ${release}`, releaseTag });
    }
    for (const id of diff.configChanged) await setConfigHash(tx, id, hashOf(id));
  }, { lockAsset: REGISTRY_LOCK });
}

/** Every YAML under `<configRoot>/assets`, loaded and hashed. An invalid one throws `invalid_asset_config`, naming it. */
export function loadAssetYamls(configRoot: string): AssetYaml[] {
  return listAssetIds(configRoot).map((id) => {
    try {
      return { id, hash: loadAsset(configRoot, id).hash };
    } catch (err) {
      if (err instanceof OrionError && err.code === 'invalid_asset_config') throw new OrionError('invalid_asset_config', `${id}: ${err.message}`);
      throw err;
    }
  });
}

/** More rows than this going `missing` in one reconcile is refused (I-3): a partial `assets/` in a release, not a retirement. */
export const MAX_RETIRE_AT_ONCE = 2;

/**
 * Refuses (`reconcile_would_retire`) a diff that would move every non-missing row to `missing` (an empty or absent
 * `assets/`) or more than MAX_RETIRE_AT_ONCE rows at once, unless `allowRetire`. Nothing is written either way here.
 */
export function checkRetirements(rows: RegistryRow[], diff: RegistryDiff, releaseTag: string | null, allowRetire = false): void {
  if (allowRetire || diff.missing.length === 0) return;
  const live = rows.filter((r) => r.state !== 'missing').length;
  const how = '; refused (orion daemon --allow-retire to accept)';
  if (diff.missing.length === live) {
    throw new OrionError('reconcile_would_retire', `${releaseLabel(releaseTag)} would retire every asset (${diff.missing.join(', ')})${how}`);
  }
  if (diff.missing.length > MAX_RETIRE_AT_ONCE) {
    throw new OrionError('reconcile_would_retire', `${releaseLabel(releaseTag)} would retire ${diff.missing.length} assets at once (${diff.missing.join(', ')})${how}`);
  }
}

/**
 * Loads every YAML (refusing an invalid one before any write), then plans and applies under one lock. A diff that
 * retires every asset or more than MAX_RETIRE_AT_ONCE is refused before any write unless `opts.allowRetire`.
 */
export async function reconcileFromDisk(
  db: Db, configRoot: string, releaseTag: string | null, now: Date, opts: { allowRetire?: boolean } = {},
): Promise<RegistryDiff> {
  const yamls = loadAssetYamls(configRoot);
  return await db.tx(async (tx) => {
    const rows = await listRegistry(tx);
    const diff = planReconcile(rows, yamls);
    checkRetirements(rows, diff, releaseTag, opts.allowRetire);
    await applyReconcile(tx, diff, yamls, releaseTag, now);
    return diff;
  }, { lockAsset: REGISTRY_LOCK });
}
