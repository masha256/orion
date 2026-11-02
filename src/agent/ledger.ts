import type { Db } from '../db/connection.js';
import { decideAnomaly, getAnomaly } from '../db/anomalies.js';
import { insertJournalEntry, type Catalyst } from '../db/journal.js';
import { insertObservation, listActiveObservations, type Observation } from '../db/observations.js';
import { insertProposal, type ProposalChange } from '../db/proposals.js';
import { OrionError } from '../types.js';
import type { StoredCitation } from './guardrails.js';

/**
 * Everything an agent run wants to write, held in memory until the run finishes cleanly. Tools validate against the
 * database plus what is staged here, so the agent reads its own writes; nothing touches the database until `commit`,
 * which applies it all in one short transaction through the same functions the CLI uses.
 */

export interface StagedResolution {
  anomalyId: number;
  note: string;
  evidence: number[];
}

export interface StagedObservation {
  /** Negative, so it can never collide with a real id. Usable as evidence in the same run; remapped at commit. */
  tempId: number;
  metricKey: string;
  value: number;
  observedAt: string;
  periodDays: number | null;
  citationUrl: string;
  quotedText: string;
  /** True when the row will be eligible unconfirmed. A disclosure run stages only inert rows: they wait for the user. */
  live: boolean;
}

export interface StagedProposal {
  change: ProposalChange;
  filedAgainst: unknown;
  rationale: string;
  evidence: number[];
  /** Always null: a proposal's 6m/12m target effect went with the valuation. Stored valuation-era rows keep theirs. */
  effect: null;
  /** Verified when the proposal was filed; `[]` when it cites nothing. */
  citations: StoredCitation[];
}

export interface StagedJournal {
  thesis: string;
  openQuestions: string[];
  summary: string;
  /** Verified when the journal was written; `[]` when there are none. */
  catalysts: Catalyst[];
}

export const DEV_FINDING_CATEGORIES = ['holder_flow', 'revenue', 'supply', 'unlocks', 'source', 'other'] as const;
export const VALUE_DIRECTIONS = ['up', 'down', 'none', 'unknown'] as const;

/**
 * Something a disclosure run found wrong or missing in how Orion measures the asset, for the developer, not the user.
 * Never a database row: it lives in the run summary (`staged.devFindings`, and `committed.devFindings` on a commit).
 */
export interface StagedDevFinding {
  category: (typeof DEV_FINDING_CATEGORIES)[number];
  title: string;
  metricKeys: string[];
  claim: string;
  orionReading: string;
  valueDirection: (typeof VALUE_DIRECTIONS)[number];
  proposedFix: string;
  evidence: number[];
  citations: StoredCitation[];
  /** sha256 of asset, category, sorted metric keys, and the target document's sha256: what the Hermes step dedupes on. */
  fingerprint: string;
}

const findingKey = (f: Pick<StagedDevFinding, 'category' | 'metricKeys'>): string => `${f.category}|${[...f.metricKeys].sort().join(',')}`;

export interface CommitSummary {
  observationIds: number[];
  resolvedAnomalyIds: number[];
  proposalIds: number[];
  journalId: number | null;
  /** The staged findings, evidence remapped to real ids. Nothing was written for them: they are carried in the run summary. */
  devFindings: StagedDevFinding[];
}

/** What a commit would write: shown by `--dry-run`, and kept in the run summary. */
export interface StagedPreview {
  resolutions: StagedResolution[];
  observations: StagedObservation[];
  proposals: StagedProposal[];
  journal: StagedJournal | null;
  devFindings: StagedDevFinding[];
}

/** The world changed between staging and commit. The run ends as `conflict` and nothing is written. */
export class AgentConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConflict';
  }
}

export class Ledger {
  /** Observation ids the agent has been shown in this run: the only ids it may cite as evidence. */
  readonly shown = new Set<number>();

  private readonly resolutions = new Map<number, StagedResolution>();
  private readonly stagedObservations: StagedObservation[] = [];
  private readonly stagedProposals: StagedProposal[] = [];
  private stagedJournal: StagedJournal | null = null;
  private readonly stagedDevFindings: StagedDevFinding[] = [];
  private nextTempId = -1;

  constructor(
    readonly assetId: string,
    readonly persona: string,
  ) {}

  markShown(ids: Iterable<number>): void {
    for (const id of ids) this.shown.add(id);
  }

  // ---- anomalies ----

  stageResolution(resolution: StagedResolution): void {
    this.resolutions.set(resolution.anomalyId, resolution);
  }

  resolvedAnomalyIds(): Set<number> {
    return new Set(this.resolutions.keys());
  }

  // ---- observations ----

  /** A second observation at the same metric and time replaces the first staged one and keeps its temporary id, so evidence that cites it still resolves. */
  stageObservation(o: Omit<StagedObservation, 'tempId'>): StagedObservation {
    const observedAt = new Date(o.observedAt).toISOString();
    const existing = this.stagedObservations.find((s) => s.metricKey === o.metricKey && s.observedAt === observedAt);
    if (existing) {
      Object.assign(existing, o, { observedAt });
      return existing;
    }
    const staged = { ...o, observedAt, tempId: this.nextTempId-- };
    this.stagedObservations.push(staged);
    this.shown.add(staged.tempId);
    return staged;
  }

  observations(): StagedObservation[] {
    return [...this.stagedObservations];
  }

  hasStagedObservation(tempId: number): boolean {
    return this.stagedObservations.some((o) => o.tempId === tempId);
  }

