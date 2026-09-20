import { OrionError, type ConfigEdit, type Scenario } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
import type { Db } from './connection.js';

export type ProposalChange =
  | { kind: 'assumption_value'; key: string; scenario: Scenario; value: number }
  | { kind: 'config'; edits: ConfigEdit[] }
  | { kind: 'acknowledge_anomaly' | 'withdraw_acknowledgement'; anomalyId: number; note: string }
  | { kind: 'confirm_observation' | 'reject_observation'; observationId: number; note: string }
  | {
      kind: 'observation';
      metricKey: string;
      value: number;
      observedAt: string;
      periodDays: number | null;
      citationUrl: string;
      quotedText: string;
    };

export type ProposalKind = ProposalChange['kind'];
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/** Expected targets before and after the change, or why the engine could not run with it. Null for kinds that cannot move a target. */
export type ProposalEffect =
  | { '6m': { from: number | null; to: number }; '12m': { from: number | null; to: number } }
  | { blocked: string[] };

export interface Proposal {
  id: number;
  assetId: string;
  persona: string;
  agentRunId: number | null;
  change: ProposalChange;
  /** The state the proposal was filed against. Approve refuses when it no longer holds. */
  filedAgainst: unknown;
  rationale: string;
  evidence: number[];
  effect: ProposalEffect | null;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface NewProposal {
  assetId: string;
  persona: string;
  agentRunId: number | null;
  change: ProposalChange;
  filedAgainst: unknown;
  rationale: string;
  evidence: number[];
  effect: ProposalEffect | null;
  createdAt: string;
}

interface Row {
  id: number;
  asset_id: string;
  persona: string;
  agent_run_id: number | null;
  kind: ProposalKind;
  change_json: string;
  filed_against_json: string;
  rationale: string;
  evidence_json: string;
  effect_json: string | null;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

function fromRow(r: Row): Proposal {
  return {
    id: r.id, assetId: r.asset_id, persona: r.persona, agentRunId: r.agent_run_id,
    change: JSON.parse(r.change_json) as ProposalChange, filedAgainst: JSON.parse(r.filed_against_json) as unknown,
    rationale: r.rationale, evidence: JSON.parse(r.evidence_json) as number[],
    effect: r.effect_json === null ? null : (JSON.parse(r.effect_json) as ProposalEffect),
    status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
  };
}

export function insertProposal(db: Db, input: NewProposal): Proposal {
  const info = db
    .prepare(
      `INSERT INTO proposals (asset_id, persona, agent_run_id, kind, change_json, filed_against_json, rationale, evidence_json, effect_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      // Stored as written, not canonically: a config edit's value is later written into the YAML, and its key order should be the author's.
      input.assetId, input.persona, input.agentRunId, input.change.kind, JSON.stringify(input.change), JSON.stringify(input.filedAgainst ?? null),
      input.rationale, JSON.stringify(input.evidence), input.effect === null ? null : JSON.stringify(input.effect),
      new Date(input.createdAt).toISOString(),
    );
  return getProposal(db, Number(info.lastInsertRowid))!;
}

export function getProposal(db: Db, id: number): Proposal | null {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Newest first. Pending only, unless `includeDecided`. */
export function listProposals(db: Db, filter: { assetId?: string; includeDecided?: boolean } = {}): Proposal[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.assetId !== undefined) {
    where.push('asset_id = ?');
    params.push(filter.assetId);
  }
  if (!filter.includeDecided) where.push("status = 'pending'");
  const sql = `SELECT * FROM proposals ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
  return (db.prepare(sql).all(...params) as Row[]).map(fromRow);
}

/** The most recently decided proposals for an asset, newest decision first: what the agent learns the user's mind from. */
export function recentlyDecidedProposals(db: Db, assetId: string, limit: number): Proposal[] {
  const rows = db
    .prepare("SELECT * FROM proposals WHERE asset_id = ? AND status != 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?")
    .all(assetId, limit) as Row[];
  return rows.map(fromRow);
}

/** A pending proposal for the asset with exactly this change, if any. Canonical JSON makes key order irrelevant. */
export function findPendingDuplicate(db: Db, assetId: string, change: ProposalChange): Proposal | null {
  const rows = db.prepare("SELECT * FROM proposals WHERE asset_id = ? AND kind = ? AND status = 'pending' ORDER BY id").all(assetId, change.kind) as Row[];
  const wanted = canonicalJson(change);
  return rows.map(fromRow).find((p) => canonicalJson(p.change) === wanted) ?? null;
}

/** Decisions are final. */
export function decideProposal(db: Db, id: number, status: 'approved' | 'rejected', note: string | null, nowIso: string): Proposal {
  const current = getProposal(db, id);
  if (!current) throw new OrionError('proposal_not_found', `no proposal with id ${id}`);
  if (current.status !== 'pending') throw new OrionError('proposal_not_pending', `proposal ${id} is already ${current.status}`);
  const text = note === null || note.trim() === '' ? null : note.trim();
  db.prepare('UPDATE proposals SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?').run(status, text, new Date(nowIso).toISOString(), id);
  return getProposal(db, id)!;
}
