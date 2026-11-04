import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { approveProposal, rejectProposal } from '../../src/app/proposals.js';
import { loadAsset } from '../../src/config/load.js';
import { decideAnomaly, getAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { getObservationsByIds, insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { getProposal, insertProposal, type NewProposal, type ProposalChange } from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { AGENT_ASSET_YAML, agentWorld, type AgentWorld } from '../helpers/agentWorld.js';
import { AS_OF } from '../helpers/obs.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

const NOW = new Date('2026-07-01T00:00:00.000Z');
let w: AgentWorld;
let home: string;
let yamlPath: string;

beforeEach(async () => {
  w = await agentWorld(testDb());
  home = mkdtempSync(join(tmpdir(), 'orion-proposals-'));
  mkdirSync(join(home, 'assets'));
  yamlPath = join(home, 'assets', 'mini.yaml');
  writeFileSync(yamlPath, AGENT_ASSET_YAML.trimStart());
});

const file = async (change: ProposalChange, filedAgainst: unknown, over: Partial<NewProposal> = {}) =>
  await insertProposal(w.db, {
    assetId: 'mini', persona: 'analyst', agentRunId: null, change, filedAgainst, rationale: 'usage is accelerating',
    evidence: [w.ids.revenue_run_rate_usd], effect: null, createdAt: AS_OF, ...over,
  });
const approve = (id: number, note?: string) => approveProposal(w.db, home, id, { note, now: NOW });
const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};
const anomaly = async () =>
  await raiseAnomaly(w.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'degrading', detail: {}, seenAt: AS_OF });

describe('a proposal row that is not what the agent files', () => {
  it('refuses an asset id that is not an asset id, before any file path is built from it', async () => {
    const p = await file({ kind: 'config', edits: [{ path: ['symbol'], value: 'EVIL' }] }, ['MINI'], { assetId: '../evil' });
    expect(await codeOf(() => approve(p.id))).toBe('invalid_proposal');
    expect((await getProposal(w.db, p.id))!.status).toBe('pending');
    // The database kinds are refused just as early: the check runs before anything reads or writes.
    const value = await file({ kind: 'acknowledge_anomaly', anomalyId: 1, note: 'n' }, { status: 'open' }, { assetId: 'MINI/../..' });
    expect(await codeOf(() => approve(value.id))).toBe('invalid_proposal');
    expect(existsSync(join(home, 'assets', '..', 'evil.yaml'))).toBe(false);
  });
});

describe('proposals', () => {
  it('proposals: the database refuses kind assumption_value', async () => {
    // The valuation era's kind: no build files one, the importer does not carry the stored ones, and the CHECK refuses one.
    await expect(file({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 1.8 }, { value: 0 })).rejects.toThrow(/proposals_kind_check/);
    await expect(
      w.db.run(
        `INSERT INTO proposals (asset_id, persona, kind, change_json, filed_against_json, rationale, evidence_json, status, created_at)
         VALUES ('mini', 'analyst', 'assumption_value', '{}', '{}', 'r', '[]', 'pending', $1)`,
        [AS_OF],
      ),
    ).rejects.toThrow(/proposals_kind_check/);
    expect(await w.db.all('SELECT id FROM proposals')).toEqual([]);
  });
});

describe('approving anomaly proposals', () => {
  it('acknowledges with the user\'s note, else the proposal\'s, and withdraws an acknowledgement by resolving', async () => {
    const a = await anomaly();
    await approve((await file({ kind: 'acknowledge_anomaly', anomalyId: a.id, note: 'lags by design' }, { status: 'open' })).id);
    expect(await getAnomaly(w.db, a.id)).toMatchObject({ status: 'acknowledged', note: 'lags by design', decidedBy: null });
    const { result } = await approve((await file({ kind: 'withdraw_acknowledgement', anomalyId: a.id, note: 'it has grown' }, { status: 'acknowledged' })).id, 'agreed, look again');
    expect(result).toEqual({ kind: 'anomaly', anomalyId: a.id, status: 'resolved' });
    expect(await getAnomaly(w.db, a.id)).toMatchObject({ status: 'resolved', note: 'agreed, look again' });
  });

  it('is stale when the anomaly is no longer in the status it was filed against', async () => {
    const a = await anomaly();
    const p = await file({ kind: 'acknowledge_anomaly', anomalyId: a.id, note: 'n' }, { status: 'open' });
    await decideAnomaly(w.db, a.id, 'resolved', 'fixed', AS_OF);
    expect(await codeOf(() => approve(p.id))).toBe('stale_proposal');
  });
});

