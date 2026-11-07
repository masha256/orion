import type { LoadedAsset } from '../config/load.js';
import type { MetricDef } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { sourceTypeOf, typeOfSource, type SourceType } from '../report/sourceTypes.js';
import { chainOfSource, locatorOfSource, methodOfSource, scrubLocator, scrubUrl } from './locator.js';
import { PRE_V2, type Json, type Locator, type ProvenanceMethod } from './types.js';

/**
 * The history backfill (spec §3, plan correction 1): every row written before 0004 is mapped mechanically from its
 * `source` / `source_detail` columns and the asset YAML of this release (there is no `config_versions` table), with
 * `code_version` and `config_hash` = 'pre-v2'. Only the provenance columns are written (and a null quoted_text, rule
 * 2b), and only on rows that have none: `value`, `source`, `source_detail`, `status`, `citation_url` and every other
 * column stay as they are. A row the rules cannot map is listed, never guessed.
 *
 * The rules, in order:
 * 1. The asset and the metric must be in the YAML (else `unknown_asset` / `unknown_metric`).
 * 2. `manual`: disclosed, rung disclosure, locator = its citation. A manual row without a citation (pre-G2 decision 2,
 *    Mike 2026-11-07; matched on content, never on ids; rejected rows alike):
 *    a. `source_detail` starting "DefiLlama artifact" (a day Mike set to the mean of its neighbours): derived, rung
 *       derived, formula `manual_mean_of_neighbours@1`, inputs = the metric's rows in force on the previous and next
 *       day (by observed_at), locator {note}. A neighbour missing: `correction_without_neighbours`.
 *    b. otherwise (the research-pass seeds): disclosed, rung disclosure, locator {note, legacy_seed: true}, quoted_text
 *       = source_detail when it has none; citation_url stays null, which only `pre-v2` history may (a new disclosed
 *       row still needs a citation: `disclosedProvenance`). Nothing to quote (no detail, no quote): `manual_without_citation`.
 * 3. `onchain` / `api` on a metric with no source in the YAML: `no_source_in_config`.
 * 4. A row whose `source` is what the metric's source writes (an adapter writes either): the metric's method, rung,
 *    chain and locator; `block_from/to` from `source_detail.blocks` (a transfer scan) or `block N` (a chain level);
 *    a derived row's formula from `derived <name>(...)`.
 * 5. Otherwise the source changed since the row was written. An `api` row is `third_party` when the current source is
 *    third party (DefiLlama), else `first_party_api` (measured, locator = the URL it names, scrubbed); an `onchain` row is `source_changed`.
 * An `api` row whose `source_detail` names a DefiLlama host (DEFILLAMA_HOSTS) is `third_party` whatever the metric reads
 * now: when the metric's current source is not third party, rule 5 applies with the DefiLlama URL as the locator.
 *
 * Writes are bounded: at most BACKFILL_BATCH_ROWS rows per transaction, each under the asset's lock, one set-based
 * UPDATE per batch. A crash leaves whole batches only, and a re-run skips them (`method IS NULL`).
 */

/** Rows written per transaction: the asset's lock is held for one batch, never for its whole history. */
export const BACKFILL_BATCH_ROWS = 1000;

/** DefiLlama's API hosts: a history row read from one is third party, whatever its metric reads now. */
const DEFILLAMA_HOSTS: ReadonlySet<string> = new Set(['api.llama.fi', 'coins.llama.fi', 'pro-api.llama.fi', 'yields.llama.fi']);

