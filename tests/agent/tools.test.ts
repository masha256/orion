import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TOOLS, toApiTools, toolsForRun } from '../../src/agent/tools/index.js';
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { eligibleObservations, valueInForce } from '../../src/app/eligibility.js';
import { TRANSCRIPT_WINDOW } from '../../src/agent/guardrails.js';
import { confirmObservation, insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { insertProposal } from '../../src/db/proposals.js';
import { AGENT_ASSET_YAML, agentWorld, DOC_CITE, PAGE_URL, QUOTE, STAKED_QUOTE, type AgentWorld } from '../helpers/agentWorld.js';
import { sha256 } from '../../src/util/canonical.js';
import { AS_OF } from '../helpers/obs.js';

let w: AgentWorld;
beforeEach(async () => {
  w = await agentWorld();
});

const NINE = [
  'get_observations', 'get_anomalies', 'get_journal', 'get_flow_total', 'resolve_anomaly', 'record_provisional_observation', 'propose_change',
  'write_journal', 'record_dev_finding',
];
const anomaly = async (severity: 'degrading' | 'advisory', dedupeKey = 'x') =>
  await raiseAnomaly(w.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey, severity, detail: {}, seenAt: AS_OF });
/** Reads revenue observations so their ids count as shown, and returns the seeded revenue id. */
const seeRevenue = async (): Promise<number> => {
  await w.call('get_observations', { metric: 'revenue_run_rate_usd' });
  return w.ids.revenue_run_rate_usd;
};
const research = (over: Record<string, unknown> = {}) =>
  w.call('record_provisional_observation', {
    metric: 'revenue_run_rate_usd', value: 1100, observed_at: '2026-06-28', citation_url: PAGE_URL, quoted_text: QUOTE, ...over,
  });
/** A figure for staked supply, which does not allow provisional data: staged as an inert row. */
const researchStaked = (over: Record<string, unknown> = {}) => research({ metric: 'staked_supply', value: 55, citation_url: 'doc:1', quoted_text: STAKED_QUOTE, ...over });

describe('tools', () => {
  it('a disclosure run is offered exactly the nine tools', () => {
    expect(toolsForRun(AGENT_TOOLS, 'disclosure').map((t) => t.name)).toEqual(NINE);
  });

  it('has nine uniquely named tools whose API schemas are plain objects generated from zod', () => {
    const api = toApiTools(AGENT_TOOLS);
    expect(api.map((t) => t.name)).toEqual(NINE);
    for (const t of api) {
      expect(t.input_schema.type).toBe('object');
      expect(t.input_schema).not.toHaveProperty('$schema');
      expect(t.description!.length).toBeGreaterThan(40);
    }
    const propose = api.find((t) => t.name === 'propose_change')!;
    expect(Object.keys(propose.input_schema.properties as object)).not.toContain('scenario');
  });

  it('answers an unknown tool and invalid input as errors the model can read, without throwing', async () => {
    expect(await w.call('delete_everything', {})).toMatchObject({ isError: true, result: { refused: 'unknown_tool' } });
    expect(await w.call('get_observations', { metric: 7 })).toMatchObject({ isError: true, result: { refused: 'invalid_input' } });
    expect(await w.call('get_observations', { metric: 'price_usd', extra: true })).toMatchObject({ isError: true, result: { refused: 'invalid_input' } });
  });

  it('has none of the valuation tools: drivers, assumptions, signal history, what-ifs and assumption changes are unknown', async () => {
    for (const name of ['get_drivers', 'get_assumptions', 'get_signal_history', 'run_whatif', 'apply_assumption_change']) {
      expect(await w.call(name, {})).toMatchObject({ isError: true, result: { refused: 'unknown_tool' } });
    }
  });
});

describe('read tools', () => {
  it('get_observations lists staged rows first, marks the stored ones shown, and refuses an unknown metric', async () => {
    await researchStaked();
    expect(w.ledger.shown.has(w.ids.staked_supply)).toBe(false);
    const { result } = await w.call('get_observations', { metric: 'staked_supply' });
    expect((result.observations as { id: number }[]).map((o) => o.id)).toEqual([-1, w.ids.staked_supply]);
    expect(w.ledger.shown.has(w.ids.staked_supply)).toBe(true);
    expect(await w.call('get_observations', { metric: 'nope' })).toMatchObject({ isError: true, result: { refused: 'unknown_metric' } });
  });
});

describe('resolve_anomaly', () => {
  it('stages a resolution with its evidence', async () => {
    const e = [await seeRevenue()];
    const open = await anomaly('degrading', 'a');
    expect(await w.call('resolve_anomaly', { id: open.id, note: 'sources agree again', evidence: e })).toEqual({ isError: false, result: { staged: true, anomaly_id: open.id } });
    expect([...w.ledger.resolvedAnomalyIds()]).toEqual([open.id]);
  });

  it('leaves the user\'s acknowledgement alone, and refuses one that is already resolved or belongs elsewhere', async () => {
    await seeRevenue();
    const e = [w.ids.revenue_run_rate_usd];
    const acked = await anomaly('degrading', 'a');
    await decideAnomaly(w.db, acked.id, 'acknowledged', 'known lag', AS_OF);
    expect((await w.call('resolve_anomaly', { id: acked.id, note: 'n', evidence: e })).result.refused).toBe('acknowledged_is_read_only');
    const done = await anomaly('degrading', 'b');
    await decideAnomaly(w.db, done.id, 'resolved', 'fixed', AS_OF);
    expect((await w.call('resolve_anomaly', { id: done.id, note: 'n', evidence: e })).result.refused).toBe('anomaly_not_open');
    expect((await w.call('resolve_anomaly', { id: 999, note: 'n', evidence: e })).result.refused).toBe('anomaly_not_found');
    const open = await anomaly('degrading', 'c');
    expect((await w.call('resolve_anomaly', { id: open.id, note: 'n', evidence: [] })).result.refused).toBe('evidence_required');
    expect((await w.call('resolve_anomaly', { id: open.id, note: ' ', evidence: e })).result.refused).toBe('invalid_input');
  });
});

