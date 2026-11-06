import { describe, expect, it } from 'vitest';
import { resolveChecks } from '../../src/checks/schema.js';
import { parseAssetObject } from '../../src/config/load.js';
import { lockerObject } from '../helpers/apportionAsset.js';

/**
 * Task 7b: a measured flow may be read by more than one statement line only as an apportion set, whose `by` series
 * partition its `total` (same total, distinct by, and a sum check total = [total], parts = the by series).
 */
const parse = (o: unknown) => parseAssetObject(o);
const refused = (o: unknown, re: RegExp) => expect(() => parse(o)).toThrow(re);

describe('income_statement apportion: schema', () => {
  it('accepts the yCRV shape, parsed exactly as written', () => {
    const o = lockerObject();
    const { config } = parse(o);
    expect(config.income_statement).toStrictEqual(o.income_statement);
    expect(config.income_statement!.holders![0]!.apportion).toEqual({ by: 'flow_usd.gross_fees', total: 'flow_usd.gross' });
  });

  it('still refuses a series read twice without apportion', () => {
    const o = lockerObject();
    delete o.income_statement.below_line[0].apportion;
    refused(o, /metric "flow_usd\.payout" is read by two lines \(holders\.ybs_payout and below_line\.incentives_to_holders\)/);
    const both = lockerObject();
    delete both.income_statement.holders[0].apportion;
    delete both.income_statement.below_line[0].apportion;
    refused(both, /metric "flow_usd\.payout" is read by two lines/);
  });

  it('refuses an apportion set whose lines name different totals', () => {
    const o = lockerObject();
    o.income_statement.below_line[0].apportion.total = 'flow_usd.treasury';
    refused(o, /apportion of "flow_usd\.payout": holders\.ybs_payout and below_line\.incentives_to_holders name different totals/);
  });

  it('refuses an apportion set that names one by series twice', () => {
    const o = lockerObject();
    o.income_statement.below_line[0].apportion.by = 'flow_usd.gross_fees';
    refused(o, /apportion of "flow_usd\.payout": by "flow_usd\.gross_fees" is named twice \(holders\.ybs_payout and below_line\.incentives_to_holders\)/);
  });

  it('refuses a by or total that is not a flow, and a by equal to its total', () => {
    const lvl = lockerObject();
    lvl.income_statement.holders[0].apportion.by = 'some_ratio';
    refused(lvl, /holders\.ybs_payout apportion by "some_ratio" is not a flow metric/);
    const tot = lockerObject();
    tot.income_statement.protocol[0].apportion.total = 'some_ratio';
    refused(tot, /protocol\.treasury apportion total "some_ratio" is not a flow metric/);
    const missing = lockerObject();
    missing.income_statement.holders[0].apportion.by = 'flow_usd.nope';
    refused(missing, /holders\.ybs_payout apportion by "flow_usd\.nope" is not a flow metric/);
    const same = lockerObject();
    same.income_statement.holders[0].apportion.by = 'flow_usd.gross';
    refused(same, /holders\.ybs_payout apportion by "flow_usd\.gross" is its total/);
  });

  it('refuses an apportion set with no sum check proving its by series partition the total', () => {
    const none = lockerObject();
    none.income_statement.checks = none.income_statement.checks.filter((c: { id: string }) => c.id !== 'gross_by_sender');
    refused(none, /apportion of "flow_usd\.payout" by \[flow_usd\.gross_fees, flow_usd\.gross_incentives\] needs a sum check with total \[flow_usd\.gross\] and parts \[flow_usd\.gross_fees, flow_usd\.gross_incentives\]/);
    // a check whose parts miss a by series does not prove the partition
    const short = lockerObject();
    short.income_statement.checks[1].parts = ['flow_usd.gross_fees'];
    refused(short, /apportion of "flow_usd\.payout" by .* needs a sum check/);
    // nor one with another total
    const other = lockerObject();
    other.income_statement.checks[1].total = ['flow_usd.treasury'];
    refused(other, /apportion of "flow_usd\.treasury" by .* needs a sum check/);
    // a set of one line (the rest of the flow on no line) is not a partition: the check would need parts [by] alone
    const one = lockerObject();
    one.income_statement.below_line = [one.income_statement.below_line[1]];
    refused(one, /apportion of "flow_usd\.payout" by \[flow_usd\.gross_fees\] needs a sum check/);
  });

  it('the partition check may name a by series through the revenue line that reads it', () => {
    const o = lockerObject();
    o.income_statement.checks[1].parts = ['fees_rev', 'flow_usd.gross_incentives'];
    expect(() => parse(o)).not.toThrow();
  });

  it('refuses apportion without a metric, and with paid_metric', () => {
    const o = lockerObject();
    o.income_statement.below_line[1] = { id: 'incentives_to_protocol', to: 'protocol', not_measured: 'n/m', apportion: { by: 'flow_usd.gross_incentives', total: 'flow_usd.gross' } };
    refused(o, /below_line\.incentives_to_protocol takes apportion only with a metric/);
    const paid = lockerObject();
    paid.income_statement.holders[0].paid_metric = 'flow_usd.treasury';
    refused(paid, /holders\.ybs_payout takes no paid_metric with apportion/);
  });

  it('refuses a sum check naming only part of an apportion set (its factor would move with the mix)', () => {
    const o = lockerObject();
    o.income_statement.checks[0].parts = ['ybs_payout', 'treasury'];
    refused(o, /check splitter part "ybs_payout" is apportioned: list every line of its set \(ybs_payout, incentives_to_holders\)/);
  });

  it('a sum check over whole apportion sets resolves each set to its flow once; metric parts resolve to themselves', () => {
    const { config } = parse(lockerObject());
    const checks = resolveChecks(config);
    const splitter = checks.find((c) => c.id === 'splitter')!;
    expect(splitter).toMatchObject({ type: 'sum', total: [{ metric: 'flow_usd.gross', factor: 1 }] });
    expect(splitter.type === 'sum' && splitter.parts.map((t) => [t.metric, t.factor])).toEqual([['flow_usd.payout', 1], ['flow_usd.treasury', 1]]);
    const bySender = checks.find((c) => c.id === 'gross_by_sender')!;
    expect(bySender.type === 'sum' && bySender.parts.map((t) => [t.metric, t.factor])).toEqual([['flow_usd.gross_fees', 1], ['flow_usd.gross_incentives', 1]]);
  });

  it('refuses a sum check part that is neither a line nor a metric', () => {
    const o = lockerObject();
    o.income_statement.checks[1].parts = ['flow_usd.gross_fees', 'flow_usd.nope'];
    refused(o, /check gross_by_sender part "flow_usd\.nope" is not a line id or a metric/);
  });
});
