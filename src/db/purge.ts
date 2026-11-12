import { createHash } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lockHolder, withRunLock } from '../app/lock.js';
import type { LoadedAsset } from '../config/load.js';
import { sourceTypeOf, type SourceType } from '../report/sourceTypes.js';
import { OrionError } from '../types.js';
import type { Db, OrionDb } from './connection.js';

/**
 * `orion data purge` (Phase 3 plan decision P2): deletes the stored history of a retired metric (one no longer in the
 * asset YAML), or the rows of one source type (`third_party`: DefiLlama history) of a metric still configured. A dry run
 * by default; applying writes every row it deletes to one JSON file first, then deletes, in one transaction that holds
 * the asset's run lock. Refused, with nothing written (spec Review Focus):
 * - a configured metric without a source type (`purge_configured_metric`), or with its current source's type
 *   (`purge_live_source`): the live series is never purged;
 * - a metric with an open anomaly (`purge_open_anomaly`): its triage still needs the rows;
 * - a kept row whose `superseded_by` points at a row to delete (`purge_dangling_reference`).
 *
 * Side state goes only with a metric that is gone entirely (not configured, and no row of it left after the purge):
 * its `latest_levels` and `watch_state` rows, and the `fetch_cursors` whose scan key names it alone. An API flow's
 * cursor is keyed `<sourceId>><metric>` (one per metric, src/ingest/run.ts); a transfer scan's is a hash over
 * token|sink|allowlist (src/ingest/plan.ts `flowScanKey`), shared by every metric that scan feeds, so it is never
 * deleted. A configured metric's side state belongs to its live source and is left alone.
 */

/** Every rung an observation's `source_type` may hold (the 0004 CHECK). */
export const SOURCE_TYPES: readonly SourceType[] = [
  'contract_state', 'log_scan', 'first_party_api', 'pool_scan', 'disclosure', 'derived', 'constant', 'market_data', 'third_party',
];

export interface PurgeMetricCount {
  metric: string;
  /** In the asset YAML: only rows of `sourceType` may go, and side state stays. */
  configured: boolean;
  /** Rows to delete (or deleted), superseded ones included. */
  observations: number;
  /** Of those, how many were superseded. */
  superseded: number;
  /** UTC date of the oldest and newest `observed_at` among them; null when there is none. */
  firstDay: string | null;
  lastDay: string | null;
  /** Sum of their `value` (every row, superseded too): a figure to check the export against. */
  valueSum: number;
  latestLevels: number;
  watchState: number;
  fetchCursors: number;
}

export interface PurgeResult {
  asset: string;
  perMetric: PurgeMetricCount[];
  /** The export written before deleting; null on a dry run or when there was nothing to delete. */
  exportFile: string | null;
  /** sha256 (hex) of the export file's bytes. */
  exportSha256: string | null;
  applied: boolean;
}

export interface PurgeOptions {
  metrics: string[];
  sourceType?: SourceType;
  apply: boolean;
  /** `$ORION_HOME/purged` from the CLI. Created mode 700; the export file is mode 600. */
  exportDir: string;
  now: Date;
  /** Test seam: fsyncs one directory (its entries). Defaults to open + fsync + close. */
  syncDir?: (dir: string) => void;
}

interface MetricPlan {
  count: PurgeMetricCount;
  ids: number[];
  /** No row of the metric is left and it is not configured: its side state goes too. */
  gone: boolean;
}

