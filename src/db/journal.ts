import type { StoredCitation } from './documents.js';
import type { Db } from './connection.js';

export const CATALYST_KINDS = ['regulatory', 'product', 'token', 'partnership', 'other'] as const;
export type CatalystKind = (typeof CATALYST_KINDS)[number];

/**
 * A dated claim from a source the run cited: either `by` a date, or between `from` and `to` (ISO `YYYY-MM-DD`). It
 * schedules nothing; a later run's context pack lists it under `catalysts_due` when its date comes near.
 */
export interface Catalyst {
  event: string;
  kind: CatalystKind;
  by?: string;
  from?: string;
  to?: string;
  /** Each verified when the journal was written. */
  citations: StoredCitation[];
}

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
  /** `[]` on rows written before catalysts existed. */
  catalysts: Catalyst[];
}

export interface NewJournalEntry {
  assetId: string;
  persona: string;
  agentRunId: number | null;
  createdAt: string;
  thesis: string;
  openQuestions: string[];
  summary: string;
  catalysts?: Catalyst[];
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
  catalysts_json: string | null;
}

const fromRow = (r: Row): JournalEntry => ({
  id: r.id, assetId: r.asset_id, persona: r.persona, agentRunId: r.agent_run_id, createdAt: r.created_at, thesis: r.thesis,
  openQuestions: JSON.parse(r.open_questions_json) as string[], summary: r.summary,
  catalysts: r.catalysts_json === null ? [] : (JSON.parse(r.catalysts_json) as Catalyst[]),
});

/** Append-only. */
export function insertJournalEntry(db: Db, input: NewJournalEntry): JournalEntry {
  const info = db
    .prepare('INSERT INTO journal (asset_id, persona, agent_run_id, created_at, thesis, open_questions_json, summary, catalysts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      input.assetId, input.persona, input.agentRunId, new Date(input.createdAt).toISOString(), input.thesis,
      JSON.stringify(input.openQuestions), input.summary,
      // NULL when there are none, like an old row (and like proposals.citations_json).
      input.catalysts && input.catalysts.length > 0 ? JSON.stringify(input.catalysts) : null,
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
