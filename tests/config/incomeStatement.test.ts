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
      { id: 'vote_incentives', run_rate: 'incentive_run_rate_usd', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked', capture_rule: 'programmatic' },
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
    expect(config.income_statement).toStrictEqual(is);
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

  it('refuses a use line reusing the id of the revenue line it passes on, in full or in part (ruling R8)', () => {
    const is = base();
    is.holders.push({ id: 'core', of: 'core', bucket: 'cash', haircut: 0, recipient_base: 'all', capture_rule: 'contractual' });
    refused(is, /line id "core" is used twice/);
    is.holders[1].share = 0.5;
    refused(is, /line id "core" is used twice/);
    // the Task 2 convention: the revenue line takes the suffix _rev, the use line keeps the name
    const renamed = base();
    renamed.revenue[0].id = 'core_rev';
    renamed.holders.push({ id: 'core', of: 'core_rev', bucket: 'cash', haircut: 0, recipient_base: 'all', capture_rule: 'contractual' });
    expect(() => parse(renamed)).not.toThrow();
  });

  it('refuses a below_line id that a revenue or use line already has', () => {
    const rev = base();
    rev.below_line[1].id = 'core';
    refused(rev, /line id "core" is used twice/);
    const use = base();
    use.below_line[1].id = 'treasury';
    refused(use, /line id "treasury" is used twice/);
  });

  it('refuses a disclosed revenue line next to another revenue line', () => {
    const is = base();
    is.revenue.push({ id: 'business', disclosed: 'revenue_run_rate_usd' });
    is.cost_of_revenue = [{ id: 'compute', to: 'other', not_measured: 'n/m' }];
    refused(is, /disclosed revenue line is the whole revenue/);
    const alone = base();
    alone.revenue = [{ id: 'business', disclosed: 'revenue_run_rate_usd', cross_check: 'flow_usd.core' }];
    alone.cost_of_revenue = [{ id: 'compute', to: 'other', not_measured: 'n/m' }];
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
    is.below_line[0] = { id: 'vote_incentives', metric: 'flow_usd.core', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked', capture_rule: 'programmatic' };
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
    lvl.below_line[0] = { id: 'vote_incentives', metric: 'incentive_run_rate_usd', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked', capture_rule: 'programmatic' };
    refused(lvl, /below_line\.vote_incentives metric "incentive_run_rate_usd" is not a flow metric/);
    // A measured line paid to holders needs its bucket, haircut and recipient base; to protocol takes none.
    const nb = base();
    delete nb.below_line[0].bucket;
    refused(nb, /below_line\.vote_incentives to holders needs bucket, haircut, recipient_base and capture_rule/);
    const pr = base();
    pr.below_line[0] = { id: 'grants', metric: 'flow_usd.bribes', to: 'protocol', haircut: 0 };
    refused(pr, /below_line\.grants to protocol takes no bucket, haircut, recipient_base, valued_per or capture_rule/);
  });

  it('volume may be { not_measured: <reason> } (1-200 chars, no other key), parsed exactly as written (Phase 3 Task 5)', () => {
    const nm = base();
    nm.volume = { not_measured: 'gross swap volume: DefiLlama series retired, no on-chain read yet' };
    expect(parse(nm).config.income_statement).toStrictEqual(nm);
    const long = base();
    long.volume = { not_measured: 'x'.repeat(200) };
    expect(() => parse(long)).not.toThrow();
    const tooLong = base();
    tooLong.volume = { not_measured: 'x'.repeat(201) };
    expect(() => parse(tooLong)).toThrow();
    const empty = base();
    empty.volume = { not_measured: '' };
    expect(() => parse(empty)).toThrow();
    const extra = base();
    extra.volume = { not_measured: 'x', extra: 1 };
    expect(() => parse(extra)).toThrow();
    const bare = base();
    bare.volume = {};
    expect(() => parse(bare)).toThrow();
    const listEmpty = base();
    listEmpty.volume = [];
    expect(() => parse(listEmpty)).toThrow();
  });

  it('the volume list form parses to the same array as before (config hash unchanged)', () => {
    const { config } = parse(base());
    expect(config.income_statement!.volume).toStrictEqual(['flow_usd.core']);
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

  it('a check takes one of the eight types (Task 5); an unknown type is refused', () => {
    const is = base();
    is.checks[0].type = 'ratio';
    refused(is, /checks/);
    const wrongShape = base();
    wrongShape.checks[0].type = 'parameter'; // a sum's keys under another type
    refused(wrongShape, /checks\.0/);
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
      // a bare estimate line (no settlement or started left behind), so only the strict estimate node can refuse it
      (is: Record<string, any>) => { is.revenue[1] = { id: 'partner', estimate: { of: 'core', ratio: 0.1, surprise: 1 } }; is.cost_of_revenue.shift(); },
      (is: Record<string, any>) => { is.holders[0].settlement = 'daily'; },
    ]) {
      const is = base();
      mutate(is);
      refused(is, /Unrecognized key/);
    }
    // the bare estimate line is valid without the stray key
    const ok = base();
    ok.revenue[1] = { id: 'partner', estimate: { of: 'core', ratio: 0.1 } };
    ok.cost_of_revenue.shift();
    expect(() => parse(ok)).not.toThrow();
  });

  it('derived revenue: from a flow, read once, registered as revenue; share_metric a level', () => {
    const d = () => {
      const is = base();
      is.revenue[1] = { id: 'partner', derived: { from: 'flow_usd.partner_fees', share: 0.5, share_metric: 'partner_share' } };
      is.cost_of_revenue.shift();
      return is;
    };
    expect(() => parse(d())).not.toThrow();
    const fl = d();
    fl.revenue[1].derived.from = 'partner_share';
    refused(fl, /revenue\.partner derived from "partner_share" is not a flow metric/);
    const twice = d();
    twice.revenue[1].derived.from = 'flow_usd.core';
    refused(twice, /metric "flow_usd\.core" is read by two lines \(revenue\.core and revenue\.partner\)/);
    const use = d();
    use.protocol[0].metric = 'flow_usd.partner_fees';
    refused(use, /protocol\.treasury metric "flow_usd\.partner_fees" is revenue line partner's metric: use of: partner/);
    const bl = d();
    bl.below_line[1] = { id: 'bribes', metric: 'flow_usd.partner_fees', to: 'protocol' };
    refused(bl, /below_line\.bribes metric "flow_usd\.partner_fees" is a revenue metric/);
    const sm = d();
    sm.revenue[1].derived.share_metric = 'flow_usd.total';
    refused(sm, /revenue\.partner derived share_metric "flow_usd\.total" is not a level metric/);
  });

  it('settlement and started only on a metric or derived revenue line', () => {
    for (const extra of [{ settlement: 'daily' }, { started: '2026-06-26' }]) {
      const is = base();
      is.revenue[1] = { id: 'partner', estimate: { of: 'core', ratio: 0.1 }, ...extra };
      is.cost_of_revenue.shift();
      refused(is, /revenue\.partner takes settlement and started only with a metric or derived/);
    }
  });

  it('of must name a measured revenue line, not a not_measured one or a use line', () => {
    const nm = base();
    nm.revenue.push({ id: 'unread', not_measured: 'not scanned' });
    nm.protocol[0] = { id: 'treasury', of: 'unread' };
    refused(nm, /protocol\.treasury of "unread" is a not_measured revenue line/);
    const use = base();
    use.protocol[0] = { id: 'treasury', of: 'buyback' };
    refused(use, /protocol\.treasury of "buyback" is not a revenue line/);
  });

  it('a use line metric must be a flow, in every use section', () => {
    const h = base();
    h.holders[0].metric = 'partner_share';
    refused(h, /holders\.buyback metric "partner_share" is not a flow metric/);
    const p = base();
    p.protocol[0].metric = 'partner_share';
    refused(p, /protocol\.treasury metric "partner_share" is not a flow metric/);
    const c = base();
    c.cost_of_revenue[1] = { id: 'lp_fees', to: 'lps', metric: 'partner_share' };
    refused(c, /cost_of_revenue\.lp_fees metric "partner_share" is not a flow metric/);
  });

  it('a not_measured holder line takes no paid_metric', () => {
    const is = base();
    is.holders.push({ id: 'unpaid', not_measured: 'not scanned', paid_metric: 'flow_usd.paid', bucket: 'cash', haircut: 0, recipient_base: 'all', capture_rule: 'contractual' });
    refused(is, /holders\.unpaid takes no paid_metric when not_measured/);
  });

  it('paid_metric is read by no other line, except the revenue series it passes on (M4)', () => {
    const crv = (paid: string) => {
      const is = base();
      is.holders.push({ id: 'crv', of: 'core', paid_metric: paid, bucket: 'cash', haircut: 0.01, recipient_base: 'staked', valued_per: 'recipients', capture_rule: 'programmatic' });
      return is;
    };
    expect(() => parse(crv('flow_usd.paid'))).not.toThrow();
    // the revenue series this line passes on (of: core) may be the series measured at the recipients too
    expect(() => parse(crv('flow_usd.core'))).not.toThrow();
    refused(crv('flow_usd.buyback'), /holders\.crv paid_metric "flow_usd\.buyback" is also read by holders\.buyback/);
    refused(crv('flow_usd.partner_fees'), /holders\.crv paid_metric "flow_usd\.partner_fees" is also read by revenue\.partner/);
    refused(crv('flow_usd.treasury'), /holders\.crv paid_metric "flow_usd\.treasury" is also read by protocol\.treasury/);
    const bl = crv('flow_usd.bribes');
    bl.below_line[1] = { id: 'bribes', metric: 'flow_usd.bribes', to: 'protocol' };
    refused(bl, /holders\.crv paid_metric "flow_usd\.bribes" is also read by below_line\.bribes/);
    const two = crv('flow_usd.paid');
    two.holders.push({ id: 'crv2', of: 'partner', paid_metric: 'flow_usd.paid', bucket: 'cash', haircut: 0.01, recipient_base: 'staked', valued_per: 'recipients', capture_rule: 'programmatic' });
    refused(two, /holders\.crv paid_metric "flow_usd\.paid" is also read by holders\.crv2/);
    const der = crv('flow_usd.partner_fees');
    der.revenue[1] = { id: 'partner', derived: { from: 'flow_usd.partner_fees', share: 0.5 } };
    der.cost_of_revenue.shift();
    refused(der, /holders\.crv paid_metric "flow_usd\.partner_fees" is also read by revenue\.partner/);
  });

  it('a measured below_line line to holders needs capture_rule; a not_measured one does not (M3)', () => {
    const rr = base();
    delete rr.below_line[0].capture_rule;
    refused(rr, /below_line\.vote_incentives to holders needs bucket, haircut, recipient_base and capture_rule/);
    const m = base();
    m.below_line[0] = { id: 'vote_incentives', metric: 'flow_usd.bribes', to: 'holders', bucket: 'cash', haircut: 0.03, recipient_base: 'locked' };
    refused(m, /below_line\.vote_incentives to holders needs bucket, haircut, recipient_base and capture_rule/);
    m.below_line[0].capture_rule = 'programmatic';
    expect(() => parse(m)).not.toThrow();
    // base()'s bribes line is not_measured, to holders, with no capture_rule, and parses
    expect(base().below_line[1].capture_rule).toBeUndefined();
    expect(() => parse(base())).not.toThrow();
  });

  it('below_line valued per recipients needs recipient_base staked', () => {
    const is = base();
    is.below_line[0].valued_per = 'recipients';
    refused(is, /below_line\.vote_incentives can be valued per recipients only with recipient_base staked/);
    is.below_line[0].recipient_base = 'staked';
    expect(() => parse(is)).not.toThrow();
  });

  it('check ids are unique and check totals are flows', () => {
    const dup = base();
    dup.checks.push({ id: 'splitter', type: 'sum', total: ['flow_usd.total'], parts: ['buyback'], tolerance_pct: 2 });
    refused(dup, /check id "splitter" is used twice/);
    const lvl = base();
    lvl.checks[0].total = ['partner_share'];
    refused(lvl, /check splitter total "partner_share" is not a flow metric/);
  });

  it('an asset without income_statement keeps its hash', () => {
    // Re-pinned (Task 11, G4): MINI lost its holder_flows block (retired).
    expect(parseAssetYaml(MINI_ASSET_YAML).hash).toBe('5b2f690b96353007bc31b9d29996ed078d92a0404e64f7d05e36ff2b81ae8021');
    expect('income_statement' in parseAssetYaml(MINI_ASSET_YAML).config).toBe(false);
  });
});
