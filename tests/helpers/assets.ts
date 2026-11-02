import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';

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
