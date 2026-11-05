import type { LoadedAsset } from '../config/load.js';
import type { MetricDef } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { sourceTypeOf, typeOfSource, type SourceType } from '../report/sourceTypes.js';
import { chainOfSource, locatorOfSource, methodOfSource, scrubLocator, scrubUrl } from './locator.js';
import { PRE_V2, type Locator, type ProvenanceMethod } from './types.js';

/**
 * The history backfill (spec §3, plan correction 1): every row written before 0004 is mapped mechanically from its
 * `source` / `source_detail` columns and the asset YAML of this release (there is no `config_versions` table), with
 * `code_version` and `config_hash` = 'pre-v2'. Only the provenance columns are written, and only on rows that have none:
 * `value`, `source`, `source_detail`, `status` and every other column stay as they are. A row the rules cannot map is
 * listed, never guessed.
 *
 * The rules, in order:
 * 1. The asset and the metric must be in the YAML (else `unknown_asset` / `unknown_metric`).
 * 2. `manual`: disclosed, rung disclosure, locator = its citation; a manual row without a citation is `manual_without_citation`.
 * 3. `onchain` / `api` on a metric with no source in the YAML: `no_source_in_config`.
 * 4. A row whose `source` is what the metric's source writes (an adapter writes either): the metric's method, rung,
 *    chain and locator; `block_from/to` from `source_detail.blocks` (a transfer scan) or `block N` (a chain level);
 *    a derived row's formula from `derived <name>(...)`.
 * 5. Otherwise the source changed since the row was written. An `api` row is `third_party` when the current source is
 *    third party (DefiLlama), else `first_party_api` (measured, locator = the URL it names, scrubbed); an `onchain` row is `source_changed`.
 */

export interface BackfillOptions {
  dryRun?: boolean;
}

export interface UnmappedRow {
  id: number;
  assetId: string;
  metricKey: string;
  source: string;
  reason: string;
}

export interface BackfillResult {
  dryRun: boolean;
  /** Rows that already had provenance (written by this release, or backfilled before). */
  alreadySet: number;
  /** Rows mapped (or, on a dry run, that would be), by `<asset>:<metric>`. */
  mapped: Record<string, number>;
  unmapped: UnmappedRow[];
}

interface Mapped {
  method: ProvenanceMethod;
  sourceType: SourceType;
  chain: string | null;
  locator: Locator;
  blockFrom: number | null;
  blockTo: number | null;
  formula: string | null;
}

interface Row {
  id: number;
  asset_id: string;
  metric_key: string;
  source: string;
  source_detail: string | null;
  citation_url: string | null;
}

/** What a source writes in the `source` column (an adapter returns its own, so either). */
function writtenSource(def: MetricDef, metrics: Readonly<Record<string, MetricDef>>): 'onchain' | 'api' | 'either' {
  const s = def.source!;
  switch (s.type) {
    case 'transfer_flow':
    case 'contract_read':
    case 'erc20_supply':
      return 'onchain';
    case 'adapter':
      return 'either';
    case 'derived': {
      // As the fetch stamps it: a derivation over an API series (defillama, an adapter) is api, else onchain.
      const p = (s.params ?? {}) as Record<string, unknown>;
      const names = [p.metric, p.metrics, p.minus].flatMap((x) => (typeof x === 'string' ? [x] : Array.isArray(x) ? x : [])) as string[];
      return names.some((m) => ['defillama', 'adapter'].includes(metrics[m]?.source?.type ?? '')) ? 'api' : 'onchain';
    }
    default:
      return 'api';
  }
}

/** `block_from/to` from a transfer scan's `{"blocks":[a,b]}` or a chain level's `block N`. */
function blocksOf(detail: string | null): { blockFrom: number | null; blockTo: number | null } {
  if (detail === null) return { blockFrom: null, blockTo: null };
  try {
    const d = JSON.parse(detail) as { blocks?: unknown };
    if (Array.isArray(d.blocks) && d.blocks.length === 2 && d.blocks.every((b) => Number.isSafeInteger(b))) {
      return { blockFrom: d.blocks[0] as number, blockTo: d.blocks[1] as number };
    }
  } catch {
    // not JSON
  }
  const m = /^block (\d+)$/.exec(detail);
  return m ? { blockFrom: Number(m[1]), blockTo: Number(m[1]) } : { blockFrom: null, blockTo: null };
}

