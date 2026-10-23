import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TOOLS, runTool, toApiTools } from '../../src/agent/tools/index.js';
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { eligibleObservations, valueInForce } from '../../src/app/eligibility.js';
import { TRANSCRIPT_WINDOW } from '../../src/agent/guardrails.js';
import { confirmObservation, insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { insertProposal } from '../../src/db/proposals.js';
import { AGENT_ASSET_YAML, agentWorld, PAGE_URL, QUOTE, type AgentWorld } from '../helpers/agentWorld.js';
import { sha256 } from '../../src/util/canonical.js';
import { AS_OF } from '../helpers/obs.js';

let w: AgentWorld;
beforeEach(() => {
  w = agentWorld();
});

const count = (table: string): number => (w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const anomaly = (severity: 'degrading' | 'advisory', dedupeKey = 'x') =>
  raiseAnomaly(w.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey, severity, detail: {}, seenAt: AS_OF });
/** Reads revenue observations so their ids count as shown, and returns the seeded revenue id. */
const seeRevenue = (): number => {
  w.call('get_observations', { metric: 'revenue_run_rate_usd' });
  return w.ids.revenue_run_rate_usd;
};
const growth = (value: number, scenario = 'base', evidence = [w.ids.revenue_run_rate_usd]) =>
  w.call('apply_assumption_change', { key: 'rev_growth_y1', scenario, value, evidence, rationale: 'usage is accelerating' });
const research = (over: Record<string, unknown> = {}) =>
  w.call('record_provisional_observation', {
    metric: 'revenue_run_rate_usd', value: 1100, observed_at: '2026-06-28', citation_url: PAGE_URL, quoted_text: QUOTE, ...over,
  });

describe('the tool list', () => {
  it('has fourteen uniquely named tools whose API schemas are plain objects generated from zod', () => {
    const api = toApiTools(AGENT_TOOLS);
    expect(api.map((t) => t.name)).toEqual([
      'get_drivers', 'get_observations', 'get_anomalies', 'get_assumptions', 'get_signal_history', 'get_journal', 'get_flow_total', 'run_whatif',
      'apply_assumption_change', 'propose_change', 'resolve_anomaly', 'record_provisional_observation', 'write_journal', 'record_dev_finding',
    ]);
    for (const t of api) {
      expect(t.input_schema.type).toBe('object');
      expect(t.input_schema).not.toHaveProperty('$schema');
      expect(t.description!.length).toBeGreaterThan(40);
    }
    const apply = api.find((t) => t.name === 'apply_assumption_change')!;
    expect(apply.input_schema.required).toEqual(['key', 'scenario', 'value', 'evidence', 'rationale']);
  });

  it('answers an unknown tool and invalid input as errors the model can read, without throwing', () => {
    expect(w.call('delete_everything', {})).toMatchObject({ isError: true, result: { refused: 'unknown_tool' } });
    expect(w.call('get_observations', { metric: 7 })).toMatchObject({ isError: true, result: { refused: 'invalid_input' } });
    expect(w.call('get_observations', { metric: 'price_usd', extra: true })).toMatchObject({ isError: true, result: { refused: 'invalid_input' } });
    expect(w.call('get_drivers', { as_of: 'yesterday' })).toMatchObject({ isError: true, result: { refused: 'invalid_timestamp' } });
  });
});

describe('read tools', () => {
  it('get_drivers reports drivers and marks the observations behind them as shown', () => {
    expect(w.ledger.shown.size).toBe(0);
    const { result } = w.call('get_drivers', {});
    expect((result.drivers as { price: { value: number } }).price.value).toBe(10);
    expect((result.observations_in_force as { id: number }[]).map((o) => o.id)).toContain(w.ids.price_usd);
    expect(w.ledger.shown.has(w.ids.price_usd)).toBe(true);
  });

  it('get_observations lists staged rows first and refuses an unknown metric', () => {
    research();
    const { result } = w.call('get_observations', { metric: 'revenue_run_rate_usd' });
    expect((result.observations as { id: number }[]).map((o) => o.id)).toEqual([-1, w.ids.revenue_run_rate_usd]);
    expect(w.call('get_observations', { metric: 'nope' })).toMatchObject({ isError: true, result: { refused: 'unknown_metric' } });
  });

  it('get_assumptions shows bounds, the band, the range allowed this run, and staged values', () => {
    seeRevenue();
    growth(0.2);
    const { result } = w.call('get_assumptions', {});
    const row = (result.assumptions as { key: string; bounds: unknown; scenarios: Record<string, Record<string, unknown>> }[]).find((a) => a.key === 'rev_growth_y1')!;
    expect(row.bounds).toEqual({ min: -0.5, max: 5 });
    expect(row.scenarios.base).toEqual({ committed: 0, staged: 0.2, band: { min: 0, max: 1 }, allowed_this_run: { min: 0, max: 0.25 } });
    expect(row.scenarios.bull).toEqual({ committed: 0, band: { min: -0.5, max: 5 }, allowed_this_run: { min: -0.5, max: 1.375 } });
  });

  it('run_whatif layers overrides over staged changes and staged live research, and persists nothing', () => {
    const base = w.call('run_whatif', { overrides: [] }).result as Record<string, { expected_target: number }>;
    expect(base['12m'].expected_target).toBeCloseTo(10, 6);
    research(); // revenue 1000 -> 1100 at a constant 10 percent capture
    const after = w.call('run_whatif', { overrides: [] }).result as Record<string, { expected_target: number }>;
    expect(after['12m'].expected_target).toBeCloseTo(11, 6);
    const bull = w.call('run_whatif', { overrides: [{ key: 'discount_rate_base', value: 0.05, scenario: 'bull' }] }).result as Record<string, { scenarios: Record<string, number> }>;
    expect(bull['12m'].scenarios.bull).toBeCloseTo(22, 6);
    expect(count('valuation_runs')).toBe(0);
    expect(count('observations')).toBe(7);
  });
});

describe('apply_assumption_change', () => {
  it('needs evidence the agent has actually been shown', () => {
    expect(growth(0.2, 'base', [])).toMatchObject({ isError: true, result: { refused: 'evidence_required' } });
    expect(growth(0.2)).toMatchObject({ isError: true, result: { refused: 'evidence_not_shown' } });
    seeRevenue();
    expect(growth(0.2)).toMatchObject({ isError: false, result: { applied: true, changes: [{ key: 'rev_growth_y1', scenario: 'base', from: 0, to: 0.2 }] } });
    expect(w.ledger.mergedValues().base.rev_growth_y1).toBe(0.2);
    expect(count('assumption_sets')).toBe(1);
  });

  it('refuses more than one step, returns the allowed range, and stages nothing', () => {
    seeRevenue();
    expect(growth(0.5)).toMatchObject({ isError: true, result: { refused: 'max_step', allowed: { min: 0, max: 0.25 } } });
    expect(w.ledger.assumptionChanges()).toEqual([]);
  });

  it('judges every call from the run-start value: two calls cannot ratchet', () => {
    seeRevenue();
    expect(growth(0.25).isError).toBe(false);
    expect(growth(0.5)).toMatchObject({ isError: true, result: { refused: 'max_step' } });
    expect(w.ledger.mergedValues().base.rev_growth_y1).toBe(0.25);
  });

  it('turns an out-of-band value into a proposal with its computed effect, and says when bounds must change too', () => {
    seeRevenue();
    const outOfBand = growth(1.2);
    expect(outOfBand).toMatchObject({ isError: false, result: { applied: false, reason: '1.2 is outside your band for base' } });
    const outOfBounds = growth(6);
    expect(outOfBounds.result.reason).toMatch(/outside the key-wide bounds/);
    const staged = w.ledger.proposals();
    expect(staged.map((p) => p.change)).toEqual([
      { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 1.2 },
      { kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 6 },
    ]);
    expect(staged[0]).toMatchObject({ filedAgainst: { value: 0 }, rationale: 'usage is accelerating', evidence: [w.ids.revenue_run_rate_usd] });
    const effect = staged[0].effect as { '12m': { from: number; to: number } };
    expect(effect['12m'].from).toBeCloseTo(10, 6);
    expect(effect['12m'].to).toBeGreaterThan(10);
    expect(w.ledger.assumptionChanges()).toEqual([]);
  });

  it('applies to all scenarios together or not at all', () => {
    seeRevenue();
    expect(growth(0.2, 'all').result.changes).toHaveLength(3);
    expect(growth(-0.2, 'all')).toMatchObject({ isError: true, result: { refused: 'out_of_band', scenarios: ['base'] } });
    expect(w.ledger.mergedValues().bear.rev_growth_y1).toBe(0.2);
  });

  it('is blocked by an open degrading anomaly, not by an advisory one, and a staged resolution lifts the block', () => {
    seeRevenue();
    anomaly('advisory', 'a');
    expect(growth(0.1).isError).toBe(false);
    const d = anomaly('degrading', 'd');
    expect(growth(0.2)).toMatchObject({ isError: true, result: { refused: 'anomaly_block', anomaly_ids: [d.id] } });
    const resolved = w.call('resolve_anomaly', { id: d.id, note: 'sources agree again', evidence: [w.ids.revenue_run_rate_usd] });
    expect(resolved).toMatchObject({ isError: false, result: { staged: true, anomalies_still_blocking_assumption_writes: [] } });
    expect(growth(0.2).isError).toBe(false);
  });

  it('refuses a change that would make the whole set invalid', () => {
    w = agentWorld(AGENT_ASSET_YAML, { terminal_growth: 0.045 });
    seeRevenue();
    const e = [w.ids.revenue_run_rate_usd];
    expect(w.call('apply_assumption_change', { key: 'terminal_growth', scenario: 'base', value: 0.05, evidence: e, rationale: 'r' }).isError).toBe(false);
    const r = w.call('apply_assumption_change', { key: 'discount_rate_base', scenario: 'base', value: 0.05, evidence: e, rationale: 'r' });
    expect(r).toMatchObject({ isError: true, result: { refused: 'invalid_set' } });
  });

  it('refuses an unknown key and a blank rationale', () => {
    seeRevenue();
    const e = [w.ids.revenue_run_rate_usd];
    expect(w.call('apply_assumption_change', { key: 'nope', scenario: 'base', value: 1, evidence: e, rationale: 'r' }).result.refused).toBe('unknown_key');
    expect(w.call('apply_assumption_change', { key: 'rev_growth_y1', scenario: 'base', value: 0.1, evidence: e, rationale: '  ' }).result.refused).toBe('invalid_input');
  });
});

describe('resolve_anomaly', () => {
  it('leaves the user\'s acknowledgement alone, and refuses one that is already resolved or belongs elsewhere', () => {
    seeRevenue();
    const e = [w.ids.revenue_run_rate_usd];
    const acked = anomaly('degrading', 'a');
    decideAnomaly(w.db, acked.id, 'acknowledged', 'known lag', AS_OF);
    expect(w.call('resolve_anomaly', { id: acked.id, note: 'n', evidence: e }).result.refused).toBe('acknowledged_is_read_only');
    const done = anomaly('degrading', 'b');
    decideAnomaly(w.db, done.id, 'resolved', 'fixed', AS_OF);
    expect(w.call('resolve_anomaly', { id: done.id, note: 'n', evidence: e }).result.refused).toBe('anomaly_not_open');
    expect(w.call('resolve_anomaly', { id: 999, note: 'n', evidence: e }).result.refused).toBe('anomaly_not_found');
    const open = anomaly('degrading', 'c');
    expect(w.call('resolve_anomaly', { id: open.id, note: 'n', evidence: [] }).result.refused).toBe('evidence_required');
    expect(w.call('resolve_anomaly', { id: open.id, note: ' ', evidence: e }).result.refused).toBe('invalid_input');
  });
});

describe('record_provisional_observation', () => {
  it('stages a small move on a critical metric as a live provisional row that can be cited at once', () => {
    const r = research();
    expect(r).toMatchObject({ isError: false, result: { recorded: true, observation_id: -1, in_signal: true } });
    expect(growth(0.1, 'base', [-1]).isError).toBe(false);
    expect(count('observations')).toBe(7);
  });

  it('turns a large move on a critical metric into a proposal with its effect; it cannot be cited', () => {
    w.pages.push({ url: 'https://news.example.com/big', text: 'The company now reports annualized revenue of $2,000.' });
    const r = research({ value: 2000, citation_url: 'https://news.example.com/big', quoted_text: 'reports annualized revenue of $2,000', note: 'Founder interview' });
    expect(r).toMatchObject({ isError: false, result: { recorded: false } });
    expect(w.ledger.observations()).toEqual([]);
    const p = w.ledger.proposals()[0];
    expect(p.change).toMatchObject({ kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-06-28T00:00:00.000Z' });
    expect(p.filedAgainst).toEqual({ inForce: 1000 });
    expect(p.rationale).toMatch(/^Founder interview \(revenue_run_rate_usd is critical and 2000 is more than 25% from the last confirmed value \(1000\)\)$/);
    const effect = p.effect as { '12m': { from: number; to: number } };
    expect(effect['12m'].from).toBeCloseTo(10, 6);
    expect(effect['12m'].to).toBeCloseTo(20, 6);
  });

  it('measures the move from the last CONFIRMED value, so provisional rows cannot compound the guard across runs', () => {
    // An earlier run's research is live in the signal: 1250, provisional. The confirmed value is still 1000.
    insertObservation(w.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-20', value: 1250, source: 'manual', status: 'provisional',
      citationUrl: 'https://news.example.com/earlier', fetchedAt: AS_OF,
    });
    w.pages.push({ url: 'https://news.example.com/next', text: 'The company now reports annualized revenue of $1,500.' });
    // 1500 is 20 percent above 1250, but 50 percent above the confirmed 1000: it must go to the user.
    const r = research({ value: 1500, citation_url: 'https://news.example.com/next', quoted_text: 'reports annualized revenue of $1,500' });
    expect(r).toMatchObject({ isError: false, result: { recorded: false } });
    expect(w.ledger.observations()).toEqual([]);
    expect(w.ledger.proposals()[0].filedAgainst).toEqual({ inForce: 1000 });
    // A value within 25 percent of the confirmed 1000 still goes live.
    w.pages.push({ url: 'https://news.example.com/small', text: 'The company now reports annualized revenue of $1,200.' });
    expect(research({ value: 1200, observed_at: '2026-06-29', citation_url: 'https://news.example.com/small', quoted_text: 'reports annualized revenue of $1,200' }))
      .toMatchObject({ isError: false, result: { recorded: true, in_signal: true } });
  });

  it('keeps a row inert when the metric does not allow provisional data', () => {
    const r = research({ metric: 'staked_supply', value: 55 });
    expect(r).toMatchObject({ isError: false, result: { recorded: true, in_signal: false } });
    expect(w.ledger.observations()[0].live).toBe(false);
  });

  it('refuses to write where an observation already exists, and names it: the agent never supersedes one', () => {
    const r = research({ observed_at: '2026-06-15' }); // the seeded revenue observation is dated 2026-06-15
    expect(r).toMatchObject({ isError: true, result: { refused: 'observation_exists', observation_id: w.ids.revenue_run_rate_usd } });
    expect(w.ledger.observations()).toEqual([]);
    expect(w.ledger.proposals()).toEqual([]);
  });

  describe('citing a machine transcript', () => {
    const TEXT =
      '[00:01] Our annualized revenue reached $1,100 in September,\n[00:04] up from a thousand.\n' +
      '[00:09] Staked supply now stands at 55 tokens across the network.\n';
    const REVENUE_QUOTE = 'annualized revenue reached $1,100 in September, up from a thousand';
    const STAKED_QUOTE = 'Staked supply now stands at 55 tokens across the network.';
    const withTranscript = (yaml?: string) => {
      w = agentWorld(yaml);
      w.ctx.citableDocs = () => [{ id: 1, kind: 'machine_transcript', sha256: 'c'.repeat(64), text: TEXT }];
    };
    /** Commits the run and returns the eligible rows that cite a document. */
    const eligibleFromDocs = () => {
      w.ledger.commit(w.db, w.loaded.config, { agentRunId: null, now: new Date(AS_OF) });
      return eligibleObservations(w.db, w.loaded.config, AS_OF).filter((o) => o.citationUrl?.startsWith('doc:'));
    };

    it.each([
      ['not critical', AGENT_ASSET_YAML.replace('critical: true, allow_provisional: true', 'critical: false, allow_provisional: true')],
      ['critical, a small move', AGENT_ASSET_YAML],
    ])('on an allow_provisional metric (%s), goes to the user as an observation proposal and never reaches the signal', (_label, yaml) => {
      withTranscript(yaml);
      expect(research({ citation_url: 'doc:2', quoted_text: REVENUE_QUOTE }).result.refused).toBe('doc_not_in_run');
      const r = research({ citation_url: 'doc:1', quoted_text: REVENUE_QUOTE, note: 'Q3 call' });
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
      expect(eligibleFromDocs()).toEqual([]);
    });

    it('on a metric that does not allow provisional data, stages an inert row that stays out of the signal after commit', () => {
      withTranscript();
      const r = research({ metric: 'staked_supply', value: 55, citation_url: 'doc:1', quoted_text: STAKED_QUOTE });
      expect(r).toMatchObject({ isError: false, result: { recorded: true, in_signal: false } });
      expect(r.result.note).toMatch(/^provisional; it cites a machine transcript, so it stays out of the signal/);
      expect(w.ledger.observations()).toEqual([expect.objectContaining({ citationUrl: 'doc:1', quotedText: STAKED_QUOTE, live: false })]);
      expect(w.ledger.proposals()).toEqual([]);
      expect(eligibleFromDocs()).toEqual([]);
      // It is stored, as a provisional row, for the user to confirm.
      expect(listActiveObservations(w.db, 'mini', 'staked_supply').filter((o) => o.citationUrl === 'doc:1').map((o) => o.status)).toEqual(['provisional']);
    });

    it('leaves a URL citation on the same metric exactly as before', () => {
      withTranscript(AGENT_ASSET_YAML.replace('critical: true, allow_provisional: true', 'critical: false, allow_provisional: true'));
      expect(research()).toMatchObject({ isError: false, result: { recorded: true, observation_id: -1, in_signal: true } });
      expect(w.ledger.proposals()).toEqual([]);
      w.ledger.commit(w.db, w.loaded.config, { agentRunId: null, now: new Date(AS_OF) });
      expect(eligibleObservations(w.db, w.loaded.config, AS_OF).filter((o) => o.citationUrl === PAGE_URL)).toHaveLength(1);
    });

    it('refuses a non-canonical doc id', () => {
      withTranscript();
      expect(research({ citation_url: 'doc:01', quoted_text: REVENUE_QUOTE }).result.refused).toBe('doc_not_in_run');
      expect(w.ledger.proposals()).toEqual([]);
    });
  });

  it('describes the transcript window with TRANSCRIPT_WINDOW', () => {
    const tool = toApiTools(AGENT_TOOLS).find((t) => t.name === 'record_provisional_observation')!;
    expect(tool.description).toContain(`within ${TRANSCRIPT_WINDOW} consecutive segments`);
  });

  it('verifies the citation against the pages fetched in this run', () => {
    expect(research({ citation_url: 'https://elsewhere.example.com/' }).result.refused).toBe('citation_not_fetched');
    expect(research({ quoted_text: 'annualized revenue reached $9,999 in September' }).result.refused).toBe('quote_not_found');
    expect(research({ quoted_text: '$1,100' }).result.refused).toBe('quote_too_short');
    expect(w.ledger.observations()).toEqual([]);
  });

  it('never writes onto a fetched level, dates only schedules and events in the future, and needs a period for a flow', () => {
    expect(research({ metric: 'price_usd', value: 11 }).result.refused).toBe('fetched_metric');
    expect(research({ metric: 'price_usd', value: 11, observed_at: '2026-08-01' }).result.refused).toBe('fetched_metric'); // a future date opens nothing on a level
    expect(research({ metric: 'nope' }).result.refused).toBe('unknown_metric');
    expect(research({ observed_at: '2026-08-01' }).result.refused).toBe('future_observation');
    expect(research({ observed_at: 'soon' }).result.refused).toBe('invalid_timestamp');
    expect(research({ metric: 'flow_usd.fees', value: 30 }).result.refused).toBe('period_required');
    expect(research({ metric: 'emission_rate_annual', value: 5, observed_at: '2026-10-01' })).toMatchObject({ isError: false, result: { recorded: true, in_signal: false } });
  });

  it('takes an announced change on a FETCHED schedule only when it is dated after now, and the confirmed row governs from its date until the chain catches up', () => {
    // The fetch owns the present: emission_rate_annual is read from the chain here, as VVV's is.
    const fw = agentWorld(
      AGENT_ASSET_YAML.replace(
        'emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }',
        'emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400, source: { type: adapter, name: test.emission } }',
      ),
    );
    const announce = (over: Record<string, unknown>) =>
      fw.call('record_provisional_observation', { metric: 'emission_rate_annual', value: 5, observed_at: '2026-10-01', citation_url: PAGE_URL, quoted_text: QUOTE, ...over });
    expect(announce({ observed_at: AS_OF }).result.refused).toBe('fetched_metric'); // at now: a reading, not an announcement
    expect(announce({ observed_at: '2026-06-01' }).result.refused).toBe('fetched_metric');
    expect(announce({})).toMatchObject({ isError: false, result: { recorded: true, in_signal: false } });
    expect(fw.ledger.observations()[0]).toMatchObject({ metricKey: 'emission_rate_annual', value: 5, observedAt: '2026-10-01T00:00:00.000Z', live: false });

    // What the row does once the user confirms it, with the daily on-chain reads landing beneath it.
    const asset = fw.loaded.config;
    const onchain = (observedAt: string, value: number) =>
      insertObservation(fw.db, { assetId: 'mini', metricKey: 'emission_rate_annual', observedAt, value, source: 'onchain', fetchedAt: observedAt });
    onchain('2026-06-29T00:00:00Z', 10); // the seeded step is 0 at 2026-01-01; this is the chain's rate in force
    const row = insertObservation(fw.db, {
      assetId: 'mini', metricKey: 'emission_rate_annual', observedAt: '2026-10-01', value: 5, source: 'manual', status: 'provisional', citationUrl: PAGE_URL, fetchedAt: AS_OF,
    });
    expect(valueInForce(fw.db, asset, 'emission_rate_annual', '2026-10-01T00:00:00Z')).toBe(10); // provisional: inert
    confirmObservation(fw.db, row.id, AS_OF);
    expect(valueInForce(fw.db, asset, 'emission_rate_annual', '2026-09-30T23:59:59Z')).toBe(10);
    expect(valueInForce(fw.db, asset, 'emission_rate_annual', '2026-10-01T00:00:00Z')).toBe(5); // the announced step, from its effective date
    onchain('2026-10-01T00:05:00Z', 5.5); // the chain's first read after the date is newer and governs
    expect(valueInForce(fw.db, asset, 'emission_rate_annual', '2026-10-02T00:00:00Z')).toBe(5.5);
  });
});

describe('propose_change', () => {
  const propose = (input: Record<string, unknown>) => w.call('propose_change', { rationale: 'because', ...input });

  it('files a config proposal with what it was filed against and its effect, validated as a whole', () => {
    const r = propose({ kind: 'config', edits: [{ path: ['scenario_probabilities'], value: { bear: 0.2, base: 0.5, bull: 0.3 } }] });
    expect(r.isError).toBe(false);
    const p = w.ledger.proposals()[0];
    expect(p.filedAgainst).toEqual([null]); // the YAML leaves scenario_probabilities to its default
    expect(p.effect).toMatchObject({ '12m': { from: expect.any(Number), to: expect.any(Number) } });
    expect(propose({ kind: 'config', edits: [{ path: ['scenario_probabilities'], value: { bear: 0.5, base: 0.5, bull: 0.5 } }] }).result.refused).toBe('invalid_asset_config');
    expect(propose({ kind: 'config', edits: [{ path: ['modules', 'hc', 'type'], value: 'no_such_module' }] }).result.refused).toBe('invalid_config');
    expect(propose({ kind: 'config', edits: [{ path: ['assumptions', 'discount_rate_base', 'min'], value: 0.2 }] }).result.refused).toBe('assumptions_invalid_under_config');
    expect(propose({ kind: 'config', edits: [{ path: ['symbol'], value: 'MINI' }] }).result.refused).toBe('no_change');
    expect(propose({ kind: 'config', edits: [{ path: ['modules', 'nope', 'weight'], value: 1 }] }).result.refused).toBe('invalid_path');
  });

  it('cannot reach its own limits or the asset id', () => {
    expect(propose({ kind: 'config', edits: [{ path: ['agent', 'max_step_fraction'], value: 1 }] }).result.refused).toBe('path_not_proposable');
    expect(propose({ kind: 'config', edits: [{ path: ['agent'], value: { max_step_fraction: 1 } }] }).result.refused).toBe('path_not_proposable');
    expect(propose({ kind: 'config', edits: [{ path: ['id'], value: 'other' }] }).result.refused).toBe('path_not_proposable');
  });

  it('proposes acknowledging an open anomaly and withdrawing an acknowledgement, each against the right status', () => {
    const open = anomaly('degrading', 'a');
    expect(propose({ kind: 'withdraw_acknowledgement', anomaly_id: open.id }).result.refused).toBe('wrong_anomaly_status');
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id }).isError).toBe(false);
    expect(w.ledger.proposals()[0]).toMatchObject({ change: { kind: 'acknowledge_anomaly', anomalyId: open.id, note: 'because' }, filedAgainst: { status: 'open' }, effect: null });
    decideAnomaly(w.db, open.id, 'acknowledged', 'ok', AS_OF);
    expect(propose({ kind: 'withdraw_acknowledgement', anomaly_id: open.id }).isError).toBe(false);
    expect(propose({ kind: 'acknowledge_anomaly' }).result.refused).toBe('invalid_input');
  });

  it('previews confirming and rejecting an observation', () => {
    const provisional = insertObservation(w.db, {
      assetId: 'mini', metricKey: 'staked_supply', observedAt: '2026-06-29T12:00:00Z', value: 80, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    expect(propose({ kind: 'confirm_observation', observation_id: provisional.id }).isError).toBe(false);
    expect(propose({ kind: 'confirm_observation', observation_id: w.ids.price_usd }).result.refused).toBe('not_provisional');
    expect(propose({ kind: 'reject_observation', observation_id: w.ids.revenue_run_rate_usd }).isError).toBe(false);
    expect(w.ledger.proposals()[1].effect).toEqual({ blocked: ['missing_metric:revenue_run_rate_usd'] });
    expect(propose({ kind: 'reject_observation', observation_id: 999 }).result.refused).toBe('observation_not_found');
  });

  it('needs evidence for an assumption value, and refuses a no-op', () => {
    expect(propose({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 3 }).result.refused).toBe('evidence_required');
    const e = [seeRevenue()];
    expect(propose({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 0, evidence: e }).result.refused).toBe('no_change');
    expect(propose({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'bull', value: 3, evidence: e }).isError).toBe(false);
  });

  it('refuses a duplicate of a pending or a staged proposal, and stops at the run\'s proposal budget', () => {
    const open = anomaly('degrading', 'a');
    insertProposal(w.db, {
      assetId: 'mini', persona: 'analyst', agentRunId: null, change: { kind: 'acknowledge_anomaly', anomalyId: open.id, note: 'because' },
      filedAgainst: { status: 'open' }, rationale: 'because', evidence: [], effect: null, createdAt: AS_OF,
    });
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id }).result.refused).toBe('duplicate_proposal');
    const other = anomaly('advisory', 'b');
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id }).isError).toBe(false);
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id })).toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', staged_in_this_run: true } });

    w.ctx.budgets = { ...w.ctx.budgets, proposals: 1 };
    const third = anomaly('advisory', 'c');
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: third.id }).result.refused).toBe('proposal_budget');
  });

  it('sees through wording: the same decision re-filed in other words is the same proposal', () => {
    const open = anomaly('degrading', 'a');
    insertProposal(w.db, {
      assetId: 'mini', persona: 'analyst', agentRunId: null, change: { kind: 'acknowledge_anomaly', anomalyId: open.id, note: 'the API lags by design' },
      filedAgainst: { status: 'open' }, rationale: 'the API lags by design', evidence: [], effect: null, createdAt: AS_OF,
    });
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: open.id, rationale: 'this source is known to report late' }))
      .toMatchObject({ isError: true, result: { refused: 'duplicate_proposal' } });

    // And the same again for one staged earlier in this run.
    const other = anomaly('advisory', 'b');
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id, rationale: 'first wording' }).isError).toBe(false);
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: other.id, rationale: 'quite different wording' }))
      .toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', staged_in_this_run: true } });

    // A different anomaly is a different proposal, however similar the words.
    const third = anomaly('advisory', 'c');
    expect(propose({ kind: 'acknowledge_anomaly', anomaly_id: third.id, rationale: 'first wording' }).isError).toBe(false);
  });

  it('is closed to config edits on a bootstrap run', () => {
    const outcome = runTool(AGENT_TOOLS, { ...w.ctx, runType: 'bootstrap' }, 'propose_change', {
      kind: 'config',
      edits: [{ path: ['scenario_probabilities'], value: { bear: 0.15, base: 0.6, bull: 0.25 } }],
      rationale: 'because',
    });
    expect(outcome.isError).toBe(true);
    expect(JSON.parse(outcome.content).refused).toBe('not_in_bootstrap');
    // The same call with w.ctx (weekly) must not be refused for that reason
    const outcome2 = runTool(AGENT_TOOLS, w.ctx, 'propose_change', {
      kind: 'config',
      edits: [{ path: ['scenario_probabilities'], value: { bear: 0.15, base: 0.6, bull: 0.25 } }],
      rationale: 'because',
    });
    expect(outcome2.isError).toBe(false);
  });

  describe('citations', () => {
    const DOC_TEXT = '[12:30] Thanks for joining the call.\n[12:33] We are moving the base scenario weight to one half,\n[12:37] because the fee switch is now live.\n';
    const DOC_QUOTE = 'moving the base scenario weight to one half, because the fee switch is now live';
    const DOC = { id: 1, kind: 'transcript' as const, sha256: 'd'.repeat(64), text: DOC_TEXT };
    const probabilities = (base: number) => ({
      kind: 'config', edits: [{ path: ['scenario_probabilities'], value: { bear: (1 - base) / 2, base, bull: (1 - base) / 2 } }],
    });
    const withDoc = (runType: 'weekly' | 'disclosure' = 'weekly') => {
      w.ctx.citableDocs = () => [DOC];
      if (runType === 'disclosure') {
        w.ctx.runType = 'disclosure';
        w.ctx.targetDoc = DOC;
      }
    };
    const storedCitations = (): unknown => {
      w.ledger.commit(w.db, w.loaded.config, { agentRunId: null, now: new Date(AS_OF) });
      const row = w.db.prepare('SELECT citations_json FROM proposals ORDER BY id DESC LIMIT 1').get() as { citations_json: string | null };
      return row.citations_json === null ? null : JSON.parse(row.citations_json);
    };

    it('propose_change verifies each citation and stores it', () => {
      withDoc();
      const r = propose({ ...probabilities(0.5), citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }, { source: PAGE_URL, quoted_text: QUOTE }] });
      expect(r.isError).toBe(false);
      const expected = [
        { source: 'doc:1', quotedText: DOC_QUOTE, locator: '12:33', docSha256: 'd'.repeat(64), docKind: 'transcript' },
        { source: PAGE_URL, quotedText: QUOTE, locator: null, docSha256: null, docKind: null },
      ];
      expect(w.ledger.proposals()[0].citations).toEqual(expected);
      expect(storedCitations()).toEqual(expected);
    });

    it('a bad citation refuses the whole proposal', () => {
      withDoc();
      const bad = propose({ ...probabilities(0.5), citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }, { source: 'doc:1', quoted_text: 'the fee switch was never discussed at all' }] });
      expect(bad).toMatchObject({ isError: true, result: { refused: 'quote_not_found' } });
      expect(propose({ ...probabilities(0.5), citations: [{ source: 'doc:2', quoted_text: DOC_QUOTE }] }).result.refused).toBe('doc_not_in_run');
      expect(w.ledger.proposals()).toEqual([]);
      // At most five.
      const six = Array.from({ length: 6 }, () => ({ source: 'doc:1', quoted_text: DOC_QUOTE }));
      expect(propose({ ...probabilities(0.5), citations: six }).result.refused).toBe('invalid_input');
      expect(w.ledger.proposals()).toEqual([]);
    });

    it('a disclosure run refuses a proposal without a citation of the target doc', () => {
      withDoc('disclosure');
      expect(propose(probabilities(0.5))).toMatchObject({ isError: true, result: { refused: 'citation_required' } });
      expect(propose({ ...probabilities(0.5), citations: [] }).result.refused).toBe('citation_required');
      expect(propose({ ...probabilities(0.5), citations: [{ source: PAGE_URL, quoted_text: QUOTE }] }).result.refused).toBe('citation_required');
      expect(w.ledger.proposals()).toEqual([]);
      expect(propose({ ...probabilities(0.5), citations: [{ source: PAGE_URL, quoted_text: QUOTE }, { source: 'doc:1', quoted_text: DOC_QUOTE }] }).isError).toBe(false);
      expect(w.ledger.proposals()[0].citations.map((c) => c.source)).toEqual([PAGE_URL, 'doc:1']);
    });

    it('other run types may file without citations, as before', () => {
      withDoc();
      expect(propose(probabilities(0.5)).isError).toBe(false);
      expect(w.ledger.proposals()[0].citations).toEqual([]);
      expect(storedCitations()).toBeNull();
    });

    it('citations do not change duplicate detection', () => {
      withDoc();
      expect(propose({ ...probabilities(0.5), citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }] }).isError).toBe(false);
      expect(propose({ ...probabilities(0.5), citations: [{ source: PAGE_URL, quoted_text: QUOTE }] }))
        .toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', staged_in_this_run: true } });
      w.ledger.commit(w.db, w.loaded.config, { agentRunId: null, now: new Date(AS_OF) });
      expect(propose(probabilities(0.5))).toMatchObject({ isError: true, result: { refused: 'duplicate_proposal', proposal_id: expect.any(Number) } });
    });

    it('a machine-transcript observation proposal carries the verified citation it came from', () => {
      const text = '[00:01] Our annualized revenue reached $1,100 in September,\n[00:04] up from a thousand.\n';
      w.ctx.citableDocs = () => [{ id: 1, kind: 'machine_transcript', sha256: 'c'.repeat(64), text }];
      const quote = 'annualized revenue reached $1,100 in September, up from a thousand';
      expect(research({ citation_url: 'doc:1', quoted_text: quote }).result.recorded).toBe(false);
      expect(w.ledger.proposals()[0].citations).toEqual([
        { source: 'doc:1', quotedText: quote, locator: '00:01', docSha256: 'c'.repeat(64), docKind: 'machine_transcript' },
      ]);
    });
  });
});

