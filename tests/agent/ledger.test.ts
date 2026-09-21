import { beforeEach, describe, expect, it } from 'vitest';
import { AgentConflict, Ledger, movesSignal } from '../../src/agent/ledger.js';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import { decideAnomaly, getAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { listAssumptionChanges } from '../../src/db/assumptionChanges.js';
import { createAssumptionSet, getLatestAssumptionSet, listAssumptionSets } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { listJournal } from '../../src/db/journal.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { listProposals } from '../../src/db/proposals.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';

const NOW = new Date('2026-09-20T00:00:00.000Z');
let db: Db;
let asset: AssetConfig;
let ledger: Ledger;
let priceId: number;

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const anomaly = () =>
  raiseAnomaly(db, {
    assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'degrading', detail: {}, seenAt: '2026-09-19T00:00:00Z',
  });
const research = (over: Partial<Parameters<Ledger['stageObservation']>[0]> = {}) =>
  ledger.stageObservation({
    metricKey: 'revenue_run_rate_usd', value: 1100, observedAt: '2026-09-18', periodDays: null,
    citationUrl: 'https://news.example.com/a', quotedText: 'annualized revenue of $1,100', live: true, ...over,
  });

beforeEach(() => {
  db = openDb(':memory:');
  asset = parseAssetYaml(MINI_ASSET_YAML).config;
  const set = createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: '2026-09-01T00:00:00Z' });
  priceId = insertObservation(db, { assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-09-19', value: 10, source: 'onchain', fetchedAt: '2026-09-19' }).id;
  ledger = new Ledger('mini', 'analyst', set);
});

describe('staging', () => {
  it('merges staged changes over the committed values; a later change replaces an earlier one', () => {
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.1, rationale: 'first', evidence: [priceId] });
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.2, rationale: 'second', evidence: [priceId] });
    expect(ledger.assumptionChanges()).toEqual([{ key: 'rev_growth_y1', scenario: 'base', start: 0, value: 0.2, rationale: 'second', evidence: [priceId] }]);
    expect(ledger.mergedValues().base.rev_growth_y1).toBe(0.2);
    expect(ledger.mergedValues().bull.rev_growth_y1).toBe(0);
    expect(ledger.mergedValues([{ key: 'rev_growth_y1', scenario: 'bull', value: 0.5 }]).bull.rev_growth_y1).toBe(0.5);
    expect(ledger.overrides()).toEqual([{ key: 'rev_growth_y1', value: 0.2, scenario: 'base' }]);
    expect(count('assumption_sets')).toBe(1); // nothing reached the database
  });

  it('unstages a change that goes back to the run-start value', () => {
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.1, rationale: 'up', evidence: [priceId] });
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0, rationale: 'never mind', evidence: [priceId] });
    expect(ledger.assumptionChanges()).toEqual([]);
  });

  it('gives staged observations negative ids, marks them shown, and separates live rows from inert ones', () => {
    const live = research();
    const inert = research({ metricKey: 'staked_supply', value: 60, live: false });
    expect([live.tempId, inert.tempId]).toEqual([-1, -2]);
    expect(live.observedAt).toBe('2026-09-18T00:00:00.000Z');
    expect(ledger.shown.has(-1) && ledger.shown.has(-2)).toBe(true);
    expect(ledger.observationRows(NOW.toISOString()).map((o) => o.id)).toEqual([-1, -2]);
    const rows = ledger.observationRows(NOW.toISOString(), { liveOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: -1, assetId: 'mini', metricKey: 'revenue_run_rate_usd', value: 1100, status: 'provisional', source: 'manual' });
  });

  it('replaces an observation staged earlier at the same metric and time, keeping its temporary id', () => {
    const first = research({ value: 1100 });
    const second = research({ value: 1150, quotedText: 'annualized revenue of $1,150' });
    expect(second.tempId).toBe(first.tempId);
    expect(ledger.observations()).toHaveLength(1);
    expect(ledger.observations()[0]).toMatchObject({ tempId: -1, value: 1150, quotedText: 'annualized revenue of $1,150' });
    expect(research({ observedAt: '2026-09-17' }).tempId).toBe(-2);
  });

  it('tracks staged resolutions', () => {
    ledger.stageResolution({ anomalyId: 4, note: 'cleared', evidence: [priceId] });
    expect([...ledger.resolvedAnomalyIds()]).toEqual([4]);
  });
});

