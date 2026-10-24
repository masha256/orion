import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { INGEST_ASSET_YAML, SAFE } from './ingestAsset.js';

export const TREASURY = '0x5555555555555555555555555555555555555555';

/**
 * The mini asset plus three watched monitor-only metrics: a report flow (the token sent to a treasury by the pool) under
 * `above`, and two display levels read from the stats endpoint, its price under `change_pct` and an `apr` ratio under
 * `outside`. Pass `levels: false` for the flow alone (the stats route then needs no `apr`).
 */
export function watchAssetYaml(opts: { above?: number; changePct?: number; outside?: [number, number]; levels?: boolean } = {}): string {
  const levels = opts.levels ?? true;
  return INGEST_ASSET_YAML.replace(`  safe: "${SAFE}"\n`, `  safe: "${SAFE}"\n  treasury: "${TREASURY}"\n`).replace(
    'holder_flows:',
    `  flow_usd.revenue:
    type: flow
    unit: usd
    staleness_days: 10
    monitor_only: true
    watch: { above: ${opts.above ?? 1000} }
    source: { type: transfer_flow, token: token, to: treasury, from_allowlist: [pool], unit: usd, price_coingecko_id: mini-token }
${
  levels
    ? `  stats_price:
    type: level
    unit: usd
    staleness_days: 3
    monitor_only: true
    watch: { change_pct: ${opts.changePct ?? 5} }
    source: { type: http_json, url: "https://api.example.test/stats", path: price }
  stats_apr:
    type: level
    unit: ratio
    staleness_days: 3
    monitor_only: true
    watch: { outside: [${(opts.outside ?? [0.057, 0.063]).join(', ')}] }
    source: { type: http_json, url: "https://api.example.test/stats", path: apr }
`
    : ''
}holder_flows:`,
  );
}

export const watchAsset = (opts: Parameters<typeof watchAssetYaml>[0] = {}): LoadedAsset => parseAssetYaml(watchAssetYaml(opts));
