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
export async function assignPersona(db: Db, assetId: string, persona: string, nowIso: string): Promise<Coverage> {
  await db.run(
    `INSERT INTO coverage (asset_id, persona, assigned_at) VALUES ($1, $2, $3)
     ON CONFLICT (asset_id) DO UPDATE SET persona = excluded.persona, assigned_at = excluded.assigned_at`,
    [assetId, persona, new Date(nowIso).toISOString()],
  );
  return (await getCoverage(db, assetId))!;
}

export async function getCoverage(db: Db, assetId: string): Promise<Coverage | null> {
  const row = await db.one<Row>('SELECT * FROM coverage WHERE asset_id = $1', [assetId]);
  return row ? fromRow(row) : null;
}

export async function listCoverage(db: Db): Promise<Coverage[]> {
  return (await db.all<Row>('SELECT * FROM coverage ORDER BY asset_id')).map(fromRow);
}
