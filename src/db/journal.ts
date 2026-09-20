import type { Db } from './connection.js';

export interface JournalEntry {
  id: number;
  assetId: string;
  persona: string;
  agentRunId: number | null;
  createdAt: string;
  /** The running view of the asset. */
  thesis: string;
  /** What the next run should look at. */
  openQuestions: string[];
  /** What this run did and why. */
  summary: string;
}

export interface NewJournalEntry {
  assetId: string;
  persona: string;
  agentRunId: number | null;
  createdAt: string;
  thesis: string;
  openQuestions: string[];
  summary: string;
}

interface Row {
  id: number;
  asset_id: string;
  persona: string;
  agent_run_id: number | null;
  created_at: string;
  thesis: string;
  open_questions_json: string;
  summary: string;
}

const fromRow = (r: Row): JournalEntry => ({
  id: r.id, assetId: r.asset_id, persona: r.persona, agentRunId: r.agent_run_id, createdAt: r.created_at, thesis: r.thesis,
  openQuestions: JSON.parse(r.open_questions_json) as string[], summary: r.summary,
});

/** Append-only. */
export function insertJournalEntry(db: Db, input: NewJournalEntry): JournalEntry {
  const info = db
    .prepare('INSERT INTO journal (asset_id, persona, agent_run_id, created_at, thesis, open_questions_json, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      input.assetId, input.persona, input.agentRunId, new Date(input.createdAt).toISOString(), input.thesis,
      JSON.stringify(input.openQuestions), input.summary,
    );
  const row = db.prepare('SELECT * FROM journal WHERE id = ?').get(Number(info.lastInsertRowid)) as Row;
  return fromRow(row);
}

/** Newest first. `beforeId` pages backwards through older entries. */
export function listJournal(db: Db, assetId: string, opts: { limit?: number; beforeId?: number } = {}): JournalEntry[] {
  const limit = opts.limit ?? 3;
  const rows = (
    opts.beforeId === undefined
      ? db.prepare('SELECT * FROM journal WHERE asset_id = ? ORDER BY id DESC LIMIT ?').all(assetId, limit)
      : db.prepare('SELECT * FROM journal WHERE asset_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(assetId, opts.beforeId, limit)
  ) as Row[];
  return rows.map(fromRow);
}
