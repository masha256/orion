import type { Db } from './connection.js';

/** The newest reading of one level metric of one asset (latest-only: a new reading replaces the row, never history). */
export interface LatestLevel {
  assetId: string;
  metricKey: string;
  value: number;
  observedAt: string;
  source: string;
  /** The block a chain read was made at; null for an API reading. */
  blockNumber: number | null;
  /** The job that wrote the row; null when written outside a job. */
  jobId: number | null;
}

interface Row {
  asset_id: string;
  metric_key: string;
  value: number;
  observed_at: string;
  source: string;
  block_number: number | null;
  job_id: number | null;
}

const toLevel = (r: Row): LatestLevel => ({
  assetId: r.asset_id, metricKey: r.metric_key, value: r.value, observedAt: r.observed_at, source: r.source, blockNumber: r.block_number, jobId: r.job_id,
});

/** One row per (asset, metric): an existing row is overwritten. */
export async function upsertLatestLevels(db: Db, rows: LatestLevel[]): Promise<void> {
  for (const r of rows) {
    await db.run(
      `INSERT INTO latest_levels (asset_id, metric_key, value, observed_at, source, block_number, job_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (asset_id, metric_key) DO UPDATE SET
         value = excluded.value, observed_at = excluded.observed_at, source = excluded.source, block_number = excluded.block_number, job_id = excluded.job_id`,
      [r.assetId, r.metricKey, r.value, r.observedAt, r.source, r.blockNumber, r.jobId],
    );
  }
}

export async function listLatestLevels(db: Db, assetId?: string): Promise<LatestLevel[]> {
  const rows = assetId === undefined
    ? await db.all<Row>('SELECT * FROM latest_levels ORDER BY asset_id, metric_key')
    : await db.all<Row>('SELECT * FROM latest_levels WHERE asset_id = $1 ORDER BY metric_key', [assetId]);
  return rows.map(toLevel);
}

/** Deletes every row `keep` returns false for; returns how many. */
export async function deleteLatestLevels(db: Db, keep: (r: LatestLevel) => boolean): Promise<number> {
  let n = 0;
  for (const r of await listLatestLevels(db)) {
    if (keep(r)) continue;
    n += (await db.run('DELETE FROM latest_levels WHERE asset_id = $1 AND metric_key = $2', [r.assetId, r.metricKey])).rowCount;
  }
  return n;
}
