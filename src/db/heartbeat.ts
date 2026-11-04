import type { Db } from './connection.js';

/**
 * `daemon_heartbeat`: one row per daemon process (spec 5.2). The daemon writes it at start, at each job start and end
 * and every 15 min (never on the 30 s watchdog beat). `drain_requested_at` is the drain flag (plan R9): `orion daemon
 * drain` sets it, the daemon claims nothing while it is set and reports `drained` once idle.
 */

export type HeartbeatState = 'running' | 'draining' | 'drained' | 'stopped';

export interface HeartbeatRow {
  daemonId: string;
  pid: number;
  host: string;
  releaseTag: string | null;
  startedAt: string;
  beatAt: string;
  currentJobId: number | null;
  state: HeartbeatState;
  drainRequestedAt: string | null;
}

interface Row {
  daemon_id: string;
  pid: number;
  host: string;
  release_tag: string | null;
  started_at: string;
  beat_at: string;
  current_job_id: number | null;
  state: HeartbeatState;
  drain_requested_at: string | null;
}

function fromRow(r: Row): HeartbeatRow {
  return {
    daemonId: r.daemon_id, pid: r.pid, host: r.host, releaseTag: r.release_tag, startedAt: r.started_at, beatAt: r.beat_at,
    currentJobId: r.current_job_id, state: r.state, drainRequestedAt: r.drain_requested_at,
  };
}

/** The new daemon's row: `running`, beat at its start, no drain request. */
export async function startHeartbeat(
  db: Db, row: { daemonId: string; pid: number; host: string; releaseTag: string | null; startedAt: string },
): Promise<void> {
  await db.run(
    `INSERT INTO daemon_heartbeat (daemon_id, pid, host, release_tag, started_at, beat_at, current_job_id, state, drain_requested_at)
     VALUES ($1, $2, $3, $4, $5, $5, NULL, 'running', NULL)`,
    [row.daemonId, row.pid, row.host, row.releaseTag, row.startedAt],
  );
}

/** Rows of earlier daemons not marked stopped (they died): stopped now. Start-up only, under the singleton lock. */
export async function stopStaleHeartbeats(db: Db, exceptDaemonId: string): Promise<number> {
  const res = await db.run("UPDATE daemon_heartbeat SET state = 'stopped', current_job_id = NULL WHERE state <> 'stopped' AND daemon_id <> $1", [exceptDaemonId]);
  return res.rowCount;
}

export async function beat(db: Db, daemonId: string, b: { currentJobId: number | null; state: HeartbeatState }, now: Date): Promise<void> {
  await db.run('UPDATE daemon_heartbeat SET beat_at = $2, current_job_id = $3, state = $4 WHERE daemon_id = $1', [daemonId, now.toISOString(), b.currentJobId, b.state]);
}

/** Asks the newest daemon that is not stopped to drain (an earlier request's time is kept); its id, or null when there is none. */
export async function requestDrain(db: Db, now: Date): Promise<string | null> {
  const res = await db.run<{ daemon_id: string }>(
    `UPDATE daemon_heartbeat SET drain_requested_at = COALESCE(drain_requested_at, $1)
     WHERE daemon_id = (SELECT daemon_id FROM daemon_heartbeat WHERE state <> 'stopped' ORDER BY started_at DESC, daemon_id DESC LIMIT 1)
     RETURNING daemon_id`,
    [now.toISOString()],
  );
  return res.rows[0]?.daemon_id ?? null;
}

/** Withdraws every drain request (`orion daemon undrain`); how many rows had one. */
export async function clearDrain(db: Db): Promise<number> {
  const res = await db.run('UPDATE daemon_heartbeat SET drain_requested_at = NULL WHERE drain_requested_at IS NOT NULL');
  return res.rowCount;
}

export async function getHeartbeat(db: Db, daemonId: string): Promise<HeartbeatRow | null> {
  const r = await db.one<Row>('SELECT * FROM daemon_heartbeat WHERE daemon_id = $1', [daemonId]);
  return r ? fromRow(r) : null;
}

/** The newest daemon's row (by start), whatever its state; null when no daemon ever ran. */
export async function latestHeartbeat(db: Db): Promise<HeartbeatRow | null> {
  const r = await db.one<Row>('SELECT * FROM daemon_heartbeat ORDER BY started_at DESC, daemon_id DESC LIMIT 1');
  return r ? fromRow(r) : null;
}
