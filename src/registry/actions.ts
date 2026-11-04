import { loadAsset } from '../config/load.js';
import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import {
  REGISTRY_LOCK, getRegistryRow, insertRegistryRow, lockRegistryRow, setRegistryState, type AssetState, type RegistryRow,
} from '../db/registry.js';
import { DEFAULT_API_FLOW_BACKFILL_DAYS } from '../ingest/apiFlow.js';
import { MS_PER_DAY, OrionError } from '../types.js';
import { loadAssetYamls } from './reconcile.js';

/**
 * Pause, resume, activate, seed (spec 5.3). Each one is one transaction under the registry lock that updates the row
 * and appends its `asset_state_events` row. A pause takes effect from the next job; it never interrupts a running one.
 */

export interface ActionOpts {
  by: string;
  now: Date;
  releaseTag: string | null;
}

export interface ResumeResult {
  /** Whole days the asset was paused. */
  pausedDays: number;
  /** How far back the asset's API series can refill (the shortest primary `backfill_days`); null without API series. */
  backfillDays: number | null;
  /** The pause was longer than the API series can refill: the report says so. */
  refillShort: boolean;
}

function requireReason(reason: string | undefined): string {
  const r = reason?.trim() ?? '';
  if (r === '') throw new OrionError('reason_required', 'a reason is required (--reason <text>)');
  return r;
}

/** Moves `id` from one of `from` to `to` under lock; the row as it was before. */
async function transition(db: Db, id: string, verb: string, from: AssetState[], to: AssetState, o: ActionOpts, reason: string | null): Promise<RegistryRow> {
  return await db.tx(async (tx) => {
    const row = await lockRegistryRow(tx, id);
    if (!row) throw new OrionError('asset_not_in_registry', `${id} is not in the asset registry (the daemon adds every YAML in the release at start-up)`);
    if (!from.includes(row.state)) throw new OrionError('invalid_state_transition', `${id} is ${row.state}; ${verb} needs ${from.join(' or ')}`);
    await setRegistryState(tx, id, row.state, to, { at: o.now.toISOString(), by: o.by, reason, releaseTag: o.releaseTag });
    return row;
  }, { lockAsset: REGISTRY_LOCK });
}

/** A state change: the state it left, and the row after it. */
export interface TransitionResult {
  from: AssetState;
  row: RegistryRow;
}

async function after(db: Db, before: RegistryRow): Promise<TransitionResult> {
  return { from: before.state, row: (await getRegistryRow(db, before.assetId))! };
}

/** `active` or `inactive` → `paused`. `reason` is required. */
export async function pauseAsset(db: Db, id: string, opts: ActionOpts & { reason: string }): Promise<TransitionResult> {
  const reason = requireReason(opts.reason);
  return await after(db, await transition(db, id, 'pause', ['active', 'inactive'], 'paused', opts, reason));
}

/** The shortest `backfill_days` among the asset's primary API series (DefiLlama; the writer's default when unset). */
export function apiBackfillDays(config: AssetConfig): number | null {
  const days: number[] = [];
  for (const def of Object.values(config.metrics)) {
    if (def.source?.type === 'defillama') days.push(def.source.backfill_days ?? DEFAULT_API_FLOW_BACKFILL_DAYS);
  }
  return days.length > 0 ? Math.min(...days) : null;
}

/**
 * `paused` → `active`. On-chain flows backfill the paused days from their cursors on their own; API series only as far
 * back as `backfill_days`, so the result says whether the pause was longer than that.
 */
export async function resumeAsset(db: Db, id: string, opts: ActionOpts & { configRoot: string; reason?: string }): Promise<ResumeResult> {
  // The YAML first: an asset whose config cannot load is not resumed.
  const backfillDays = apiBackfillDays(loadAsset(opts.configRoot, id).config);
  const before = await transition(db, id, 'resume', ['paused'], 'active', opts, opts.reason?.trim() || null);
  const pausedDays = Math.floor((opts.now.getTime() - new Date(before.stateSince).getTime()) / MS_PER_DAY);
  return { pausedDays, backfillDays, refillShort: backfillDays !== null && pausedDays > backfillDays };
}

/** `inactive` → `active`: the only way a new asset starts running. */
export async function activateAsset(db: Db, id: string, opts: ActionOpts & { reason?: string }): Promise<TransitionResult> {
  return await after(db, await transition(db, id, 'activate', ['inactive'], 'active', opts, opts.reason?.trim() || null));
}

/**
 * Cutover (plan R11): a row in `state` for every YAML that has none; rows that exist are left as they are. The YAMLs
 * are loaded (an invalid one refused) before anything is written.
 */
export async function seedRegistry(
  db: Db, configRoot: string, opts: { state: 'active'; by: string; reason: string; now: Date; releaseTag?: string | null },
): Promise<{ seeded: string[]; existing: string[] }> {
  const reason = requireReason(opts.reason);
  const yamls = loadAssetYamls(configRoot);
  const releaseTag = opts.releaseTag ?? null;
  return await db.tx(async (tx) => {
    const seeded: string[] = [];
    const existing: string[] = [];
    for (const y of yamls) {
      if (await lockRegistryRow(tx, y.id)) {
        existing.push(y.id);
        continue;
      }
      await insertRegistryRow(tx, y.id, opts.state, y.hash, { at: opts.now.toISOString(), by: opts.by, reason, releaseTag });
      seeded.push(y.id);
    }
    return { seeded, existing };
  }, { lockAsset: REGISTRY_LOCK });
}
