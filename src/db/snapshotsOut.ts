import type { SnapshotEnvelope, SnapshotKind } from '../push/envelope.js';
import { MS_PER_DAY } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
import type { Db } from './connection.js';

/**
 * The snapshot outbox (spec 9.1): every snapshot is written here first, then published, so a failed publish is retried
 * from the row and nothing is recomputed. `seq` increases per kind.
 */

/** Every outbox write that allocates a seq takes this advisory lock. */
export const SNAPSHOTS_LOCK = 'orion:snapshots';
/** Outbox rows older than this are pruned, except the newest `KEEP_FULL` full snapshots (and the newest levels one). */
export const SNAPSHOT_RETENTION_DAYS = 30;
export const KEEP_FULL = 7;

export interface OutboxRow {
  id: number;
  kind: SnapshotKind;
  seq: number;
  snapshotId: string;
  sha256: string;
  day: string | null;
  /** The whole envelope, as canonical JSON text (exactly the bytes published, less the trailing newline). */
  body: string;
  createdAt: string;
  pushedAt: string | null;
  attempts: number;
  lastError: string | null;
  alertedAt: string | null;
}

interface Row {
  id: number;
  kind: SnapshotKind;
  seq: number;
  snapshot_id: string;
  sha256: string;
  day: string | null;
  body: string;
  created_at: string;
  pushed_at: string | null;
  attempts: number;
  last_error: string | null;
  alerted_at: string | null;
}

const fromRow = (r: Row): OutboxRow => ({
  id: r.id, kind: r.kind, seq: r.seq, snapshotId: r.snapshot_id, sha256: r.sha256, day: r.day, body: r.body, createdAt: r.created_at,
  pushedAt: r.pushed_at, attempts: r.attempts, lastError: r.last_error, alertedAt: r.alerted_at,
});

/**
 * Stores a snapshot with the next seq of its kind (the envelope's own `seq` is replaced by it; `sha256` covers only the
 * body, so it is unaffected). `created_at` is the envelope's `generated_at`.
 */
export async function insertSnapshot(db: Db, s: { kind: SnapshotKind; day: string | null; envelope: Omit<SnapshotEnvelope, 'seq'> }): Promise<OutboxRow> {
  return await db.tx(async (tx) => {
    const next = await tx.one<{ seq: number }>('SELECT coalesce(max(seq), 0) + 1 AS seq FROM snapshots_out WHERE kind = $1', [s.kind]);
    const envelope: SnapshotEnvelope = { ...s.envelope, kind: s.kind, seq: next!.seq };
    const res = await tx.run<Row>(
      `INSERT INTO snapshots_out (kind, seq, snapshot_id, sha256, day, body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [s.kind, envelope.seq, envelope.snapshot_id, envelope.sha256, s.day, canonicalJson(envelope), envelope.generated_at],
    );
    return fromRow(res.rows[0]);
  }, { lockAsset: SNAPSHOTS_LOCK });
}

/** Unpushed rows, oldest first. */
export async function pendingSnapshots(db: Db): Promise<OutboxRow[]> {
  return (await db.all<Row>('SELECT * FROM snapshots_out WHERE pushed_at IS NULL ORDER BY created_at, id')).map(fromRow);
}

export async function markPushed(db: Db, ids: readonly number[], at: string): Promise<void> {
  await db.run('UPDATE snapshots_out SET pushed_at = $2, last_error = NULL WHERE id = ANY($1::bigint[])', [ids, at]);
}

/** One more failed attempt for each row. */
export async function markPushFailed(db: Db, ids: readonly number[], error: string): Promise<void> {
  await db.run('UPDATE snapshots_out SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])', [ids, error]);
}

export async function markAlerted(db: Db, ids: readonly number[], at: string): Promise<void> {
  await db.run('UPDATE snapshots_out SET alerted_at = $2 WHERE id = ANY($1::bigint[]) AND alerted_at IS NULL', [ids, at]);
}

/** The highest-seq pushed row of `kind`, or null. */
export async function latestPushed(db: Db, kind: SnapshotKind): Promise<OutboxRow | null> {
  const row = await db.one<Row>('SELECT * FROM snapshots_out WHERE kind = $1 AND pushed_at IS NOT NULL ORDER BY seq DESC LIMIT 1', [kind]);
  return row ? fromRow(row) : null;
}

/**
 * Deletes rows created more than 30 days before `now`, except the newest 7 `full` and the newest `levels` (the next
 * publish rebuilds its file set from the newest row of each kind, so those must survive a quiet month). How many.
 */
export async function pruneSnapshots(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_DAYS * MS_PER_DAY).toISOString();
  const res = await db.run(
    `DELETE FROM snapshots_out WHERE created_at < $1
       AND id NOT IN (SELECT id FROM snapshots_out WHERE kind = 'full' ORDER BY seq DESC LIMIT $2)
       AND id NOT IN (SELECT id FROM snapshots_out WHERE kind = 'levels' ORDER BY seq DESC LIMIT 1)`,
    [cutoff, KEEP_FULL],
  );
  return res.rowCount;
}
