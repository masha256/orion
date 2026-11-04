import type { StoredCitation } from './documents.js';
import { OrionError, type ConfigEdit } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
import type { Db } from './connection.js';

export type ProposalChange =
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
  /** Verified citations (spec 5.4), outside the change: they never make a duplicate look new. `[]` on rows from before them. */
  citations: StoredCitation[];
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
  /** Verified by the tool that filed it. Omitted or empty is stored as NULL, so a citation-free row looks like an old one. */
  citations?: StoredCitation[];
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
  citations_json: string | null;
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
    citations: r.citations_json === null ? [] : (JSON.parse(r.citations_json) as StoredCitation[]),
    status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
  };
}

export async function insertProposal(db: Db, input: NewProposal): Promise<Proposal> {
  const inserted = await db.run<{ id: number }>(
    `INSERT INTO proposals (asset_id, persona, agent_run_id, kind, change_json, filed_against_json, rationale, evidence_json, effect_json, citations_json, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
     RETURNING id`,
    [
      // Stored as written, not canonically: a config edit's value is later written into the YAML, and its key order should be the author's.
      input.assetId, input.persona, input.agentRunId, input.change.kind, JSON.stringify(input.change), JSON.stringify(input.filedAgainst ?? null),
      input.rationale, JSON.stringify(input.evidence), input.effect === null ? null : JSON.stringify(input.effect),
      input.citations === undefined || input.citations.length === 0 ? null : JSON.stringify(input.citations),
      new Date(input.createdAt).toISOString(),
    ],
  );
  return (await getProposal(db, Number(inserted.rows[0].id)))!;
}

export async function getProposal(db: Db, id: number): Promise<Proposal | null> {
  const row = await db.one<Row>('SELECT * FROM proposals WHERE id = $1', [id]);
  return row ? fromRow(row) : null;
}

/** Newest first. Pending only, unless `includeDecided`. */
export async function listProposals(db: Db, filter: { assetId?: string; includeDecided?: boolean } = {}): Promise<Proposal[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.assetId !== undefined) {
    params.push(filter.assetId);
    where.push(`asset_id = $${params.length}`);
  }
  if (!filter.includeDecided) where.push("status = 'pending'");
  const sql = `SELECT * FROM proposals ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
  return (await db.all<Row>(sql, params)).map(fromRow);
}

/** The most recently decided proposals for an asset, newest decision first: what the agent learns the user's mind from. */
export async function recentlyDecidedProposals(db: Db, assetId: string, limit: number): Promise<Proposal[]> {
  const rows = await db.all<Row>(
    "SELECT * FROM proposals WHERE asset_id = $1 AND status != 'pending' ORDER BY decided_at DESC, id DESC LIMIT $2",
    [assetId, limit],
  );
  return rows.map(fromRow);
}

/**
 * What a change actually decides, with the free text the model wrote left out: the `note` the anomaly and observation
 * kinds carry, and the observation kind's `quotedText`. Two proposals that ask for the same thing in different words are
 * the same proposal; comparing the wording too would let the agent refile the same decision indefinitely.
 */
export function proposalIdentity(change: ProposalChange): string {
  const { note: _note, quotedText: _quotedText, ...decision } = change as ProposalChange & { note?: string; quotedText?: string };
  return canonicalJson(decision);
}

/** A pending proposal for the asset that decides the same thing, if any. Canonical JSON makes key order irrelevant. */
export async function findPendingDuplicate(db: Db, assetId: string, change: ProposalChange): Promise<Proposal | null> {
  const rows = await db.all<Row>("SELECT * FROM proposals WHERE asset_id = $1 AND kind = $2 AND status = 'pending' ORDER BY id", [assetId, change.kind]);
  const wanted = proposalIdentity(change);
  return rows.map(fromRow).find((p) => proposalIdentity(p.change) === wanted) ?? null;
}

/** Decisions are final. */
export async function decideProposal(db: Db, id: number, status: 'approved' | 'rejected', note: string | null, nowIso: string): Promise<Proposal> {
  const found = await getProposal(db, id);
  if (!found) throw new OrionError('proposal_not_found', `no proposal with id ${id}`);
  return db.tx(
    async (t) => {
      const current = (await getProposal(t, id))!; // rows are never deleted
      if (current.status !== 'pending') throw new OrionError('proposal_not_pending', `proposal ${id} is already ${current.status}`);
      const text = note === null || note.trim() === '' ? null : note.trim();
      await t.run('UPDATE proposals SET status = $1, decision_note = $2, decided_at = $3 WHERE id = $4', [status, text, new Date(nowIso).toISOString(), id]);
      return (await getProposal(t, id))!;
    },
    { lockAsset: found.assetId },
  );
}
