import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { revenueStaleMovePct } from '../../src/config/schema.js';
import { contractNames, isChainSource } from '../../src/config/sources.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { INGEST_ASSET_YAML, ingestAsset } from '../helpers/ingestAsset.js';

const bad = (yaml: string): string => {
  try {
    parseAssetYaml(yaml);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
};

describe('declarative sources in the asset config', () => {
  it('parses every source type and fills in defaults', () => {
    const { config } = ingestAsset();
    expect(config.ingest).toEqual({ chain_id: 8453, rpc_url_env: 'TEST_RPC_URL', backfill_days: 3 });
    expect(config.metrics.price_usd.source).toEqual({ type: 'coingecko', id: 'mini-token', field: 'price' });
    expect(config.metrics.price_usd.cross_checks).toEqual([
      { tolerance_pct: 2, source: { type: 'http_json', url: 'https://api.example.test/stats', path: 'price', scale: 1, decimals: 0 } },
    ]);
    expect(config.metrics.staked_supply.source).toEqual({
      type: 'contract_read', contract: 'staking', function: 'totalSupply', abi_type: 'uint256', decimals: 18, scale: 1, offset: 0,
    });
    expect(config.metrics.revenue_run_rate_usd.source).toBeUndefined();
  });

  it('leaves the hash of a config without sources unchanged by the new optional fields', () => {
    const { config } = parseAssetYaml(MINI_ASSET_YAML);
    expect('ingest' in config).toBe(false);
    expect('source' in config.metrics.price_usd).toBe(false);
    expect('cross_checks' in config.metrics.price_usd).toBe(false);
  });

  it('still parses a stored config that carries the legacy fetcher key', () => {
    const { config } = parseAssetYaml(MINI_ASSET_YAML);
    expect(config.metrics.price_usd.fetcher).toBe('manual');
  });

  it('defaults backfill_days to 90', () => {
    const yaml = INGEST_ASSET_YAML.replace('ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL, backfill_days: 3 }', 'ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL }');
    expect(parseAssetYaml(yaml).config.ingest!.backfill_days).toBe(90);
  });

  it('names the contracts a source needs and tells chain sources apart', () => {
    const { config } = ingestAsset();
    expect(contractNames(config.metrics.effective_supply.source!)).toEqual(['token', 'burn_sink']);
    expect(contractNames(config.metrics['flow_usd.fees_programmatic'].source!)).toEqual(['token', 'burn_sink', 'pool', 'safe', 'pool']);
    expect(contractNames(config.metrics.price_usd.source!)).toEqual([]);
    expect(isChainSource(config.metrics.staked_supply.source!)).toBe(true);
    expect(isChainSource(config.metrics.price_usd.source!)).toBe(false);
  });

  it('rejects an unknown contract name', () => {
    expect(bad(INGEST_ASSET_YAML.replace('subtract_balances: [burn_sink]', 'subtract_balances: [nowhere]'))).toMatch(
      /effective_supply.*unknown contract "nowhere"/,
    );
  });

  it('rejects a source type that does not fit the metric type', () => {
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: coingecko, id: mini-token, field: price }', 'source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool], unit: tokens }')))
      .toMatch(/price_usd.*transfer_flow cannot be the source of a level metric/);
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: tokens }', 'source: { type: coingecko, id: mini-token, field: price }')))
      .toMatch(/flow_tokens\.fees.*coingecko cannot be the source of a flow metric/);
  });

  it('never allows defillama as a primary, or transfer_flow and derived as cross-checks', () => {
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: coingecko, id: mini-token, field: circulating_supply }', 'source: { type: defillama, slug: mini, data_type: x, compare: monthly_sum }')))
      .toMatch(/circulating_supply.*defillama cannot be the source/);
    expect(bad(INGEST_ASSET_YAML.replace('- { tolerance_pct: 2, source: { type: http_json, url: "https://api.example.test/stats", path: price } }', '- { source: { type: derived, name: x } }')))
      .toMatch(/price_usd.*derived cannot be a cross-check/);
  });

  it('allows defillama as the primary of a usd flow, and keeps the two roles apart', () => {
    const asPrimary = (source: string) =>
      INGEST_ASSET_YAML.replace('source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], count_from: [pool], unit: usd, price_coingecko_id: mini-token }', source);
    expect(bad(asPrimary('source: { type: defillama, slug: mini, data_type: dailyHoldersRevenue }'))).toBe('');
    expect(bad(asPrimary('source: { type: defillama, slug: mini, data_type: dailyHoldersRevenue, backfill_days: 30 }'))).toBe('');
    expect(bad(asPrimary('source: { type: defillama, slug: mini, data_type: dailyHoldersRevenue, compare: monthly_sum }')))
      .toMatch(/fees_programmatic.*compare is for the cross-check role/);
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: tokens }', 'source: { type: defillama, slug: mini, data_type: x }')))
      .toMatch(/flow_tokens\.fees.*needs unit usd/);
    expect(bad(INGEST_ASSET_YAML.replace('compare: monthly_sum }', '}'))).toMatch(/flow_usd\.fees\.cross_checks\.0.*needs compare: monthly_sum/);
    expect(bad(INGEST_ASSET_YAML.replace('compare: monthly_sum }', 'compare: monthly_sum, backfill_days: 5 }'))).toMatch(/cross_checks\.0.*backfill_days is for the primary role/);
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: usd, price_coingecko_id: mini-token }', 'source: { type: defillama, slug: mini, data_type: dailyHoldersRevenue }')))
      .toMatch(/flow_usd\.fees\.cross_checks\.0.*cannot be cross-checked against defillama/);
  });

  it('rejects cross_checks on a metric that has no source', () => {
    expect(bad(INGEST_ASSET_YAML.replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
      'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, cross_checks: [ { source: { type: coingecko, id: x, field: price } } ] }')))
      .toMatch(/revenue_run_rate_usd.*cross_checks need a primary source/);
  });

  it('requires a price id for a USD flow and keeps count_from inside the allowlist', () => {
    expect(bad(INGEST_ASSET_YAML.replace('from_allowlist: [pool, safe], unit: usd, price_coingecko_id: mini-token }\n    cross_checks', 'from_allowlist: [pool, safe], unit: usd }\n    cross_checks')))
      .toMatch(/flow_usd\.fees.*price_coingecko_id/);
    expect(bad(INGEST_ASSET_YAML.replace('count_from: [pool]', 'count_from: [staking]'))).toMatch(/count_from "staking" is not in from_allowlist/);
  });

  it('never lets an undocumented JSON endpoint be the primary source of a required metric', () => {
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: coingecko, id: mini-token, field: price }', 'source: { type: http_json, url: "https://api.example.test/stats", path: price }')))
      .toMatch(/price_usd.*http_json cannot be the primary source of a required metric/);
  });

  it('requires the ingest block when a chain source is configured', () => {
    expect(bad(INGEST_ASSET_YAML.replace('ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL, backfill_days: 3 }\n', ''))).toMatch(/ingest.*required/);
  });

  it('reads the stale-revenue threshold, defaulting to 30, and rejects a bad one', () => {
    expect(revenueStaleMovePct(ingestAsset().config)).toBe(30);
    expect(revenueStaleMovePct(parseAssetYaml(`${INGEST_ASSET_YAML}review_triggers: { revenue_stale_move_pct: 45 }\n`).config)).toBe(45);
    expect(bad(`${INGEST_ASSET_YAML}review_triggers: { revenue_stale_move_pct: -1 }\n`)).toMatch(/revenue_stale_move_pct must be a positive number/);
  });
});
