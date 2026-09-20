import type { Db } from './connection.js';

export interface Coverage {
  assetId: string;
  persona: string;
  assignedAt: string;
}

interface Row {
  asset_id: string;
  persona: string;
  assigned_at: string;
}

const fromRow = (r: Row): Coverage => ({ assetId: r.asset_id, persona: r.persona, assignedAt: r.assigned_at });

/** One lead persona per asset. Assigning again replaces the earlier assignment. */
export function assignPersona(db: Db, assetId: string, persona: string, nowIso: string): Coverage {
  db.prepare(
    `INSERT INTO coverage (asset_id, persona, assigned_at) VALUES (?, ?, ?)
     ON CONFLICT (asset_id) DO UPDATE SET persona = excluded.persona, assigned_at = excluded.assigned_at`,
  ).run(assetId, persona, new Date(nowIso).toISOString());
  return getCoverage(db, assetId)!;
}

export function getCoverage(db: Db, assetId: string): Coverage | null {
  const row = db.prepare('SELECT * FROM coverage WHERE asset_id = ?').get(assetId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listCoverage(db: Db): Coverage[] {
  return (db.prepare('SELECT * FROM coverage ORDER BY asset_id').all() as Row[]).map(fromRow);
}