describe('model-authored text', () => {
  it('is stripped of control characters before it is staged, with newlines kept', () => {
    seeRevenue();
    w.call('apply_assumption_change', {
      key: 'rev_growth_y1', scenario: 'base', value: 0.1, evidence: [w.ids.revenue_run_rate_usd], rationale: ' usage\u0007 is up\nand steady ',
    });
    expect(w.ledger.assumptionChanges()[0].rationale).toBe('usage is up\nand steady');
    w.call('write_journal', { thesis: 'steady\u0007', open_questions: ['what\u0000 next?', ' \u0007 '], summary: 'review\u001Bed' });
    expect(w.ledger.journal()).toEqual({ thesis: 'steady', openQuestions: ['what next?'], summary: 'reviewed', catalysts: [] });
  });

  it('is cleaned before the citation is verified, so a stray control character in a quote costs nothing', () => {
    const r = research({ quoted_text: 'annualized revenue reached \u0000$1,100 in September' });
    expect(r).toMatchObject({ isError: false, result: { recorded: true } });
    expect(w.ledger.observations()[0].quotedText).toBe(QUOTE); // the CLEANED quote is what is stored
  });

  it('is refused as ordinary invalid input when it is too long, so the model can shorten it and retry', () => {
    seeRevenue();
    const e = [w.ids.revenue_run_rate_usd];
    const apply = (rationale: string) => w.call('apply_assumption_change', { key: 'rev_growth_y1', scenario: 'base', value: 0.1, evidence: e, rationale });
    expect(apply('r'.repeat(2001)).result.refused).toBe('invalid_input');
    expect(apply('r'.repeat(2000)).isError).toBe(false);
    expect(research({ quoted_text: QUOTE + 'x'.repeat(601) }).result.refused).toBe('invalid_input');
    expect(research({ citation_url: `https://x.example.com/${'a'.repeat(2000)}` }).result.refused).toBe('invalid_input');
    expect(research({ note: 'n'.repeat(2001) }).result.refused).toBe('invalid_input');
    expect(w.call('resolve_anomaly', { id: anomaly('advisory').id, note: 'n'.repeat(2001), evidence: e }).result.refused).toBe('invalid_input');
    expect(w.call('propose_change', { kind: 'acknowledge_anomaly', anomaly_id: 1, rationale: 'r'.repeat(2001) }).result.refused).toBe('invalid_input');
    const journal = (over: Record<string, unknown>) => w.call('write_journal', { thesis: 't', open_questions: [], summary: 's', ...over });
    expect(journal({ thesis: 't'.repeat(4001) }).result.refused).toBe('invalid_input');
    expect(journal({ summary: 's'.repeat(4001) }).result.refused).toBe('invalid_input');
    expect(journal({ open_questions: ['q'.repeat(501)] }).result.refused).toBe('invalid_input');
    expect(journal({ open_questions: Array.from({ length: 21 }, () => 'q') }).result.refused).toBe('invalid_input');
    expect(journal({ open_questions: Array.from({ length: 20 }, () => 'q') }).isError).toBe(false);
  });
});

