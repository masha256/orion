import { SCENARIOS, type AssumptionValues, type Scenario } from '../types.js';
import type { Db } from './connection.js';

export interface AssumptionSet {
  id: number;
  assetId: string;
  version: number;
  parentVersion: number | null;
  author: string;
  rationale: string;
  createdAt: string;
  values: AssumptionValues;
}

interface SetRow {
  id: number;
  asset_id: string;
  version: number;
  parent_version: number | null;
  author: string;
  rationale: string;
  created_at: string;
}

function meta(r: SetRow): Omit<AssumptionSet, 'values'> {
  return {
    id: r.id, assetId: r.asset_id, version: r.version, parentVersion: r.parent_version,
    author: r.author, rationale: r.rationale, createdAt: r.created_at,
  };
}

function loadValues(db: Db, setId: number): AssumptionValues {
  const values: AssumptionValues = { bear: {}, base: {}, bull: {} };
  const rows = db.prepare('SELECT key, scenario, value FROM assumptions WHERE set_id = ? ORDER BY key').all(setId) as {
    key: string; scenario: Scenario; value: number;
  }[];
  for (const r of rows) values[r.scenario][r.key] = r.value;
  return values;
}

export function getAssumptionSetById(db: Db, id: number): AssumptionSet | null {
  const row = db.prepare('SELECT * FROM assumption_sets WHERE id = ?').get(id) as SetRow | undefined;
  return row ? { ...meta(row), values: loadValues(db, row.id) } : null;
}

export function getLatestAssumptionSet(db: Db, assetId: string): AssumptionSet | null {
  const row = db
    .prepare('SELECT * FROM assumption_sets WHERE asset_id = ? ORDER BY version DESC LIMIT 1')
    .get(assetId) as SetRow | undefined;
  return row ? { ...meta(row), values: loadValues(db, row.id) } : null;
}

export function listAssumptionSets(db: Db, assetId: string): Omit<AssumptionSet, 'values'>[] {
  const rows = db.prepare('SELECT * FROM assumption_sets WHERE asset_id = ? ORDER BY version DESC').all(assetId) as SetRow[];
  return rows.map(meta);
}

export function createAssumptionSet(
  db: Db,
  input: { assetId: string; author: string; rationale: string; values: AssumptionValues; createdAt: string },
): AssumptionSet {
  const id = db.transaction(() => {
    const latest = getLatestAssumptionSet(db, input.assetId);
    const version = (latest?.version ?? 0) + 1;
    const info = db
      .prepare('INSERT INTO assumption_sets (asset_id, version, parent_version, author, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.assetId, version, latest?.version ?? null, input.author, input.rationale, new Date(input.createdAt).toISOString());
    const setId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO assumptions (set_id, key, scenario, value) VALUES (?, ?, ?, ?)');
    for (const s of SCENARIOS) {
      for (const [key, value] of Object.entries(input.values[s])) insert.run(setId, key, s, value);
    }
    return setId;
  })();
  return getAssumptionSetById(db, id)!;
}
