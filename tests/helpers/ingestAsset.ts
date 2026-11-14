import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';

export const TOKEN = '0x1111111111111111111111111111111111111111';
export const STAKING = '0x2222222222222222222222222222222222222222';
export const SINK = '0x0000000000000000000000000000000000000000';
export const POOL = '0x3333333333333333333333333333333333333333';
export const SAFE = '0x4444444444444444444444444444444444444444';

/**
 * The last line of INGEST_ASSET_YAML's metrics block (a YAML comment): tests insert a metric with
 * `.replace(METRICS_END, `${metric}${METRICS_END}`)`, as they did before `holder_flows:` (the block after it) retired.
 */
export const METRICS_END = '  # end of metrics';

/** The mini asset with every declarative source type wired up (no income statement: it reports nothing). */
export const INGEST_ASSET_YAML = `
id: mini
symbol: MINI
name: Mini Ingest Asset
contracts:
  token: "${TOKEN}"
  staking: "${STAKING}"
  burn_sink: "${SINK}"
  pool: "${POOL}"
  safe: "${SAFE}"
ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL, backfill_days: 3 }
metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: mini-token, field: price }
    cross_checks:
      - { tolerance_pct: 2, source: { type: http_json, url: "https://api.example.test/stats", path: price } }
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: coingecko, id: mini-token, field: circulating_supply }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }
  total_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    tolerance_pct: 0.1
    source: { type: erc20_supply, token: token, subtract_balances: [burn_sink] }
    cross_checks:
      - { source: { type: http_json, url: "https://api.example.test/stats", path: supply.totalBaseUnit, decimals: 18 } }
  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: contract_read, contract: staking, function: totalSupply, decimals: 18 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 400
    source: { type: contract_read, contract: staking, function: emissionRatePerSecond, decimals: 18, scale: 31536000 }
  flow_usd.fees:
    type: flow
    unit: usd
    staleness_days: 45
    critical: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: usd }
    cross_checks:
      - { tolerance_pct: 5, source: { type: defillama, slug: mini, data_type: dailyHoldersRevenue, compare: monthly_sum } }
  flow_tokens.fees:
    type: flow
    unit: tokens
    staleness_days: 45
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: tokens }
  flow_usd.fees_programmatic:
    type: flow
    unit: usd
    staleness_days: 45
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], count_from: [pool], unit: usd }
${METRICS_END}
`;

/** INGEST_ASSET_YAML's CoinGecko price: refused from a config root with a prices.yaml (Phase 3 R2, Ruling R24). */
const CG_PRICE_USD = `  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: mini-token, field: price }
    cross_checks:
      - { tolerance_pct: 2, source: { type: http_json, url: "https://api.example.test/stats", path: price } }
`;
/**
 * INGEST_ASSET_YAML for a config root with a prices.yaml, where a CoinGecko price is refused (Ruling R24): the same asset
 * with price_usd entered by hand (no source, no cross-check); every other metric unchanged.
 */
export const PRICED_INGEST_ASSET_YAML = INGEST_ASSET_YAML.replace(CG_PRICE_USD, '  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }\n');
if (PRICED_INGEST_ASSET_YAML === INGEST_ASSET_YAML) throw new Error('PRICED_INGEST_ASSET_YAML: the price_usd block moved');

/** The mini token's prices.yaml entry (its usd flows are valued at it): what a config root needs since Ruling R32(a). */
export const MINI_PRICES_YAML = `"eip155:8453/0x1111111111111111111111111111111111111111":\n  symbol: MINI\n  decimals: 18\n  chain: eip155:8453\n  valid_from: "2026-09-01"\n` +
  `  primary: { kind: chainlink, feed: "0x${'a'.repeat(40)}" }\n  check: { kind: chainlink, feed: "0x${'b'.repeat(40)}", tolerance_pct: 2 }\n`;

/**
 * An asset YAML as a config root with prices.yaml takes it (Rulings R24, R32): INGEST_ASSET_YAML's CoinGecko price_usd
 * (and its cross-check) becomes the hand-entered price_usd of PRICED_INGEST_ASSET_YAML; any other YAML is unchanged.
 */
export function forPricedRoot(yaml: string): string {
  return yaml.replace(CG_PRICE_USD, '  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }\n');
}

/** Writes `assets/<id>.yaml` (forPricedRoot) and the mini prices.yaml into `home` (Ruling R32(a): a usd flow needs its entry). */
export function writeMiniHome(home: string, id: string, yaml: string): void {
  writeFileSync(join(home, 'assets', `${id}.yaml`), forPricedRoot(yaml));
  writeFileSync(join(home, 'prices.yaml'), MINI_PRICES_YAML);
}

export function ingestAsset(): LoadedAsset {
  return parseAssetYaml(INGEST_ASSET_YAML);
}
