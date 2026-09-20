import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { approveProposal, rejectProposal } from '../../src/app/proposals.js';
import { loadAsset } from '../../src/config/load.js';
import { decideAnomaly, getAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { listAssumptionChanges } from '../../src/db/assumptionChanges.js';
import { createAssumptionSet, getLatestAssumptionSet } from '../../src/db/assumptions.js';
import { getObservationsByIds, insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { getProposal, insertProposal, type NewProposal, type ProposalChange } from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { miniAssumptions } from '../helpers/assets.js';
import { AGENT_ASSET_YAML, agentWorld, type AgentWorld } from '../helpers/agentWorld.js';
import { AS_OF } from '../helpers/obs.js';

const NOW = new Date('2026-07-01T00:00:00.000Z');
let w: AgentWorld;
let home: string;
let yamlPath: string;

beforeEach(() => {
  w = agentWorld();
  home = mkdtempSync(join(tmpdir(), 'orion-proposals-'));
  mkdirSync(join(home, 'assets'));
  yamlPath = join(home, 'assets', 'mini.yaml');
  writeFileSync(yamlPath, AGENT_ASSET_YAML.trimStart());
});

const file = (change: ProposalChange, filedAgainst: unknown, over: Partial<NewProposal> = {}) =>
  insertProposal(w.db, {
    assetId: 'mini', persona: 'analyst', agentRunId: null, change, filedAgainst, rationale: 'usage is accelerating',
    evidence: [w.ids.revenue_run_rate_usd], effect: null, createdAt: AS_OF, ...over,
  });
const approve = (id: number, note?: string) => approveProposal(w.db, home, id, { note, now: NOW });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};
const anomaly = () =>
  raiseAnomaly(w.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'degrading', detail: {}, seenAt: AS_OF });

describe('approving an assumption value', () => {
  const growth = (value: number) => file({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value }, { value: 0 });

  it('saves a new set as the user, outside the agent band but inside the key-wide bounds, with the change and its evidence', () => {
    const p = growth(1.8);
    const { proposal, result } = approve(p.id, 'agreed');
    expect(result).toEqual({ kind: 'assumption_value', setVersion: 2 });
    expect(proposal).toMatchObject({ status: 'approved', decisionNote: 'agreed', decidedAt: NOW.toISOString() });
    const set = getLatestAssumptionSet(w.db, 'mini')!;
    expect(set).toMatchObject({ author: 'user', rationale: `Approved proposal #${p.id} from analyst: usage is accelerating` });
    expect(set.values.base.rev_growth_y1).toBe(1.8);
    expect(set.values.bull.rev_growth_y1).toBe(0);
    expect(listAssumptionChanges(w.db, set.id)).toMatchObject([{ key: 'rev_growth_y1', scenario: 'base', fromValue: 0, toValue: 1.8, evidence: [w.ids.revenue_run_rate_usd] }]);
  });

  it('refuses a value outside the key-wide bounds, says what to widen, and leaves the proposal pending', () => {
    const p = growth(6);
    expect(codeOf(() => approve(p.id))).toBe('outside_key_bounds');
    expect(getProposal(w.db, p.id)!.status).toBe('pending');
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(1);
  });

  it('is stale once the value it was filed against has moved', () => {
    const p = growth(1.8);
    createAssumptionSet(w.db, { assetId: 'mini', author: 'user', rationale: 'mine', values: miniAssumptions({ rev_growth_y1: 0.3 }), createdAt: AS_OF });
    expect(codeOf(() => approve(p.id))).toBe('stale_proposal');
    expect(getProposal(w.db, p.id)!.status).toBe('pending');
  });
});

describe('approving anomaly proposals', () => {
  it('acknowledges with the user\'s note, else the proposal\'s, and withdraws an acknowledgement by resolving', () => {
    const a = anomaly();
    approve(file({ kind: 'acknowledge_anomaly', anomalyId: a.id, note: 'lags by design' }, { status: 'open' }).id);
    expect(getAnomaly(w.db, a.id)).toMatchObject({ status: 'acknowledged', note: 'lags by design', decidedBy: null });
    const { result } = approve(file({ kind: 'withdraw_acknowledgement', anomalyId: a.id, note: 'it has grown' }, { status: 'acknowledged' }).id, 'agreed, look again');
    expect(result).toEqual({ kind: 'anomaly', anomalyId: a.id, status: 'resolved' });
    expect(getAnomaly(w.db, a.id)).toMatchObject({ status: 'resolved', note: 'agreed, look again' });
  });

  it('is stale when the anomaly is no longer in the status it was filed against', () => {
    const a = anomaly();
    const p = file({ kind: 'acknowledge_anomaly', anomalyId: a.id, note: 'n' }, { status: 'open' });
    decideAnomaly(w.db, a.id, 'resolved', 'fixed', AS_OF);
    expect(codeOf(() => approve(p.id))).toBe('stale_proposal');
  });
});

