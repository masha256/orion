import type { Scenario } from '../types.js';
import type { Db } from './connection.js';

/** One changed value inside an assumption set, with its own rationale and the observations cited for it. */
export interface AssumptionChange {
  id: number;
  setId: number;
  key: string;
  scenario: Scenario;
  fromValue: number;
  toValue: number;
  rationale: string;
  evidence: number[];
}

export interface NewAssumptionChange {
  setId: number;
  key: string;
  scenario: Scenario;
  fromValue: number;
  toValue: number;
  rationale: string;
  evidence: number[];
}

interface Row {
  id: number;
  set_id: number;
  key: string;
  scenario: Scenario;
  from_value: number;
  to_value: number;
  rationale: string;
}

export function insertAssumptionChange(db: Db, input: NewAssumptionChange): AssumptionChange {
  const id = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO assumption_changes (set_id, key, scenario, from_value, to_value, rationale) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.setId, input.key, input.scenario, input.fromValue, input.toValue, input.rationale);
    const changeId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT OR IGNORE INTO assumption_evidence (change_id, observation_id) VALUES (?, ?)');
    for (const observationId of input.evidence) insert.run(changeId, observationId);
    return changeId;
  })();
  return listAssumptionChanges(db, input.setId).find((c) => c.id === id)!;
}

/** In insertion order. */
export function listAssumptionChanges(db: Db, setId: number): AssumptionChange[] {
  const rows = db.prepare('SELECT * FROM assumption_changes WHERE set_id = ? ORDER BY id').all(setId) as Row[];
  const evidence = db.prepare('SELECT observation_id FROM assumption_evidence WHERE change_id = ? ORDER BY observation_id');
  return rows.map((r) => ({
    id: r.id, setId: r.set_id, key: r.key, scenario: r.scenario, fromValue: r.from_value, toValue: r.to_value, rationale: r.rationale,
    evidence: (evidence.all(r.id) as { observation_id: number }[]).map((e) => e.observation_id),
  }));
}
