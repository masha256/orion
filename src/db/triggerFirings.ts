import type { Db } from './connection.js';

export const TRIGGER_KINDS = ['open_anomaly', 'driver_deviation', 'staleness', 'provisional', 'calendar'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** One live row per trigger instance (asset, kind, key): the instance fired once and has not cleared since. */
export interface Firing {
  id: number;
  assetId: string;
  kind: TriggerKind;
  key: string;
  firedAt: string;
  /** The run launched for it (or the scheduled run that absorbed it), whatever that run's outcome; null when none started. */
  agentRunId: number | null;
  detail: Record<string, unknown>;
}

interface Row {
  id: number;
  asset_id: string;
  kind: TriggerKind;
  key: string;
  fired_at: string;
  agent_run_id: number | null;
  detail_json: string;
}

function fromRow(r: Row): Firing {
  return {
    id: r.id, assetId: r.asset_id, kind: r.kind, key: r.key, firedAt: r.fired_at, agentRunId: r.agent_run_id,
    detail: JSON.parse(r.detail_json) as Record<string, unknown>,
  };
}

export function insertFiring(db: Db, input: { assetId: string; kind: TriggerKind; key: string; firedAt: string; detail: Record<string, unknown> }): Firing {
  const info = db
    .prepare('INSERT INTO trigger_firings (asset_id, kind, key, fired_at, agent_run_id, detail_json) VALUES (?, ?, ?, ?, NULL, ?)')
    .run(input.assetId, input.kind, input.key, new Date(input.firedAt).toISOString(), JSON.stringify(input.detail));
  return getFiring(db, Number(info.lastInsertRowid))!;
}

export function getFiring(db: Db, id: number): Firing | null {
  const row = db.prepare('SELECT * FROM trigger_firings WHERE id = ?').get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Oldest first. */
export function listFirings(db: Db, assetId: string): Firing[] {
  return (db.prepare('SELECT * FROM trigger_firings WHERE asset_id = ? ORDER BY id').all(assetId) as Row[]).map(fromRow);
}

export function deleteFiring(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM trigger_firings WHERE id = ?').run(id).changes === 1;
}

/** Attaches a run to one or more firings in a single transaction. Returns the number of rows updated. */
export function attachRun(db: Db, ids: number[], agentRunId: number): number {
  return db.transaction(() => {
    const stmt = db.prepare('UPDATE trigger_firings SET agent_run_id = ? WHERE id = ?');
    let sum = 0;
    for (const id of ids) sum += stmt.run(agentRunId, id).changes;
    return sum;
  })();
}
