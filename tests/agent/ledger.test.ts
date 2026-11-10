import { beforeEach, describe, expect, it } from 'vitest';
import { AgentConflict, Ledger } from '../../src/agent/ledger.js';
import { decideAnomaly, getAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import type { Db } from '../../src/db/connection.js';
import { listJournal } from '../../src/db/journal.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { listProposals } from '../../src/db/proposals.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

const testDb = useTestDb();

const NOW = new Date('2026-09-20T00:00:00.000Z');
let db: Db;
let ledger: Ledger;
let priceId: number;

const CITATION = { source: 'doc:1', quotedText: 'the API lags by design, every day', locator: '12:33', docSha256: 'd'.repeat(64), docKind: 'transcript' as const };
const count = async (table: string): Promise<number> => (await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const anomaly = async () =>
  await raiseAnomaly(db, {
    assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'degrading', detail: {}, seenAt: '2026-09-19T00:00:00Z',
  });
const research = (over: Partial<Parameters<Ledger['stageObservation']>[0]> = {}) =>
  ledger.stageObservation({
    metricKey: 'staked_supply', value: 60, observedAt: '2026-09-18', periodDays: null,
    citationUrl: 'doc:1', quotedText: 'staked supply stands at 60 tokens', live: false, ...over,
  });
const commit = () => ledger.commit(db, { agentRunId: null, now: NOW });

beforeEach(async () => {
  db = testDb();
  priceId = (await insertObservation(db, { provenance: testProvenance('onchain'), assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-09-19', value: 10, fetchedAt: '2026-09-19' })).id;
  ledger = new Ledger('mini', 'analyst', 'test');
});

describe('staging', () => {
  it('gives staged observations negative ids, marks them shown, and separates live rows from inert ones', () => {
    const live = research({ metricKey: 'revenue_run_rate_usd', value: 1100, live: true });
    const inert = research();
    expect([live.tempId, inert.tempId]).toEqual([-1, -2]);
    expect(live.observedAt).toBe('2026-09-18T00:00:00.000Z');
    expect(ledger.shown.has(-1) && ledger.shown.has(-2)).toBe(true);
    expect(ledger.observationRows(NOW.toISOString()).map((o) => o.id)).toEqual([-1, -2]);
    const rows = ledger.observationRows(NOW.toISOString(), { liveOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: -1, assetId: 'mini', metricKey: 'revenue_run_rate_usd', value: 1100, status: 'provisional', source: 'manual' });
  });

  it('replaces an observation staged earlier at the same metric and time, keeping its temporary id', () => {
    const first = research({ value: 60 });
    const second = research({ value: 65, quotedText: 'staked supply stands at 65 tokens' });
    expect(second.tempId).toBe(first.tempId);
    expect(ledger.observations()).toHaveLength(1);
    expect(ledger.observations()[0]).toMatchObject({ tempId: -1, value: 65, quotedText: 'staked supply stands at 65 tokens' });
    expect(research({ observedAt: '2026-09-17' }).tempId).toBe(-2);
  });

  it('tracks staged resolutions', () => {
    ledger.stageResolution({ anomalyId: 4, note: 'cleared', evidence: [priceId] });
    expect([...ledger.resolvedAnomalyIds()]).toEqual([4]);
  });

  it('stages nothing about assumptions: the preview has resolutions, observations, proposals, the journal and dev findings only', () => {
    expect(ledger.preview()).toEqual({ resolutions: [], observations: [], proposals: [], journal: null, devFindings: [] });
  });
});

describe('commit', () => {
  it('inserts staged research as provisional manual rows and remaps temporary ids in evidence', async () => {
    const staged = research();
    ledger.stageProposal({
      change: { kind: 'reject_observation', observationId: priceId, note: 'stale' }, filedAgainst: { status: 'confirmed', active: true },
      rationale: 'the post contradicts it', evidence: [staged.tempId, priceId], effect: null, citations: [],
    });
    const summary = await commit();
    const row = (await listActiveObservations(db, 'mini', 'staked_supply'))[0];
    expect(row).toMatchObject({
      value: 60, source: 'manual', status: 'provisional', citationUrl: 'doc:1', quotedText: 'staked supply stands at 60 tokens',
      sourceDetail: 'research:analyst:run none', fetchedAt: NOW.toISOString(),
    });
    expect(summary.observationIds).toEqual([row.id]);
    expect((await listProposals(db))[0].evidence).toEqual([row.id, priceId]); // the order the proposal gave, the staged id remapped
    expect((await listProposals(db))[0].effect).toBeNull();
  });

  it('resolves anomalies as the persona, with the evidence in the note', async () => {
    const a = await anomaly();
    ledger.stageResolution({ anomalyId: a.id, note: 'sources agree again', evidence: [priceId] });
    const summary = await commit();
    expect(summary.resolvedAnomalyIds).toEqual([a.id]);
    expect(await getAnomaly(db, a.id)).toMatchObject({ status: 'resolved', decidedBy: 'analyst', note: `sources agree again [evidence: #${priceId}]` });
  });

  it('writes proposals and the journal, and its summary has no assumption set version', async () => {
    ledger.setJournal({ thesis: 'steady', openQuestions: ['Q3 revenue?'], summary: 'no change', catalysts: [] });
    ledger.setJournal({ thesis: 'steady, still', openQuestions: ['Q3 revenue?'], summary: 'no change', catalysts: [] });
    ledger.stageProposal({
      change: { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'lags by design' }, filedAgainst: { status: 'open' }, rationale: 'known lag', evidence: [], effect: null,
      citations: [CITATION],
    });
    const summary = await commit();
    expect(Object.keys(summary)).toEqual(['observationIds', 'resolvedAnomalyIds', 'proposalIds', 'journalId', 'devFindings']);
    expect(summary).toMatchObject({ observationIds: [], resolvedAnomalyIds: [] });
    expect(await listJournal(db, 'mini')).toHaveLength(1);
    expect((await listJournal(db, 'mini'))[0]).toMatchObject({ id: summary.journalId, thesis: 'steady, still', persona: 'analyst' });
    expect((await listProposals(db))[0]).toMatchObject({ id: summary.proposalIds[0], persona: 'analyst', status: 'pending', citations: [CITATION] });
  });

  it('previews what it would write without writing', async () => {
    research();
    ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's', catalysts: [] });
    const preview = ledger.preview();
    expect(preview.observations).toHaveLength(1);
    expect(preview.journal).toEqual({ thesis: 't', openQuestions: [], summary: 's', catalysts: [] });
    expect(await count('observations')).toBe(1);
    expect(await count('journal')).toBe(0);
  });
});

describe('dev findings', () => {
  const FINDING = {
    category: 'holder_flow' as const, title: 't', metricKeys: ['flow_usd.fees'], claim: 'c', orionReading: 'o', valueDirection: 'up' as const,
    proposedFix: 'f', citations: [CITATION], fingerprint: 'f'.repeat(64),
  };
  const tableCounts = async (): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const t of await db.all<{ name: string }>('SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename')) {
      counts[t.name] = await count(`"${t.name}"`);
    }
    return counts;
  };

  it('dev findings survive a dry run in staged and appear in committed after a commit; nothing is written to any table', async () => {
    ledger.stageDevFinding({ ...FINDING, evidence: [priceId] });
    const before = await tableCounts();
    expect(ledger.preview().devFindings).toEqual([{ ...FINDING, evidence: [priceId] }]);
    const summary = await commit();
    expect(summary.devFindings).toEqual([{ ...FINDING, evidence: [priceId] }]);
    expect(await tableCounts()).toEqual(before);
  });

  it('replaces a finding with the same category and sorted keys, and gives committed findings the real ids of rows staged with them', async () => {
    const staged = research();
    ledger.stageDevFinding({ ...FINDING, metricKeys: ['flow_usd.fees', 'revenue_run_rate_usd'], evidence: [priceId] });
    ledger.stageDevFinding({ ...FINDING, category: 'revenue', evidence: [priceId] });
    ledger.stageDevFinding({ ...FINDING, metricKeys: ['revenue_run_rate_usd', 'flow_usd.fees'], title: 'second', evidence: [staged.tempId] });
    expect(ledger.devFindings().map((f) => [f.category, f.title])).toEqual([['holder_flow', 'second'], ['revenue', 't']]);
    expect(ledger.preview().devFindings[0].evidence).toEqual([staged.tempId]);
    const summary = await commit();
    expect(summary.devFindings[0].evidence).toEqual(summary.observationIds);
    expect(ledger.devFindings()[0].evidence).toEqual([staged.tempId]); // the staged copy is untouched
  });
});

describe('the world changes mid-run', () => {
  const stageEverything = () => {
    const staged = research();
    ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's', catalysts: [] });
    ledger.stageProposal({ change: { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'n' }, filedAgainst: {}, rationale: 'r', evidence: [staged.tempId], effect: null, citations: [] });
  };
  const nothingWritten = async () => {
    expect(await count('observations')).toBe(1);
    expect(await count('journal')).toBe(0);
    expect(await count('proposals')).toBe(0);
  };

  it('conflicts when the anomaly was decided during the run, and never withdraws an acknowledgement', async () => {
    const a = await anomaly();
    stageEverything();
    ledger.stageResolution({ anomalyId: a.id, note: 'cleared', evidence: [priceId] });
    await decideAnomaly(db, a.id, 'acknowledged', 'known lag', '2026-09-19T12:00:00Z');
    await expect(commit()).rejects.toThrow(/anomaly \d+ is no longer open \(acknowledged\)/);
    expect(await getAnomaly(db, a.id)).toMatchObject({ status: 'acknowledged', note: 'known lag' });
    await nothingWritten();
  });

  it('conflicts rather than supersede an observation that already exists at the same metric and time', async () => {
    research();
    ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's', catalysts: [] });
    const users = await insertObservation(db, {
      provenance: testProvenance('manual', true),
      assetId: 'mini', metricKey: 'staked_supply', observedAt: '2026-09-18', value: 50, status: 'provisional',
      citationUrl: 'https://example.com/user', fetchedAt: '2026-09-19',
    });
    await expect(commit()).rejects.toThrow(/already exists/);
    const active = await listActiveObservations(db, 'mini', 'staked_supply');
    expect(active.map((o) => o.id)).toEqual([users.id]);
    expect(await count('journal')).toBe(0);
  });

  it('conflicts on evidence that cites a staged id this run never staged, and rolls back the rows already inserted', async () => {
    stageEverything();
    ledger.stageResolution({ anomalyId: (await anomaly()).id, note: 'cleared', evidence: [-9] });
    await expect(commit()).rejects.toThrow(AgentConflict);
    await nothingWritten();
  });

  it('a degrading anomaly opened during the run blocks nothing: there is no assumption change to block', async () => {
    stageEverything();
    await anomaly();
    expect((await commit()).journalId).not.toBeNull();
  });
});
