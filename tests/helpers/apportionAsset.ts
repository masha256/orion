import { parse as parseYaml } from 'yaml';

/**
 * A yCRV-shaped liquid locker (Task 7b): the splitter receives `flow_usd.gross` from two senders, `flow_usd.gross_fees`
 * (users pay it: revenue) and `flow_usd.gross_incentives` (third-party vote incentives: below the line), and pays it on as
 * `flow_usd.payout` (stakers) and `flow_usd.treasury` (the protocol). Each paid flow is read twice, apportioned by the
 * window's sender mix. 10-day window.
 */
export const LOCKER_W = 10;

export const LOCKER_YAML = `
id: locker
symbol: LCK
name: Locker
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  circulating_supply: { type: level, unit: tokens, staleness_days: 7 }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  some_ratio: { type: level, unit: ratio, staleness_days: 30 }
  flow_usd.gross: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.gross_fees: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.gross_incentives: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.payout: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.treasury: { type: flow, unit: usd, staleness_days: 45 }
holder_flows:
  - { id: fees, kind: fee_share, capture_rule: programmatic, recipient_base: staked, valued_per: recipients, metric: flow_usd.payout, window_days: ${LOCKER_W} }
reporting:
  window_days: ${LOCKER_W}
  haircuts: { fees: 0 }
  volume: [ flow_usd.gross ]
  income:
    lines:
      - { id: ybs_payout, to: holders, metric: flow_usd.payout }
      - { id: treasury, to: protocol, metric: flow_usd.treasury }
income_statement:
  category: liquid_locker
  scope: complete
  window_days: ${LOCKER_W}
  revenue:
    - { id: fees_rev, metric: flow_usd.gross_fees }
  holders:
    - { id: ybs_payout, metric: flow_usd.payout, apportion: { by: flow_usd.gross_fees, total: flow_usd.gross }, bucket: cash, haircut: 0, recipient_base: staked, valued_per: recipients, capture_rule: programmatic }
  protocol:
    - { id: treasury, metric: flow_usd.treasury, apportion: { by: flow_usd.gross_fees, total: flow_usd.gross } }
  below_line:
    - { id: incentives_to_holders, to: holders, metric: flow_usd.payout, apportion: { by: flow_usd.gross_incentives, total: flow_usd.gross }, bucket: cash, haircut: 0, recipient_base: staked, valued_per: recipients, capture_rule: programmatic, note: "auctioned third-party vote incentives" }
    - { id: incentives_to_protocol, to: protocol, metric: flow_usd.treasury, apportion: { by: flow_usd.gross_incentives, total: flow_usd.gross } }
  checks:
    - { id: splitter, type: sum, total: [ flow_usd.gross ], parts: [ ybs_payout, treasury, incentives_to_holders, incentives_to_protocol ], tolerance_pct: 2 }
    - { id: gross_by_sender, type: sum, total: [ flow_usd.gross ], parts: [ flow_usd.gross_fees, flow_usd.gross_incentives ], tolerance_pct: 0.000001 }
  volume: [ flow_usd.gross ]
`;

/** The locker as a plain object, for tests that edit it before parsing. */
export function lockerObject(): Record<string, any> {
  return parseYaml(LOCKER_YAML) as Record<string, any>;
}