describe('commit', () => {
  it('writes one set version for several changes, each with its own rationale and evidence, through saveAssumptions', () => {
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.1, rationale: 'usage up', evidence: [priceId] });
    ledger.stageAssumptionChange({ key: 'discount_rate_base', scenario: 'bull', value: 0.09, rationale: 'rates down', evidence: [priceId] });
    const summary = ledger.commit(db, asset, { agentRunId: null, now: NOW });
    expect(summary.setVersion).toBe(2);
    const set = getLatestAssumptionSet(db, 'mini')!;
    expect(set).toMatchObject({ version: 2, parentVersion: 1, author: 'analyst', createdAt: NOW.toISOString() });
    expect(set.rationale).toBe('rev_growth_y1 base 0 -> 0.1: usage up; discount_rate_base bull 0.1 -> 0.09: rates down');
    expect(set.values.base.rev_growth_y1).toBe(0.1);
    expect(set.values.bull.discount_rate_base).toBe(0.09);
    expect(set.values.bear.discount_rate_base).toBe(0.1);
    expect(listAssumptionChanges(db, set.id).map((c) => [c.key, c.scenario, c.fromValue, c.toValue, c.rationale, c.evidence])).toEqual([
      ['rev_growth_y1', 'base', 0, 0.1, 'usage up', [priceId]],
      ['discount_rate_base', 'bull', 0.1, 0.09, 'rates down', [priceId]],
    ]);
    expect(movesSignal(summary)).toBe(true);
  });

  it('inserts staged research as provisional manual rows and remaps temporary ids in evidence', () => {
    const staged = research();
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.1, rationale: 'new disclosure', evidence: [staged.tempId, priceId] });
    ledger.stageProposal({
      change: { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 3 }, filedAgainst: { value: 0 },
      rationale: 'beyond the step', evidence: [staged.tempId], effect: null,
    });
    const summary = ledger.commit(db, asset, { agentRunId: null, now: NOW });
    const row = listActiveObservations(db, 'mini', 'revenue_run_rate_usd')[0];
    expect(row).toMatchObject({
      value: 1100, source: 'manual', status: 'provisional', citationUrl: 'https://news.example.com/a', quotedText: 'annualized revenue of $1,100',
      sourceDetail: 'research:analyst:run none', fetchedAt: NOW.toISOString(),
    });
    expect(summary.observationIds).toEqual([row.id]);
    expect(listAssumptionChanges(db, getLatestAssumptionSet(db, 'mini')!.id)[0].evidence).toEqual([priceId, row.id].sort((a, b) => a - b));
    expect(listProposals(db)[0].evidence).toEqual([row.id]);
  });

  it('resolves anomalies as the persona, with the evidence in the note', () => {
    const a = anomaly();
    ledger.stageResolution({ anomalyId: a.id, note: 'sources agree again', evidence: [priceId] });
    const summary = ledger.commit(db, asset, { agentRunId: null, now: NOW });
    expect(summary.resolvedAnomalyIds).toEqual([a.id]);
    expect(getAnomaly(db, a.id)).toMatchObject({ status: 'resolved', decidedBy: 'analyst', note: `sources agree again [evidence: #${priceId}]` });
  });

  it('writes proposals and the journal, and a journal-only commit does not move a signal', () => {
    ledger.setJournal({ thesis: 'steady', openQuestions: ['Q3 revenue?'], summary: 'no change' });
    ledger.setJournal({ thesis: 'steady, still', openQuestions: ['Q3 revenue?'], summary: 'no change' });
    ledger.stageProposal({
      change: { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'lags by design' }, filedAgainst: { status: 'open' }, rationale: 'known lag', evidence: [], effect: null,
    });
    const summary = ledger.commit(db, asset, { agentRunId: null, now: NOW });
    expect(summary).toMatchObject({ setVersion: null, observationIds: [], resolvedAnomalyIds: [] });
    expect(listJournal(db, 'mini')).toHaveLength(1);
    expect(listJournal(db, 'mini')[0]).toMatchObject({ id: summary.journalId, thesis: 'steady, still', persona: 'analyst' });
    expect(listProposals(db)[0]).toMatchObject({ id: summary.proposalIds[0], persona: 'analyst', status: 'pending' });
    expect(movesSignal(summary)).toBe(false);
  });

  it('previews what it would write without writing', () => {
    research();
    ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's' });
    const preview = ledger.preview();
    expect(preview.observations).toHaveLength(1);
    expect(preview.journal).toEqual({ thesis: 't', openQuestions: [], summary: 's' });
    expect(count('observations')).toBe(1);
    expect(count('journal')).toBe(0);
  });
});