  /** Staged rows as observations, for reads. `liveOnly` leaves out rows that will be inert until confirmed. */
  observationRows(nowIso: string, opts: { liveOnly?: boolean } = {}): Observation[] {
    return this.stagedObservations
      .filter((o) => !opts.liveOnly || o.live)
      .map((o) => ({
        id: o.tempId, assetId: this.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value,
        source: 'manual' as const, sourceDetail: 'staged in this run', status: 'provisional' as const, citationUrl: o.citationUrl,
        quotedText: o.quotedText, fetchedAt: nowIso, supersededBy: null,
      }));
  }

  // ---- proposals and the journal ----

  stageProposal(p: StagedProposal): void {
    this.stagedProposals.push(p);
  }

  proposals(): StagedProposal[] {
    return [...this.stagedProposals];
  }

  setJournal(j: StagedJournal): void {
    this.stagedJournal = j;
  }

  journal(): StagedJournal | null {
    return this.stagedJournal;
  }

  // ---- dev findings ----

  /** One with the same category and sorted metric keys as a staged one replaces it, in its place. The run's limit is the tool's to enforce. */
  stageDevFinding(f: StagedDevFinding): { replaced: boolean } {
    const at = this.stagedDevFindings.findIndex((s) => findingKey(s) === findingKey(f));
    if (at >= 0) this.stagedDevFindings[at] = f;
    else this.stagedDevFindings.push(f);
    return { replaced: at >= 0 };
  }

  hasDevFinding(f: Pick<StagedDevFinding, 'category' | 'metricKeys'>): boolean {
    return this.stagedDevFindings.some((s) => findingKey(s) === findingKey(f));
  }

  devFindings(): StagedDevFinding[] {
    return [...this.stagedDevFindings];
  }

  /** What a commit would write: shown by `--dry-run`, and kept in the run summary. */
  preview(): StagedPreview {
    return {
      resolutions: [...this.resolutions.values()], observations: this.observations(), proposals: this.proposals(), journal: this.stagedJournal,
      devFindings: this.devFindings(),
    };
  }

  /**
   * Applies everything in one transaction, through the real write functions, which validate again. Anything that no
   * longer holds (an anomaly was decided, an observation now exists where one was staged) throws AgentConflict and rolls
   * the whole transaction back.
   */
  async commit(db: Db, ctx: { agentRunId: number | null; now: Date }): Promise<CommitSummary> {
    const nowIso = ctx.now.toISOString();
    // IMMEDIATE, not the default DEFERRED: this transaction reads before it writes, and a deferred one takes the write
    // lock only at its first write. Another connection committing in between makes SQLite refuse this one at once with
    // SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot retry away. Taking the lock at BEGIN means it waits instead.
    return db.tx(async (t): Promise<CommitSummary> => {
      try {
        for (const r of this.resolutions.values()) {
          const current = await getAnomaly(t, r.anomalyId);
          // decideAnomaly would also resolve an ACKNOWLEDGED anomaly, which withdraws the user's decision. Never let that through.
          if (!current || current.status !== 'open') throw new AgentConflict(`anomaly ${r.anomalyId} is no longer open (${current?.status ?? 'missing'})`);
        }

        // The agent never supersedes an observation. insertObservation would let a provisional insert retire any active
        // provisional row at the same metric and time, including one the user entered; rejecting a row is the user's call.
        for (const o of this.stagedObservations) {
          const taken = (await listActiveObservations(t, this.assetId, o.metricKey)).find((row) => row.observedAt === o.observedAt);
          if (taken) throw new AgentConflict(`observation #${taken.id} of ${o.metricKey} at ${o.observedAt} already exists; the agent never supersedes one`);
        }

        const realId = new Map<number, number>();
        for (const o of this.stagedObservations) {
          const row = await insertObservation(t, {
            assetId: this.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: 'manual',
            sourceDetail: `research:${this.persona}:run ${ctx.agentRunId ?? 'none'}`, status: 'provisional', citationUrl: o.citationUrl,
            quotedText: o.quotedText, fetchedAt: nowIso,
          });
          realId.set(o.tempId, row.id);
        }
        const remap = (ids: number[]): number[] =>
          ids.map((id) => {
            if (id >= 0) return id;
            const mapped = realId.get(id);
            if (mapped === undefined) throw new AgentConflict(`evidence cites staged observation ${id}, which this run did not stage`);
            return mapped;
          });

        const resolvedAnomalyIds: number[] = [];
        for (const r of this.resolutions.values()) {
          const cited = remap(r.evidence).map((id) => `#${id}`).join(', ');
          await decideAnomaly(t, r.anomalyId, 'resolved', `${r.note} [evidence: ${cited}]`, nowIso, this.persona);
          resolvedAnomalyIds.push(r.anomalyId);
        }

        const proposalIds: number[] = [];
        for (const p of this.stagedProposals) {
          const row = await insertProposal(t, {
            assetId: this.assetId, persona: this.persona, agentRunId: ctx.agentRunId, change: p.change, filedAgainst: p.filedAgainst,
            rationale: p.rationale, evidence: remap(p.evidence), effect: p.effect, citations: p.citations,
            createdAt: nowIso,
          });
          proposalIds.push(row.id);
        }

        const journalId = this.stagedJournal
          ? (await insertJournalEntry(t, { assetId: this.assetId, persona: this.persona, agentRunId: ctx.agentRunId, createdAt: nowIso, ...this.stagedJournal })).id
          : null;

        // Written nowhere: the run summary carries them. Remapped like every other evidence list, so a committed finding cites real rows.
        const devFindings = this.stagedDevFindings.map((f) => ({ ...f, evidence: remap(f.evidence) }));

        return { observationIds: [...realId.values()], resolvedAnomalyIds, proposalIds, journalId, devFindings };
      } catch (err) {
        // A real write function refusing (say an observation the config no longer allows) is a conflict too.
        if (err instanceof OrionError) throw new AgentConflict(`${err.code}: ${err.message}`);
        throw err;
      }
    }, { lockAsset: this.assetId });
  }
}
