import { lockHolder, withRunLock } from '../app/lock.js';
import type { LoadedAsset } from '../config/load.js';
import type { MetricDef } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import { adapterNeedsRpc } from '../ingest/adapters/registry.js';
import { DEFAULT_RPC_URLS, validateReading } from '../ingest/run.js';
import { getSourceHandler } from '../ingest/sources/registry.js';
import { utcDay } from '../ingest/time.js';
import type { HttpTransport } from '../ingest/transport/http.js';
import { firstBlockAtOrAfter, type BlockRef, type RpcFactory, type RpcTransport } from '../ingest/transport/rpc.js';
import { contractResolver, type SourceContext, type SourceRequest } from '../ingest/types.js';
import { chainOfSource, fetchedProvenance } from '../provenance/locator.js';
import { originOf } from '../provenance/origin.js';
import { codeVersion, type Locator, type Provenance } from '../provenance/types.js';
import { OrionError } from '../types.js';
import type { Db, OrionDb } from './connection.js';
import { dbDayBlocks } from './dayBlocks.js';
import { insertObservation } from './observations.js';

/**
 * `orion data rebuild-supply-levels` (Phase 3 R3, plan decision N2 A, Rulings R5/R6): every active `circulating_supply`
 * row whose source is not the asset's current one (a CoinGecko `market_data` row; a wrapper's old `erc20_supply`
 * totalSupply() row) gets a new active row at the same `observed_at`, read by the asset's CONFIGURED source through the
 * normal source handler (src/ingest/sources/registry.ts) with `ctx.block` = the first block at or after `observed_at`
 * (firstBlockAtOrAfter; a 00:00Z row's block is the day boundary, cached in `day_blocks`). So a rebuilt row is exactly
 * what a fetch at that block would have written; there is no per-adapter read path here. insertObservation supersedes
 * the old row; nothing is deleted (`data purge --source-type market_data` does that afterwards, src/db/purge.ts).
 *
 * The rule for "another source" (precise): a row is the current source's when its `source_type` equals the current
 * source's rung AND its locator's `adapter` and `call` keys equal the current source's locator's (an absent key equals
 * an absent key). So CoinGecko rows (`market_data`) and the wrappers' `erc20_supply` rows (contract_state, no adapter,
 * call `totalSupply()`) are targets; a row of the same adapter is `unchanged` (a rebuilt row included, so a second run
 * rebuilds nothing), whatever its params were: a params change is a definition change and its release says so.
 *
 * Per target: `notRebuildable` (listed with its day, untouched) when the current source is not an EVM chain read (a
 * Hyperliquid or Solana adapter: no archive state to read) or `observed_at` is before the metric's `rebuild_from`;
 * `refused` (listed with the reason, untouched; the CLI exits 3) when the block search or the read fails at that block:
 * a term whose contract has no code yet reverts and fails the whole level (Review Focus 1), never a partial sum.
 * Provenance: the fetch's own (method measured, the adapter's rung, chain, locator, config hash), blocks = the read
 * block, locator + `rebuilt: { at, release?, from_id }`, code version = the release (default: the running version).
 * A dry run by default (the reads run; nothing is written, day_blocks included); `yes` reads and writes under the asset's
 * run lock, one transaction per asset-day.
 */

export const SUPPLY_LEVEL_METRIC = 'circulating_supply';

export interface SupplyRebuildResult {
  asset: string;
  applied: boolean;
  metric: 'circulating_supply';
  /** Active rows of another source than the current one: rebuilt + refused + notRebuildable. */
  rows: number;
  rebuilt: number;
  /** Active rows already of the current source (not targets). */
  unchanged: number;
  refused: { id: number; observedAt: string; reason: string }[];
  notRebuildable: { id: number; observedAt: string; day: string }[];
  /** RPC requests made (block searches and reads). */
  calls: number;
}

export interface SupplyRebuildDeps {
  rpc: RpcFactory;
  http: HttpTransport;
  /** Where the asset's `ingest.rpc_url_env` is looked up; unset or missing: the chain's keyless default, if any. */
  env?: Record<string, string | undefined>;
}

export interface SupplyRebuildOptions {
  yes: boolean;
  /** ISO time: the run lock's clock and the `rebuilt.at` of every row written. */
  now: string;
  /** The release the rows' code_version (and `rebuilt.release`) names; default the running code version. */
  release?: string;
}

/** A metric whose source reads EVM chain state at a block: a chain level, or an RPC adapter on the asset's EVM chain. */
function readsEvmState(loaded: LoadedAsset, def: MetricDef | undefined): boolean {
  const s = def?.source;
  if (s === undefined) return false;
  if (!(isChainSource(s) || (s.type === 'adapter' && adapterNeedsRpc(s)))) return false;
  return (chainOfSource(loaded.config, s) ?? '').startsWith('eip155:');
}

