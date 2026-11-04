import type { WatchRule } from '../types.js';
import type { Db } from './connection.js';

/** Whether a level watch is firing, per asset and metric, so the hourly job posts on a change only (fire, clear). */
export interface WatchStateRow {
  assetId: string;
  metricKey: string;
  rule: WatchRule;
  firing: boolean;
  /** When the current state (firing or not) began. */
  since: string;
  lastValue: number | null;
}

interface Row {
  asset_id: string;
  metric_key: string;
  rule: WatchRule;
  firing: boolean;
  since: string;
  last_value: number | null;
}

export async function listWatchStates(db: Db, assetId?: string): Promise<WatchStateRow[]> {
  const rows = assetId === undefined
    ? await db.all<Row>('SELECT * FROM watch_state ORDER BY asset_id, metric_key')
    : await db.all<Row>('SELECT * FROM watch_state WHERE asset_id = $1 ORDER BY metric_key', [assetId]);
  return rows.map((r) => ({ assetId: r.asset_id, metricKey: r.metric_key, rule: r.rule, firing: r.firing, since: r.since, lastValue: r.last_value }));
}

/** Upserts each row (one per asset and metric). */
export async function putWatchStates(db: Db, rows: WatchStateRow[]): Promise<void> {
  for (const r of rows) {
    await db.run(
      `INSERT INTO watch_state (asset_id, metric_key, rule, firing, since, last_value) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (asset_id, metric_key) DO UPDATE SET
         rule = excluded.rule, firing = excluded.firing, since = excluded.since, last_value = excluded.last_value`,
      [r.assetId, r.metricKey, r.rule, r.firing ? 'true' : 'false', r.since, r.lastValue],
    );
  }
}