/** The mapping of one row, or the reason it has none. */
export function mapRow(row: Row, loaded: LoadedAsset | undefined): Mapped | { reason: string } {
  if (loaded === undefined) return { reason: 'unknown_asset' };
  const metrics = loaded.config.metrics;
  const def = metrics[row.metric_key];
  if (def === undefined) return { reason: 'unknown_metric' };
  if (row.source === 'manual') {
    if (!row.citation_url) return { reason: 'manual_without_citation' };
    const proposedBy: Locator = row.source_detail?.startsWith('research:') ? { proposed_by: row.source_detail } : {};
    return {
      method: 'disclosed', sourceType: 'disclosure', chain: null, blockFrom: null, blockTo: null, formula: null,
      locator: scrubLocator({ citation_url: row.citation_url, approved_by: null, approved_at: null, ...proposedBy }),
    };
  }
  if (row.source !== 'onchain' && row.source !== 'api') return { reason: 'unknown_source' };
  if (def.source === undefined) return { reason: 'no_source_in_config' };
  const writes = writtenSource(def, metrics);
  if (writes === 'either' || writes === row.source) {
    const sourceType = sourceTypeOf(def, metrics);
    if (sourceType === null) return { reason: 'no_source_type' };
    const derived = def.source.type === 'derived' ? /^derived (\w+)\(/.exec(row.source_detail ?? '') : null;
    return {
      method: methodOfSource(def.source), sourceType, chain: chainOfSource(loaded.config, def.source),
      locator: scrubLocator(locatorOfSource(loaded.config, row.metric_key, def.source)), ...blocksOf(row.source_detail),
      formula: derived ? `${derived[1]}@1` : null,
    };
  }
  if (row.source === 'onchain') return { reason: 'source_changed' };
  // Correction 1: an api row whose metric's source changed since is mapped by its source column.
  const url = /^(https?:\/\/\S+)/.exec(row.source_detail ?? '');
  return {
    method: 'measured', sourceType: typeOfSource(def.source, metrics) === 'third_party' ? 'third_party' : 'first_party_api', chain: null, blockFrom: null, blockTo: null,
    formula: null, locator: url ? { endpoint: scrubUrl(url[1]!) } : { note: 'written by a source this release no longer reads' },
  };
}

/**
 * Maps every row that has no provenance. A dry run writes nothing. Each asset's rows are updated in one transaction under
 * the asset's lock; a row that gained provenance meanwhile (`method IS NOT NULL`) is left alone.
 */
export async function backfillProvenance(db: Db, assets: LoadedAsset[], opts: BackfillOptions = {}): Promise<BackfillResult> {
  const byId = new Map(assets.map((a) => [a.config.id, a]));
  const result: BackfillResult = { dryRun: opts.dryRun === true, alreadySet: 0, mapped: {}, unmapped: [] };
  result.alreadySet = (await db.one<{ n: number }>('SELECT count(*)::bigint AS n FROM observations WHERE method IS NOT NULL'))?.n ?? 0;
  const rows = await db.all<Row>(
    'SELECT id, asset_id, metric_key, source, source_detail, citation_url FROM observations WHERE method IS NULL ORDER BY asset_id, id',
  );
  const perAsset = new Map<string, { row: Row; m: Mapped }[]>();
  for (const row of rows) {
    const m = mapRow(row, byId.get(row.asset_id));
    if ('reason' in m) {
      result.unmapped.push({ id: row.id, assetId: row.asset_id, metricKey: row.metric_key, source: row.source, reason: m.reason });
      continue;
    }
    const key = `${row.asset_id}:${row.metric_key}`;
    result.mapped[key] = (result.mapped[key] ?? 0) + 1;
    perAsset.set(row.asset_id, [...(perAsset.get(row.asset_id) ?? []), { row, m }]);
  }
  if (result.dryRun) return result;
  for (const [assetId, list] of perAsset) {
    await db.tx(
      async (t) => {
        for (const { row, m } of list) {
          await t.run(
            `UPDATE observations SET method = $2, source_type = $3, chain = $4, locator = $5::jsonb, block_from = $6, block_to = $7, formula = $8,
               code_version = $9, config_hash = $9
             WHERE id = $1 AND method IS NULL`,
            [row.id, m.method, m.sourceType, m.chain, JSON.stringify(m.locator), m.blockFrom, m.blockTo, m.formula, PRE_V2],
          );
        }
      },
      { lockAsset: assetId },
    );
  }
  return result;
}
