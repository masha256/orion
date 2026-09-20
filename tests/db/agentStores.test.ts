import { beforeEach, describe, expect, it } from 'vitest';
import {
  abandonStaleRuns, finishAgentRun, getAgentRun, getTranscript, lastCompletedRun, listAgentRuns, startAgentRun, ZERO_USAGE,
  type StartAgentRunInput,
} from '../../src/db/agentRuns.js';
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { insertAssumptionChange, listAssumptionChanges } from '../../src/db/assumptionChanges.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { assignPersona, getCoverage, listCoverage } from '../../src/db/coverage.js';
import { insertJournalEntry, listJournal } from '../../src/db/journal.js';
import { insertObservation } from '../../src/db/observations.js';
import {
  decideProposal, findPendingDuplicate, getProposal, insertProposal, listProposals, recentlyDecidedProposals, type NewProposal,
} from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { miniAssumptions } from '../helpers/assets.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

const run = (over: Partial<StartAgentRunInput> = {}): StartAgentRunInput => ({
  assetId: 'mini', persona: 'analyst', runType: 'weekly', trigger: 'manual', triggerDetail: {}, dryRun: false,
  configHash: 'abc', model: 'claude-opus-5', startedAt: '2026-09-20T00:00:00.000Z', ...over,
});

describe('coverage', () => {
  it('assigns one persona per asset and replaces on reassignment', () => {
    expect(getCoverage(db, 'mini')).toBeNull();
    assignPersona(db, 'mini', 'analyst', '2026-09-20T00:00:00Z');
    const again = assignPersona(db, 'mini', 'other', '2026-09-21T00:00:00Z');
    expect(again).toEqual({ assetId: 'mini', persona: 'other', assignedAt: '2026-09-21T00:00:00.000Z' });
    expect(listCoverage(db)).toHaveLength(1);
  });
});

