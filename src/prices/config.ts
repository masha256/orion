import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import type { AssetConfig } from '../config/schema.js';
import { evmTokenRef, solanaTokenRef } from '../db/prices.js';
import { OrionError } from '../types.js';

/**
 * The central price config (Phase 3 R2, plan P1): `prices.yaml` at the config root, keyed by token ref, one primary method
 * and one check per ref. Asset YAMLs name refs (through their contracts and symbol), never methods; an asset's config
 * hash includes the entries of every ref it uses (entriesFor), so a method change shows as "config" on that asset.
 */

export const PRICES_FILE = 'prices.yaml';

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x address');
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte 0x id');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Decoded byte length of a base58 string, or undefined when a character is outside the alphabet. */
export function base58ByteLength(s: string): number | undefined {
  let n = 0n;
  for (const ch of s) {
    const d = BASE58.indexOf(ch);
    if (d < 0) return undefined;
    n = n * 58n + BigInt(d);
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros += 1;
  let len = 0;
  for (let v = n; v > 0n; v >>= 8n) len += 1;
  return zeros + len;
}
/** A Solana account address: base58 that decodes to exactly 32 bytes. */
const solanaAddress = z
  .string()
  .refine((s) => base58ByteLength(s) === 32, { message: 'must be a base58 32-byte Solana address' });
const EVM_REF = /^eip155:(\d+)\/0x[0-9a-f]{40}$/;
const SOLANA_REF = /^solana:mainnet\/[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HYPERLIQUID_REF = /^hyperliquid:spot\/@\d+$/;
const tokenRef = z.string().refine((r) => EVM_REF.test(r) || SOLANA_REF.test(r) || HYPERLIQUID_REF.test(r), {
  message: 'must be a token ref (eip155:<chain>/<lowercase 0x address>, solana:mainnet/<mint> or hyperliquid:spot/@<index>)',
});
/** Either a token ref priced in this file or a Chainlink feed (8 decimals, latestRoundData) turns the quote into USD. */
const quote = { quote_ref: tokenRef.optional(), usd_feed: evmAddress.optional() };

const METHOD_SHAPES = [
  z.strictObject({ kind: z.literal('chainlink'), feed: evmAddress }),
  /** `price_oracle()`, or `price_oracle(index)` on a multi-coin pool: the EMA price of the coin in the pool's quote. */
  z.strictObject({ kind: z.literal('curve_oracle'), pool: evmAddress, index: z.number().int().nonnegative().optional(), ...quote }),
  /** `get_dy(i, j, dx)` divided by (1 - fee): the executable spot; `dx` in tokens of coin i (writer default 1). */
  z.strictObject({ kind: z.literal('curve_get_dy'), pool: evmAddress, i: z.number().int().nonnegative(), j: z.number().int().nonnegative(), dx: z.number().positive().optional(), quote_ref: tokenRef }),
  /** The cumulative-price TWAP between B(H) and B(H+1h). */
  z.strictObject({ kind: z.literal('v2_twap'), pool: evmAddress, flavor: z.enum(['uniswap', 'aerodrome']), ...quote }),
  /** `observe([3600, 0])`: the one-hour TWAP ending at B(H+1h) (Uniswap/PancakeSwap v3, Slipstream). */
  z.strictObject({ kind: z.literal('v3_twap'), pool: evmAddress, seconds: z.literal(3600), ...quote }),
  /** `slot0()` sqrtPriceX96 at B(H+1h) (Uniswap v3-style pool spot, e.g. Slipstream). */
  z.strictObject({ kind: z.literal('v3_spot'), pool: evmAddress, ...quote }),
  /** StateView `getSlot0(pool_id)` at B(H+1h); an hour whose in-range liquidity (`getLiquidity`) is 0 is skipped. */
  z.strictObject({ kind: z.literal('v4_spot'), state_view: evmAddress, pool_id: bytes32, ...quote }),
  /** Hyperliquid `candleSnapshot` hourly close of `coin` (live: `allMids[coin]`), in USDC. */
  z.strictObject({ kind: z.literal('hyperliquid_candle'), coin: z.string().regex(/^(@\d+|[A-Z0-9]+)$/), usd_feed: evmAddress }),
  /** Lighter `/api/v1/candles` hourly close of `market_id` (live: order-book mid), in USDC. */
  z.strictObject({ kind: z.literal('lighter_candle'), market_id: z.number().int().nonnegative(), usd_feed: evmAddress }),
  /** Quote vault / base vault token balances (live: the accounts; history: the last swap's postTokenBalances before H+1h). */
  z.strictObject({ kind: z.literal('solana_vaults'), base_vault: solanaAddress, quote_vault: solanaAddress, usd_feed: evmAddress }),
  /** Meteora DLMM `lb_pair` active bin price, (1 + bin_step / 1e4) ^ active_id. */
  z.strictObject({ kind: z.literal('meteora_dlmm'), pair: solanaAddress, usd_feed: evmAddress }),
  /** A sanity band in the quote ref (no independent venue exists): a breach is a price outside [min, max]. Check only. */
  z.strictObject({ kind: z.literal('bound'), min_in_quote: z.number().positive(), max_in_quote: z.number().positive(), quote_ref: tokenRef }),
] as const;

const MethodSchema = z.discriminatedUnion('kind', METHOD_SHAPES);
const CHECK_FIELDS = {
  /** Required on every check but `bound`, refused on `bound` (its band is the tolerance). */
  tolerance_pct: z.number().positive().optional(),
  /** Hours the gap must exceed the tolerance in a row before it is a breach. */
  consecutive: z.number().int().positive().default(1),
  label: z.enum(['same_venue', 'no_independent_check']).optional(),
};
const CheckSchema = z.discriminatedUnion(
  'kind',
  METHOD_SHAPES.map((m) => m.extend(CHECK_FIELDS)) as unknown as [
    z.ZodObject<{ kind: z.ZodLiteral<string> }>,
    ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[],
  ],
);

const CHAINS = ['eip155:1', 'eip155:56', 'eip155:8453', 'solana', 'hyperliquid', 'lighter'] as const;
const EntrySchema = z.strictObject({
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  /** Where the PRIMARY is read: an EVM chain, or an off-chain venue (LIT's ref is its Ethereum address, read on Lighter). */
  chain: z.enum(CHAINS),
  /** The first hour (UTC day start) Orion writes a price for this ref. */
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD day'),
  primary: MethodSchema,
  check: CheckSchema,
});
const FileSchema = z.record(z.string(), EntrySchema);

export type PriceMethod = z.infer<typeof MethodSchema>;
export type PriceChain = (typeof CHAINS)[number];
export type PriceCheck = PriceMethod & { tolerancePct: number; consecutive: number; label?: 'same_venue' | 'no_independent_check' };
export interface PriceEntry {
  ref: string;
  symbol: string;
  decimals: number;
  chain: PriceChain;
  validFrom: string;
  primary: PriceMethod;
  /** For `bound`, tolerancePct is 0 and unused: the breach is a price outside [min_in_quote, max_in_quote]. */
  check: PriceCheck;
}

const EVM_KINDS: ReadonlySet<string> = new Set(['chainlink', 'curve_oracle', 'curve_get_dy', 'v2_twap', 'v3_twap', 'v3_spot', 'v4_spot']);
const SOLANA_KINDS: ReadonlySet<string> = new Set(['solana_vaults', 'meteora_dlmm']);
const QUOTED_KINDS: ReadonlySet<string> = new Set(['curve_oracle', 'v2_twap', 'v3_twap', 'v3_spot', 'v4_spot']);

/** `chain:<kind>` for a method read from a chain, `first_party:<venue>` for a venue's own API. */
export function methodSource(m: PriceMethod): string {
  if (m.kind === 'hyperliquid_candle') return 'first_party:hyperliquid';
  if (m.kind === 'lighter_candle') return 'first_party:lighter';
  return `chain:${m.kind}`;
}

/** The token ref a method's price is quoted in (multiplied by), if any. */
export function quoteRefOf(m: PriceMethod): string | undefined {
  return 'quote_ref' in m ? m.quote_ref : undefined;
}

/** The chain the primary of a ref with this chain field must be read on, by method kind. */
function primaryFits(chain: PriceChain, kind: string): boolean {
  if (chain.startsWith('eip155:')) return EVM_KINDS.has(kind);
  if (chain === 'solana') return SOLANA_KINDS.has(kind);
  if (chain === 'hyperliquid') return kind === 'hyperliquid_candle';
  return kind === 'lighter_candle';
}

/** The ref's namespace must agree with `chain`: eip155:N refs on chain eip155:N (or an off-chain venue, `lighter`). */
function refFits(ref: string, chain: PriceChain): boolean {
  const evm = EVM_REF.exec(ref);
  if (chain.startsWith('eip155:')) return evm !== null && `eip155:${evm[1]}` === chain;
  if (chain === 'solana') return SOLANA_REF.test(ref);
  if (chain === 'hyperliquid') return HYPERLIQUID_REF.test(ref);
  return evm !== null;
}

function methodIssues(where: string, m: PriceMethod, role: 'primary' | 'check'): string[] {
  const out: string[] = [];
  if (QUOTED_KINDS.has(m.kind)) {
    const q = m as { quote_ref?: string; usd_feed?: string };
    if ((q.quote_ref === undefined) === (q.usd_feed === undefined)) out.push(`${where}: ${m.kind} needs exactly one of quote_ref and usd_feed`);
  }
  if (m.kind === 'curve_get_dy' && m.i === m.j) out.push(`${where}: curve_get_dy needs i != j`);
  if (m.kind === 'bound') {
    if (role === 'primary') out.push(`${where}: bound is a check, never a primary`);
    if (m.min_in_quote >= m.max_in_quote) out.push(`${where}: bound needs min_in_quote < max_in_quote`);
  }
  return out;
}

/** Parses a prices.yaml object; every refusal names the ref and field. `where` prefixes the messages (the file). */
export function parsePrices(obj: unknown, where = PRICES_FILE): Map<string, PriceEntry> {
  const parsed = FileSchema.safeParse(obj ?? {});
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${where}: ${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
    throw new OrionError('invalid_price_config', lines.join('\n'));
  }
  const issues: string[] = [];
  const out = new Map<string, PriceEntry>();
  for (const [ref, e] of Object.entries(parsed.data)) {
    const at = `${where}: ${ref}`;
    if (!tokenRef.safeParse(ref).success) issues.push(`${at}: not a token ref (eip155:<chain>/<lowercase 0x address>, solana:mainnet/<mint> or hyperliquid:spot/@<index>)`);
    else if (!refFits(ref, e.chain)) issues.push(`${at}: the ref's chain contradicts chain ${e.chain}`);
    if (!primaryFits(e.chain, e.primary.kind)) issues.push(`${at}.primary: ${e.primary.kind} is not read on chain ${e.chain}`);
    issues.push(...methodIssues(`${at}.primary`, e.primary, 'primary'));
    const { tolerance_pct, consecutive, label, ...checkMethod } = e.check as PriceMethod & { tolerance_pct?: number; consecutive: number; label?: PriceCheck['label'] };
    issues.push(...methodIssues(`${at}.check`, checkMethod as PriceMethod, 'check'));
    if (checkMethod.kind === 'bound' && tolerance_pct !== undefined) issues.push(`${at}.check.tolerance_pct: a bound check has no tolerance (its band is the tolerance)`);
    if (checkMethod.kind !== 'bound' && tolerance_pct === undefined) issues.push(`${at}.check.tolerance_pct: required`);
    out.set(ref, {
      ref, symbol: e.symbol, decimals: e.decimals, chain: e.chain, validFrom: e.valid_from, primary: e.primary,
      check: { ...(checkMethod as PriceMethod), tolerancePct: tolerance_pct ?? 0, consecutive, ...(label === undefined ? {} : { label }) },
    });
  }
  // Every quote ref is priced here, and no ref depends on itself through its quotes (primary or check).
  for (const e of out.values()) {
    for (const [role, m] of [['primary', e.primary], ['check', e.check]] as const) {
      const q = quoteRefOf(m);
      if (q === undefined) continue;
      if (q === e.ref) issues.push(`${where}: ${e.ref}.${role}.quote_ref: a ref cannot be quoted in itself`);
      else if (!out.has(q)) issues.push(`${where}: ${e.ref}.${role}.quote_ref: ${q} is not in ${where}`);
    }
  }
  if (issues.length === 0) {
    for (const ref of out.keys()) {
      const cycle = cycleFrom(ref, out);
      if (cycle) {
        issues.push(`${where}: ${ref}: quote refs form a cycle (${cycle.join(' -> ')})`);
        break;
      }
    }
  }
  if (issues.length > 0) throw new OrionError('invalid_price_config', issues.join('\n'));
  return out;
}

function quoteRefsOf(e: PriceEntry): string[] {
  return [quoteRefOf(e.primary), quoteRefOf(e.check)].filter((q): q is string => q !== undefined);
}

function cycleFrom(start: string, prices: Map<string, PriceEntry>): string[] | null {
  const walk = (ref: string, path: string[]): string[] | null => {
    for (const q of quoteRefsOf(prices.get(ref)!)) {
      if (q === start) return [...path, q];
      if (path.includes(q)) continue;
      const found = walk(q, [...path, q]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

/** Loads `<rootDir>/prices.yaml`. A config root without one (a test home, an older release) has no price entries. */
export function loadPrices(rootDir: string): Map<string, PriceEntry> {
  const path = join(rootDir, PRICES_FILE);
  if (!existsSync(path)) return new Map();
  let obj: unknown;
  try {
    obj = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const line = err.linePos?.[0]?.line;
      throw new OrionError('invalid_price_config', `${path}: not valid YAML${line === undefined ? '' : ` at line ${line}`}: ${err.message.split('\n')[0]}`);
    }
    throw err;
  }
  return parsePrices(obj, path);
}

/**
 * The chain-priced ref of every `unit: usd` transfer_flow of the asset (Phase 3 R2 Task 6a), by metric: the scanned
 * token's ref on the ingest chain, or for a vault share its `share_price.underlying`'s. A metric whose ref cannot be named
 * (no ingest block, an unknown contract, a share without an underlying) is left out: the schema refuses those first.
 */
export function usdFlowRefs(asset: AssetConfig): { metricKey: string; contract: string; ref: string }[] {
  const out: { metricKey: string; contract: string; ref: string }[] = [];
  if (!asset.ingest) return out;
  for (const [metricKey, def] of Object.entries(asset.metrics)) {
    const s = def.source;
    if (s?.type !== 'transfer_flow' || s.unit !== 'usd') continue;
    const contract = s.share_price ? s.share_price.underlying : s.token;
    const address = contract === undefined ? undefined : asset.contracts?.[contract];
    if (contract === undefined || address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(String(address))) continue;
    out.push({ metricKey, contract, ref: evmTokenRef(asset.ingest.chain_id, String(address)) });
  }
  return out;
}

/**
 * The refs an asset uses: every contract address it names, as a token ref on its chain (its `ingest` EVM chain, or
 * Solana), plus the entry carrying its own symbol (HYPE has no address ref); then their quote refs, transitively.
 * Sorted by ref, so the config hash does not depend on file order.
 */
export function entriesFor(asset: AssetConfig, prices: Map<string, PriceEntry>): PriceEntry[] {
  const used = new Set<string>();
  for (const address of Object.values(asset.contracts ?? {})) {
    const a = String(address);
    if (asset.ingest && /^0x[0-9a-fA-F]{40}$/.test(a)) used.add(evmTokenRef(asset.ingest.chain_id, a));
    else if (asset.chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) used.add(solanaTokenRef(a));
  }
  // Interim (Ruling R11), replaced in Task 6: the symbol match exists only for HYPE, which has no address ref. Task 6 reads
  // refs from price.token/price.token_check params and transfer_flow tokens and deletes this line.
  for (const e of prices.values()) if (e.symbol === asset.symbol) used.add(e.ref);
  const out = new Map<string, PriceEntry>();
  const visit = (ref: string) => {
    const e = prices.get(ref);
    if (!e || out.has(ref)) return;
    out.set(ref, e);
    for (const q of quoteRefsOf(e)) visit(q);
  };
  for (const ref of used) visit(ref);
  return [...out.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}