/** The first URL in a source detail on a DefiLlama host, or null. */
export function defillamaUrlOf(detail: string | null): string | null {
  for (const [u] of (detail ?? '').matchAll(/\bhttps?:\/\/[^\s"'<>]+/g)) {
    try {
      if (DEFILLAMA_HOSTS.has(new URL(u).hostname)) return u;
    } catch {
      // not a URL
    }
  }
  return null;
}

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
  /** A derived row's inputs (rule 2a). */
  inputs?: Json | null;
  /** Filled into quoted_text only where that is null (rule 2b). */
  quotedText?: string | null;
}

/** A neighbouring day's row in force (rule 2a). */
export interface NeighbourRow {
  id: number;
  observed_at: string;
  value: number;
}

interface Row {
  id: number;
  asset_id: string;
  metric_key: string;
  source: string;
  source_detail: string | null;
  citation_url: string | null;
  observed_at?: string;
  period_days?: number | null;
  quoted_text?: string | null;
}

/** Rule 2a's marker: Mike's correction of a DefiLlama day to the mean of its neighbours. */
const CORRECTION_PREFIX = 'DefiLlama artifact';
export const isNeighbourCorrection = (row: Pick<Row, 'source' | 'citation_url' | 'source_detail'>): boolean =>
  row.source === 'manual' && !row.citation_url && (row.source_detail ?? '').startsWith(CORRECTION_PREFIX);

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
  // A contract read writes `block N`; an RPC adapter's level `block N: <what it read>` (adapters/chain.ts).
  const m = /^block (\d+)(?::|$)/.exec(detail);
  return m ? { blockFrom: Number(m[1]), blockTo: Number(m[1]) } : { blockFrom: null, blockTo: null };
}