describe('record_provisional_observation (spec section 15, Ruling 18): every figure waits for the user', () => {
  const NON_CRITICAL = AGENT_ASSET_YAML.replace('critical: true, allow_provisional: true', 'critical: false, allow_provisional: true');

  it('a URL citation on a non-critical allow_provisional metric becomes an observation proposal, not a live row', async () => {
    w = await agentWorld(NON_CRITICAL);
    const r = await research({ note: 'from the call' });
    expect(r).toMatchObject({ isError: false, result: { recorded: false } });
    expect(r.result.converted_to_proposal).toBeDefined();
    expect(r.result.reason).toMatch(/disclosure run/);
    expect(r.result.reason).toMatch(/always goes to the user/);
    expect(w.ledger.observations()).toEqual([]);
    const proposals = w.ledger.proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].change).toMatchObject({ kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 1100, citationUrl: PAGE_URL, quotedText: QUOTE });
    expect(proposals[0].rationale).toMatch(/^from the call \(.*disclosure run.*\)$/);
    expect(proposals[0].effect).toBeNull();
  });

  it('a large move on a critical metric is a proposal like any other figure, filed against the confirmed value, with effect null', async () => {
    w.pages.push({ url: 'https://news.example.com/big', text: 'The company now reports annualized revenue of $2,000.' });
    const r = await research({ value: 2000, citation_url: 'https://news.example.com/big', quoted_text: 'reports annualized revenue of $2,000', note: 'Founder interview' });
    expect(r).toMatchObject({ isError: false, result: { recorded: false } });
    expect(w.ledger.observations()).toEqual([]);
    const p = w.ledger.proposals()[0];
    expect(p.change).toMatchObject({ kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-28T00:00:00.000Z' });
    expect(p.filedAgainst).toEqual({ inForce: 1000 });
    expect(p.rationale).toBe('Founder interview (this is a disclosure run: a figure from a disclosure run always goes to the user)');
    expect(p.effect).toBeNull();
  });

  it('files an observation proposal against the last CONFIRMED value, the baseline approve checks it against', async () => {
    // An earlier run's figure is provisional: 1250. The confirmed value is still 1000.
    await insertObservation(w.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-20', value: 1250, source: 'manual', status: 'provisional',
      citationUrl: 'https://news.example.com/earlier', fetchedAt: AS_OF,
    });
    expect(await research()).toMatchObject({ isError: false, result: { recorded: false } });
    expect(w.ledger.proposals()[0].filedAgainst).toEqual({ inForce: 1000 });
  });

  it('a citation on a metric that does not allow provisional data stages an inert row', async () => {
    const r = await research({ metric: 'staked_supply', value: 55 });
    expect(r).toMatchObject({ isError: false, result: { recorded: true } });
    expect(Object.keys(r.result as object)).not.toContain('in_signal');
    expect(r.result.note).toMatch(/^provisional; it comes from a disclosure run, so it is not read as the value in force; it is listed in the inbox/);
    expect(w.ledger.observations()).toEqual([expect.objectContaining({ citationUrl: PAGE_URL, live: false })]);
    expect(w.ledger.proposals()).toEqual([]);
  });

  it('refuses to write where an observation already exists, and names it: the agent never supersedes one', async () => {
    const r = await research({ observed_at: '2026-06-15' }); // the seeded revenue observation is dated 2026-06-15
    expect(r).toMatchObject({ isError: true, result: { refused: 'observation_exists', observation_id: w.ids.revenue_run_rate_usd } });
    expect(w.ledger.observations()).toEqual([]);
    expect(w.ledger.proposals()).toEqual([]);
  });

  describe('citing a machine transcript', () => {
    const TEXT =
      '[00:01] Our annualized revenue reached $1,100 in September,\n[00:04] up from a thousand.\n' +
      '[00:09] Staked supply now stands at 55 tokens across the network.\n';
    const REVENUE_QUOTE = 'annualized revenue reached $1,100 in September, up from a thousand';
    const withTranscript = async (yaml?: string) => {
      w = await agentWorld(yaml);
      const doc = { id: 1, kind: 'machine_transcript' as const, sha256: 'c'.repeat(64), text: TEXT };
      w.ctx.citableDocs = () => [doc];
      w.ctx.targetDoc = doc;
    };
    /** Commits the run and returns the eligible rows that cite a document. */
    const eligibleFromDocs = async () => {
      await w.ledger.commit(w.db, { agentRunId: null, now: new Date(AS_OF) });
      return (await eligibleObservations(w.db, w.loaded.config, AS_OF)).filter((o) => o.citationUrl?.startsWith('doc:'));
    };

    it.each([
      ['not critical', AGENT_ASSET_YAML.replace('critical: true, allow_provisional: true', 'critical: false, allow_provisional: true')],
      ['critical, a small move', AGENT_ASSET_YAML],
    ])('on an allow_provisional metric (%s), goes to the user as an observation proposal and is never in force unconfirmed', async (_label, yaml) => {
      await withTranscript(yaml);
      expect((await research({ citation_url: 'doc:2', quoted_text: REVENUE_QUOTE })).result.refused).toBe('doc_not_in_run');
      const r = await research({ citation_url: 'doc:1', quoted_text: REVENUE_QUOTE, note: 'Q3 call' });
      expect(r).toMatchObject({ isError: false, result: { recorded: false } });
      expect(r.result.converted_to_proposal).toBeDefined();
      expect(r.result.reason).toMatch(/machine transcript/);
      expect(w.ledger.observations()).toEqual([]);
      const proposals = w.ledger.proposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0].change).toMatchObject({
        kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 1100, observedAt: '2026-06-28T00:00:00.000Z', citationUrl: 'doc:1', quotedText: REVENUE_QUOTE,
      });
      expect(proposals[0].rationale).toMatch(/^Q3 call \(.*machine transcript.*\)$/);
      expect(await eligibleFromDocs()).toEqual([]);
    });

    it('on a metric that does not allow provisional data, stages an inert row that stays out of the value in force after commit', async () => {
      await withTranscript();
      const r = await researchStaked();
      expect(r).toMatchObject({ isError: false, result: { recorded: true } });
      expect(r.result.note).toMatch(/^provisional; it cites a machine transcript, so it is not read as the value in force; it is listed in the inbox/);
      expect(w.ledger.observations()).toEqual([expect.objectContaining({ citationUrl: 'doc:1', quotedText: STAKED_QUOTE, live: false })]);
      expect(w.ledger.proposals()).toEqual([]);
      expect(await eligibleFromDocs()).toEqual([]);
      // It is stored, as a provisional row, for the user to confirm.
      expect((await listActiveObservations(w.db, 'mini', 'staked_supply')).filter((o) => o.citationUrl === 'doc:1').map((o) => o.status)).toEqual(['provisional']);
    });

    it('refuses a non-canonical doc id', async () => {
      await withTranscript();
      expect((await research({ citation_url: 'doc:01', quoted_text: REVENUE_QUOTE })).result.refused).toBe('doc_not_in_run');
      expect(w.ledger.proposals()).toEqual([]);
    });
  });

  it('describes the transcript window with TRANSCRIPT_WINDOW', () => {
    const tool = toApiTools(AGENT_TOOLS).find((t) => t.name === 'record_provisional_observation')!;
    expect(tool.description).toContain(`within ${TRANSCRIPT_WINDOW} consecutive segments`);
  });

  it('verifies the citation against the pages fetched in this run and the target document', async () => {
    expect((await research({ citation_url: 'https://elsewhere.example.com/' })).result.refused).toBe('citation_not_fetched');
    expect((await research({ quoted_text: 'annualized revenue reached $9,999 in September' })).result.refused).toBe('quote_not_found');
    expect((await research({ quoted_text: '$1,100' })).result.refused).toBe('quote_too_short');
    expect((await research({ citation_url: 'doc:1', quoted_text: 'annualized revenue reached $9,999 in September' })).result.refused).toBe('quote_not_found');
    expect(w.ledger.observations()).toEqual([]);
    expect(w.ledger.proposals()).toEqual([]);
  });

  it('never writes onto a fetched level, dates only schedules and events in the future, and needs a period for a flow', async () => {
    expect((await research({ metric: 'price_usd', value: 11 })).result.refused).toBe('fetched_metric');
    expect((await research({ metric: 'price_usd', value: 11, observed_at: '2026-08-01' })).result.refused).toBe('fetched_metric'); // a future date opens nothing on a level
    expect((await research({ metric: 'nope' })).result.refused).toBe('unknown_metric');
    expect((await research({ observed_at: '2026-08-01' })).result.refused).toBe('future_observation');
    expect((await research({ observed_at: 'soon' })).result.refused).toBe('invalid_timestamp');
    expect((await research({ metric: 'flow_usd.fees', value: 30 })).result.refused).toBe('period_required');
    expect(await research({ metric: 'emission_rate_annual', value: 5, observed_at: '2026-10-01' })).toMatchObject({ isError: false, result: { recorded: true } });
  });

  it('takes an announced change on a FETCHED schedule only when it is dated after now, and the confirmed row governs from its date until the chain catches up', async () => {
    // The fetch owns the present: emission_rate_annual is read from the chain here, as VVV's is.
    const fw = await agentWorld(
      AGENT_ASSET_YAML.replace(
        'emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }',
        'emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400, source: { type: adapter, name: test.emission } }',
      ),
    );
    const announce = (over: Record<string, unknown>) =>
      fw.call('record_provisional_observation', { metric: 'emission_rate_annual', value: 5, observed_at: '2026-10-01', citation_url: PAGE_URL, quoted_text: QUOTE, ...over });
    expect((await announce({ observed_at: AS_OF })).result.refused).toBe('fetched_metric'); // at now: a reading, not an announcement
    expect((await announce({ observed_at: '2026-06-01' })).result.refused).toBe('fetched_metric');
    expect(await announce({})).toMatchObject({ isError: false, result: { recorded: true } });
    expect(fw.ledger.observations()[0]).toMatchObject({ metricKey: 'emission_rate_annual', value: 5, observedAt: '2026-10-01T00:00:00.000Z', live: false });

    // What the row does once the user confirms it, with the daily on-chain reads landing beneath it.
    const asset = fw.loaded.config;
    const onchain = async (observedAt: string, value: number) =>
      await insertObservation(fw.db, { assetId: 'mini', metricKey: 'emission_rate_annual', observedAt, value, source: 'onchain', fetchedAt: observedAt });
    await onchain('2026-06-29T00:00:00Z', 10); // the seeded step is 0 at 2026-01-01; this is the chain's rate in force
    const row = await insertObservation(fw.db, {
      assetId: 'mini', metricKey: 'emission_rate_annual', observedAt: '2026-10-01', value: 5, source: 'manual', status: 'provisional', citationUrl: PAGE_URL, fetchedAt: AS_OF,
    });
    expect(await valueInForce(fw.db, asset, 'emission_rate_annual', '2026-10-01T00:00:00Z')).toBe(10); // provisional: inert
    await confirmObservation(fw.db, row.id, AS_OF);
    expect(await valueInForce(fw.db, asset, 'emission_rate_annual', '2026-09-30T23:59:59Z')).toBe(10);
    expect(await valueInForce(fw.db, asset, 'emission_rate_annual', '2026-10-01T00:00:00Z')).toBe(5); // the announced step, from its effective date
    await onchain('2026-10-01T00:05:00Z', 5.5); // the chain's first read after the date is newer and governs
    expect(await valueInForce(fw.db, asset, 'emission_rate_annual', '2026-10-02T00:00:00Z')).toBe(5.5);
  });
});

