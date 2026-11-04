import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { resolveUse } from '../../src/config/incomeStatement.js';
import { parseAssetObject, parseAssetYaml } from '../../src/config/load.js';
import type { IncomeStatementDef } from '../../src/config/schema.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

/** The mini asset plus the flows and levels an income statement reads, with `income_statement` set to `is`. */
function withStatement(is: unknown): unknown {
  const obj = parseYaml(MINI_ASSET_YAML) as { metrics: Record<string, unknown> } & Record<string, unknown>;
  const flow = { type: 'flow', unit: 'usd', staleness_days: 45 };
  for (const k of ['flow_usd.core', 'flow_usd.partner_fees', 'flow_usd.buyback', 'flow_usd.treasury', 'flow_usd.bribes', 'flow_usd.paid', 'flow_usd.total']) obj.metrics[k] = flow;
  obj.metrics['flow_tokens.buyback'] = { type: 'flow', unit: 'tokens', staleness_days: 45 };
  obj.metrics.partner_share = { type: 'level', unit: 'ratio', staleness_days: 30 };
  obj.metrics.incentive_run_rate_usd = { type: 'level', unit: 'usd', staleness_days: 30 };
  obj.metrics.unlocks_next_year = { type: 'level', unit: 'tokens', staleness_days: 30 };
  obj.income_statement = is;
  return obj;
}

