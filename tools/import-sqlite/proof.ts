import type { DatabaseConfig } from '../../src/db/connection.js';
import { openDb } from '../../src/db/connection.js';
import { carryPlan } from './carry.js';
import { loadAssetsDir, openSource, type ImportManifest } from './importer.js';
import { rowHash, tableHash } from './rowHash.js';

export interface TableProof {
  table: string;
  sqlite_carried: number;
  pg_rows: number;
  manifest_carried: number | null;
  sha256_sqlite: string;
  sha256_pg: string;
  /** The first row (in primary-key order) whose hash differs; `column` null when one side has no row there. */
  first_mismatch: { pk: unknown; column: string | null; sqlite: unknown; pg: unknown } | null;
}

export interface ProofResult {
  ok: boolean;
  tables: TableProof[];
  sequences: { table: string; expected_next: number; pg_next: number; ok: boolean }[];
}

/**
 * Proves an import row for row: every carried table read from SQLite with `carryPlan`'s selects and from Postgres
 * through Orion's own `Db` (`openDb`, so the type parsers are part of what is proved), hashed per row with `rowHash`;
 * and every identity sequence continuing at `sqlite_sequence + 1`.
 */
export async function proveImport(opts: { from: string; to: DatabaseConfig; assetsDir: string; manifest: ImportManifest }): Promise<ProofResult> {
  const sqlite = openSource(opts.from);
  try {
    const plan = carryPlan(sqlite, loadAssetsDir(opts.assetsDir));
    const seqs = new Map((sqlite.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]).map((r) => [r.name, r.seq]));
    const db = await openDb(opts.to);
    try {
      const tables: TableProof[] = [];
      for (const t of plan) {
        const names = t.columns.map((c) => c.name);
        const lite = sqlite.prepare(t.select).raw().all() as unknown[][];
        const pg = (await db.all(`SELECT ${names.join(', ')} FROM ${t.table} ORDER BY ${t.primaryKey.join(', ')}`)).map((r) => names.map((n) => r[n]));
        const liteHashes = lite.map(rowHash);
        const pgHashes = pg.map(rowHash);
        const pkIdx = t.primaryKey.map((k) => names.indexOf(k));
        const pkOf = (row: unknown[]) => (pkIdx.length === 1 ? row[pkIdx[0]!] : pkIdx.map((i) => row[i]));
        let firstMismatch: TableProof['first_mismatch'] = null;
        for (let i = 0; i < Math.max(lite.length, pg.length) && !firstMismatch; i++) {
          if (liteHashes[i] === pgHashes[i]) continue;
          const a = lite[i];
          const b = pg[i];
          if (!a || !b) {
            firstMismatch = { pk: pkOf((a ?? b)!), column: null, sqlite: a ?? null, pg: b ?? null };
            break;
          }
          const j = names.findIndex((_, c) => rowHash([a[c]]) !== rowHash([b[c]]));
          firstMismatch = { pk: pkOf(a), column: names[j]!, sqlite: a[j], pg: b[j] };
        }
        tables.push({
          table: t.table,
          sqlite_carried: lite.length,
          pg_rows: pg.length,
          manifest_carried: opts.manifest.tables.find((m) => m.table === t.table)?.carried ?? null,
          sha256_sqlite: tableHash(liteHashes),
          sha256_pg: tableHash(pgHashes),
          first_mismatch: firstMismatch,
        });
      }

      const sequences: ProofResult['sequences'] = [];
      for (const t of plan.filter((p) => p.identity)) {
        const row = await db.one<{ v: number | null }>(
          `SELECT s.last_value AS v FROM pg_sequences s
            WHERE s.schemaname || '.' || s.sequencename = pg_get_serial_sequence($1, 'id')`,
          [`${db.schema}.${t.table}`],
        );
        const pgNext = (row?.v ?? 0) + 1;
        const expected = (seqs.get(t.table) ?? 0) + 1;
        sequences.push({ table: t.table, expected_next: expected, pg_next: pgNext, ok: pgNext === expected });
      }

      const ok =
        tables.every((t) => t.sqlite_carried === t.pg_rows && t.pg_rows === t.manifest_carried && t.sha256_sqlite === t.sha256_pg && !t.first_mismatch) &&
        sequences.every((s) => s.ok);
      return { ok, tables, sequences };
    } finally {
      await db.close();
    }
  } finally {
    sqlite.close();
  }
}
