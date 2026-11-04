import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig, IncomeStatementDef } from '../../src/config/schema.js';

export const MINI_ASSET_YAML = `
id: mini
symbol: MINI
name: Mini Test Asset
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, critical: true }
holder_flows:
  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees }
`;

export function miniAsset(): AssetConfig {
  return parseAssetYaml(MINI_ASSET_YAML).config;
}

/**
 * An asset's income statement reduced to what later tasks key on (the asset tests' v2 block shape): category, scope and
 * window, the line ids of each section in order, the check ids, the remainder, and each use line's `of` revenue line.
 * Absent sections stay undefined, so toEqual fails on a section the plan does not list.
 */
export function statementShape(is: IncomeStatementDef | undefined) {
  if (is === undefined) return undefined;
  const ids = (lines?: { id: string }[]) => lines?.map((l) => l.id);
  const uses = [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])];
  return {
    category: is.category,
    scope: is.scope,
    window_days: is.window_days,
    revenue: ids(is.revenue),
    cost_of_revenue: ids(is.cost_of_revenue),
    holders: ids(is.holders),
    protocol: ids(is.protocol),
    operating_costs: ids(is.operating_costs),
    remainder: is.remainder,
    below_line: ids(is.below_line),
    checks: ids(is.checks),
    of: Object.fromEntries(uses.filter((l) => l.of !== undefined).map((l) => [l.id, l.of])),
  };
}