/** A valid statement covering every section (LIT-like revenue, a share cost, CRV-like below_line and sum check). */
function base(): Record<string, any> {
  return {
    category: 'perp_dex',
    window_days: 91,
    scope: 'complete',
    revenue: [
      { id: 'core', label: 'core fees', metric: 'flow_usd.core', settlement: 'daily' },
      { id: 'partner', metric: 'flow_usd.partner_fees', settlement: 'periodic', started: '2026-06-26' },
    ],
    cost_of_revenue: [
      { id: 'partner_cut', to: 'partners', of: 'partner', share: 0.5, share_metric: 'partner_share' },
      { id: 'lp_fees', to: 'lps', not_measured: 'LP fees: pools not scanned yet' },
    ],
    holders: [
      { id: 'buyback', bucket: 'burn', metric: 'flow_usd.buyback', haircut: 0, recipient_base: 'all', capture_rule: 'discretionary', note: 'bought daily' },
    ],
    protocol: [{ id: 'treasury', metric: 'flow_usd.treasury' }],
    below_line: [
      { id: 'vote_incentives', run_rate: 'incentive_run_rate_usd', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked' },
      { id: 'bribes', not_measured: 'voter bribes not scanned', to: 'holders' },
    ],
    checks: [{ id: 'splitter', type: 'sum', total: ['flow_usd.total'], parts: ['buyback', 'treasury'], tolerance_pct: 2 }],
    volume: ['flow_usd.core'],
    burned_tokens: ['flow_tokens.buyback'],
    dilution: [{ id: 'unlocks', metric: 'unlocks_next_year' }],
  };
}

const parse = (is: unknown) => parseAssetObject(withStatement(is));
const refused = (is: unknown, re: RegExp) => expect(() => parse(is)).toThrow(re);

describe('income_statement schema', () => {
  it('accepts a statement covering every section, parsed exactly as written', () => {
    const is = base();
    const { config } = parse(is);
    expect(config.income_statement).toEqual(is);
  });

  it('refuses a line with two value sources', () => {
    const is = base();
    is.holders[0].of = 'core';
    refused(is, /holders\.buyback.*exactly one of/);
    const rev = base();
    rev.revenue[0].disclosed = 'revenue_run_rate_usd';
    refused(rev, /revenue\.core.*exactly one of/);
    const none = base();
    delete none.protocol[0].metric;
    refused(none, /protocol\.treasury.*exactly one of/);
  });

  it('refuses duplicate ids across sections', () => {
    const is = base();
    is.protocol[0].id = 'buyback';
    refused(is, /line id "buyback" is used twice/);
    const rev = base();
    rev.holders[0].id = 'core'; // a metric line, not a pass-through of the revenue line core
    refused(rev, /line id "core" is used twice/);
  });

  it('lets a use line share the id of the revenue line it passes on in full (of, share 1)', () => {
    const is = base();
    is.holders.push({ id: 'core', of: 'core', bucket: 'cash', haircut: 0, recipient_base: 'all', capture_rule: 'contractual' });
    expect(() => parse(is)).not.toThrow();
    is.holders[1].share = 0.5;
    refused(is, /line id "core" is used twice/);
  });

  it('refuses a disclosed revenue line next to another revenue line', () => {
    const is = base();
    is.revenue.push({ id: 'business', disclosed: 'revenue_run_rate_usd' });
    is.cost_of_revenue = [{ id: 'compute', to: 'other', not_measured: 'n/m' }];
    refused(is, /disclosed revenue line is the whole revenue/);
    const alone = base();
    alone.revenue = [{ id: 'business', disclosed: 'revenue_run_rate_usd', cross_check: 'flow_usd.core' }];
    alone.cost_of_revenue = [{ id: 'compute', to: 'other', not_measured: 'n/m' }];
    alone.volume = undefined;
    delete alone.volume;
    expect(() => parse(alone)).not.toThrow();
    alone.revenue[0].disclosed = 'flow_usd.core';
    refused(alone, /disclosed "flow_usd\.core" is not a level metric/);
  });

  it('cross_check only on a disclosed revenue line, naming a flow', () => {
    const is = base();
    is.revenue[0].cross_check = 'flow_usd.total';
    refused(is, /only a disclosed revenue line takes a cross_check/);
    const lvl = base();
    lvl.revenue = [{ id: 'business', disclosed: 'revenue_run_rate_usd', cross_check: 'partner_share' }];
    lvl.cost_of_revenue = [{ id: 'compute', to: 'other', not_measured: 'n/m' }];
    refused(lvl, /cross_check "partner_share" is not a flow metric/);
  });

  it('refuses remainder naming a section that has lines', () => {
    const is = base();
    is.remainder = 'protocol';
    refused(is, /remainder protocol.*list no protocol line/);
    delete is.protocol;
    is.checks[0].parts = ['buyback'];
    expect(() => parse(is)).not.toThrow();
    is.remainder = 'operating_costs';
    is.operating_costs = [{ id: 'keepers', estimate: { of: 'core', ratio: 0.05 } }];
    refused(is, /remainder operating_costs.*list no operating_costs line/);
  });

  it('refuses a burn line with haircut > 0', () => {
    const is = base();
    is.holders[0].haircut = 0.01;
    refused(is, /holders\.buyback is a burn, whose haircut is 0/);
    const bl = base();
    bl.below_line[0].bucket = 'burn';
    refused(bl, /below_line\.vote_incentives is a burn, whose haircut is 0/);
  });

  it('refuses a below_line metric that is also a revenue metric', () => {
    const is = base();
    is.below_line[0] = { id: 'vote_incentives', metric: 'flow_usd.core', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked' };
    refused(is, /below_line\.vote_incentives metric "flow_usd\.core" is a revenue metric/);
  });

  it('refuses a use line whose metric equals a revenue line metric (use of)', () => {
    const is = base();
    is.protocol[0].metric = 'flow_usd.core';
    refused(is, /protocol\.treasury metric "flow_usd\.core" is revenue line core's metric: use of: core/);
  });

  it('refuses a metric read by two lines outside revenue', () => {
    const is = base();
    is.protocol[0].metric = 'flow_usd.buyback';
    refused(is, /metric "flow_usd\.buyback" is read by two lines/);
  });

  it('accepts of + share and resolves inherited settlement/started', () => {
    const is = base();
    const { config } = parse(is);
    const def = config.income_statement as IncomeStatementDef;
    expect(def.cost_of_revenue?.[0]).toEqual({ id: 'partner_cut', to: 'partners', of: 'partner', share: 0.5, share_metric: 'partner_share' });
    const cut = resolveUse(def, def.cost_of_revenue![0]);
    expect(cut).toMatchObject({ id: 'partner_cut', metric: 'flow_usd.partner_fees', share: 0.5, share_metric: 'partner_share', settlement: 'periodic', started: '2026-06-26' });
    expect(cut.revenue?.id).toBe('partner');
    // share defaults to 1 in the resolver only; own-metric lines inherit nothing.
    const bb = resolveUse(def, def.holders![0]);
    expect(bb).toMatchObject({ id: 'buyback', metric: 'flow_usd.buyback', share: 1 });
    expect(bb.revenue).toBeUndefined();
    expect(bb.settlement).toBeUndefined();
    // of a revenue estimate inherits the estimate.
    is.revenue.push({ id: 'callers_fee', estimate: { of: 'core', ratio: 0.05 } });
    is.operating_costs = [{ id: 'callers', of: 'callers_fee' }];
    const p = parse(is).config.income_statement as IncomeStatementDef;
    expect(resolveUse(p, p.operating_costs![0])).toMatchObject({ share: 1, estimate: { of: 'core', ratio: 0.05 } });
    // of must name a revenue line; share and share_metric only with of.
    const bad = base();
    bad.cost_of_revenue[0].of = 'nope';
    refused(bad, /cost_of_revenue\.partner_cut of "nope" is not a revenue line/);
    const sh = base();
    sh.protocol[0].share = 0.5;
    refused(sh, /protocol\.treasury takes share or share_metric only with of/);
    const sm = base();
    sm.cost_of_revenue[0].share_metric = 'flow_usd.core';
    refused(sm, /share_metric "flow_usd\.core" is not a level metric/);
  });

  it('a periodic revenue line needs started; settlement only on metric lines', () => {
    const is = base();
    delete is.revenue[1].started;
    refused(is, /revenue\.partner is periodic and needs started/);
  });

  it('estimate names a measured revenue line', () => {
    const is = base();
    is.operating_costs = [{ id: 'keepers', estimate: { of: 'flow_usd.core', ratio: 0.05 } }];
    refused(is, /operating_costs\.keepers estimate of "flow_usd\.core" is not a measured revenue line/);
  });

  it('paid_metric only on holders lines; must be a flow', () => {
    const is = base();
    is.holders.push({ id: 'crv', of: 'core', paid_metric: 'flow_usd.paid', bucket: 'cash', haircut: 0.01, recipient_base: 'staked', valued_per: 'recipients', capture_rule: 'programmatic' });
    expect(() => parse(is)).not.toThrow();
    is.holders[1].paid_metric = 'partner_share';
    refused(is, /holders\.crv paid_metric "partner_share" is not a flow metric/);
    const p = base();
    p.protocol[0].paid_metric = 'flow_usd.paid';
    refused(p, /paid_metric/);
  });

  it('below_line has exactly one of metric | run_rate | not_measured; run_rate must be a level', () => {
    const is = base();
    is.below_line[0].metric = 'flow_usd.bribes';
    refused(is, /below_line\.vote_incentives takes exactly one of metric, run_rate or not_measured/);
    const none = base();
    delete none.below_line[0].run_rate;
    refused(none, /below_line\.vote_incentives takes exactly one of metric, run_rate or not_measured/);
    const flow = base();
    flow.below_line[0].run_rate = 'flow_usd.bribes';
    refused(flow, /below_line\.vote_incentives run_rate "flow_usd\.bribes" is not a level metric/);
    const lvl = base();
    lvl.below_line[0] = { id: 'vote_incentives', metric: 'incentive_run_rate_usd', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked' };
    refused(lvl, /below_line\.vote_incentives metric "incentive_run_rate_usd" is not a flow metric/);
    // A measured line paid to holders needs its bucket, haircut and recipient base; to protocol takes none.
    const nb = base();
    delete nb.below_line[0].bucket;
    refused(nb, /below_line\.vote_incentives to holders needs bucket, haircut and recipient_base/);
    const pr = base();
    pr.below_line[0] = { id: 'grants', metric: 'flow_usd.bribes', to: 'protocol', haircut: 0 };
    refused(pr, /below_line\.grants to protocol takes no bucket, haircut, recipient_base, valued_per or capture_rule/);
  });

  it('metric, flow and line references are checked', () => {
    const is = base();
    is.revenue[0].metric = 'flow_usd.missing';
    refused(is, /revenue\.core metric "flow_usd\.missing" is not a flow metric/);
    const ck = base();
    ck.checks[0].parts = ['buyback', 'nope'];
    refused(ck, /check splitter part "nope" is not a line id/);
    const vr = base();
    vr.holders[0].valued_per = 'recipients';
    refused(vr, /holders\.buyback can be valued per recipients only with recipient_base staked/);
    const vol = base();
    vol.volume = ['partner_share'];
    refused(vol, /income_statement: volume "partner_share" is not a flow metric/);
    const bt = base();
    bt.burned_tokens = ['flow_usd.core'];
    refused(bt, /income_statement: burned_tokens "flow_usd\.core" is not a flow metric in tokens/);
    const dl = base();
    dl.dilution = [{ id: 'unlocks', metric: 'flow_usd.core' }];
    refused(dl, /income_statement: dilution "unlocks" metric "flow_usd\.core" is not a level metric/);
  });

  it('checks take only the sum type for now', () => {
    const is = base();
    is.checks[0].type = 'parameter';
    expect(() => parse(is)).toThrow();
  });

  it('unknown keys refused (strict)', () => {
    for (const mutate of [
      (is: Record<string, any>) => { is.surprise = 1; },
      (is: Record<string, any>) => { is.revenue[0].surprise = 1; },
      (is: Record<string, any>) => { is.cost_of_revenue[0].surprise = 1; },
      (is: Record<string, any>) => { is.holders[0].surprise = 1; },
      (is: Record<string, any>) => { is.protocol[0].surprise = 1; },
      (is: Record<string, any>) => { is.below_line[0].surprise = 1; },
      (is: Record<string, any>) => { is.checks[0].surprise = 1; },
      (is: Record<string, any>) => { is.dilution[0].surprise = 1; },
      (is: Record<string, any>) => { is.revenue[1].estimate = { of: 'core', ratio: 0.1, surprise: 1 }; delete is.revenue[1].metric; },
      (is: Record<string, any>) => { is.holders[0].settlement = 'daily'; },
    ]) {
      const is = base();
      mutate(is);
      expect(() => parse(is)).toThrow();
    }
  });

  it('an asset without income_statement keeps its hash', () => {
    expect(parseAssetYaml(MINI_ASSET_YAML).hash).toBe('c8cc46425acb05d4fd7e211aa648d8c284b29d3ccd9dfdfde6d5cdad4030f830');
    expect('income_statement' in parseAssetYaml(MINI_ASSET_YAML).config).toBe(false);
  });
});
