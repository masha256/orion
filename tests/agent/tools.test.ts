import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TOOLS, toApiTools } from '../../src/agent/tools/index.js';
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { insertObservation } from '../../src/db/observations.js';
import { insertProposal } from '../../src/db/proposals.js';
import { AGENT_ASSET_YAML, agentWorld, PAGE_URL, QUOTE, type AgentWorld } from '../helpers/agentWorld.js';
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
  it('has twelve uniquely named tools whose API schemas are plain objects generated from zod', () => {
    const api = toApiTools(AGENT_TOOLS);
    expect(api.map((t) => t.name)).toEqual([
      'get_drivers', 'get_observations', 'get_anomalies', 'get_assumptions', 'get_signal_history', 'get_journal', 'run_whatif',
      'apply_assumption_change', 'propose_change', 'resolve_anomaly', 'record_provisional_observation', 'write_journal',
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

  it('verifies the citation against the pages fetched in this run', () => {
    expect(research({ citation_url: 'https://elsewhere.example.com/' }).result.refused).toBe('citation_not_fetched');
    expect(research({ quoted_text: 'annualized revenue reached $9,999 in September' }).result.refused).toBe('quote_not_found');
    expect(research({ quoted_text: '$1,100' }).result.refused).toBe('quote_too_short');
    expect(w.ledger.observations()).toEqual([]);
  });

  it('never writes onto a fetched metric, dates only schedules and events in the future, and needs a period for a flow', () => {
    expect(research({ metric: 'price_usd', value: 11 }).result.refused).toBe('fetched_metric');
    expect(research({ metric: 'nope' }).result.refused).toBe('unknown_metric');
    expect(research({ observed_at: '2026-08-01' }).result.refused).toBe('future_observation');
    expect(research({ observed_at: 'soon' }).result.refused).toBe('invalid_timestamp');
    expect(research({ metric: 'flow_usd.fees', value: 30 }).result.refused).toBe('period_required');
    expect(research({ metric: 'emission_rate_annual', value: 5, observed_at: '2026-10-01' })).toMatchObject({ isError: false, result: { recorded: true, in_signal: false } });
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
});

describe('model-authored text', () => {
  it('is stripped of control characters before it is staged, with newlines kept', () => {
    seeRevenue();
    w.call('apply_assumption_change', {
      key: 'rev_growth_y1', scenario: 'base', value: 0.1, evidence: [w.ids.revenue_run_rate_usd], rationale: ' usage\u0007 is up\nand steady ',
    });
    expect(w.ledger.assumptionChanges()[0].rationale).toBe('usage is up\nand steady');
    w.call('write_journal', { thesis: 'steady\u0007', open_questions: ['what\u0000 next?', ' \u0007 '], summary: 'review\u001Bed' });
    expect(w.ledger.journal()).toEqual({ thesis: 'steady', openQuestions: ['what next?'], summary: 'reviewed' });
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
    expect(w.ledger.journal()).toEqual({ thesis: 'second', openQuestions: ['q'], summary: 's' });
  });
});
