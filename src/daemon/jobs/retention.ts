import { loadAsset } from '../../config/load.js';
import type { Db } from '../../db/connection.js';
import { listRegistry } from '../../db/registry.js';
import { pruneSnapshots } from '../../db/snapshotsOut.js';
import { MS_PER_DAY, OrionError } from '../../types.js';
import type { JobHandler } from '../daemon.js';

/** Finished jobs are kept this long after they ended. */
export const RETENTION_JOB_DAYS = 90;

/**
 * The daily `retention` job: deletes finished jobs (done, failed, skipped) that ended more than 90 days ago, and the
 * `latest_levels` / `watch_state` rows of an asset that is `missing` (or has no YAML at all) or of a metric its YAML no
 * longer declares. An asset whose YAML does not load is left alone. Prunes the snapshot outbox (older than 30 days,
 * except the newest 7 `full` and the newest `levels`).
 */
export const retentionHandler: JobHandler = async (_job, ctx) => {
  const { db } = ctx;
  const cutoff = new Date(ctx.clock.now().getTime() - RETENTION_JOB_DAYS * MS_PER_DAY).toISOString();
  const jobs = (await db.run("DELETE FROM jobs WHERE ended_at < $1 AND status IN ('done', 'failed', 'skipped')", [cutoff])).rowCount;
  let latestLevels = 0;
  let watchState = 0;
  const missing = new Set((await listRegistry(db)).filter((r) => r.state === 'missing').map((r) => r.assetId));
  for (const assetId of await assetsWithRows(db)) {
    let keep: string[];
    if (missing.has(assetId)) {
      keep = [];
    } else {
      try {
        keep = Object.keys(loadAsset(ctx.paths.configRoot, assetId).config.metrics);
      } catch (err) {
        if (!(err instanceof OrionError)) throw err;
        if (err.code !== 'asset_not_found') {
          ctx.log(`${assetId}: YAML does not load, its levels are kept: ${err.message.split('\n')[0]}`);
          continue;
        }
        keep = [];
      }
    }
    latestLevels += (await db.run('DELETE FROM latest_levels WHERE asset_id = $1 AND NOT (metric_key = ANY($2::text[]))', [assetId, keep])).rowCount;
    watchState += (await db.run('DELETE FROM watch_state WHERE asset_id = $1 AND NOT (metric_key = ANY($2::text[]))', [assetId, keep])).rowCount;
  }
  const snapshots = await pruneSnapshots(db, ctx.clock.now());
  return { status: 'done', result: { jobs, latestLevels, watchState, snapshots } };
};

async function assetsWithRows(db: Db): Promise<string[]> {
  const rows = await db.all<{ asset_id: string }>('SELECT asset_id FROM latest_levels UNION SELECT asset_id FROM watch_state ORDER BY asset_id');
  return rows.map((r) => r.asset_id);
}