/**
 * True when a circulating_supply row observed at `observedAtIso` can never be rebuilt: the metric's current source is not
 * an EVM chain read (HYPE, PUMP), or the row is before the metric's `rebuild_from` (00:00Z of it; AERO). Shared by the
 * rebuild (its `notRebuildable` list) and the purge (src/db/purge.ts: deleted without replacement, listed).
 */
export function supplyNotRebuildable(loaded: LoadedAsset, observedAtIso: string): boolean {
  const def = loaded.config.metrics[SUPPLY_LEVEL_METRIC];
  if (!readsEvmState(loaded, def)) return true;
  const from = def?.rebuild_from;
  return from !== undefined && Date.parse(observedAtIso) < Date.parse(`${from}T00:00:00.000Z`);
}

const keyOf = (l: Locator | null | undefined, k: 'adapter' | 'call'): string | null => {
  const v = l?.[k];
  return typeof v === 'string' ? v : null;
};

/** The current-source rule above. */
function isCurrentSource(current: { sourceType: string; locator: Locator }, row: { source_type: string; locator: Locator | null }): boolean {
  return row.source_type === current.sourceType && keyOf(row.locator, 'adapter') === keyOf(current.locator, 'adapter') && keyOf(row.locator, 'call') === keyOf(current.locator, 'call');
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Counts every request a transport serves (the result's `calls`). */
function counting(rpc: RpcTransport, n: { calls: number }): RpcTransport {
  const methods = new Set(['latestBlock', 'finalizedBlock', 'getBlock', 'multicall', 'getCode', 'getReceiptLogs', 'getTransferLogs']);
  return new Proxy(rpc, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || typeof prop !== 'string' || !methods.has(prop)) return v;
      return (...args: unknown[]) => {
        n.calls++;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

interface Planned {
  fromId: number;
  observedAt: string;
  value: number;
  detail: string;
  block: BlockRef;
}

interface Plan {
  result: SupplyRebuildResult;
  planned: Planned[];
  /** 00:00Z rows' boundary blocks found by search (written to day_blocks on --yes). */
  boundaries: Map<string, BlockRef>;
}

async function planRebuild(db: Db, loaded: LoadedAsset, deps: SupplyRebuildDeps, opts: SupplyRebuildOptions): Promise<Plan> {
  const { config } = loaded;
  const asset = config.id;
  const counter = { calls: 0 };
  const result: SupplyRebuildResult = { asset, applied: false, metric: SUPPLY_LEVEL_METRIC, rows: 0, rebuilt: 0, unchanged: 0, refused: [], notRebuildable: [], calls: 0 };
  const planned: Planned[] = [];
  const boundaries = new Map<string, BlockRef>();
  const def = config.metrics[SUPPLY_LEVEL_METRIC];
  if (def?.source === undefined) return { result, planned, boundaries };

  const current = fetchedProvenance(loaded, SUPPLY_LEVEL_METRIC);
  const rows = await db.all<{ id: number; observed_at: string; source_type: string; locator: Locator | null }>(
    `SELECT id, observed_at, source_type, locator FROM observations
      WHERE asset_id = $1 AND metric_key = $2 AND superseded_by IS NULL AND status <> 'rejected' ORDER BY observed_at, id`,
    [asset, SUPPLY_LEVEL_METRIC],
  );
  const targets: { id: number; observedAt: string }[] = [];
  for (const r of rows) {
    if (isCurrentSource(current, r)) result.unchanged++;
    else targets.push({ id: Number(r.id), observedAt: new Date(r.observed_at).toISOString() });
  }
  result.rows = targets.length;

  const rebuildable: { id: number; observedAt: string }[] = [];
  for (const t of targets) {
    if (supplyNotRebuildable(loaded, t.observedAt)) result.notRebuildable.push({ ...t, day: t.observedAt.slice(0, 10) });
    else rebuildable.push(t);
  }
  if (rebuildable.length === 0) return { result, planned, boundaries };

  // readsEvmState held, so the asset has an ingest block (buildPlan's rule for a chain read).
  const ingest = config.ingest;
  if (!ingest) throw new OrionError('invalid_source_config', `assets/${asset}.yaml reads from a chain but has no ingest block`);
  const url = deps.env?.[ingest.rpc_url_env] ?? DEFAULT_RPC_URLS[ingest.chain_id];
  if (!url) throw new OrionError('missing_rpc_url', `set ${ingest.rpc_url_env}: there is no default RPC URL for chain ${ingest.chain_id}`);
  const rpc = counting(deps.rpc(url, ingest.chain_id), counter);
  const dayBlocks = dbDayBlocks(db, ingest.chain_id);
  const refuse = (t: { id: number; observedAt: string }, reason: string) => result.refused.push({ ...t, reason });

  let latest: BlockRef | null = null;
  try {
    latest = await rpc.latestBlock();
  } catch (err) {
    for (const t of rebuildable) refuse(t, `could not read the latest block: ${message(err)}`);
  }
  const handler = getSourceHandler(def.source.type);
  const request: SourceRequest = { metricKey: SUPPLY_LEVEL_METRIC, role: 'primary', source: def.source, tolerancePct: def.tolerance_pct };
  let anchor = latest;
  for (const t of latest === null ? [] : rebuildable) {
    const ms = Date.parse(t.observedAt);
    const midnight = ms % 86_400_000 === 0 ? utcDay(ms) : null;
    let block: BlockRef;
    try {
      const cached = midnight === null ? null : await dayBlocks.get(midnight);
      block = cached ?? (await firstBlockAtOrAfter(rpc, Math.ceil(ms / 1000), anchor!, latest!));
      if (midnight !== null && cached === null) boundaries.set(midnight, block);
    } catch (err) {
      refuse(t, `no block at or after ${t.observedAt}: ${message(err)}`);
      continue;
    }
    anchor = block; // rows are in time order: the next search starts near this one
    // The fetch's own context, at the row's block: the same handler and adapter a fetch at that block runs.
    const ctx: SourceContext = {
      asset: config, nowIso: t.observedAt, http: deps.http, rpc, block, env: deps.env ?? {}, contract: contractResolver(config),
      ...(loaded.prices ? { prices: loaded.prices } : {}),
    };
    let reading;
    try {
      [reading] = await handler.fetch([request], ctx);
    } catch (err) {
      if (err instanceof OrionError) throw err; // a configuration error, as in a fetch
      refuse(t, message(err));
      continue;
    }
    if (reading === undefined) {
      refuse(t, 'the source returned no result for this request');
      continue;
    }
    if (!reading.ok) {
      refuse(t, reading.error);
      continue;
    }
    if (reading.value.kind !== 'level') {
      refuse(t, `a ${reading.value.kind} cannot be stored as a level`);
      continue;
    }
    const invalid = validateReading(def, reading.value.value) ?? (reading.value.source === 'onchain' ? null : `the reading is ${reading.value.source}, not on chain`);
    if (invalid !== null) {
      refuse(t, invalid);
      continue;
    }
    planned.push({ fromId: t.id, observedAt: t.observedAt, value: reading.value.value, detail: reading.value.detail, block });
  }
  result.rebuilt = planned.length;
  result.calls = counter.calls;
  return { result, planned, boundaries };
}

export async function rebuildSupplyLevels(db: OrionDb, loaded: LoadedAsset, deps: SupplyRebuildDeps, opts: SupplyRebuildOptions): Promise<SupplyRebuildResult> {
  const asset = loaded.config.id;
  if (!opts.yes) return (await planRebuild(db, loaded, deps, opts)).result;
  const version = opts.release ?? codeVersion();
  return await withRunLock(db, asset, lockHolder('orion data rebuild-supply-levels'), new Date(opts.now), async () => {
    const { result, planned, boundaries } = await planRebuild(db, loaded, deps, opts);
    const dayBlocks = loaded.config.ingest ? dbDayBlocks(db, loaded.config.ingest.chain_id) : null;
    for (const [day, b] of boundaries) await dayBlocks?.put(day, b);
    const byDay = new Map<string, Planned[]>();
    for (const p of planned) {
      const day = p.observedAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), p]);
    }
    for (const day of [...byDay.keys()].sort()) {
      await db.tx(async (t) => {
        for (const p of byDay.get(day)!) {
          const fetched = fetchedProvenance(loaded, SUPPLY_LEVEL_METRIC, { blockFrom: Number(p.block.number), blockTo: Number(p.block.number), codeVersion: version });
          const provenance: Provenance = {
            ...fetched,
            locator: { ...fetched.locator, rebuilt: { at: opts.now, ...(opts.release ? { release: opts.release } : {}), from_id: p.fromId } },
          };
          if (originOf(provenance) !== 'onchain') {
            throw new OrionError('origin_mismatch', `${SUPPLY_LEVEL_METRIC}: a rebuilt row's provenance reads back as ${originOf(provenance)}, not onchain; this day was rolled back`);
          }
          // Re-checked inside the transaction: the old row is still the active one (a refresh may have run).
          const still = await t.one("SELECT 1 FROM observations WHERE id = $1 AND superseded_by IS NULL AND status <> 'rejected'", [p.fromId]);
          if (!still) throw new OrionError('rebuild_conflict', `${SUPPLY_LEVEL_METRIC} #${p.fromId} at ${p.observedAt} is no longer active; this day was rolled back`);
          await insertObservation(t, {
            assetId: asset, metricKey: SUPPLY_LEVEL_METRIC, observedAt: p.observedAt, periodDays: null, value: p.value,
            sourceDetail: `rebuilt from #${p.fromId}: ${p.detail}`, fetchedAt: opts.now, provenance,
          });
        }
      }, { lockAsset: asset });
    }
    return { ...result, applied: true };
  });
}
