import { beforeEach, describe, expect, it } from 'vitest';
import {
  abandonRunningRuns, finishAgentRun, getAgentRun, getTranscript, listAgentRuns, startAgentRun, ZERO_USAGE,
  type StartAgentRunInput,
} from '../../src/db/agentRuns.js';
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import type { Db } from '../../src/db/connection.js';
import { assignPersona, getCoverage, listCoverage } from '../../src/db/coverage.js';
import { insertJournalEntry, listJournal } from '../../src/db/journal.js';
import {
  decideProposal, findPendingDuplicate, getProposal, insertProposal, listProposals, recentlyDecidedProposals, type NewProposal,
} from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

let db: Db;
beforeEach(() => {
  db = testDb();
});

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
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
  it('assigns one persona per asset and replaces on reassignment', async () => {
    expect(await getCoverage(db, 'mini')).toBeNull();
    await assignPersona(db, 'mini', 'analyst', '2026-09-20T00:00:00Z');
    const again = await assignPersona(db, 'mini', 'other', '2026-09-21T00:00:00Z');
    expect(again).toEqual({ assetId: 'mini', persona: 'other', assignedAt: '2026-09-21T00:00:00.000Z' });
    expect(await listCoverage(db)).toHaveLength(1);
  });
});

describe('agent runs', () => {
  it('starts as running, then records outcome, usage, summary, and the transcript apart from the row', async () => {
    const id = await startAgentRun(db, run({ runType: 'triage', triggerDetail: { anomalyId: 7 }, dryRun: true }));
    expect(await getAgentRun(db, id)).toMatchObject({ outcome: 'running', runType: 'triage', triggerDetail: { anomalyId: 7 }, dryRun: true, endedAt: null, usage: ZERO_USAGE });
    expect(await getTranscript(db, id)).toBeNull();

    const usage = { requests: 4, inputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 500, outputTokens: 700, webSearches: 1, webFetches: 2 };
    const done = await finishAgentRun(db, id, {
      outcome: 'completed', endedAt: '2026-09-20T00:05:00Z', usage, error: null, summary: { setVersion: 2 }, transcript: { messages: [{ role: 'user' }] },
    });
    expect(done).toMatchObject({ outcome: 'completed', endedAt: '2026-09-20T00:05:00.000Z', usage, summary: { setVersion: 2 }, error: null });
    expect(await getTranscript(db, id)).toEqual({ messages: [{ role: 'user' }] });
  });

  it('finishes a run exactly once: a second finish throws and rewrites nothing', async () => {
    const id = await startAgentRun(db, run());
    const first = { outcome: 'completed' as const, endedAt: '2026-09-20T00:05:00Z', usage: ZERO_USAGE, error: null, summary: { n: 1 }, transcript: ['first'] };
    await finishAgentRun(db, id, first);
    expect(await codeOf(() => finishAgentRun(db, id, { ...first, outcome: 'error', error: 'late', summary: { n: 2 }, transcript: ['second'] }))).toBe('agent_run_already_finished');
    expect(await getAgentRun(db, id)).toMatchObject({ outcome: 'completed', error: null, summary: { n: 1 } });
    expect(await getTranscript(db, id)).toEqual(['first']);
  });

  it('lets a run that was marked abandoned still record its one real finish', async () => {
    const id = await startAgentRun(db, run({ startedAt: '2026-09-20T00:00:00Z' }));
    expect(await abandonRunningRuns(db, 'mini', '2026-09-20T02:00:00Z')).toBe(1);
    await finishAgentRun(db, id, { outcome: 'completed', endedAt: '2026-09-20T02:30:00Z', usage: ZERO_USAGE, error: null, summary: null, transcript: ['late but real'] });
    expect(await getAgentRun(db, id)).toMatchObject({ outcome: 'completed', error: null });
    expect(await getTranscript(db, id)).toEqual(['late but real']);
  });

  it('lists newest first, by asset', async () => {
    const a = await startAgentRun(db, run());
    const b = await startAgentRun(db, run({ dryRun: true }));
    const c = await startAgentRun(db, run({ assetId: 'other' }));
    const finish = async (id: number, outcome: 'completed' | 'error') =>
      await finishAgentRun(db, id, { outcome, endedAt: '2026-09-20T01:00:00Z', usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
    await finish(a, 'completed');
    await finish(b, 'completed');
    await finish(c, 'error');
    expect((await listAgentRuns(db)).map((r) => r.id)).toEqual([c, b, a]);
    expect((await listAgentRuns(db, { assetId: 'mini' })).map((r) => r.id)).toEqual([b, a]);
  });

  it('abandons every running row of the asset, whatever its age, and no other asset\'s', async () => {
    const old = await startAgentRun(db, run({ startedAt: '2026-09-20T00:00:00Z' }));
    const fresh = await startAgentRun(db, run({ startedAt: '2026-09-20T01:59:00Z' }));
    const elsewhere = await startAgentRun(db, run({ assetId: 'other', startedAt: '2026-09-20T00:00:00Z' }));
    const done = await startAgentRun(db, run());
    await finishAgentRun(db, done, { outcome: 'completed', endedAt: '2026-09-20T00:05:00Z', usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
    expect(await abandonRunningRuns(db, 'mini', '2026-09-20T02:00:00Z')).toBe(2);
    expect(await getAgentRun(db, old)).toMatchObject({ outcome: 'error', error: 'abandoned', endedAt: '2026-09-20T02:00:00.000Z' });
    expect(await getAgentRun(db, fresh)).toMatchObject({ outcome: 'error', error: 'abandoned' });
    expect((await getAgentRun(db, elsewhere))!.outcome).toBe('running');
    expect((await getAgentRun(db, done))!.outcome).toBe('completed');
  });
});

describe('proposals', () => {
  const proposal = (over: Partial<NewProposal> = {}): NewProposal => ({
    assetId: 'mini', persona: 'analyst', agentRunId: null,
    change: { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 0.4 },
    filedAgainst: { value: 0 }, rationale: 'usage is accelerating', evidence: [3, 5],
    effect: { '6m': { from: 10, to: 11 }, '12m': { from: 10, to: 12 } }, createdAt: '2026-09-20T00:00:00Z', ...over,
  });

  it('round-trips a proposal and lists pending ones newest first', async () => {
    const p = await insertProposal(db, proposal());
    expect(p).toMatchObject({ status: 'pending', evidence: [3, 5], decidedAt: null, decisionNote: null, createdAt: '2026-09-20T00:00:00.000Z' });
    expect(p.change).toEqual({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 0.4 });
    expect(await getProposal(db, p.id)).toEqual(p);
    // Key order survives storage: a config edit's value is written into the YAML as the author ordered it.
    const band = await insertProposal(db, proposal({ change: { kind: 'config', edits: [{ path: ['assumptions', 'x', 'base'], value: { min: 0, max: 2 } }] } }));
    expect(JSON.stringify(band.change)).toContain('{"min":0,"max":2}');
    const q = await insertProposal(db, proposal({ change: { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'lags by design' }, effect: null }));
    expect((await listProposals(db, { assetId: 'mini' })).map((x) => x.id)).toEqual([q.id, band.id, p.id]);
    expect(await listProposals(db, { assetId: 'other' })).toEqual([]);
  });

  it('finds a pending duplicate whatever the key order, and stops finding it once decided', async () => {
    const p = await insertProposal(db, proposal());
    const sameChange = { value: 0.4, scenario: 'base', key: 'rev_growth_y1', kind: 'assumption_value' } as const;
    expect((await findPendingDuplicate(db, 'mini', sameChange))!.id).toBe(p.id);
    expect(await findPendingDuplicate(db, 'mini', { ...sameChange, value: 0.5 })).toBeNull();
    await decideProposal(db, p.id, 'rejected', 'not yet', '2026-09-21T00:00:00Z');
    expect(await findPendingDuplicate(db, 'mini', sameChange)).toBeNull();
  });

  it('decides once, keeps the note, and reports decided proposals newest decision first', async () => {
    const p = await insertProposal(db, proposal());
    const q = await insertProposal(db, proposal({ change: { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 1 } }));
    await decideProposal(db, q.id, 'approved', '  ', '2026-09-21T00:00:00Z');
    const rejected = await decideProposal(db, p.id, 'rejected', ' wait for the Q3 disclosure ', '2026-09-22T00:00:00Z');
    expect(rejected).toMatchObject({ status: 'rejected', decisionNote: 'wait for the Q3 disclosure', decidedAt: '2026-09-22T00:00:00.000Z' });
    expect((await getProposal(db, q.id))!.decisionNote).toBeNull();
    expect(await codeOf(() => decideProposal(db, p.id, 'approved', null, '2026-09-23T00:00:00Z'))).toBe('proposal_not_pending');
    expect(await codeOf(() => decideProposal(db, 999, 'approved', null, '2026-09-23T00:00:00Z'))).toBe('proposal_not_found');
    expect((await recentlyDecidedProposals(db, 'mini', 10)).map((x) => x.id)).toEqual([p.id, q.id]);
    expect(await listProposals(db)).toEqual([]);
    expect(await listProposals(db, { includeDecided: true })).toHaveLength(2);
  });

  it('stores citations as JSON, and a citation-free proposal as NULL', async () => {
    const citations = [
      { source: 'doc:1', quotedText: 'we moved the base weight to one half', locator: '12:33', docSha256: 'd'.repeat(64), docKind: 'transcript' as const },
      { source: 'https://news.example.com/a', quotedText: 'annualized revenue of $1,100', locator: null, docSha256: null, docKind: null },
    ];
    const cited = await insertProposal(db, proposal({ citations }));
    expect(cited.citations).toEqual(citations);
    expect((await getProposal(db, cited.id))!.citations).toEqual(citations);
    const raw = async (id: number) => (await db.one<{ citations_json: string | null }>('SELECT citations_json FROM proposals WHERE id = $1', [id]))!.citations_json;
    expect(JSON.parse((await raw(cited.id))!)).toEqual(citations);
    const bare = await insertProposal(db, proposal({ change: { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 1 }, citations: [] }));
    expect(await raw(bare.id)).toBeNull();
  });

  it('old proposal rows read citations as []', async () => {
    const p = await insertProposal(db, proposal());
    await db.run('UPDATE proposals SET citations_json = NULL WHERE id = $1', [p.id]);
    expect((await getProposal(db, p.id))!.citations).toEqual([]);
    expect((await listProposals(db))[0].citations).toEqual([]);
  });
});

describe('journal', () => {
  it('appends entries and pages backwards', async () => {
    const ids: number[] = [];
    for (const n of [1, 2, 3, 4]) {
      const entry = await insertJournalEntry(db, {
        assetId: 'mini', persona: 'analyst', agentRunId: null, createdAt: `2026-09-0${n}T00:00:00Z`,
        thesis: `thesis ${n}`, openQuestions: [`q${n}`], summary: `did ${n}`,
      });
      ids.push(entry.id);
    }
    const newest = await listJournal(db, 'mini');
    expect(newest.map((e) => e.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(newest[0]).toMatchObject({ thesis: 'thesis 4', openQuestions: ['q4'], summary: 'did 4', createdAt: '2026-09-04T00:00:00.000Z' });
    expect((await listJournal(db, 'mini', { beforeId: ids[1], limit: 5 })).map((e) => e.id)).toEqual([ids[0]]);
    expect(await listJournal(db, 'other')).toEqual([]);
  });

  it('stores catalysts, and old journal rows read catalysts as []', async () => {
    const catalysts = [
      {
        event: 'license granted', kind: 'regulatory' as const, by: '2026-09-30',
        citations: [{ source: 'doc:1', quotedText: 'the license should be granted by September', locator: '00:04', docSha256: 'e'.repeat(64), docKind: 'transcript' as const }],
      },
    ];
    const entry = async (over: Record<string, unknown> = {}) =>
      await insertJournalEntry(db, { assetId: 'mini', persona: 'analyst', agentRunId: null, createdAt: '2026-09-01T00:00:00Z', thesis: 't', openQuestions: [], summary: 's', ...over });
    const cited = await entry({ catalysts });
    expect(cited.catalysts).toEqual(catalysts);
    const old = await entry();
    expect(old.catalysts).toEqual([]);
    const raw = async (id: number) => (await db.one<{ catalysts_json: string | null }>('SELECT catalysts_json FROM journal WHERE id = $1', [id]))!.catalysts_json;
    expect(await raw(old.id)).toBeNull();
    expect((await listJournal(db, 'mini')).map((e) => e.catalysts)).toEqual([[], catalysts]);
  });
});

describe('anomaly decisions', () => {
  it('records who decided: a persona, or null for the user', async () => {
    const raise = async (dedupeKey: string) =>
      await raiseAnomaly(db, {
        assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey, severity: 'degrading', detail: {}, seenAt: '2026-09-18T00:00:00Z',
      });
    const byAgent = await decideAnomaly(db, (await raise('a')).id, 'resolved', 'cleared', '2026-09-19T00:00:00Z', 'analyst');
    const byUser = await decideAnomaly(db, (await raise('b')).id, 'acknowledged', 'known lag', '2026-09-19T00:00:00Z');
    expect(byAgent.decidedBy).toBe('analyst');
    expect(byUser.decidedBy).toBeNull();
  });
});
