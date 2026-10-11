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
  z.strictObject({
    type: z.literal('defillama'),
    slug: name,
    data_type: name,
    /** Required in the cross-check role, forbidden in the primary role (sourceIssues). */
    compare: z.literal('monthly_sum').optional(),
    /** Primary role only: how far back the first fetch writes. Optional with no default; the writer applies 90. */
    backfill_days: z.number().int().positive().optional(),
  }),
  z.strictObject({ type: z.literal('erc20_supply'), token: name, subtract_balances: z.array(name).default([]) }),
  z.strictObject({
    type: z.literal('contract_read'),
    contract: name,
    function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    abi_type: z.string().regex(/^uint(8|16|32|64|128|256)$/).default('uint256'),
    decimals: z.number().int().min(0).max(36).default(0),
    scale: z.number().default(1),
    offset: z.number().default(0),
    /** Contract names passed as `address` arguments, e.g. `balanceOf(holder)`. Optional with no default (hashes). */
    args: z.array(name).min(1).optional(),
    /**
     * For a function returning several values (a struct, e.g. veCRV `locked(address)` -> (int128 amount, uint256 end)):
     * the full return types, and which one to read. `abi_type` is ignored when set. A negative value is refused.
     */
    returns: z.array(z.string().regex(/^u?int(8|16|32|64|128|256)$/)).min(2).optional(),
    pick: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    type: z.literal('transfer_flow'),
    token: name,
    to: name,
    /** The senders whose transfers are the flow; any other sender is reported as unlisted. Exactly one of this and `from_any`. */
    from_allowlist: z.array(name).min(1).optional(),
    /**
     * Every sender is the flow except the ignore lists (UNI: anyone may burn UNI to release fees, and searcher contracts rotate
     * weekly, so an allowlist would flag noise). Nothing is ever reported as unlisted. Optional with no default (hashes).
     */
    from_any: z.literal(true).optional(),
    /** Subset of the allowlist to sum. Default: all of it. Not with `from_any`. */
    count_from: z.array(name).min(1).optional(),
    unit: z.enum(['usd', 'tokens']),
    price_coingecko_id: name.optional(),
    /**
     * When the transferred token is a vault share, convert each day's shares to the underlying token before pricing:
     * tokens × `function()` (e.g. pricePerShare, scaled by `decimals`), read at the last block of the day. The price id
     * is then the underlying's. Optional with no default, so existing config hashes do not move.
     */
    share_price: z
      .strictObject({ contract: name, function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), decimals: z.number().int().min(0).max(36) })
      .optional(),
    /**
     * Known senders that are not this flow (another product's fees, a distributor's dust): never counted, never reported
     * as unlisted. Names from `contracts`; give each a why-comment in the YAML. Optional with no default (hashes).
     */
    from_ignore: z.array(name).min(1).optional(),
    /**
     * Implementations whose EIP-1167 minimal-proxy clones are ignored like `from_ignore` (a factory's per-pool sidecars,
     * too many to list). Matched on the sender's runtime code; trailing immutable-arg bytes after the proxy are allowed.
     */
    from_ignore_clones_of: z.array(name).min(1).optional(),
    /**
     * Who a mint (a transfer from 0x0) is from. erc4626_deposit: the depositor of the vault's own ERC-4626 Deposit event in
     * the same transaction (token = vault, owner = the sink, shares = the minted amount); the allow/ignore lists then apply
     * to that address. A mint with no matching Deposit stays 0x0 (so it is reported). Optional with no default (hashes).
     */
    mint_sender: z.literal('erc4626_deposit').optional(),
  }).superRefine((s, ctx) => {
    if ((s.from_allowlist === undefined) === (s.from_any === undefined)) ctx.addIssue({ code: 'custom', message: 'a transfer_flow needs exactly one of from_allowlist and from_any' });
    if (s.from_any && s.count_from) ctx.addIssue({ code: 'custom', message: 'count_from picks from an allowlist; with from_any every sender counts' });
    const allow = new Set(s.from_allowlist ?? []);
    for (const n of [...(s.from_ignore ?? []), ...(s.from_ignore_clones_of ?? [])]) {
      if (allow.has(n)) ctx.addIssue({ code: 'custom', message: `${n} is on from_allowlist and on an ignore list; a sender is one or the other` });
    }
  }),
  z.strictObject({ type: z.literal('adapter'), name, params }),
  /**
   * A structural constant of the asset (CRV's staker emission share is 0: every emission goes to LP gauges). Written as
   * a fetched level every run, so it never goes stale and, not being manual, does not cap the grade. Changing it is an
   * edit of the asset file, which moves the config hash and which the agent can only propose.
   */
  z.strictObject({ type: z.literal('constant'), value: z.number().finite(), note: z.string().min(1) }),
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
      return [s.contract, ...(s.args ?? [])];
    case 'transfer_flow':
      return [
        s.token, s.to, ...(s.from_allowlist ?? []), ...(s.count_from ?? []), ...(s.share_price ? [s.share_price.contract] : []),
        ...(s.from_ignore ?? []), ...(s.from_ignore_clones_of ?? []),
      ];
    default:
      return [];
  }
}

