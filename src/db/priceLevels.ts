import { lockHolder, withRunLock } from '../app/lock.js';
import type { LoadedAsset } from '../config/load.js';
import { utcDay } from '../ingest/time.js';
import { INPUT_ORIGIN_KEY } from '../provenance/origin.js';
import { codeVersion, type Provenance } from '../provenance/types.js';
import type { PriceMethod } from '../prices/config.js';
import { venueOfMethod } from '../prices/venue.js';
import { OrionError } from '../types.js';
import type { Db, OrionDb } from './connection.js';
import { insertObservation } from './observations.js';
import { CHAIN_PRICE_MAX_AGE_HOURS, evmTokenRef, MS_PER_HOUR } from './prices.js';

/**
 * `orion data rebuild-price-levels` (Phase 3 R2, Mike's M7): every active CoinGecko (`market_data`) `price_usd` /
 * `diem_price_usd` level row gets a new active row at the same `observed_at` (insertObservation supersedes the CoinGecko
 * row; nothing is deleted: `data purge --source-type market_data` does that afterwards), valued at the newest
 * chain/first-party `prices` row of the metric's ref with `ts <= observed_at - 1 h` (the newest hour bucket complete by
 * then; equal ts: the newest write, then the source by name, Ruling R6), no more than 6 h older than that. Refused
 * (listed, the CoinGecko row left active) where none exists. Provenance: method `derived`, the rung of the price row's
 * method (contract state on chain, first-party API for a venue's candle), locator `{ from: 'prices', token_ref, ts,
 * source }`. The ref: the metric's `price.token` ref, else (AERO) the EVM address of the contract its price adapter
 * names as `token`. A dry run by default; `yes` writes under the asset's run lock, one transaction per asset-day.
 */

export const PRICE_LEVEL_METRICS = ['price_usd', 'diem_price_usd'] as const;

export interface RebuildRefusal {
  id: number;
  observedAt: string;
  reason: string;
}

export interface RebuildMetric {
  metric: string;
  tokenRef: string | null;
  /** Active market_data rows of the metric. */
  rows: number;
  rebuilt: number;
  refused: RebuildRefusal[];
}

export interface RebuildResult {
  asset: string;
  applied: boolean;
  perMetric: RebuildMetric[];
  /** Asset-days written (one transaction each). */
  days: number;
}

export interface RebuildOptions {
  yes: boolean;
  now: Date;
  /** The release the rows' code_version names; default the running code version. */
  release?: string;
}

interface Planned {
  metric: string;
  observedAt: string;
  tokenRef: string;
  ts: string;
  price: number;
  source: string;
}

/** The ref a price level metric is priced under, or null. */
export function priceLevelRef(loaded: LoadedAsset, metric: string): string | null {
  const { config } = loaded;
  const s = config.metrics[metric]?.source as { type?: string; params?: Record<string, unknown> } | undefined;
  if (s?.type !== 'adapter') return null;
  const p = s.params ?? {};
  if (typeof p.ref === 'string') return p.ref;
  const token = typeof p.token === 'string' ? (config.contracts[p.token] ?? p.token) : null;
  if (token !== null && config.ingest && /^0x[0-9a-fA-F]{40}$/.test(token)) return evmTokenRef(config.ingest.chain_id, token);
  return null;
}

/** The method kind behind a `prices.source` label (`chain:<kind>`, `first_party:<venue>`). */
function kindOfSource(source: string): string {
  if (source === 'first_party:hyperliquid') return 'hyperliquid_candle';
  if (source === 'first_party:lighter') return 'lighter_candle';
  return source.startsWith('chain:') ? source.slice('chain:'.length) : source;
}

