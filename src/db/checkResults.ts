import type { Db } from './connection.js';

export type CheckStatus = 'ok' | 'breach' | 'incomplete';

/** One check's evaluation for one asset and day (migration 0003). `lhs`/`rhs`/`gapPct` are null when incomplete. */
export interface CheckResult {
  assetId: string;
  checkId: string;
  day: string;
  type: string;
  lhs: number | null;
  rhs: number | null;
  /** |lhs - rhs| / max(|lhs|, |rhs|) x 100 (0 when both are 0); for a revision check, the worst restated day's. */
  gapPct: number | null;
  status: CheckStatus;
  detail: Record<string, unknown>;
  evaluatedAt: string;
}

interface Row {
  asset_id: string;
  check_id: string;
  day: string;
  type: string;
  lhs: number | null;
  rhs: number | null;
  gap_pct: number | null;
  status: CheckStatus;
  detail_json: string;
  evaluated_at: string;
}

const fromRow = (r: Row): CheckResult => ({
  assetId: r.asset_id, checkId: r.check_id, day: r.day, type: r.type, lhs: r.lhs, rhs: r.rhs, gapPct: r.gap_pct, status: r.status,
  detail: JSON.parse(r.detail_json) as Record<string, unknown>, evaluatedAt: r.evaluated_at,
});

/**
 * Writes each row, replacing the stored one for the same (asset, check, day): the latest evaluation of a day wins.
 * Takes a transaction handle (or the database) and awaits each statement in turn.
 */
export async function upsertCheckResults(t: Db, rows: CheckResult[]): Promise<void> {
  for (const r of rows) {
    await t.run(
      `INSERT INTO check_results (asset_id, check_id, day, type, lhs, rhs, gap_pct, status, detail_json, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (asset_id, check_id, day) DO UPDATE SET
         type = excluded.type, lhs = excluded.lhs, rhs = excluded.rhs, gap_pct = excluded.gap_pct, status = excluded.status,
         detail_json = excluded.detail_json, evaluated_at = excluded.evaluated_at`,
      [r.assetId, r.checkId, r.day, r.type, r.lhs, r.rhs, r.gapPct, r.status, JSON.stringify(r.detail), new Date(r.evaluatedAt).toISOString()],
    );
  }
}

/** The asset's stored results, by check id; for one day when given (newest day first otherwise). */
export async function listCheckResults(db: Db, assetId: string, day?: string): Promise<CheckResult[]> {
  const rows = day === undefined
    ? await db.all<Row>('SELECT * FROM check_results WHERE asset_id = $1 ORDER BY day DESC, check_id', [assetId])
    : await db.all<Row>('SELECT * FROM check_results WHERE asset_id = $1 AND day = $2 ORDER BY check_id', [assetId, day]);
  return rows.map(fromRow);
}
