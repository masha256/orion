/**
 * Task 10 (G3) proof, ruling R10.2a: on a schema that still has `observations.source` (a prod copy at 0005, before
 * this build migrates it), every row's derived origin (`originOf`, src/provenance/origin.ts) must equal the stored
 * column. Read-only. Exit 0 when every row matches, 1 otherwise; prints a JSON summary.
 *
 *   ORION_DATABASE_URL=<url> ORION_DB_SCHEMA=p2proof_<stamp> npx tsx tools/phase2-proof/origin-check.ts
 *
 * Run it after prod_copy.py and BEFORE `db migrate --breaking` on the copy (0006 drops the column it compares with).
 */
import { databaseConfig, openDb, type Db } from '../../src/db/connection.js';
import { originOfRow, type OriginRow } from '../../src/provenance/origin.js';

export interface OriginCheck {
  rows: number;
  equal: number;
  /** Rows with a null provenance column: they cannot be derived (and 0006 would refuse them). */
  unmapped: number;
  /** Per `method/source_type/stored->derived`, the count, for every mismatching shape. */
  mismatches: Record<string, number>;
  /** The first 50 mismatching ids. */
  mismatchIds: number[];
}

export async function originCheck(db: Db): Promise<OriginCheck> {
  const rows = await db.all<{ id: number; source: string } & { [K in keyof OriginRow]: OriginRow[K] | null }>(
    'SELECT id, source, method, source_type, locator, formula FROM observations ORDER BY id',
  );
  const out: OriginCheck = { rows: rows.length, equal: 0, unmapped: 0, mismatches: {}, mismatchIds: [] };
  for (const r of rows) {
    if (r.method === null || r.source_type === null) {
      out.unmapped++;
      continue;
    }
    const derived = originOfRow({ method: r.method, source_type: r.source_type, locator: r.locator, formula: r.formula });
    if (derived === r.source) {
      out.equal++;
      continue;
    }
    const key = `${r.method}/${r.source_type}/${r.source}->${derived}`;
    out.mismatches[key] = (out.mismatches[key] ?? 0) + 1;
    if (out.mismatchIds.length < 50) out.mismatchIds.push(Number(r.id));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await openDb(databaseConfig(process.env), { checkSchema: false });
  try {
    const r = await originCheck(db);
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.equal === r.rows ? 0 : 1;
  } finally {
    await db.close();
  }
}