const LEVEL_PRIMARY: ReadonlySet<string> = new Set(['coingecko', 'http_json', 'erc20_supply', 'contract_read', 'adapter', 'derived', 'constant']);
const LEVEL_CHECK: ReadonlySet<string> = new Set(['coingecko', 'http_json', 'erc20_supply', 'contract_read', 'adapter']);
const FLOW_PRIMARY: ReadonlySet<string> = new Set(['transfer_flow', 'defillama', 'adapter']);
const FLOW_CHECK: ReadonlySet<string> = new Set(['defillama', 'adapter']);

export interface SourceBearingAsset {
  contracts: Record<string, string>;
  ingest?: unknown;
  metrics: Record<
    string,
    { type: 'level' | 'flow' | 'schedule' | 'event'; unit: string; source?: SourceConfig; cross_checks?: { source: SourceConfig; tolerance_pct?: number }[] }
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
      for (const c of s.count_from ?? []) if (!(s.from_allowlist ?? []).includes(c)) issues.push(`${where}: count_from "${c}" is not in from_allowlist`);
    }
    if (s.type === 'contract_read' && (s.returns === undefined) !== (s.pick === undefined)) {
      issues.push(`${where}: returns and pick go together`);
    }
    if (s.type === 'contract_read' && s.returns !== undefined && s.pick !== undefined && s.pick >= s.returns.length) {
      issues.push(`${where}: pick ${s.pick} is past the ${s.returns.length} return values`);
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
    const fits = def.type === 'flow' ? FLOW_PRIMARY.has(s.type) : def.type === 'event' ? false : LEVEL_PRIMARY.has(s.type);
    if (!fits) issues.push(`${where}: ${s.type} cannot be the source of a ${def.type} metric`);
    if (s.type === 'defillama' && def.type === 'flow') {
      if (s.compare !== undefined) issues.push(`${where}: compare is for the cross-check role; a defillama primary has none`);
      if (def.unit !== 'usd') issues.push(`${where}: a defillama primary needs unit usd; the series is in dollars`);
    }
    if (s.type === 'http_json' && requiredMetrics.includes(key)) {
      issues.push(`${where}: http_json cannot be the primary source of a required metric (use it as a cross-check)`);
    }
    checkShape(where, s);

    checks.forEach((c, i) => {
      const allowed = def.type === 'flow' ? FLOW_CHECK : LEVEL_CHECK;
      if (!allowed.has(c.source.type)) issues.push(`${where}.cross_checks.${i}: ${c.source.type} cannot be a cross-check of a ${def.type} metric`);
      if (c.source.type === 'defillama') {
        if (c.source.compare === undefined) issues.push(`${where}.cross_checks.${i}: a defillama cross-check needs compare: monthly_sum`);
        if (c.source.backfill_days !== undefined) issues.push(`${where}.cross_checks.${i}: backfill_days is for the primary role`);
        if (s.type === 'defillama') issues.push(`${where}.cross_checks.${i}: a defillama primary cannot be cross-checked against defillama`);
      }
      checkShape(`${where}.cross_checks.${i}`, c.source);
    });
  }

  if (usesChain && asset.ingest === undefined) issues.push('ingest: required when a metric reads from a chain (erc20_supply, contract_read, transfer_flow)');
  return issues;
}