describe('approving observation proposals', () => {
  it('confirms a provisional observation and rejects an active one', () => {
    const provisional = insertObservation(w.db, {
      assetId: 'mini', metricKey: 'staked_supply', observedAt: '2026-06-29T12:00:00Z', value: 80, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    const confirmed = approve(file({ kind: 'confirm_observation', observationId: provisional.id, note: 'n' }, { status: 'provisional', active: true }).id);
    expect(confirmed.result).toMatchObject({ kind: 'observation', action: 'confirmed' });
    expect(listActiveObservations(w.db, 'mini', 'staked_supply').at(-1)).toMatchObject({ value: 80, status: 'confirmed' });

    approve(file({ kind: 'reject_observation', observationId: w.ids.price_usd, note: 'n' }, { status: 'confirmed', active: true }).id);
    expect(getObservationsByIds(w.db, [w.ids.price_usd])[0].status).toBe('rejected');
    const again = file({ kind: 'reject_observation', observationId: w.ids.price_usd, note: 'again' }, { status: 'confirmed', active: true });
    expect(codeOf(() => approve(again.id))).toBe('stale_proposal');
  });

  it('inserts a move-guarded observation as confirmed, keeping the citation, unless the value in force has changed', () => {
    const change: ProposalChange = {
      kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-28T00:00:00.000Z', periodDays: null,
      citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
    };
    const p = file(change, { inForce: 1000 }, { agentRunId: null });
    const { result } = approve(p.id);
    const row = getObservationsByIds(w.db, [(result as { observationId: number }).observationId])[0];
    expect(row).toMatchObject({
      value: 2000, status: 'confirmed', source: 'manual', citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
      sourceDetail: `research:analyst:run none; approved proposal #${p.id}`,
    });
    const late = file({ ...change, value: 2100 }, { inForce: 1000 });
    expect(codeOf(() => approve(late.id))).toBe('stale_proposal'); // 2000 is in force now
  });

  it('checks an observation proposal against the last CONFIRMED value, the baseline the move guard filed it against', () => {
    // A provisional row is live in the signal (1250). The confirmed value, which the proposal was filed against, is still 1000.
    insertObservation(w.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-20', value: 1250, source: 'manual', status: 'provisional',
      citationUrl: 'https://news.example.com/earlier', fetchedAt: AS_OF,
    });
    const p = file(
      {
        kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-28T00:00:00.000Z', periodDays: null,
        citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
      },
      { inForce: 1000 },
    );
    expect(approve(p.id).result).toMatchObject({ kind: 'observation', action: 'inserted' });
  });

  it('goes stale rather than supersede an observation that now exists at the same metric and time, even a confirmed one', () => {
    const change: ProposalChange = {
      kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-10T00:00:00.000Z', periodDays: null,
      citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
    };
    const p = file(change, { inForce: 1000 });
    const users = insertObservation(w.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-10', value: 900, source: 'manual', fetchedAt: AS_OF,
    });
    expect(codeOf(() => approve(p.id))).toBe('stale_proposal');
    expect(getObservationsByIds(w.db, [users.id])[0]).toMatchObject({ supersededBy: null, status: 'confirmed' });
    expect(getProposal(w.db, p.id)!.status).toBe('pending');
  });
});