export async function purgeMetrics(db: OrionDb, loaded: LoadedAsset, opts: PurgeOptions): Promise<PurgeResult> {
  const asset = loaded.config.id;
  const metrics = [...new Set(opts.metrics)];
  if (metrics.length === 0) throw new OrionError('purge_no_metric', 'name at least one --metric to purge');
  if (opts.sourceType !== undefined && !SOURCE_TYPES.includes(opts.sourceType)) {
    throw new OrionError('invalid_source_type', `--source-type must be one of ${SOURCE_TYPES.join(', ')}; got ${String(opts.sourceType)}`);
  }
  // The config-only refusals first, before any lock: a refused --yes gives the dry run's code even while a refresh holds
  // the lock, and writes nothing (taking the lock would abandon orphaned agent runs). Re-checked inside the transaction.
  checkConfigured(loaded, metrics, opts.sourceType);
  if (!opts.apply) {
    const plans = await planPurge(db, loaded, metrics, opts.sourceType);
    return { asset, perMetric: plans.map((p) => p.count), exportFile: null, exportSha256: null, applied: false };
  }
  return await withRunLock(db, asset, lockHolder('orion data purge'), opts.now, async () =>
    await db.tx(async (t) => {
      const plans = await planPurge(t, loaded, metrics, opts.sourceType);
      const ids = plans.flatMap((p) => p.ids);
      const gone = plans.filter((p) => p.gone).map((p) => p.count.metric);
      const rows = await exportRows(t, asset, ids, gone);
      const total = rows.observations.length + rows.latestLevels.length + rows.watchState.length + rows.fetchCursors.length;
      let exportFile: string | null = null;
      let exportSha256: string | null = null;
      if (total > 0) {
        // The export is on disk (fsynced) before the first delete; a failure to write it throws, rolling back nothing
        // because nothing was written yet.
        ({ file: exportFile, sha256: exportSha256 } = writeExport(opts.exportDir, asset, metrics, opts.now, {
          asset, metrics, sourceType: opts.sourceType ?? null, createdAt: opts.now.toISOString(), perMetric: plans.map((p) => p.count), ...rows,
        }, opts.syncDir ?? fsyncDir));
      }
      // The self-referencing FK: a deleted row may be superseded by another deleted row (or by a kept one). Clear the
      // pointers inside the set first, so the delete never trips it; a kept row pointing into the set was refused above.
      if (ids.length > 0) {
        await t.run('UPDATE observations SET superseded_by = NULL WHERE id = ANY($1::bigint[]) AND superseded_by IS NOT NULL', [ids]);
        const deleted = (await t.run('DELETE FROM observations WHERE id = ANY($1::bigint[])', [ids])).rowCount;
        if (deleted !== ids.length) throw new OrionError('purge_conflict', `expected to delete ${ids.length} observation(s), deleted ${deleted}`);
      }
      for (const m of gone) {
        await t.run('DELETE FROM latest_levels WHERE asset_id = $1 AND metric_key = $2', [asset, m]);
        await t.run('DELETE FROM watch_state WHERE asset_id = $1 AND metric_key = $2', [asset, m]);
        await t.run(`DELETE FROM fetch_cursors WHERE asset_id = $1 AND ${NAMES_METRIC}`, [asset, m]);
      }
      return { asset, perMetric: plans.map((p) => p.count), exportFile, exportSha256, applied: true };
    }, { lockAsset: asset }),
  );
}

/** A cursor whose scan key is `<sourceId>><metric>`: an API flow's own cursor (no LIKE, so `_` in a key is literal). */
const NAMES_METRIC = "right(scan_key, length($2) + 1) = '>' || $2";

const n = (v: unknown): number => Number(v ?? 0);

/** The refusals that read only the asset config (no DB): a configured metric without a source type, or on its live one. */
function checkConfigured(loaded: LoadedAsset, metrics: string[], sourceType: SourceType | undefined): void {
  const { config } = loaded;
  const asset = config.id;
  for (const metric of metrics) {
    const def = config.metrics[metric];
    if (def === undefined) continue;
    if (sourceType === undefined) {
      throw new OrionError(
        'purge_configured_metric',
        `metric "${metric}" is still configured in assets/${asset}.yaml: pass --source-type <t> to purge only the rows of a retired source`,
      );
    }
    const live = sourceTypeOf(def, config.metrics);
    if (live === null || live === sourceType) {
      throw new OrionError(
        'purge_live_source',
        live === null
          ? `metric "${metric}"'s current source has no known source type, so its rows cannot be told apart from a retired source's`
          : `metric "${metric}"'s current source is ${live}: its ${live} rows are the live series and are never purged`,
      );
    }
  }
}