describe('approving observation proposals', () => {
  it('confirms a provisional observation and rejects an active one', async () => {
    const provisional = await insertObservation(w.db, {
      assetId: 'mini', metricKey: 'staked_supply', observedAt: '2026-06-29T12:00:00Z', value: 80, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    const confirmed = await approve((await file({ kind: 'confirm_observation', observationId: provisional.id, note: 'n' }, { status: 'provisional', active: true })).id);
    expect(confirmed.result).toMatchObject({ kind: 'observation', action: 'confirmed' });
    expect((await listActiveObservations(w.db, 'mini', 'staked_supply')).at(-1)).toMatchObject({ value: 80, status: 'confirmed' });

    await approve((await file({ kind: 'reject_observation', observationId: w.ids.price_usd, note: 'n' }, { status: 'confirmed', active: true })).id);
    expect((await getObservationsByIds(w.db, [w.ids.price_usd]))[0].status).toBe('rejected');
    const again = await file({ kind: 'reject_observation', observationId: w.ids.price_usd, note: 'again' }, { status: 'confirmed', active: true });
    expect(await codeOf(() => approve(again.id))).toBe('stale_proposal');
  });

  it('refuses a stored proposal whose observation or anomaly belongs to another asset (tx_asset_mismatch), and changes nothing', async () => {
    // A row edited in the database, or carried from an older build: approve locks the proposal's asset, and the nested
    // write on the other asset's row asks for that asset's lock, which is refused rather than taken mid-transaction.
    const theirs = await insertObservation(w.db, {
      assetId: 'other', metricKey: 'staked_supply', observedAt: '2026-06-29T12:00:00Z', value: 80, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    for (const kind of ['confirm_observation', 'reject_observation'] as const) {
      const p = await file({ kind, observationId: theirs.id, note: 'n' }, { status: 'provisional', active: true });
      await expect(approve(p.id)).rejects.toMatchObject({ code: 'tx_asset_mismatch', message: 'a write on asset other was attempted inside a transaction locked on asset mini' });
      expect((await getProposal(w.db, p.id))!.status).toBe('pending');
    }
    expect((await getObservationsByIds(w.db, [theirs.id]))[0]).toMatchObject({ status: 'provisional', supersededBy: null });
    const theirAnomaly = await raiseAnomaly(w.db, { assetId: 'other', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'degrading', detail: {}, seenAt: AS_OF });
    const ack = await file({ kind: 'acknowledge_anomaly', anomalyId: theirAnomaly.id, note: 'n' }, { status: 'open' });
    expect(await codeOf(() => approve(ack.id))).toBe('tx_asset_mismatch');
    expect((await getAnomaly(w.db, theirAnomaly.id))!.status).toBe('open');
  });

  it('inserts a move-guarded observation as confirmed, keeping the citation, unless the value in force has changed', async () => {
    const change: ProposalChange = {
      kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-28T00:00:00.000Z', periodDays: null,
      citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
    };
    const p = await file(change, { inForce: 1000 }, { agentRunId: null });
    const { result } = await approve(p.id);
    const row = (await getObservationsByIds(w.db, [(result as { observationId: number }).observationId]))[0];
    expect(row).toMatchObject({
      value: 2000, status: 'confirmed', source: 'manual', citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
      sourceDetail: `research:analyst:run none; approved proposal #${p.id}`,
    });
    const late = await file({ ...change, value: 2100 }, { inForce: 1000 });
    expect(await codeOf(() => approve(late.id))).toBe('stale_proposal'); // 2000 is in force now
  });

  it('checks an observation proposal against the last CONFIRMED value, the baseline the move guard filed it against', async () => {
    // A provisional row is in force (1250). The confirmed value, which the proposal was filed against, is still 1000.
    await insertObservation(w.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-20', value: 1250, source: 'manual', status: 'provisional',
      citationUrl: 'https://news.example.com/earlier', fetchedAt: AS_OF,
    });
    const p = await file(
      {
        kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-28T00:00:00.000Z', periodDays: null,
        citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
      },
      { inForce: 1000 },
    );
    expect((await approve(p.id)).result).toMatchObject({ kind: 'observation', action: 'inserted' });
  });

  it('goes stale rather than supersede an observation that now exists at the same metric and time, even a confirmed one', async () => {
    const change: ProposalChange = {
      kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-10T00:00:00.000Z', periodDays: null,
      citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
    };
    const p = await file(change, { inForce: 1000 });
    const users = await insertObservation(w.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-10', value: 900, source: 'manual', fetchedAt: AS_OF,
    });
    expect(await codeOf(() => approve(p.id))).toBe('stale_proposal');
    expect((await getObservationsByIds(w.db, [users.id]))[0]).toMatchObject({ supersededBy: null, status: 'confirmed' });
    expect((await getProposal(w.db, p.id))!.status).toBe('pending');
  });
});

describe('approving a config proposal', () => {
  const stalenessEdit: ProposalChange = { kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'staleness_days'], value: 14 }] };

  it('edits the YAML in place, changing only the edited line, and reports old and new values', async () => {
    const before = readFileSync(yamlPath, 'utf8');
    const p = await file(stalenessEdit, [7]);
    const { proposal, result } = await approve(p.id);
    expect(proposal.status).toBe('approved');
    expect(result).toEqual({ kind: 'config', file: yamlPath, changes: [{ path: ['metrics', 'staked_supply', 'staleness_days'], from: 7, to: 14 }] });
    const after = readFileSync(yamlPath, 'utf8');
    const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
    expect(changed).toEqual(['  staked_supply: { type: level, unit: tokens, staleness_days: 7 }']);
    expect(after).toContain('  staked_supply: { type: level, unit: tokens, staleness_days: 14 }');
    expect(loadAsset(home, 'mini').config.metrics.staked_supply.staleness_days).toBe(14);
  });

  it('is stale when the file no longer holds what the proposal was filed against', async () => {
    const p = await file(stalenessEdit, [10]);
    const before = readFileSync(yamlPath, 'utf8');
    expect(await codeOf(() => approve(p.id))).toBe('stale_proposal');
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
  });

  it('refuses an edit that would break the config, and leaves the file untouched', async () => {
    // The real loader is the check: the asset must still parse after the edit.
    const before = readFileSync(yamlPath, 'utf8');
    const weights = await file({ kind: 'config', edits: [{ path: ['holder_flows', 'fees', 'metric'], value: 'price_usd' }] }, ['flow_usd.fees']);
    expect(await codeOf(() => approve(weights.id))).toBe('invalid_asset_config');
    const inverted = await file({ kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'staleness_days'], value: -1 }] }, [7]);
    expect(await codeOf(() => approve(inverted.id))).toBe('invalid_asset_config');
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
    expect((await getProposal(w.db, weights.id))!.status).toBe('pending');
  });

  it('proposals: approving a config proposal that edits assumptions is refused (invalid_asset_config)', async () => {
    // A stored row from the valuation era, or one edited in the database: its edit would put a removed key back, and the
    // schema refuses the edited file before it touches the disk. Review Focus 4.
    const before = readFileSync(yamlPath, 'utf8');
    const removed: [string, unknown][] = [
      ['assumptions', { rev_growth_y1: { min: -0.5, max: 5 } }],
      ['modules', [{ id: 'hc', type: 'holder_cashflow', kind: 'estimate', weight: 1 }]],
      ['scenario_probabilities', { bear: 0.25, base: 0.5, bull: 0.25 }],
      ['review_triggers', { provisional_move_pct: 25 }],
      ['peer_set', []],
      ['total_return_variants', []],
      ['supply_basis', 'effective_total'],
    ];
    for (const [key, value] of removed) {
      const p = await file({ kind: 'config', edits: [{ path: [key], value }] }, [null]);
      await expect(approve(p.id), key).rejects.toThrow(expect.objectContaining({ code: 'invalid_asset_config', message: expect.stringContaining(`Unrecognized key: "${key}"`) }));
      expect((await getProposal(w.db, p.id))!.status).toBe('pending');
    }
    // A path below a removed key has no parent in today's file: refused before any edit.
    const band = await file({ kind: 'config', edits: [{ path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 2 } }] }, [{ min: 0, max: 1 }]);
    expect(await codeOf(() => approve(band.id))).toBe('invalid_path');
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
  });

  it('restores the file when marking the proposal approved fails', async () => {
    const before = readFileSync(yamlPath, 'utf8');
    const p = await file(stalenessEdit, [7]);
    // The schema is the test file's and outlives this test (tables are emptied, not dropped): the trigger goes after it.
    await w.db.run("CREATE FUNCTION fail_decide() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$");
    await w.db.run('CREATE TRIGGER fail_decide BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION fail_decide()');
    try {
      await expect(approve(p.id)).rejects.toThrow(/disk full/);
      expect(readFileSync(yamlPath, 'utf8')).toBe(before);
      expect((await getProposal(w.db, p.id))!.status).toBe('pending');
    } finally {
      await w.db.run('DROP TRIGGER fail_decide ON proposals');
      await w.db.run('DROP FUNCTION fail_decide()');
    }
  });

  it('never applies an edit under agent: or id, whoever wrote the proposal row: the agent cannot raise its own limits', async () => {
    const before = readFileSync(yamlPath, 'utf8');
    const step = await file({ kind: 'config', edits: [{ path: ['agent', 'max_step_fraction'], value: 1 }] }, [null]);
    const budgets = await file({ kind: 'config', edits: [{ path: ['agent'], value: { budgets: { weekly: { proposals: 9999 } } } }] }, [null]);
    const rename = await file({ kind: 'config', edits: [{ path: ['id'], value: 'other' }] }, ['mini']);
    for (const p of [step, budgets, rename]) {
      expect(await codeOf(() => approve(p.id))).toBe('path_not_proposable');
      expect((await getProposal(w.db, p.id))!.status).toBe('pending');
    }
    expect(readFileSync(yamlPath, 'utf8')).toBe(before);
  });

  it('refuses a proposal whose filed-against record does not line up with its edits', async () => {
    expect(await codeOf(async () => approve((await file(stalenessEdit, [])).id))).toBe('invalid_proposal');
    expect(await codeOf(async () => approve((await file(stalenessEdit, { value: 0 })).id))).toBe('invalid_proposal');
  });

  it('marks a proposal approved without rewriting when the file already holds every proposed value', async () => {
    // A crash after the rename and before the status write leaves exactly this state.
    const p = await file(stalenessEdit, [7]);
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('staked_supply: { type: level, unit: tokens, staleness_days: 7 }', 'staked_supply: { type: level, unit: tokens, staleness_days: 14 }'));
    const applied = readFileSync(yamlPath, 'utf8');
    expect((await approve(p.id)).proposal.status).toBe('approved');
    expect(readFileSync(yamlPath, 'utf8')).toBe(applied);
  });

  it('leaves no temp file behind, and reports a missing asset file as such', async () => {
    await approve((await file(stalenessEdit, [7])).id);
    expect(existsSync(`${yamlPath}.tmp`)).toBe(false);
    const orphan = await file(stalenessEdit, [7], { assetId: 'ghost' });
    expect(await codeOf(() => approve(orphan.id))).toBe('asset_not_found');
  });
});

describe('rejecting, and deciding twice', () => {
  it('needs a note, keeps it, and makes the decision final', async () => {
    const p = await file({ kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'staleness_days'], value: 14 }] }, [7]);
    expect(await codeOf(() => rejectProposal(w.db, p.id, '  ', NOW))).toBe('note_required');
    expect(await rejectProposal(w.db, p.id, 'wait for the Q3 disclosure', NOW)).toMatchObject({ status: 'rejected', decisionNote: 'wait for the Q3 disclosure' });
    expect(await codeOf(() => approve(p.id))).toBe('proposal_not_pending');
    expect(await codeOf(() => rejectProposal(w.db, p.id, 'again', NOW))).toBe('proposal_not_pending');
    expect(await codeOf(() => approve(999))).toBe('proposal_not_found');
  });
});