describe('propose_change', () => {
  /** Every proposal in a disclosure run cites the target document; the default citation does. */
  const propose = (input: Record<string, unknown>) => w.call('propose_change', { rationale: 'because', citations: [DOC_CITE], ...input });

  it('propose_change: a config proposal stores effect null', async () => {
    const r = await propose({ kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'tolerance_pct'], value: 2 }] });
    expect(r.isError).toBe(false);
    expect(r.result).not.toHaveProperty('effect');
    const p = w.ledger.proposals()[0];
    expect(p.filedAgainst).toEqual([null]); // the YAML leaves tolerance_pct to its default
    expect(p.effect).toBeNull();
    const { proposalIds } = await w.ledger.commit(w.db, { agentRunId: null, now: new Date(AS_OF) });
    expect((w.db.prepare('SELECT effect_json FROM proposals WHERE id = ?').get(proposalIds[0]) as { effect_json: string | null }).effect_json).toBeNull();
  });

  it('propose_change: kind assumption_value is invalid input', async () => {
    const e = [await seeRevenue()];
    const r = await propose({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 3, evidence: e });
    expect(r).toMatchObject({ isError: true, result: { refused: 'invalid_input' } });
    expect((await propose({ kind: 'assumption_value' })).result.refused).toBe('invalid_input');
    expect(w.ledger.proposals()).toEqual([]);
  });

  it('validates a config proposal as a whole config, and refuses one that changes nothing or points nowhere', async () => {
    expect((await propose({ kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'tolerance_pct'], value: -1 }] })).result.refused).toBe('invalid_asset_config');
    expect((await propose({ kind: 'config', edits: [{ path: ['symbol'], value: 'MINI' }] })).result.refused).toBe('no_change');
    expect((await propose({ kind: 'config', edits: [{ path: ['holder_flows', 'nope', 'window_days'], value: 1 }] })).result.refused).toBe('invalid_path');
    expect((await propose({ kind: 'config' })).result.refused).toBe('invalid_input');
    expect(w.ledger.proposals()).toEqual([]);
  });

  it('propose_change: a config edit that puts back a removed valuation key is refused at filing', async () => {
    // Review Focus 4: the edited config must still parse, and the schema refuses every removed key by name.
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
      const r = await propose({ kind: 'config', edits: [{ path: [key], value }] });
      expect(r, key).toMatchObject({ isError: true, result: { refused: 'invalid_asset_config' } });
      expect(JSON.stringify(r.result), key).toContain(`Unrecognized key: \\"${key}\\"`);
    }
    // A path below a removed key has no parent: refused as a bad path.
    expect((await propose({ kind: 'config', edits: [{ path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 1 } }] })).result.refused).toBe('invalid_path');
    expect(w.ledger.proposals()).toEqual([]);
  });

  it('cannot reach its own limits or the asset id', async () => {
    expect((await propose({ kind: 'config', edits: [{ path: ['agent', 'max_step_fraction'], value: 1 }] })).result.refused).toBe('path_not_proposable');
    expect((await propose({ kind: 'config', edits: [{ path: ['agent'], value: { max_step_fraction: 1 } }] })).result.refused).toBe('path_not_proposable');
    expect((await propose({ kind: 'config', edits: [{ path: ['id'], value: 'other' }] })).result.refused).toBe('path_not_proposable');
  });

  it('proposes acknowledging an open anomaly and withdrawing an acknowledgement, each against the right status', async () => {
    const open = await anomaly('degrading', 'a');
    expect((await propose({ kind: 'withdraw_acknowledgement', anomaly_id: open.id })).result.refused).toBe('wrong_anomaly_status');
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id })).isError).toBe(false);
    expect(w.ledger.proposals()[0]).toMatchObject({ change: { kind: 'acknowledge_anomaly', anomalyId: open.id, note: 'because' }, filedAgainst: { status: 'open' }, effect: null });
    await decideAnomaly(w.db, open.id, 'acknowledged', 'ok', AS_OF);
    expect((await propose({ kind: 'withdraw_acknowledgement', anomaly_id: open.id })).isError).toBe(false);
    expect((await propose({ kind: 'acknowledge_anomaly' })).result.refused).toBe('invalid_input');
  });

  it('files confirming and rejecting an observation, with effect null', async () => {
    const provisional = await insertObservation(w.db, {
      assetId: 'mini', metricKey: 'staked_supply', observedAt: '2026-06-29T12:00:00Z', value: 80, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    expect((await propose({ kind: 'confirm_observation', observation_id: provisional.id })).isError).toBe(false);
    expect((await propose({ kind: 'confirm_observation', observation_id: w.ids.price_usd })).result.refused).toBe('not_provisional');
    expect((await propose({ kind: 'reject_observation', observation_id: w.ids.revenue_run_rate_usd })).isError).toBe(false);
    expect(w.ledger.proposals().map((p) => [p.change.kind, p.filedAgainst, p.effect])).toEqual([
      ['confirm_observation', { status: 'provisional', active: true }, null],
      ['reject_observation', { status: 'confirmed', active: true }, null],
    ]);
    expect((await propose({ kind: 'reject_observation', observation_id: 999 })).result.refused).toBe('observation_not_found');
  });

  it('checks evidence when it is given', async () => {
    const open = await anomaly('degrading', 'a');
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id, evidence: [w.ids.revenue_run_rate_usd] })).result.refused).toBe('evidence_not_shown');
    await seeRevenue();
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id, evidence: [w.ids.revenue_run_rate_usd] })).isError).toBe(false);
  });

  it('refuses a duplicate of a pending or a staged proposal, and stops at the run\'s proposal budget', async () => {
    const open = await anomaly('degrading', 'a');
    insertProposal(w.db, {
      assetId: 'mini', persona: 'analyst', agentRunId: null, change: { kind: 'acknowledge_anomaly', anomalyId: open.id, note: 'because' },
      filedAgainst: { status: 'open' }, rationale: 'because', evidence: [], effect: null, createdAt: AS_OF,
    });
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id })).result.refused).toBe('duplicate_proposal');
    const other = await anomaly('advisory', 'b');
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id })).isError).toBe(false);
    expect(await propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id })).toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', staged_in_this_run: true } });

    w.ctx.budgets = { ...w.ctx.budgets, proposals: 1 };
    const third = await anomaly('advisory', 'c');
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: third.id })).result.refused).toBe('proposal_budget');
  });

  it('sees through wording: the same decision re-filed in other words is the same proposal', async () => {
    const open = await anomaly('degrading', 'a');
    insertProposal(w.db, {
      assetId: 'mini', persona: 'analyst', agentRunId: null, change: { kind: 'acknowledge_anomaly', anomalyId: open.id, note: 'the API lags by design' },
      filedAgainst: { status: 'open' }, rationale: 'the API lags by design', evidence: [], effect: null, createdAt: AS_OF,
    });
    expect(await propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id, rationale: 'this source is known to report late' }))
      .toMatchObject({ isError: true, result: { refused: 'duplicate_proposal' } });

    // And the same again for one staged earlier in this run.
    const other = await anomaly('advisory', 'b');
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id, rationale: 'first wording' })).isError).toBe(false);
    expect(await propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id, rationale: 'quite different wording' }))
      .toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', staged_in_this_run: true } });

    // A different anomaly is a different proposal, however similar the words.
    const third = await anomaly('advisory', 'c');
    expect((await propose({ kind: 'acknowledge_anomaly', anomaly_id: third.id, rationale: 'first wording' })).isError).toBe(false);
  });

  describe('citations', () => {
    const DOC_TEXT = '[12:30] Thanks for joining the call.\n[12:33] We are moving the base scenario weight to one half,\n[12:37] because the fee switch is now live.\n';
    const DOC_QUOTE = 'moving the base scenario weight to one half, because the fee switch is now live';
    const DOC = { id: 1, kind: 'transcript' as const, sha256: 'd'.repeat(64), text: DOC_TEXT };
    const ON_DOC = { source: 'doc:1', quoted_text: DOC_QUOTE };
    const toleranceEdit = (pct: number) => ({
      kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'tolerance_pct'], value: pct }],
    });
    const withDoc = () => {
      w.ctx.citableDocs = () => [DOC];
      w.ctx.targetDoc = DOC;
    };
    const storedCitations = async (): Promise<unknown> => {
      await w.ledger.commit(w.db, { agentRunId: null, now: new Date(AS_OF) });
      const row = w.db.prepare('SELECT citations_json FROM proposals ORDER BY id DESC LIMIT 1').get() as { citations_json: string | null };
      return row.citations_json === null ? null : JSON.parse(row.citations_json);
    };

    it('propose_change verifies each citation and stores it', async () => {
      withDoc();
      const r = await propose({ ...toleranceEdit(2), citations: [ON_DOC, { source: PAGE_URL, quoted_text: QUOTE }] });
      expect(r.isError).toBe(false);
      const expected = [
        { source: 'doc:1', quotedText: DOC_QUOTE, locator: '12:33', docSha256: 'd'.repeat(64), docKind: 'transcript' },
        { source: PAGE_URL, quotedText: QUOTE, locator: null, docSha256: null, docKind: null },
      ];
      expect(w.ledger.proposals()[0].citations).toEqual(expected);
      expect(await storedCitations()).toEqual(expected);
    });

    it('a citation given twice (the same source and quote, after cleaning) is stored once, in first-given order', async () => {
      withDoc();
      const r = await propose({
        ...toleranceEdit(2),
        citations: [
          { source: PAGE_URL, quoted_text: QUOTE },
          ON_DOC,
          { source: PAGE_URL, quoted_text: QUOTE },
          { source: 'doc:1', quoted_text: `  ${DOC_QUOTE}  ` },
        ],
      });
      expect(r.isError).toBe(false);
      expect(w.ledger.proposals()[0].citations.map((c) => [c.source, c.quotedText])).toEqual([[PAGE_URL, QUOTE], ['doc:1', DOC_QUOTE]]);
    });

    it('a bad citation refuses the whole proposal', async () => {
      withDoc();
      const bad = await propose({ ...toleranceEdit(2), citations: [ON_DOC, { source: 'doc:1', quoted_text: 'the fee switch was never discussed at all' }] });
      expect(bad).toMatchObject({ isError: true, result: { refused: 'quote_not_found' } });
      expect((await propose({ ...toleranceEdit(2), citations: [{ source: 'doc:2', quoted_text: DOC_QUOTE }] })).result.refused).toBe('doc_not_in_run');
      expect(w.ledger.proposals()).toEqual([]);
      // At most five.
      const six = Array.from({ length: 6 }, () => ON_DOC);
      expect((await propose({ ...toleranceEdit(2), citations: six })).result.refused).toBe('invalid_input');
      expect(w.ledger.proposals()).toEqual([]);
    });

    it('refuses a proposal without a citation of the target doc', async () => {
      withDoc();
      expect(await w.call('propose_change', { rationale: 'because', ...toleranceEdit(2) })).toMatchObject({ isError: true, result: { refused: 'citation_required' } });
      expect((await propose({ ...toleranceEdit(2), citations: [] })).result.refused).toBe('citation_required');
      expect((await propose({ ...toleranceEdit(2), citations: [{ source: PAGE_URL, quoted_text: QUOTE }] })).result.refused).toBe('citation_required');
      expect(w.ledger.proposals()).toEqual([]);
      expect((await propose({ ...toleranceEdit(2), citations: [{ source: PAGE_URL, quoted_text: QUOTE }, ON_DOC] })).isError).toBe(false);
      expect(w.ledger.proposals()[0].citations.map((c) => c.source)).toEqual([PAGE_URL, 'doc:1']);
    });

    it('citations do not change duplicate detection', async () => {
      withDoc();
      expect((await propose({ ...toleranceEdit(2), citations: [ON_DOC] })).isError).toBe(false);
      expect(await propose({ ...toleranceEdit(2), citations: [{ source: PAGE_URL, quoted_text: QUOTE }, ON_DOC] }))
        .toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', staged_in_this_run: true } });
      await w.ledger.commit(w.db, { agentRunId: null, now: new Date(AS_OF) });
      expect(await propose({ ...toleranceEdit(2), citations: [ON_DOC] })).toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', proposal_id: expect.any(Number) } });
    });

    it('a machine-transcript observation proposal carries the verified citation it came from', async () => {
      const text = '[00:01] Our annualized revenue reached $1,100 in September,\n[00:04] up from a thousand.\n';
      w.ctx.citableDocs = () => [{ id: 1, kind: 'machine_transcript', sha256: 'c'.repeat(64), text }];
      const quote = 'annualized revenue reached $1,100 in September, up from a thousand';
      expect((await research({ citation_url: 'doc:1', quoted_text: quote })).result.recorded).toBe(false);
      expect(w.ledger.proposals()[0].citations).toEqual([
        { source: 'doc:1', quotedText: quote, locator: '00:01', docSha256: 'c'.repeat(64), docKind: 'machine_transcript' },
      ]);
    });
  });
});