describe('agent runs', () => {
  it('starts as running, then records outcome, usage, summary, and the transcript apart from the row', () => {
    const id = startAgentRun(db, run({ runType: 'triage', triggerDetail: { anomalyId: 7 }, dryRun: true }));
    expect(getAgentRun(db, id)).toMatchObject({ outcome: 'running', runType: 'triage', triggerDetail: { anomalyId: 7 }, dryRun: true, endedAt: null, usage: ZERO_USAGE });
    expect(getTranscript(db, id)).toBeNull();

    const usage = { requests: 4, inputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 500, outputTokens: 700, webSearches: 1, webFetches: 2 };
    const done = finishAgentRun(db, id, {
      outcome: 'completed', endedAt: '2026-09-20T00:05:00Z', usage, error: null, summary: { setVersion: 2 }, transcript: { messages: [{ role: 'user' }] },
    });
    expect(done).toMatchObject({ outcome: 'completed', endedAt: '2026-09-20T00:05:00.000Z', usage, summary: { setVersion: 2 }, error: null });
    expect(getTranscript(db, id)).toEqual({ messages: [{ role: 'user' }] });
  });

  it('lists newest first, by asset, and finds the last completed non-dry run', () => {
    const a = startAgentRun(db, run());
    const b = startAgentRun(db, run({ dryRun: true }));
    const c = startAgentRun(db, run({ assetId: 'other' }));
    const finish = (id: number, outcome: 'completed' | 'error') =>
      finishAgentRun(db, id, { outcome, endedAt: '2026-09-20T01:00:00Z', usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
    finish(a, 'completed');
    finish(b, 'completed');
    finish(c, 'error');
    expect(listAgentRuns(db).map((r) => r.id)).toEqual([c, b, a]);
    expect(listAgentRuns(db, { assetId: 'mini' }).map((r) => r.id)).toEqual([b, a]);
    expect(lastCompletedRun(db, 'mini')!.id).toBe(a); // the dry run does not count
    expect(lastCompletedRun(db, 'other')).toBeNull();
  });

  it('marks running rows older than an hour as abandoned, and only those', () => {
    const old = startAgentRun(db, run({ startedAt: '2026-09-20T00:00:00Z' }));
    const fresh = startAgentRun(db, run({ startedAt: '2026-09-20T01:30:00Z' }));
    const elsewhere = startAgentRun(db, run({ assetId: 'other', startedAt: '2026-09-20T00:00:00Z' }));
    expect(abandonStaleRuns(db, 'mini', '2026-09-20T02:00:00Z')).toBe(1);
    expect(getAgentRun(db, old)).toMatchObject({ outcome: 'error', error: 'abandoned', endedAt: '2026-09-20T02:00:00.000Z' });
    expect(getAgentRun(db, fresh)!.outcome).toBe('running');
    expect(getAgentRun(db, elsewhere)!.outcome).toBe('running');
  });
});

describe('proposals', () => {
  const proposal = (over: Partial<NewProposal> = {}): NewProposal => ({
    assetId: 'mini', persona: 'analyst', agentRunId: null,
    change: { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 0.4 },
    filedAgainst: { value: 0 }, rationale: 'usage is accelerating', evidence: [3, 5],
    effect: { '6m': { from: 10, to: 11 }, '12m': { from: 10, to: 12 } }, createdAt: '2026-09-20T00:00:00Z', ...over,
  });

  it('round-trips a proposal and lists pending ones newest first', () => {
    const p = insertProposal(db, proposal());
    expect(p).toMatchObject({ status: 'pending', evidence: [3, 5], decidedAt: null, decisionNote: null, createdAt: '2026-09-20T00:00:00.000Z' });
    expect(p.change).toEqual({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 0.4 });
    expect(getProposal(db, p.id)).toEqual(p);
    // Key order survives storage: a config edit's value is written into the YAML as the author ordered it.
    const band = insertProposal(db, proposal({ change: { kind: 'config', edits: [{ path: ['assumptions', 'x', 'base'], value: { min: 0, max: 2 } }] } }));
    expect(JSON.stringify(band.change)).toContain('{"min":0,"max":2}');
    const q = insertProposal(db, proposal({ change: { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'lags by design' }, effect: null }));
    expect(listProposals(db, { assetId: 'mini' }).map((x) => x.id)).toEqual([q.id, band.id, p.id]);
    expect(listProposals(db, { assetId: 'other' })).toEqual([]);
  });

  it('finds a pending duplicate whatever the key order, and stops finding it once decided', () => {
    const p = insertProposal(db, proposal());
    const sameChange = { value: 0.4, scenario: 'base', key: 'rev_growth_y1', kind: 'assumption_value' } as const;
    expect(findPendingDuplicate(db, 'mini', sameChange)!.id).toBe(p.id);
    expect(findPendingDuplicate(db, 'mini', { ...sameChange, value: 0.5 })).toBeNull();
    decideProposal(db, p.id, 'rejected', 'not yet', '2026-09-21T00:00:00Z');
    expect(findPendingDuplicate(db, 'mini', sameChange)).toBeNull();
  });

  it('decides once, keeps the note, and reports decided proposals newest decision first', () => {
    const p = insertProposal(db, proposal());
    const q = insertProposal(db, proposal({ change: { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 1 } }));
    decideProposal(db, q.id, 'approved', '  ', '2026-09-21T00:00:00Z');
    const rejected = decideProposal(db, p.id, 'rejected', ' wait for the Q3 disclosure ', '2026-09-22T00:00:00Z');
    expect(rejected).toMatchObject({ status: 'rejected', decisionNote: 'wait for the Q3 disclosure', decidedAt: '2026-09-22T00:00:00.000Z' });
    expect(getProposal(db, q.id)!.decisionNote).toBeNull();
    expect(codeOf(() => decideProposal(db, p.id, 'approved', null, '2026-09-23T00:00:00Z'))).toBe('proposal_not_pending');
    expect(codeOf(() => decideProposal(db, 999, 'approved', null, '2026-09-23T00:00:00Z'))).toBe('proposal_not_found');
    expect(recentlyDecidedProposals(db, 'mini', 10).map((x) => x.id)).toEqual([p.id, q.id]);
    expect(listProposals(db)).toEqual([]);
    expect(listProposals(db, { includeDecided: true })).toHaveLength(2);
  });
});

describe('journal', () => {
  it('appends entries and pages backwards', () => {
    const ids = [1, 2, 3, 4].map(
      (n) =>
        insertJournalEntry(db, {
          assetId: 'mini', persona: 'analyst', agentRunId: null, createdAt: `2026-09-0${n}T00:00:00Z`,
          thesis: `thesis ${n}`, openQuestions: [`q${n}`], summary: `did ${n}`,
        }).id,
    );
    const newest = listJournal(db, 'mini');
    expect(newest.map((e) => e.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(newest[0]).toMatchObject({ thesis: 'thesis 4', openQuestions: ['q4'], summary: 'did 4', createdAt: '2026-09-04T00:00:00.000Z' });
    expect(listJournal(db, 'mini', { beforeId: ids[1], limit: 5 }).map((e) => e.id)).toEqual([ids[0]]);
    expect(listJournal(db, 'other')).toEqual([]);
  });
});

describe('assumption changes', () => {
  it('records each change with its own rationale and evidence', () => {
    const set = createAssumptionSet(db, { assetId: 'mini', author: 'analyst', rationale: 'digest', values: miniAssumptions(), createdAt: '2026-09-20T00:00:00Z' });
    const o = insertObservation(db, { assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-09-19', value: 10, source: 'onchain', fetchedAt: '2026-09-19' });
    const change = insertAssumptionChange(db, {
      setId: set.id, key: 'rev_growth_y1', scenario: 'base', fromValue: 0, toValue: 0.1, rationale: 'usage up', evidence: [o.id, o.id],
    });
    expect(change).toMatchObject({ key: 'rev_growth_y1', scenario: 'base', fromValue: 0, toValue: 0.1, rationale: 'usage up', evidence: [o.id] });
    expect(listAssumptionChanges(db, set.id)).toEqual([change]);
    expect(listAssumptionChanges(db, 999)).toEqual([]);
  });
});

describe('anomaly decisions', () => {
  it('records who decided: a persona, or null for the user', () => {
    const raise = (dedupeKey: string) =>
      raiseAnomaly(db, {
        assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey, severity: 'degrading', detail: {}, seenAt: '2026-09-18T00:00:00Z',
      });
    const byAgent = decideAnomaly(db, raise('a').id, 'resolved', 'cleared', '2026-09-19T00:00:00Z', 'analyst');
    const byUser = decideAnomaly(db, raise('b').id, 'acknowledged', 'known lag', '2026-09-19T00:00:00Z');
    expect(byAgent.decidedBy).toBe('analyst');
    expect(byUser.decidedBy).toBeNull();
  });
});