describe('approving a config proposal', () => {
  const bandEdit: ProposalChange = { kind: 'config', edits: [{ path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 2 } }] };

  it('edits the YAML in place, changing only the edited line, and reports old and new values', () => {
    const before = readFileSync(yamlPath, 'utf8');
    const p = file(bandEdit, [{ min: 0, max: 1 }]);
    const { proposal, result } = approve(p.id);
    expect(proposal.status).toBe('approved');
    expect(result).toEqual({ kind: 'config', file: yamlPath, changes: [{ path: ['assumptions', 'rev_growth_y1', 'base'], from: { min: 0, max: 1 }, to: { min: 0, max: 2 } }] });
    const after = readFileSync(yamlPath, 'utf8');
    const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
    expect(changed).toEqual(['  rev_growth_y1: { min: -0.5, max: 5, base: { min: 0, max: 1 } }']);
    expect(after).toContain('  rev_growth_y1: { min: -0.5, max: 5, base: { min: 0, max: 2 } }'); // key order as the proposal wrote it
    expect(loadAsset(home, 'mini').config.assumptions.rev_growth_y1.base).toEqual({ min: 0, max: 2 });
  });

  it('is stale when the file no longer holds what the proposal was filed against', () => {
    const p = file(bandEdit, [{ min: 0, max: 0.5 }]);
    const before = readFileSync(yamlPath, 'utf8');
    expect(codeOf(() => approve(p.id))).toBe('stale_proposal');
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
  });

  it('refuses an edit that would break the config or the current assumptions, and leaves the file untouched', () => {
    const before = readFileSync(yamlPath, 'utf8');
    const weights = file({ kind: 'config', edits: [{ path: ['modules', 'hc', 'weight'], value: 0.5 }] }, [1]);
    expect(codeOf(() => approve(weights.id))).toBe('invalid_asset_config');
    const tight = file({ kind: 'config', edits: [{ path: ['assumptions', 'discount_rate_base', 'min'], value: 0.2 }] }, [0.05]);
    expect(codeOf(() => approve(tight.id))).toBe('invalid_asset_config');
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
    expect(getProposal(w.db, weights.id)!.status).toBe('pending');
  });

  it('restores the file when marking the proposal approved fails', () => {
    const before = readFileSync(yamlPath, 'utf8');
    const p = file(bandEdit, [{ min: 0, max: 1 }]);
    w.db.exec("CREATE TRIGGER fail_decide BEFORE UPDATE ON proposals BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    expect(() => approve(p.id)).toThrow(/disk full/);
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
  });

  it('never applies an edit under agent: or id, whoever wrote the proposal row: the agent cannot raise its own limits', () => {
    const before = readFileSync(yamlPath, 'utf8');
    const step = file({ kind: 'config', edits: [{ path: ['agent', 'max_step_fraction'], value: 1 }] }, [null]);
    const budgets = file({ kind: 'config', edits: [{ path: ['agent'], value: { budgets: { weekly: { proposals: 9999 } } } }] }, [null]);
    const rename = file({ kind: 'config', edits: [{ path: ['id'], value: 'other' }] }, ['mini']);
    for (const p of [step, budgets, rename]) {
      expect(codeOf(() => approve(p.id))).toBe('path_not_proposable');
      expect(getProposal(w.db, p.id)!.status).toBe('pending');
    }
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
  });

  it('refuses a proposal whose filed-against record does not line up with its edits', () => {
    const edit: ProposalChange = { kind: 'config', edits: [{ path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 2 } }] };
    expect(codeOf(() => approve(file(edit, []).id))).toBe('invalid_proposal');
    expect(codeOf(() => approve(file(edit, { value: 0 }).id))).toBe('invalid_proposal');
  });

  it('marks a proposal approved without rewriting when the file already holds every proposed value', () => {
    // A crash after the rename and before the status write leaves exactly this state.
    const p = file(bandEdit, [{ min: 0, max: 1 }]);
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('base: { min: 0, max: 1 }', 'base: { min: 0, max: 2 }'));
    const applied = readFileSync(yamlPath, 'utf8');
    expect(approve(p.id).proposal.status).toBe('approved');
    expect(readFileSync(yamlPath, 'utf8')).toBe(applied);
  });

  it('leaves no temp file behind, and reports a missing asset file as such', () => {
    approve(file(bandEdit, [{ min: 0, max: 1 }]).id);
    expect(existsSync(`${yamlPath}.tmp`)).toBe(false);
    const orphan = file(bandEdit, [{ min: 0, max: 1 }], { assetId: 'ghost' });
    expect(codeOf(() => approve(orphan.id))).toBe('asset_not_found');
  });
});

describe('rejecting, and deciding twice', () => {
  it('needs a note, keeps it, and makes the decision final', () => {
    const p = file({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 1.8 }, { value: 0 });
    expect(codeOf(() => rejectProposal(w.db, p.id, '  ', NOW))).toBe('note_required');
    expect(rejectProposal(w.db, p.id, 'wait for the Q3 disclosure', NOW)).toMatchObject({ status: 'rejected', decisionNote: 'wait for the Q3 disclosure' });
    expect(codeOf(() => approve(p.id))).toBe('proposal_not_pending');
    expect(codeOf(() => rejectProposal(w.db, p.id, 'again', NOW))).toBe('proposal_not_pending');
    expect(codeOf(() => approve(999))).toBe('proposal_not_found');
  });
});