describe('model-authored text', () => {
  it('is stripped of control characters before it is staged, with newlines kept', async () => {
    const open = await anomaly('advisory');
    await w.call('propose_change', { kind: 'acknowledge_anomaly', anomaly_id: open.id, rationale: ' lags\u0007 by design\nand steady ', citations: [DOC_CITE] });
    expect(w.ledger.proposals()[0].rationale).toBe('lags by design\nand steady');
    await w.call('write_journal', { thesis: 'steady\u0007', open_questions: ['what\u0000 next?', ' \u0007 '], summary: 'review\u001Bed' });
    expect(w.ledger.journal()).toEqual({ thesis: 'steady', openQuestions: ['what next?'], summary: 'reviewed', catalysts: [] });
  });

  it('is cleaned before the citation is verified, so a stray control character in a quote costs nothing', async () => {
    const r = await research({ metric: 'staked_supply', value: 55, quoted_text: 'annualized revenue reached \u0000$1,100 in September' });
    expect(r).toMatchObject({ isError: false, result: { recorded: true } });
    expect(w.ledger.observations()[0].quotedText).toBe(QUOTE); // the CLEANED quote is what is stored
  });

  it('is refused as ordinary invalid input when it is too long, so the model can shorten it and retry', async () => {
    await seeRevenue();
    const e = [w.ids.revenue_run_rate_usd];
    const resolve = async (note: string) => w.call('resolve_anomaly', { id: (await anomaly('advisory')).id, note, evidence: e });
    expect((await resolve('n'.repeat(2001))).result.refused).toBe('invalid_input');
    expect((await resolve('n'.repeat(2000))).isError).toBe(false);
    expect((await research({ quoted_text: QUOTE + 'x'.repeat(601) })).result.refused).toBe('invalid_input');
    expect((await research({ citation_url: `https://x.example.com/${'a'.repeat(2000)}` })).result.refused).toBe('invalid_input');
    expect((await research({ note: 'n'.repeat(2001) })).result.refused).toBe('invalid_input');
    expect((await w.call('propose_change', { kind: 'acknowledge_anomaly', anomaly_id: 1, rationale: 'r'.repeat(2001) })).result.refused).toBe('invalid_input');
    const journal = (over: Record<string, unknown>) => w.call('write_journal', { thesis: 't', open_questions: [], summary: 's', ...over });
    expect((await journal({ thesis: 't'.repeat(4001) })).result.refused).toBe('invalid_input');
    expect((await journal({ summary: 's'.repeat(4001) })).result.refused).toBe('invalid_input');
    expect((await journal({ open_questions: ['q'.repeat(501)] })).result.refused).toBe('invalid_input');
    expect((await journal({ open_questions: Array.from({ length: 21 }, () => 'q') })).result.refused).toBe('invalid_input');
    expect((await journal({ open_questions: Array.from({ length: 20 }, () => 'q') })).isError).toBe(false);
  });
});