describe('the world changes mid-run', () => {
  const stageEverything = () => {
    const staged = research();
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.1, rationale: 'up', evidence: [staged.tempId] });
    ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's' });
    ledger.stageProposal({ change: { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'n' }, filedAgainst: {}, rationale: 'r', evidence: [], effect: null });
  };
  const nothingWritten = () => {
    expect(count('observations')).toBe(1);
    expect(count('journal')).toBe(0);
    expect(count('proposals')).toBe(0);
    expect(count('assumption_changes')).toBe(0);
  };

  it('conflicts when the user saved an assumption set during the run, and writes nothing at all', () => {
    stageEverything();
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'mine', values: miniAssumptions({ rev_growth_y1: 0.3 }), createdAt: '2026-09-19T12:00:00Z' });
    expect(() => ledger.commit(db, asset, { agentRunId: null, now: NOW })).toThrow(AgentConflict);
    expect(listAssumptionSets(db, 'mini')).toHaveLength(2);
    expect(getLatestAssumptionSet(db, 'mini')!.author).toBe('user');
    nothingWritten();
  });

  it('does not mind a newer set when it staged no assumption change', () => {
    ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's' });
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'mine', values: miniAssumptions(), createdAt: '2026-09-19T12:00:00Z' });
    expect(ledger.commit(db, asset, { agentRunId: null, now: NOW }).journalId).not.toBeNull();
  });

  it('conflicts when the anomaly was decided during the run, and never withdraws an acknowledgement', () => {
    const a = anomaly();
    stageEverything();
    ledger.stageResolution({ anomalyId: a.id, note: 'cleared', evidence: [priceId] });
    decideAnomaly(db, a.id, 'acknowledged', 'known lag', '2026-09-19T12:00:00Z');
    expect(() => ledger.commit(db, asset, { agentRunId: null, now: NOW })).toThrow(/anomaly \d+ is no longer open \(acknowledged\)/);
    expect(getAnomaly(db, a.id)).toMatchObject({ status: 'acknowledged', note: 'known lag' });
    nothingWritten();
  });

  it('conflicts rather than supersede an observation that already exists at the same metric and time', () => {
    research();
    ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's' });
    const users = insertObservation(db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-09-18', value: 1000, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com/user', fetchedAt: '2026-09-19',
    });
    expect(() => ledger.commit(db, asset, { agentRunId: null, now: NOW })).toThrow(/already exists/);
    const active = listActiveObservations(db, 'mini', 'revenue_run_rate_usd');
    expect(active.map((o) => o.id)).toEqual([users.id]);
    expect(count('journal')).toBe(0);
  });

  it('conflicts when the config tightened so the staged set is no longer valid, and rolls back the rows already inserted', () => {
    stageEverything();
    const tightened = parseAssetYaml(MINI_ASSET_YAML.replace('rev_growth_y1: { min: -0.5, max: 5 }', 'rev_growth_y1: { min: -0.5, max: 0.05 }')).config;
    expect(() => ledger.commit(db, tightened, { agentRunId: null, now: NOW })).toThrow(/invalid_assumptions/);
    expect(getLatestAssumptionSet(db, 'mini')!.version).toBe(1);
    nothingWritten();
  });

  it('conflicts when a degrading anomaly opened after the tool checked, and writes nothing', () => {
    stageEverything();
    const a = anomaly(); // raised between the tool's check and the commit
    expect(() => ledger.commit(db, asset, { agentRunId: null, now: NOW })).toThrow(
      new RegExp(`a degrading anomaly opened during the run \\(#${a.id}\\); assumption changes are blocked`),
    );
    expect(getLatestAssumptionSet(db, 'mini')!.version).toBe(1);
    nothingWritten();
  });

  it('counts a resolution staged in this run as resolved, exactly as the tool did', () => {
    const a = anomaly();
    stageEverything();
    ledger.stageResolution({ anomalyId: a.id, note: 'cleared', evidence: [priceId] });
    expect(ledger.commit(db, asset, { agentRunId: null, now: NOW }).setVersion).toBe(2);
    expect(getAnomaly(db, a.id)).toMatchObject({ status: 'resolved' });
  });

  it('conflicts on evidence that cites a staged id this run never staged', () => {
    ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.1, rationale: 'up', evidence: [-9] });
    expect(() => ledger.commit(db, asset, { agentRunId: null, now: NOW })).toThrow(AgentConflict);
    expect(getLatestAssumptionSet(db, 'mini')!.version).toBe(1);
  });
});
