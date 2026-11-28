import { z } from 'zod';

/**
 * The pool scan's config and results (Phase 3 R4, spec §4.1). Asset-agnostic: the config names every contract; the
 * engine (scan.ts) hard-codes only ABIs (abi.ts).
 */

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x address');

/**
 * A reviewed price anchor: a token address and the Chainlink USD feed proxy that prices it, with the feed's on-chain
 * `description()`. `feed_chain_id` reads the feed on another chain (Elysium's three read Base feeds). Pricing (Task 5)
 * owns the semantics; the shape is declared here so the scan config validates in one place.
 */
export const AnchorSchema = z.strictObject({
  token: evmAddress,
  feed: evmAddress,
  description: z.string().min(1),
  feed_chain_id: z.number().int().positive().optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

/** One pool factory and the tape its pools record on; `hook` (CL only) is the swap hook that writes that tape. */
export const ScanFactorySchema = z.strictObject({
  address: evmAddress,
  kind: z.enum(['v2_stable', 'v2_volatile', 'cl']),
  tape: evmAddress,
  hook: evmAddress.optional(),
});
export type ScanFactory = z.infer<typeof ScanFactorySchema>;

export const ChainScanSchema = z.strictObject({
  chain_id: z.number().int().positive(),
  factories: z.array(ScanFactorySchema).min(1),
  factory_registry: evmAddress,
  leaf_voter: evmAddress,
  anchors: z.array(AnchorSchema),
  /** Blocks per eth_getLogs request; default: the chain's CHAINS maxLogRange. */
  log_range: z.number().int().positive().optional(),
});
export type ChainScan = z.infer<typeof ChainScanSchema>;

export const ScanConfigSchema = z.strictObject({
  chains: z.array(ChainScanSchema).min(1),
  /** Incentive program creators whose programs book as `protocol_subsidy` (Task 6); everyone else is `vote_incentives`. */
  subsidy_creators: z.array(evmAddress),
  /** The root Voter whose `chains()` must equal the configured chain ids (drift otherwise). */
  root_voter: z.strictObject({ chain_id: z.literal(8453), address: evmAddress }).optional(),
});
export type ScanConfig = z.infer<typeof ScanConfigSchema>;

/** Raw token amounts by lowercased token address. */
export type TokenAmounts = Map<string, bigint>;

/** One pool's gross fees for the day, in raw token units (0 for an unregistered pool: the tape does not record it). */
export interface PoolFees {
  pool: string;
  factory: string;
  token0: string;
  token1: string;
  fee0: bigint;
  fee1: bigint;
  registered: boolean;
  /** Absent from the factory at s−1 (created during the day). */
  newInDay: boolean;
  /** The pool's gauge (FactoryRegistry), or null. */
  gauge: string | null;
}

/**
 * Protocol drift the scan saw (spec §5 "drift"): warn, never fail.
 * - `tape`: a factory's `poolTape()` / `clPoolTape()` differs from the configured tape (id = factory).
 * - `hook`: a CL pool's `getPoolSwapHook` differs from the configured hook (id = pool).
 * - `factory`: a FactoryRegistry target factory is not configured (id = factory).
 * - `gauged_unregistered`: a gauged pool the tape does not record (id = pool).
 * - `chain`: the root Voter's `chains()` and the configured ids differ (id = chain id).
 * - `negative_allocator` / `negative_gross`: a per-pool per-token accrual came out below 0 and was taken as 0 (id = pool).
 */
export type DriftKind = 'tape' | 'hook' | 'factory' | 'gauged_unregistered' | 'chain' | 'negative_allocator' | 'negative_gross';
export interface Drift {
  kind: DriftKind;
  /** The chain the drift was seen on (for `chain`: the root Voter's chain). */
  chainId: number;
  id: string;
  detail: Record<string, unknown>;
}

/** `<kind>:<id>`, e.g. `chain:12345` or `tape:0x…`. */
export function driftKey(d: Drift): string {
  return `${d.kind}:${d.id}`;
}

/** The adapter warning key (plan Global Constraints): `pool_scan:<kind>:<chain>:<id>`. */
export function driftDedupeKey(d: Drift): string {
  return `pool_scan:${d.kind}:${d.chainId}:${d.id}`;
}

export interface ChainDayScan {
  chainId: number;
  day: string;
  /** s = first block at or after D 00:00Z, e = first block at or after D+1 00:00Z; reads are at s−1 and e−1. */
  blocks: { s: bigint; e: bigint };
  pools: PoolFees[];
  counts: { pools: number; registered: number; gauged: number; newInDay: number };
  /** Allocator share per gauged pool (Δ raw pending + Σ FeesCollected), keyed by pool; never negative. */
  allocatorByPool: Map<string, TokenAmounts>;
  drift: Drift[];
  /** calls = inner eth_calls; requests = eth_call chunks + eth_getLogs requests; logs = eth_getLogs requests. */
  rpc: { calls: number; requests: number; logs: number };
}
