import type { SourceConfig } from '../config/sources.js';

/**
 * One stable id per source. It is the batch key (requests with the same id are served together),
 * the key of the source's entry in fetch_runs.detail, and the dedupe key of cross-check and
 * failure-streak anomalies.
 */
export function sourceId(s: SourceConfig): string {
  switch (s.type) {
    case 'coingecko':
      return 'coingecko';
    case 'http_json':
      return `http_json:${s.url}`;
    case 'defillama':
      return `defillama:${s.slug}:${s.data_type}`;
    case 'erc20_supply':
    case 'contract_read':
      return 'chain_levels';
    case 'transfer_flow':
      return `transfer_flow:${s.token}>${s.to}[${[...s.from_allowlist].sort().join(',')}]`;
    case 'adapter':
      return `adapter:${s.name}`;
    case 'derived':
      return `derived:${s.name}`;
  }
}