describe('write_journal', () => {
  it('stages one entry, replaces it on a second call, and refuses blanks', async () => {
    expect((await w.call('write_journal', { thesis: ' ', open_questions: [], summary: 's' })).result.refused).toBe('invalid_input');
    await w.call('write_journal', { thesis: 'first', open_questions: ['q', ' '], summary: 's' });
    await w.call('write_journal', { thesis: 'second', open_questions: ['q', ' '], summary: 's' });
    expect(w.ledger.journal()).toEqual({ thesis: 'second', openQuestions: ['q'], summary: 's', catalysts: [] });
  });

  describe('catalysts', () => {
    const DOC_TEXT = '[00:01] Thanks for joining.\n[00:04] The exchange license should be granted by the end of September.\n';
    const DOC_QUOTE = 'The exchange license should be granted by the end of September';
    const DOC = { id: 1, kind: 'transcript' as const, sha256: 'e'.repeat(64), text: DOC_TEXT };
    const catalyst = (over: Record<string, unknown> = {}) => ({
      event: 'exchange license granted', kind: 'regulatory', by: '2026-09-30', citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }], ...over,
    });
    const journal = (catalysts: unknown[]) => w.call('write_journal', { thesis: 't', open_questions: [], summary: 's', catalysts });
    beforeEach(() => {
      w.ctx.citableDocs = () => [DOC];
      w.ctx.targetDoc = DOC;
    });

    it('write_journal stages catalysts with verified citations; commit stores them', async () => {
      const r = await journal([
        catalyst({ event: ' exchange license\u0007 granted ' }),
        {
          event: 'revenue milestone', kind: 'product', from: '2026-07-01', to: '2026-09-30',
          citations: [{ source: PAGE_URL, quoted_text: QUOTE }, { source: 'doc:1', quoted_text: DOC_QUOTE }],
        },
      ]);
      expect(r.isError).toBe(false);
      const onDoc = { source: 'doc:1', quotedText: DOC_QUOTE, locator: '00:04', docSha256: 'e'.repeat(64), docKind: 'transcript' };
      const expected = [
        { event: 'exchange license granted', kind: 'regulatory', by: '2026-09-30', citations: [onDoc] },
        {
          event: 'revenue milestone', kind: 'product', from: '2026-07-01', to: '2026-09-30',
          citations: [{ source: PAGE_URL, quotedText: QUOTE, locator: null, docSha256: null, docKind: null }, onDoc],
        },
      ];
      expect(w.ledger.journal()!.catalysts).toEqual(expected);
      const { journalId } = await w.ledger.commit(w.db, { agentRunId: null, now: new Date(AS_OF) });
      const row = w.db.prepare('SELECT catalysts_json FROM journal WHERE id = ?').get(journalId) as { catalysts_json: string };
      expect(JSON.parse(row.catalysts_json)).toEqual(expected);
      expect(((await w.call('get_journal', {})).result.entries as { catalysts: unknown }[])[0].catalysts).toEqual(expected);
    });

    it('refuses by together with from/to, from after to, a bad date, a 9th catalyst, an unverified quote', async () => {
      const refused = async (c: Record<string, unknown>) => (await journal([catalyst(c)])).result.refused;
      expect(await refused({ from: '2026-07-01', to: '2026-09-30' })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: undefined })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: undefined, from: '2026-07-01' })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: undefined, to: '2026-07-01' })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: undefined, from: '2026-10-01', to: '2026-09-30' })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: '2026-02-30' })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: '2026-9-30' })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: '2026-09-30T00:00:00Z' })).toBe('invalid_catalyst_dates');
      expect(await refused({ by: 'end of Q3' })).toBe('invalid_catalyst_dates');
      expect((await journal([catalyst({ by: undefined, from: '2026-09-30', to: '2026-09-30' })])).isError).toBe(false);
      expect(await refused({ kind: 'rumor' })).toBe('invalid_input');
      expect(await refused({ event: 'e'.repeat(201) })).toBe('invalid_input');
      expect(await refused({ event: ' \u0007 ' })).toBe('invalid_input');
      expect(await refused({ citations: [] })).toBe('invalid_input');
      expect(await refused({ citations: Array.from({ length: 4 }, () => ({ source: 'doc:1', quoted_text: DOC_QUOTE })) })).toBe('invalid_input');
      expect((await journal(Array.from({ length: 9 }, () => catalyst()))).result.refused).toBe('invalid_input');
      expect(await refused({ citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }, { source: 'doc:1', quoted_text: 'the license was denied outright by the regulator' }] })).toBe('quote_not_found');
      expect(await refused({ citations: [{ source: 'doc:2', quoted_text: DOC_QUOTE }] })).toBe('doc_not_in_run');
      // A refused call leaves the earlier staged entry in place.
      expect(w.ledger.journal()!.catalysts).toHaveLength(1);
      expect((await journal(Array.from({ length: 8 }, () => catalyst()))).isError).toBe(false);
      expect(w.ledger.journal()!.catalysts).toHaveLength(8);
    });

    it('each catalyst must cite the target doc: a URL alone refuses citation_required, naming the event', async () => {
      const r = await journal([catalyst(), catalyst({ event: 'revenue milestone', citations: [{ source: PAGE_URL, quoted_text: QUOTE }] })]);
      expect(r.result.refused).toBe('citation_required');
      expect(r.result.message).toContain('catalyst "revenue milestone"');
      expect(r.result.message).toContain('doc:1');
      expect(w.ledger.journal()).toBeNull();
    });

    it('a catalyst citing the target doc stages, alongside a URL citation', async () => {
      const r = await journal([catalyst({ citations: [{ source: PAGE_URL, quoted_text: QUOTE }, { source: 'doc:1', quoted_text: DOC_QUOTE }] })]);
      expect(r.isError).toBe(false);
      expect(r.result).toEqual({ staged: true });
      expect(w.ledger.journal()!.catalysts.map((c) => c.citations.map((x) => x.source))).toEqual([[PAGE_URL, 'doc:1']]);
    });

    it('checks the dates before the citations: a bad date refuses invalid_catalyst_dates even when a quote fails too', async () => {
      const badBoth = catalyst({ by: 'end of Q3', citations: [{ source: PAGE_URL, quoted_text: 'a sentence the page never said at all' }] });
      expect((await journal([badBoth])).result.refused).toBe('invalid_catalyst_dates');
      // A bad date with a verified URL-only citation: the date is named first, not citation_required.
      expect((await journal([catalyst({ by: '2026-02-30', citations: [{ source: PAGE_URL, quoted_text: QUOTE }] })])).result.refused).toBe('invalid_catalyst_dates');
      expect(w.ledger.journal()).toBeNull();
    });

    it('a catalyst citation that fails verification names the catalyst in the refusal', async () => {
      const r = await journal([catalyst({ event: 'mainnet launch', citations: [{ source: PAGE_URL, quoted_text: 'a sentence the page never said at all' }] })]);
      expect(r.result.refused).toBe('quote_not_found');
      expect(r.result.message).toMatch(/^catalyst "mainnet launch": /);
    });

    it('a journal without catalysts stores NULL', async () => {
      await journal([]);
      const { journalId } = await w.ledger.commit(w.db, { agentRunId: null, now: new Date(AS_OF) });
      expect((w.db.prepare('SELECT catalysts_json FROM journal WHERE id = ?').get(journalId) as { catalysts_json: string | null }).catalysts_json).toBeNull();
    });
  });
});