/** Every refusal and every count, reading only. Throws on the first refused metric, so one refusal refuses the request. */
async function planPurge(db: Db, loaded: LoadedAsset, metrics: string[], sourceType: SourceType | undefined): Promise<MetricPlan[]> {
  const { config } = loaded;
  const asset = config.id;
  checkConfigured(loaded, metrics, sourceType);
  for (const metric of metrics) {
    const open = await db.all<{ id: number }>("SELECT id FROM anomalies WHERE asset_id = $1 AND metric_key = $2 AND status = 'open' ORDER BY id", [asset, metric]);
    if (open.length > 0) {
      throw new OrionError('purge_open_anomaly', `metric "${metric}" has open anomal${open.length === 1 ? 'y' : 'ies'} ${open.map((a) => `#${a.id}`).join(', ')}: resolve or ack first`);
    }
  }
  const plans: MetricPlan[] = [];
  for (const metric of metrics) {
    const configured = config.metrics[metric] !== undefined;
    const ids = (await db.all<{ id: number }>(
      'SELECT id FROM observations WHERE asset_id = $1 AND metric_key = $2 AND ($3::text IS NULL OR source_type = $3) ORDER BY id',
      [asset, metric, sourceType ?? null],
    )).map((r) => n(r.id));
    const s = await db.one<{ superseded: number; first_day: string | null; last_day: string | null; value_sum: number }>(
      `SELECT count(superseded_by)::bigint AS superseded,
              to_char(min(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first_day,
              to_char(max(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_day,
              COALESCE(sum(value)::float8, 0) AS value_sum
         FROM observations WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    const kept = n((await db.one<{ k: number }>(
      'SELECT count(*)::bigint AS k FROM observations WHERE asset_id = $1 AND metric_key = $2 AND NOT (id = ANY($3::bigint[]))', [asset, metric, ids],
    ))?.k);
    const gone = !configured && kept === 0;
    const side = async (sql: string): Promise<number> => (gone ? n((await db.one<{ c: number }>(sql, [asset, metric]))?.c) : 0);
    plans.push({
      ids,
      gone,
      count: {
        metric, configured, observations: ids.length, superseded: n(s?.superseded), firstDay: s?.first_day ?? null, lastDay: s?.last_day ?? null,
        valueSum: n(s?.value_sum),
        latestLevels: await side('SELECT count(*)::bigint AS c FROM latest_levels WHERE asset_id = $1 AND metric_key = $2'),
        watchState: await side('SELECT count(*)::bigint AS c FROM watch_state WHERE asset_id = $1 AND metric_key = $2'),
        fetchCursors: await side(`SELECT count(*)::bigint AS c FROM fetch_cursors WHERE asset_id = $1 AND ${NAMES_METRIC}`),
      },
    });
  }
  const ids = plans.flatMap((p) => p.ids);
  const dangling = await db.all<{ id: number; superseded_by: number }>(
    'SELECT id, superseded_by FROM observations WHERE superseded_by = ANY($1::bigint[]) AND NOT (id = ANY($1::bigint[])) ORDER BY id LIMIT 5',
    [ids],
  );
  if (dangling.length > 0) {
    throw new OrionError(
      'purge_dangling_reference',
      `kept observation(s) ${dangling.map((d) => `#${d.id} (superseded by #${d.superseded_by})`).join(', ')} point at rows this purge would delete`,
    );
  }
  return plans;
}

/** Every deleted row, all columns, as Postgres renders them (`to_jsonb`): what a restore would need. */
async function exportRows(db: Db, asset: string, ids: number[], gone: string[]) {
  const rows = async (sql: string, params: unknown[]): Promise<unknown[]> => (await db.all<{ row: unknown }>(sql, params as never)).map((r) => r.row);
  return {
    observations: await rows('SELECT to_jsonb(o) AS row FROM observations o WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]),
    latestLevels: await rows('SELECT to_jsonb(l) AS row FROM latest_levels l WHERE asset_id = $1 AND metric_key = ANY($2::text[]) ORDER BY metric_key', [asset, gone]),
    watchState: await rows('SELECT to_jsonb(w) AS row FROM watch_state w WHERE asset_id = $1 AND metric_key = ANY($2::text[]) ORDER BY metric_key', [asset, gone]),
    fetchCursors: await rows(
      `SELECT to_jsonb(c) AS row FROM fetch_cursors c, unnest($2::text[]) AS m(k)
        WHERE c.asset_id = $1 AND right(c.scan_key, length(m.k) + 1) = '>' || m.k ORDER BY c.scan_key`,
      [asset, gone],
    ),
  };
}

/**
 * `<asset>-<first metric>[+N]-<UTCstamp>.json`, e.g. `pump-flow_usd.fees-20261112T031500Z.json` or, for three metrics,
 * `pump-flow_usd.fees+2-...`: a long --metric list never exceeds the 255-byte name limit; the JSON lists every metric.
 */
export function exportFileName(asset: string, metrics: string[], now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  const rest = metrics.length > 1 ? `+${metrics.length - 1}` : '';
  return `${asset}-${metrics[0]}${rest}-${stamp}.json`.replace(/[^A-Za-z0-9._+-]/g, '_');
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes the export and makes it durable before any delete: the file is fsynced, then its directory (so the new name
 * survives a crash after the DB commit), and, when this call created the directory, each parent up to the existing one
 * (`$ORION_HOME` on the first purge). Any failure is `purge_export_failed`, thrown before the first delete.
 */
function writeExport(dir: string, asset: string, metrics: string[], now: Date, doc: unknown, syncDir: (dir: string) => void): { file: string; sha256: string } {
  const file = join(dir, exportFileName(asset, metrics, now));
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  try {
    // The first directory it created, or undefined when `dir` already existed.
    const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // 'wx': never overwrite an earlier export.
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(file, 0o600);
    const toSync = [dir];
    if (created !== undefined) {
      for (let p = dir; p !== created && p !== dirname(p); p = dirname(p)) toSync.push(dirname(p));
      toSync.push(dirname(created));
    }
    for (const d of toSync) syncDir(d);
  } catch (err) {
    throw new OrionError('purge_export_failed', `could not write the export ${file}: ${(err as Error).message}; nothing was deleted`);
  }
  return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
}