async function planRebuild(db: Db, loaded: LoadedAsset): Promise<{ perMetric: RebuildMetric[]; planned: Planned[] }> {
  const asset = loaded.config.id;
  const perMetric: RebuildMetric[] = [];
  const planned: Planned[] = [];
  const metrics = PRICE_LEVEL_METRICS.filter((m) => loaded.config.metrics[m] !== undefined).sort();
  for (const metric of metrics) {
    const tokenRef = priceLevelRef(loaded, metric);
    const rows = await db.all<{ id: number; observed_at: string }>(
      `SELECT id, observed_at FROM observations WHERE asset_id = $1 AND metric_key = $2 AND source_type = 'market_data'
         AND superseded_by IS NULL AND status <> 'rejected' ORDER BY observed_at, id`,
      [asset, metric],
    );
    const m: RebuildMetric = { metric, tokenRef, rows: rows.length, rebuilt: 0, refused: [] };
    for (const r of rows) {
      const observedAt = new Date(r.observed_at).toISOString();
      if (tokenRef === null) {
        m.refused.push({ id: Number(r.id), observedAt, reason: `metrics.${metric} has no price ref (a price.token source, or a price adapter naming its token)` });
        continue;
      }
      const upTo = new Date(Date.parse(observedAt) - MS_PER_HOUR).toISOString();
      const since = new Date(Date.parse(upTo) - CHAIN_PRICE_MAX_AGE_HOURS * MS_PER_HOUR).toISOString();
      const p = await db.one<{ ts: string; price_usd: number; source: string }>(
        `SELECT ts, price_usd, source FROM prices
          WHERE token_ref = $1 AND ts <= $2 AND ts >= $3 AND (starts_with(source, 'chain:') OR starts_with(source, 'first_party:'))
          ORDER BY ts DESC, fetched_at DESC, source LIMIT 1`,
        [tokenRef, upTo, since],
      );
      if (!p) {
        m.refused.push({ id: Number(r.id), observedAt, reason: `no chain/first-party price of ${tokenRef} in the ${CHAIN_PRICE_MAX_AGE_HOURS} h to ${upTo}` });
        continue;
      }
      m.rebuilt++;
      planned.push({ metric, observedAt, tokenRef, ts: new Date(p.ts).toISOString(), price: p.price_usd, source: p.source });
    }
    perMetric.push(m);
  }
  return { perMetric, planned };
}

export async function rebuildPriceLevels(db: OrionDb, loaded: LoadedAsset, opts: RebuildOptions): Promise<RebuildResult> {
  const asset = loaded.config.id;
  if (!opts.yes) {
    const { perMetric } = await planRebuild(db, loaded);
    return { asset, applied: false, perMetric, days: 0 };
  }
  const version = opts.release ?? codeVersion();
  return await withRunLock(db, asset, lockHolder('orion data rebuild-price-levels'), opts.now, async () => {
    const { perMetric, planned } = await planRebuild(db, loaded);
    const byDay = new Map<string, Planned[]>();
    for (const p of planned) {
      const day = utcDay(Date.parse(p.observedAt));
      byDay.set(day, [...(byDay.get(day) ?? []), p]);
    }
    const days = [...byDay.keys()].sort();
    const nowIso = opts.now.toISOString();
    for (const day of days) {
      await db.tx(async (t) => {
        for (const p of byDay.get(day)!) {
          const firstParty = p.source.startsWith('first_party:');
          const venue = venueOfMethod({ ref: p.tokenRef }, { kind: kindOfSource(p.source) as PriceMethod['kind'] });
          const provenance: Provenance = {
            method: 'derived', sourceType: firstParty ? 'first_party_api' : 'contract_state', chain: venue.chain,
            locator: { from: 'prices', token_ref: p.tokenRef, ts: p.ts, source: p.source, ...(firstParty ? { [INPUT_ORIGIN_KEY]: 'api' } : {}) },
            formula: 'price_level_from_prices@1', codeVersion: version, configHash: loaded.hash,
          };
          // Re-checked inside the transaction: the CoinGecko row is still the active one (a refresh may have run).
          const still = await t.one(
            "SELECT 1 FROM observations WHERE asset_id = $1 AND metric_key = $2 AND observed_at = $3 AND source_type = 'market_data' AND superseded_by IS NULL AND status <> 'rejected'",
            [asset, p.metric, p.observedAt],
          );
          if (!still) throw new OrionError('rebuild_conflict', `${p.metric} at ${p.observedAt} is no longer an active CoinGecko row; this day was rolled back`);
          await insertObservation(t, {
            assetId: asset, metricKey: p.metric, observedAt: p.observedAt, periodDays: null, value: p.price,
            sourceDetail: `rebuilt from prices ${p.source} ${p.ts} (${p.tokenRef})`, fetchedAt: nowIso, provenance,
          });
        }
      }, { lockAsset: asset });
    }
    return { asset, applied: true, perMetric, days: days.length };
  });
}