describe('get_flow_total', () => {
  const FEES = 'flow_usd.fees';
  const DAY = 86_400_000;
  const Q3_START = Date.parse('2026-07-01T00:00:00Z');
  const dayOf = (i: number): string => new Date(Q3_START + i * DAY).toISOString().slice(0, 10);
  /** One daily row per Q3 day (92), observed at the end of its day, valued i + 1; `skip` leaves days out. */
  const seedQ3 = async (skip: string[] = []): Promise<number[]> => {
    const ids: number[] = [];
    for (let i = 0; i < 92; i++) {
      if (skip.includes(dayOf(i))) continue;
      ids.push((await insertObservation(w.db, {
        assetId: 'mini', metricKey: FEES, observedAt: new Date(Q3_START + (i + 1) * DAY).toISOString(), periodDays: 1, value: i + 1, source: 'onchain', fetchedAt: AS_OF,
      })).id);
    }
    return ids;
  };
  const total = (over: Record<string, unknown> = {}) => w.call('get_flow_total', { metric: FEES, from: '2026-07-01', to: '2026-09-30', ...over });

  it('get_flow_total sums Q3 daily rows, reports missing days, and marks them shown', async () => {
    const ids = await seedQ3();
    const { isError, result } = await total();
    expect(isError).toBe(false);
    expect(result).toEqual({
      metric: FEES, from: '2026-07-01', to: '2026-09-30', total: (92 * 93) / 2, unit: 'usd', days_covered: 92, days_missing: [], rows: 92,
      first_id: Math.min(...ids), last_id: Math.max(...ids),
    });
    for (const id of ids) expect(w.ledger.shown.has(id)).toBe(true);
    // The seeded 90-day row ends at 2026-06-30 and lies wholly before the range: not summed, not shown.
    expect(w.ledger.shown.has(w.ids[FEES])).toBe(false);
    // A sub-range counts whole days only.
    expect((await total({ from: '2026-07-01', to: '2026-07-03' })).result).toMatchObject({ total: 1 + 2 + 3, days_covered: 3, rows: 3 });
  });

  it('reports a dropped day as missing, and a row staged in this run does not fill it', async () => {
    await seedQ3(['2026-08-15']); // day index 45, value 46
    expect((await total()).result).toMatchObject({ total: (92 * 93) / 2 - 46, days_covered: 91, days_missing: ['2026-08-15'], rows: 91 });
    const staged = w.ledger.stageObservation({
      metricKey: FEES, value: 46, observedAt: '2026-08-16T00:00:00Z', periodDays: 1, citationUrl: PAGE_URL, quotedText: QUOTE, live: true,
    });
    // Staged rows are this run's own figures, not Orion's measurement: the day stays missing and the row is not summed.
    expect((await total()).result).toMatchObject({ total: (92 * 93) / 2 - 46, days_covered: 91, days_missing: ['2026-08-15'], rows: 91 });
    expect(w.ledger.shown.has(staged.tempId)).toBe(true); // shown because it was staged, not because it was summed
  });

  it('ignores a 92-day provisional row staged on top of the 92 daily rows: the total is the daily sum', async () => {
    const ids = await seedQ3();
    w.ledger.stageObservation({
      metricKey: FEES, value: 99_999, observedAt: '2026-10-01T00:00:00Z', periodDays: 92, citationUrl: PAGE_URL, quotedText: QUOTE, live: true,
    });
    expect(await total()).toMatchObject({
      isError: false,
      result: { total: (92 * 93) / 2, days_covered: 92, days_missing: [], rows: 92, first_id: Math.min(...ids), last_id: Math.max(...ids) },
    });
  });

  it('ignores a committed provisional row: only confirmed rows are summed', async () => {
    await seedQ3(['2026-08-15']);
    const provisional = await insertObservation(w.db, {
      assetId: 'mini', metricKey: FEES, observedAt: '2026-08-16T00:00:00Z', periodDays: 1, value: 46, source: 'manual', fetchedAt: AS_OF,
      status: 'provisional', citationUrl: PAGE_URL, quotedText: QUOTE,
    });
    expect((await total()).result).toMatchObject({ total: (92 * 93) / 2 - 46, days_covered: 91, days_missing: ['2026-08-15'], rows: 91 });
    expect(w.ledger.shown.has(provisional.id)).toBe(false);
  });

  it('refuses flow_conflict, with the ids and the days, when two confirmed rows cover the same day', async () => {
    const ids = await seedQ3();
    // A confirmed two-day manual row for 2026-07-01 and 2026-07-02.
    const manual = await insertObservation(w.db, {
      assetId: 'mini', metricKey: FEES, observedAt: '2026-07-03T00:00:00Z', periodDays: 2, value: 7, source: 'manual', fetchedAt: AS_OF,
    });
    // It shares observed_at with the daily row for 2026-07-02, which insertObservation supersedes, so it overlaps 07-01's row only.
    expect((await listActiveObservations(w.db, 'mini', FEES)).some((o) => o.id === ids[1])).toBe(false);
    const { isError, result } = await total();
    expect(isError).toBe(true);
    expect(result).toMatchObject({ refused: 'flow_conflict', ids: [ids[0], manual.id], days: ['2026-07-01'] });
    expect(result).not.toHaveProperty('total');
    expect(w.ledger.shown.size).toBe(0);
  });

  it('leaves out superseded and rejected rows, and a row that straddles the edge of the range', async () => {
    await seedQ3(['2026-07-01']); // the straddling row below is the only row on 2026-07-01, so it overlaps nothing
    const rejected = await insertObservation(w.db, {
      assetId: 'mini', metricKey: FEES, observedAt: '2026-07-02T12:00:00Z', periodDays: 1, value: 1000, source: 'manual', fetchedAt: AS_OF,
    });
    w.db.prepare("UPDATE observations SET status = 'rejected' WHERE id = ?").run(rejected.id);
    // Noon to noon: covers 2026-06-30 and 2026-07-01, half outside July, so July leaves it out.
    await insertObservation(w.db, { assetId: 'mini', metricKey: FEES, observedAt: '2026-07-01T12:00:00Z', periodDays: 1, value: 500, source: 'manual', fetchedAt: AS_OF });
    expect((await total({ from: '2026-07-01', to: '2026-07-31' })).result).toMatchObject({ total: (31 * 32) / 2 - 1, days_covered: 30, rows: 30, days_missing: ['2026-07-01'] });
    expect((await total({ from: '2026-06-30', to: '2026-07-31' })).result).toMatchObject({ total: (31 * 32) / 2 - 1 + 500, days_covered: 32, rows: 31, days_missing: [] });
  });

  it('says it reports confirmed measurements only, without provisional or staged figures', () => {
    const description = AGENT_TOOLS.find((t) => t.name === 'get_flow_total')!.description;
    expect(description).toContain('confirmed');
    expect(description).toMatch(/provisional/);
    expect(description).toMatch(/staged/);
    expect(description).toContain('flow_conflict');
  });

  it('says a series in revenue_streams with a share counts only that share as revenue', () => {
    const description = AGENT_TOOLS.find((t) => t.name === 'get_flow_total')!.description;
    expect(description).toContain('a series listed in revenue_streams with a share counts only that share as the asset\'s revenue');
  });

  it('get_flow_total refuses a level metric and from > to', async () => {
    expect(await total({ metric: 'price_usd' })).toMatchObject({ isError: true, result: { refused: 'not_a_flow' } });
    expect(await total({ metric: 'nope' })).toMatchObject({ isError: true, result: { refused: 'unknown_metric' } });
    expect(await total({ from: '2026-09-30', to: '2026-07-01' })).toMatchObject({ isError: true, result: { refused: 'invalid_range' } });
    expect(await total({ from: '2026-02-30' })).toMatchObject({ isError: true, result: { refused: 'invalid_date' } });
    expect(await total({ to: '2026-09-30T00:00:00Z' })).toMatchObject({ isError: true, result: { refused: 'invalid_date' } });
    expect(await total({ from: '2025-01-01', to: '2026-09-30' })).toMatchObject({ isError: true, result: { refused: 'invalid_range' } });
    expect(w.ledger.shown.size).toBe(0);
  });

  it('reports a range with no rows as all missing, with null ids', async () => {
    expect((await total({ from: '2026-07-01', to: '2026-07-02' })).result).toEqual({
      metric: FEES, from: '2026-07-01', to: '2026-07-02', total: 0, unit: 'usd', days_covered: 0, days_missing: ['2026-07-01', '2026-07-02'], rows: 0,
      first_id: null, last_id: null,
    });
  });
});