/** The mapping of one row, or the reason it has none. */
export function mapRow(row: Row, loaded: LoadedAsset | undefined, neighbours?: { prev: NeighbourRow | null; next: NeighbourRow | null }): Mapped | { reason: string } {
  if (loaded === undefined) return { reason: 'unknown_asset' };
  const metrics = loaded.config.metrics;
  const def = metrics[row.metric_key];
  if (def === undefined) return { reason: 'unknown_metric' };
  if (row.source === 'manual') {
    if (!row.citation_url) return manualWithoutCitation(row, neighbours);
    const proposedBy: Locator = row.source_detail?.startsWith('research:') ? { proposed_by: row.source_detail } : {};
    return {
      method: 'disclosed', sourceType: 'disclosure', chain: null, blockFrom: null, blockTo: null, formula: null,
      locator: scrubLocator({ citation_url: row.citation_url, approved_by: null, approved_at: null, ...proposedBy }),
    };
  }
  if (row.source !== 'onchain' && row.source !== 'api') return { reason: 'unknown_source' };
  if (def.source === undefined) return { reason: 'no_source_in_config' };
  const writes = writtenSource(def, metrics);
  const llama = row.source === 'api' ? defillamaUrlOf(row.source_detail) : null;
  if (llama !== null && sourceTypeOf(def, metrics) !== 'third_party') {
    return { method: 'measured', sourceType: 'third_party', chain: null, blockFrom: null, blockTo: null, formula: null, locator: { endpoint: scrubUrl(llama) } };
  }
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

/** Rules 2a and 2b: a pre-v2 manual row without a citation. */
function manualWithoutCitation(row: Row, neighbours: { prev: NeighbourRow | null; next: NeighbourRow | null } | undefined): Mapped | { reason: string } {
  const none = { chain: null, blockFrom: null, blockTo: null } as const;
  if (isNeighbourCorrection(row)) {
    if (!neighbours?.prev || !neighbours.next) return { reason: 'correction_without_neighbours' };
    const input = (n: NeighbourRow): Json => ({ metric: row.metric_key, observation_id: Number(n.id), observed_at: n.observed_at, value: n.value });
    return {
      ...none, method: 'derived', sourceType: 'derived', formula: 'manual_mean_of_neighbours@1',
      locator: scrubLocator({ note: row.source_detail }), inputs: [input(neighbours.prev), input(neighbours.next)],
    };
  }
  const note = row.source_detail ?? null;
  const quote = row.quoted_text ?? null;
  if (!note && !quote) return { reason: 'manual_without_citation' };
  return {
    ...none, method: 'disclosed', sourceType: 'disclosure', formula: null,
    locator: scrubLocator({ note, legacy_seed: true }), ...(quote === null ? { quotedText: note } : {}),
  };
}

/** The rows in force on the day before and after `row` (same metric and period), or null where there is not exactly one. */
async function neighboursOf(db: Db, row: Row): Promise<{ prev: NeighbourRow | null; next: NeighbourRow | null }> {
  const rows = await db.all<NeighbourRow & { side: string }>(
    `SELECT id, observed_at, value, CASE WHEN observed_at < $3::timestamptz THEN 'prev' ELSE 'next' END AS side FROM observations
     WHERE asset_id = $1 AND metric_key = $2 AND period_days IS NOT DISTINCT FROM $4::bigint AND superseded_by IS NULL AND status != 'rejected'
       AND observed_at IN ($3::timestamptz - interval '1 day', $3::timestamptz + interval '1 day')
     ORDER BY observed_at, id`,
    [row.asset_id, row.metric_key, row.observed_at ?? null, row.period_days ?? null],
  );
  const one = (side: string): NeighbourRow | null => {
    const xs = rows.filter((r) => r.side === side);
    return xs.length === 1 ? { id: Number(xs[0]!.id), observed_at: xs[0]!.observed_at, value: xs[0]!.value } : null;
  };
  return { prev: one('prev'), next: one('next') };
}

/**
 * Maps every row that has no provenance. A dry run writes nothing. Rows are written in batches of at most
 * BACKFILL_BATCH_ROWS, one transaction per batch under the asset's lock; a row that gained provenance meanwhile
 * (`method IS NOT NULL`) is left alone, so a re-run after a crash resumes where the last whole batch ended.
 */
export async function backfillProvenance(db: Db, assets: LoadedAsset[], opts: BackfillOptions = {}): Promise<BackfillResult> {
  const byId = new Map(assets.map((a) => [a.config.id, a]));
  const result: BackfillResult = { dryRun: opts.dryRun === true, alreadySet: 0, mapped: {}, unmapped: [] };
  result.alreadySet = (await db.one<{ n: number }>('SELECT count(*)::bigint AS n FROM observations WHERE method IS NOT NULL'))?.n ?? 0;
  const rows = await db.all<Row>(
    'SELECT id, asset_id, metric_key, source, source_detail, citation_url, observed_at, period_days, quoted_text FROM observations WHERE method IS NULL ORDER BY asset_id, id',
  );
  const perAsset = new Map<string, { row: Row; m: Mapped }[]>();
  for (const row of rows) {
    const m = mapRow(row, byId.get(row.asset_id), isNeighbourCorrection(row) ? await neighboursOf(db, row) : undefined);
    if ('reason' in m) {
      result.unmapped.push({ id: row.id, assetId: row.asset_id, metricKey: row.metric_key, source: row.source, reason: m.reason });
      continue;
    }
    const key = `${row.asset_id}:${row.metric_key}`;
    result.mapped[key] = (result.mapped[key] ?? 0) + 1;
    let list = perAsset.get(row.asset_id);
    if (list === undefined) perAsset.set(row.asset_id, (list = []));
    list.push({ row, m });
  }
  if (result.dryRun) return result;
  for (const [assetId, list] of perAsset) {
    for (let i = 0; i < list.length; i += BACKFILL_BATCH_ROWS) {
      const batch = list.slice(i, i + BACKFILL_BATCH_ROWS).map(({ row, m }) => ({
        id: row.id, method: m.method, source_type: m.sourceType, chain: m.chain, locator: m.locator, block_from: m.blockFrom, block_to: m.blockTo, formula: m.formula,
        inputs: m.inputs ?? null, quoted_text: m.quotedText ?? null,
      }));
      await db.tx(
        async (t) => {
          await t.run(
            `UPDATE observations o SET method = m.method, source_type = m.source_type, chain = m.chain, locator = m.locator, block_from = m.block_from,
               block_to = m.block_to, formula = m.formula, inputs = m.inputs, quoted_text = COALESCE(o.quoted_text, m.quoted_text), code_version = $2, config_hash = $2
             FROM jsonb_to_recordset($1::jsonb) AS m(id bigint, method text, source_type text, chain text, locator jsonb, block_from bigint, block_to bigint, formula text,
               inputs jsonb, quoted_text text)
             WHERE o.id = m.id AND o.method IS NULL`,
            [JSON.stringify(batch), PRE_V2],
          );
        },
        { lockAsset: assetId },
      );
    }
  }
  return result;
}
