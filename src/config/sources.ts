import { z } from 'zod';

const name = z.string().min(1);
const params = z.record(z.string(), z.unknown()).default({});

/** The declarative source vocabulary (ingestion spec 4.1). Contract names are keys of the asset's `contracts` map. */
export const SourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('coingecko'), id: name, field: z.enum(['price', 'market_cap', 'circulating_supply']) }),
  z.strictObject({
    type: z.literal('http_json'),
    url: z.url(),
    /** Dot path into the JSON; numeric segments index arrays. */
    path: name,
    scale: z.number().default(1),
    decimals: z.number().int().min(0).max(36).default(0),
  }),
  z.strictObject({ type: z.literal('defillama'), slug: name, data_type: name, compare: z.literal('monthly_sum') }),
  z.strictObject({ type: z.literal('erc20_supply'), token: name, subtract_balances: z.array(name).default([]) }),
  z.strictObject({
    type: z.literal('contract_read'),
    contract: name,
    function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    abi_type: z.string().regex(/^uint(8|16|32|64|128|256)$/).default('uint256'),
    decimals: z.number().int().min(0).max(36).default(0),
    scale: z.number().default(1),
    offset: z.number().default(0),
  }),
  z.strictObject({
    type: z.literal('transfer_flow'),
    token: name,
    to: name,
    from_allowlist: z.array(name).min(1),
    /** Subset of the allowlist to sum. Default: all of it. */
    count_from: z.array(name).min(1).optional(),
    unit: z.enum(['usd', 'tokens']),
    price_coingecko_id: name.optional(),
  }),
  z.strictObject({ type: z.literal('adapter'), name, params }),
  z.strictObject({ type: z.literal('derived'), name, params }),
]);

export type SourceConfig = z.infer<typeof SourceSchema>;
export type SourceOf<T extends SourceConfig['type']> = Extract<SourceConfig, { type: T }>;

/** A missing tolerance falls back to the metric's own tolerance_pct. */
export const CrossCheckSchema = z.strictObject({ source: SourceSchema, tolerance_pct: z.number().nonnegative().optional() });

export const IngestSchema = z.strictObject({
  chain_id: z.number().int().positive(),
  /** Name of the environment variable that holds the RPC URL. */
  rpc_url_env: name,
  backfill_days: z.number().int().positive().default(90),
});

export function isChainSource(s: SourceConfig): boolean {
  return s.type === 'erc20_supply' || s.type === 'contract_read' || s.type === 'transfer_flow';
}

export function contractNames(s: SourceConfig): string[] {
  switch (s.type) {
    case 'erc20_supply':
      return [s.token, ...s.subtract_balances];
    case 'contract_read':
      return [s.contract];
    case 'transfer_flow':
      return [s.token, s.to, ...s.from_allowlist, ...(s.count_from ?? [])];
    default:
      return [];
  }
}

const LEVEL_PRIMARY: ReadonlySet<string> = new Set(['coingecko', 'http_json', 'erc20_supply', 'contract_read', 'adapter', 'derived']);
const LEVEL_CHECK: ReadonlySet<string> = new Set(['coingecko', 'http_json', 'erc20_supply', 'contract_read', 'adapter']);
const FLOW_CHECK: ReadonlySet<string> = new Set(['defillama', 'adapter']);

export interface SourceBearingAsset {
  contracts: Record<string, string>;
  ingest?: unknown;
  metrics: Record<
    string,
    { type: 'level' | 'flow' | 'schedule' | 'event'; source?: SourceConfig; cross_checks?: { source: SourceConfig; tolerance_pct?: number }[] }
  >;
}

/** Cross-field validation of every source in an asset. `requiredMetrics` are the standard metrics the engine cannot run without. */
export function sourceIssues(asset: SourceBearingAsset, requiredMetrics: string[]): string[] {
  const issues: string[] = [];
  let usesChain = false;

  const checkShape = (where: string, s: SourceConfig) => {
    for (const c of contractNames(s)) if (asset.contracts[c] === undefined) issues.push(`${where}: unknown contract "${c}"`);
    if (s.type === 'transfer_flow') {
      if (s.unit === 'usd' && s.price_coingecko_id === undefined) issues.push(`${where}: a transfer_flow with unit usd needs price_coingecko_id`);
      for (const c of s.count_from ?? []) if (!s.from_allowlist.includes(c)) issues.push(`${where}: count_from "${c}" is not in from_allowlist`);
    }
    if (isChainSource(s)) usesChain = true;
  };

  for (const [key, def] of Object.entries(asset.metrics)) {
    const where = `metrics.${key}`;
    const checks = def.cross_checks ?? [];
    if (def.source === undefined) {
      if (checks.length > 0) issues.push(`${where}: cross_checks need a primary source`);
      continue;
    }
    const s = def.source;
    const fits = def.type === 'flow' ? s.type === 'transfer_flow' : def.type === 'event' ? false : LEVEL_PRIMARY.has(s.type);
    if (!fits) issues.push(`${where}: ${s.type} cannot be the source of a ${def.type} metric`);
    if (s.type === 'http_json' && requiredMetrics.includes(key)) {
      issues.push(`${where}: http_json cannot be the primary source of a required metric (use it as a cross-check)`);
    }
    checkShape(where, s);

    checks.forEach((c, i) => {
      const allowed = def.type === 'flow' ? FLOW_CHECK : LEVEL_CHECK;
      if (!allowed.has(c.source.type)) issues.push(`${where}.cross_checks.${i}: ${c.source.type} cannot be a cross-check of a ${def.type} metric`);
      checkShape(`${where}.cross_checks.${i}`, c.source);
    });
  }

  if (usesChain && asset.ingest === undefined) issues.push('ingest: required when a metric reads from a chain (erc20_supply, contract_read, transfer_flow)');
  return issues;
}