describe('record_dev_finding', () => {
  const DOC_TEXT = 'Mini says its holders received $9,000 in fees in the third quarter, all of it paid out on chain.\n';
  const DOC_QUOTE = 'holders received $9,000 in fees in the third quarter';
  const DOC = { id: 1, kind: 'post' as const, sha256: 'd'.repeat(64), text: DOC_TEXT };
  beforeEach(() => {
    w.ctx.citableDocs = () => [DOC];
    w.ctx.targetDoc = DOC;
  });
  const finding = (over: Record<string, unknown> = {}) =>
    w.call('record_dev_finding', {
      category: 'holder_flow', title: 'Fees paid to holders are under-counted', metric_keys: ['revenue_run_rate_usd', 'flow_usd.fees'],
      claim: 'The post says holders received $9,000 in Q3.', orion_reading: 'Orion sums $2,466 of fees over Q3.', value_direction: 'up',
      proposed_fix: 'Add the second fee contract to the transfer scan.', evidence: [w.ids.revenue_run_rate_usd],
      citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }], ...over,
    });

  it('record_dev_finding stages a cited finding with its fingerprint', async () => {
    await seeRevenue();
    const r = await finding();
    expect(r).toMatchObject({ isError: false, result: { staged: true, findings_staged: 1 } });
    const fingerprint = sha256(`mini|holder_flow|flow_usd.fees,revenue_run_rate_usd|${'d'.repeat(64)}`);
    expect(r.result.fingerprint).toBe(fingerprint);
    expect(w.ledger.devFindings()).toEqual([{
      category: 'holder_flow', title: 'Fees paid to holders are under-counted', metricKeys: ['flow_usd.fees', 'revenue_run_rate_usd'],
      claim: 'The post says holders received $9,000 in Q3.', orionReading: 'Orion sums $2,466 of fees over Q3.', valueDirection: 'up',
      proposedFix: 'Add the second fee contract to the transfer scan.', evidence: [w.ids.revenue_run_rate_usd],
      citations: [{ source: 'doc:1', quotedText: DOC_QUOTE, locator: null, docSha256: 'd'.repeat(64), docKind: 'post' }], fingerprint,
    }]);
    expect(w.ledger.preview().devFindings).toHaveLength(1);
  });

  it('refuses an undeclared metric key, unshown evidence, no doc citation, and a sixth finding', async () => {
    expect(await finding()).toMatchObject({ isError: true, result: { refused: 'evidence_not_shown' } });
    await seeRevenue();
    expect(await finding({ evidence: [] })).toMatchObject({ isError: true, result: { refused: 'evidence_required' } });
    expect(await finding({ metric_keys: ['flow_usd.fees', 'nope'] })).toMatchObject({ isError: true, result: { refused: 'unknown_metric' } });
    expect((await finding({ metric_keys: [] })).result.refused).toBe('invalid_input');
    expect((await finding({ metric_keys: Array(7).fill('flow_usd.fees') })).result.refused).toBe('invalid_input');
    expect((await finding({ citations: [] })).result.refused).toBe('invalid_input');
    expect(await finding({ citations: [{ source: PAGE_URL, quoted_text: QUOTE }] })).toMatchObject({ isError: true, result: { refused: 'citation_required' } });
    expect((await finding({ citations: [{ source: 'doc:1', quoted_text: 'a sentence the post never says at all' }] })).result.refused).toBe('quote_not_found');
    expect((await finding({ title: 'x'.repeat(121) })).result.refused).toBe('invalid_input');
    expect((await finding({ proposed_fix: 'x'.repeat(1501) })).result.refused).toBe('invalid_input');
    expect((await finding({ claim: '  ' })).result.refused).toBe('invalid_input');
    expect((await finding({ category: 'vibes' })).result.refused).toBe('invalid_input');
    expect(w.ledger.devFindings()).toEqual([]);

    for (const category of ['holder_flow', 'revenue', 'supply', 'unlocks', 'source']) expect((await finding({ category })).isError).toBe(false);
    expect(await finding({ category: 'other' })).toMatchObject({ isError: true, result: { refused: 'dev_finding_limit' } });
    expect(w.ledger.devFindings()).toHaveLength(5);
  });

  it('refuses defensively when the run has no target document to cite', async () => {
    w.ctx.targetDoc = null;
    await seeRevenue();
    expect(await finding()).toMatchObject({ isError: true, result: { refused: 'citation_required' } });
    expect(w.ledger.devFindings()).toEqual([]);
  });

  it('the same category and keys replace the earlier finding', async () => {
    await seeRevenue();
    for (const category of ['holder_flow', 'revenue', 'supply', 'unlocks', 'source']) await finding({ category });
    // At the limit, a replacement still goes through: it adds nothing.
    const r = await finding({ metric_keys: ['flow_usd.fees', 'revenue_run_rate_usd'], title: 'A sharper title' });
    expect(r).toMatchObject({ isError: false, result: { staged: true, replaced: true, findings_staged: 5 } });
    expect(w.ledger.devFindings().map((f) => f.title)).toEqual(['A sharper title', ...Array(4).fill('Fees paid to holders are under-counted')]);
    // Other keys under the same category are a different finding.
    expect(await finding({ metric_keys: ['flow_usd.fees'] })).toMatchObject({ isError: true, result: { refused: 'dev_finding_limit' } });
  });
});