describe('write_journal', () => {
  it('stages one entry, replaces it on a second call, and refuses blanks', () => {
    expect(w.call('write_journal', { thesis: ' ', open_questions: [], summary: 's' }).result.refused).toBe('invalid_input');
    w.call('write_journal', { thesis: 'first', open_questions: ['q', ' '], summary: 's' });
    w.call('write_journal', { thesis: 'second', open_questions: ['q', ' '], summary: 's' });
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

    it('write_journal stages catalysts with verified citations; commit stores them', () => {
      w.ctx.citableDocs = () => [DOC];
      const r = journal([
        catalyst({ event: ' exchange license\u0007 granted ' }),
        { event: 'revenue milestone', kind: 'product', from: '2026-07-01', to: '2026-09-30', citations: [{ source: PAGE_URL, quoted_text: QUOTE }] },
      ]);
      expect(r.isError).toBe(false);
      const expected = [
        {
          event: 'exchange license granted', kind: 'regulatory', by: '2026-09-30',
          citations: [{ source: 'doc:1', quotedText: DOC_QUOTE, locator: '00:04', docSha256: 'e'.repeat(64), docKind: 'transcript' }],
        },
        {
          event: 'revenue milestone', kind: 'product', from: '2026-07-01', to: '2026-09-30',
          citations: [{ source: PAGE_URL, quotedText: QUOTE, locator: null, docSha256: null, docKind: null }],
        },
      ];
      expect(w.ledger.journal()!.catalysts).toEqual(expected);
      const { journalId } = w.ledger.commit(w.db, w.loaded.config, { agentRunId: null, now: new Date(AS_OF) });
      const row = w.db.prepare('SELECT catalysts_json FROM journal WHERE id = ?').get(journalId) as { catalysts_json: string };
      expect(JSON.parse(row.catalysts_json)).toEqual(expected);
      expect((w.call('get_journal', {}).result.entries as { catalysts: unknown }[])[0].catalysts).toEqual(expected);
    });

    it('refuses by together with from/to, from after to, a bad date, a 9th catalyst, an unverified quote', () => {
      w.ctx.citableDocs = () => [DOC];
      const refused = (c: Record<string, unknown>) => journal([catalyst(c)]).result.refused;
      expect(refused({ from: '2026-07-01', to: '2026-09-30' })).toBe('invalid_catalyst_dates');
      expect(refused({ by: undefined })).toBe('invalid_catalyst_dates');
      expect(refused({ by: undefined, from: '2026-07-01' })).toBe('invalid_catalyst_dates');
      expect(refused({ by: undefined, to: '2026-07-01' })).toBe('invalid_catalyst_dates');
      expect(refused({ by: undefined, from: '2026-10-01', to: '2026-09-30' })).toBe('invalid_catalyst_dates');
      expect(refused({ by: '2026-02-30' })).toBe('invalid_catalyst_dates');
      expect(refused({ by: '2026-9-30' })).toBe('invalid_catalyst_dates');
      expect(refused({ by: '2026-09-30T00:00:00Z' })).toBe('invalid_catalyst_dates');
      expect(refused({ by: 'end of Q3' })).toBe('invalid_catalyst_dates');
      expect(journal([catalyst({ by: undefined, from: '2026-09-30', to: '2026-09-30' })]).isError).toBe(false);
      expect(refused({ kind: 'rumor' })).toBe('invalid_input');
      expect(refused({ event: 'e'.repeat(201) })).toBe('invalid_input');
      expect(refused({ event: ' \u0007 ' })).toBe('invalid_input');
      expect(refused({ citations: [] })).toBe('invalid_input');
      expect(refused({ citations: Array.from({ length: 4 }, () => ({ source: 'doc:1', quoted_text: DOC_QUOTE })) })).toBe('invalid_input');
      expect(journal(Array.from({ length: 9 }, () => catalyst())).result.refused).toBe('invalid_input');
      expect(refused({ citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }, { source: 'doc:1', quoted_text: 'the license was denied outright by the regulator' }] })).toBe('quote_not_found');
      expect(refused({ citations: [{ source: 'doc:2', quoted_text: DOC_QUOTE }] })).toBe('doc_not_in_run');
      // A refused call leaves the earlier staged entry in place.
      expect(w.ledger.journal()!.catalysts).toHaveLength(1);
      expect(journal(Array.from({ length: 8 }, () => catalyst())).isError).toBe(false);
      expect(w.ledger.journal()!.catalysts).toHaveLength(8);
    });

    it('needs no target-doc citation in a disclosure run, but every citation still verifies', () => {
      w.ctx.citableDocs = () => [DOC];
      w.ctx.runType = 'disclosure';
      w.ctx.targetDoc = DOC;
      expect(journal([catalyst({ citations: [{ source: PAGE_URL, quoted_text: QUOTE }] })]).isError).toBe(false);
      expect(journal([catalyst({ citations: [{ source: PAGE_URL, quoted_text: 'a sentence the page never said at all' }] })]).result.refused).toBe('quote_not_found');
    });

    it('a journal without catalysts stores NULL', () => {
      journal([]);
      const { journalId } = w.ledger.commit(w.db, w.loaded.config, { agentRunId: null, now: new Date(AS_OF) });
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
  const seedQ3 = (skip: string[] = []): number[] => {
    const ids: number[] = [];
    for (let i = 0; i < 92; i++) {
      if (skip.includes(dayOf(i))) continue;
      ids.push(insertObservation(w.db, {
        assetId: 'mini', metricKey: FEES, observedAt: new Date(Q3_START + (i + 1) * DAY).toISOString(), periodDays: 1, value: i + 1, source: 'onchain', fetchedAt: AS_OF,
      }).id);
    }
    return ids;
  };
  const total = (over: Record<string, unknown> = {}) => w.call('get_flow_total', { metric: FEES, from: '2026-07-01', to: '2026-09-30', ...over });

  it('get_flow_total sums Q3 daily rows, reports missing days, and marks them shown', () => {
    const ids = seedQ3();
    const { isError, result } = total();
    expect(isError).toBe(false);
    expect(result).toEqual({
      metric: FEES, from: '2026-07-01', to: '2026-09-30', total: (92 * 93) / 2, unit: 'usd', days_covered: 92, days_missing: [], rows: 92,
      first_id: Math.min(...ids), last_id: Math.max(...ids),
    });
    for (const id of ids) expect(w.ledger.shown.has(id)).toBe(true);
    // The seeded 90-day row ends at 2026-06-30 and lies wholly before the range: not summed, not shown.
    expect(w.ledger.shown.has(w.ids[FEES])).toBe(false);
    // A sub-range counts whole days only.
    expect(total({ from: '2026-07-01', to: '2026-07-03' }).result).toMatchObject({ total: 1 + 2 + 3, days_covered: 3, rows: 3 });
  });

  it('reports a dropped day as missing, and a row staged in this run does not fill it', () => {
    seedQ3(['2026-08-15']); // day index 45, value 46
    expect(total().result).toMatchObject({ total: (92 * 93) / 2 - 46, days_covered: 91, days_missing: ['2026-08-15'], rows: 91 });
    const staged = w.ledger.stageObservation({
      metricKey: FEES, value: 46, observedAt: '2026-08-16T00:00:00Z', periodDays: 1, citationUrl: PAGE_URL, quotedText: QUOTE, live: true,
    });
    // Staged rows are this run's own figures, not Orion's measurement: the day stays missing and the row is not summed.
    expect(total().result).toMatchObject({ total: (92 * 93) / 2 - 46, days_covered: 91, days_missing: ['2026-08-15'], rows: 91 });
    expect(w.ledger.shown.has(staged.tempId)).toBe(true); // shown because it was staged, not because it was summed
  });

  it('ignores a 92-day provisional row staged on top of the 92 daily rows: the total is the daily sum', () => {
    const ids = seedQ3();
    w.ledger.stageObservation({
      metricKey: FEES, value: 99_999, observedAt: '2026-10-01T00:00:00Z', periodDays: 92, citationUrl: PAGE_URL, quotedText: QUOTE, live: true,
    });
    expect(total()).toMatchObject({
      isError: false,
      result: { total: (92 * 93) / 2, days_covered: 92, days_missing: [], rows: 92, first_id: Math.min(...ids), last_id: Math.max(...ids) },
    });
  });

  it('ignores a committed provisional row: only confirmed rows are summed', () => {
    seedQ3(['2026-08-15']);
    const provisional = insertObservation(w.db, {
      assetId: 'mini', metricKey: FEES, observedAt: '2026-08-16T00:00:00Z', periodDays: 1, value: 46, source: 'manual', fetchedAt: AS_OF,
      status: 'provisional', citationUrl: PAGE_URL, quotedText: QUOTE,
    });
    expect(total().result).toMatchObject({ total: (92 * 93) / 2 - 46, days_covered: 91, days_missing: ['2026-08-15'], rows: 91 });
    expect(w.ledger.shown.has(provisional.id)).toBe(false);
  });

  it('refuses flow_conflict, with the ids and the days, when two confirmed rows cover the same day', () => {
    const ids = seedQ3();
    // A confirmed two-day manual row for 2026-07-01 and 2026-07-02.
    const manual = insertObservation(w.db, {
      assetId: 'mini', metricKey: FEES, observedAt: '2026-07-03T00:00:00Z', periodDays: 2, value: 7, source: 'manual', fetchedAt: AS_OF,
    });
    // It shares observed_at with the daily row for 2026-07-02, which insertObservation supersedes, so it overlaps 07-01's row only.
    expect(listActiveObservations(w.db, 'mini', FEES).some((o) => o.id === ids[1])).toBe(false);
    const { isError, result } = total();
    expect(isError).toBe(true);
    expect(result).toMatchObject({ refused: 'flow_conflict', ids: [ids[0], manual.id], days: ['2026-07-01'] });
    expect(result).not.toHaveProperty('total');
    expect(w.ledger.shown.size).toBe(0);
  });

  it('leaves out superseded and rejected rows, and a row that straddles the edge of the range', () => {
    seedQ3(['2026-07-01']); // the straddling row below is the only row on 2026-07-01, so it overlaps nothing
    const rejected = insertObservation(w.db, {
      assetId: 'mini', metricKey: FEES, observedAt: '2026-07-02T12:00:00Z', periodDays: 1, value: 1000, source: 'manual', fetchedAt: AS_OF,
    });
    w.db.prepare("UPDATE observations SET status = 'rejected' WHERE id = ?").run(rejected.id);
    // Noon to noon: covers 2026-06-30 and 2026-07-01, half outside July, so July leaves it out.
    insertObservation(w.db, { assetId: 'mini', metricKey: FEES, observedAt: '2026-07-01T12:00:00Z', periodDays: 1, value: 500, source: 'manual', fetchedAt: AS_OF });
    expect(total({ from: '2026-07-01', to: '2026-07-31' }).result).toMatchObject({ total: (31 * 32) / 2 - 1, days_covered: 30, rows: 30, days_missing: ['2026-07-01'] });
    expect(total({ from: '2026-06-30', to: '2026-07-31' }).result).toMatchObject({ total: (31 * 32) / 2 - 1 + 500, days_covered: 32, rows: 31, days_missing: [] });
  });

  it('says it reports confirmed measurements only, without provisional or staged figures', () => {
    const description = AGENT_TOOLS.find((t) => t.name === 'get_flow_total')!.description;
    expect(description).toContain('confirmed');
    expect(description).toMatch(/provisional/);
    expect(description).toMatch(/staged/);
    expect(description).toContain('flow_conflict');
  });

  it('get_flow_total refuses a level metric and from > to', () => {
    expect(total({ metric: 'price_usd' })).toMatchObject({ isError: true, result: { refused: 'not_a_flow' } });
    expect(total({ metric: 'nope' })).toMatchObject({ isError: true, result: { refused: 'unknown_metric' } });
    expect(total({ from: '2026-09-30', to: '2026-07-01' })).toMatchObject({ isError: true, result: { refused: 'invalid_range' } });
    expect(total({ from: '2026-02-30' })).toMatchObject({ isError: true, result: { refused: 'invalid_date' } });
    expect(total({ to: '2026-09-30T00:00:00Z' })).toMatchObject({ isError: true, result: { refused: 'invalid_date' } });
    expect(total({ from: '2025-01-01', to: '2026-09-30' })).toMatchObject({ isError: true, result: { refused: 'invalid_range' } });
    expect(w.ledger.shown.size).toBe(0);
  });

  it('reports a range with no rows as all missing, with null ids', () => {
    expect(total({ from: '2026-07-01', to: '2026-07-02' }).result).toEqual({
      metric: FEES, from: '2026-07-01', to: '2026-07-02', total: 0, unit: 'usd', days_covered: 0, days_missing: ['2026-07-01', '2026-07-02'], rows: 0,
      first_id: null, last_id: null,
    });
  });
});

describe('record_dev_finding', () => {
  const DOC_TEXT = 'Mini says its holders received $9,000 in fees in the third quarter, all of it paid out on chain.\n';
  const DOC_QUOTE = 'holders received $9,000 in fees in the third quarter';
  const DOC = { id: 1, kind: 'post' as const, sha256: 'd'.repeat(64), text: DOC_TEXT };
  const disclosure = () => {
    w.ctx.citableDocs = () => [DOC];
    w.ctx.runType = 'disclosure';
    w.ctx.targetDoc = DOC;
  };
  const finding = (over: Record<string, unknown> = {}) =>
    w.call('record_dev_finding', {
      category: 'holder_flow', title: 'Fees paid to holders are under-counted', metric_keys: ['revenue_run_rate_usd', 'flow_usd.fees'],
      claim: 'The post says holders received $9,000 in Q3.', orion_reading: 'Orion sums $2,466 of fees over Q3.', value_direction: 'up',
      proposed_fix: 'Add the second fee contract to the transfer scan.', evidence: [w.ids.revenue_run_rate_usd],
      citations: [{ source: 'doc:1', quoted_text: DOC_QUOTE }], ...over,
    });

  it('record_dev_finding stages a cited finding with its fingerprint', () => {
    disclosure();
    seeRevenue();
    const r = finding();
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

  it('refuses an undeclared metric key, unshown evidence, no doc citation, and a sixth finding', () => {
    disclosure();
    expect(finding()).toMatchObject({ isError: true, result: { refused: 'evidence_not_shown' } });
    seeRevenue();
    expect(finding({ evidence: [] })).toMatchObject({ isError: true, result: { refused: 'evidence_required' } });
    expect(finding({ metric_keys: ['flow_usd.fees', 'nope'] })).toMatchObject({ isError: true, result: { refused: 'unknown_metric' } });
    expect(finding({ metric_keys: [] }).result.refused).toBe('invalid_input');
    expect(finding({ metric_keys: Array(7).fill('flow_usd.fees') }).result.refused).toBe('invalid_input');
    expect(finding({ citations: [] }).result.refused).toBe('invalid_input');
    expect(finding({ citations: [{ source: PAGE_URL, quoted_text: QUOTE }] })).toMatchObject({ isError: true, result: { refused: 'citation_required' } });
    expect(finding({ citations: [{ source: 'doc:1', quoted_text: 'a sentence the post never says at all' }] }).result.refused).toBe('quote_not_found');
    expect(finding({ title: 'x'.repeat(121) }).result.refused).toBe('invalid_input');
    expect(finding({ proposed_fix: 'x'.repeat(1501) }).result.refused).toBe('invalid_input');
    expect(finding({ claim: '  ' }).result.refused).toBe('invalid_input');
    expect(finding({ category: 'vibes' }).result.refused).toBe('invalid_input');
    expect(w.ledger.devFindings()).toEqual([]);

    for (const category of ['holder_flow', 'revenue', 'supply', 'unlocks', 'source']) expect(finding({ category }).isError).toBe(false);
    expect(finding({ category: 'other' })).toMatchObject({ isError: true, result: { refused: 'dev_finding_limit' } });
    expect(w.ledger.devFindings()).toHaveLength(5);
  });

  it('refuses defensively outside a disclosure run: there is no target document to cite', () => {
    w.ctx.citableDocs = () => [DOC];
    seeRevenue();
    expect(finding()).toMatchObject({ isError: true, result: { refused: 'citation_required' } });
    expect(w.ledger.devFindings()).toEqual([]);
  });

  it('the same category and keys replace the earlier finding', () => {
    disclosure();
    seeRevenue();
    for (const category of ['holder_flow', 'revenue', 'supply', 'unlocks', 'source']) finding({ category });
    // At the limit, a replacement still goes through: it adds nothing.
    const r = finding({ metric_keys: ['flow_usd.fees', 'revenue_run_rate_usd'], title: 'A sharper title' });
    expect(r).toMatchObject({ isError: false, result: { staged: true, replaced: true, findings_staged: 5 } });
    expect(w.ledger.devFindings().map((f) => f.title)).toEqual(['A sharper title', ...Array(4).fill('Fees paid to holders are under-counted')]);
    // Other keys under the same category are a different finding.
    expect(finding({ metric_keys: ['flow_usd.fees'] })).toMatchObject({ isError: true, result: { refused: 'dev_finding_limit' } });
  });
});
