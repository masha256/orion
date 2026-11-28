/**
 * The chains Orion reads. Per chain: how many blocks one eth_getLogs call may span, the nominal block time the block
 * search estimates from, and a keyless default RPC URL where a public one serves what Orion needs (ranged logs with
 * blockTimestamp, historical eth_call). Ethereum has none: every free endpoint tried on 2026-10-08 capped ranged logs
 * or refused archive reads, so ORION_ETH_RPC_URL must be set.
 */
export interface ChainInfo {
  id: number;
  name: string;
  maxLogRange: bigint;
  blockTimeSec: number;
  defaultRpcUrl: string | null;
  /**
   * M-7: how far behind the head a transfer scan stops when the RPC rejects the `finalized` tag (latest minus this many
   * blocks, a reorg-safe depth for the chain; logged as a note).
   */
  confirmations: bigint;
}

export const CHAINS: Readonly<Record<number, ChainInfo>> = {
  /**
   * https://mainnet.base.org caps eth_getLogs at 2,000 blocks per call (error -32614 beyond that). Blocks every 0.2 s
   * since block 53,556,128 (2026-11-05T18:00:01Z; 2 s before, measured 2026-11-13), so 2,000 blocks is 400 s and a day is
   * ~216 calls. The block search interpolates on the blocks it reads, so days on either side of the change are found.
   */
  8453: { id: 8453, name: 'Base', maxLogRange: 2000n, blockTimeSec: 0.2, defaultRpcUrl: 'https://mainnet.base.org', confirmations: 9000n }, // 30 min
  /** 10,000 blocks is about 33 hours; Alchemy serves 100,000 in one call, so 10,000 leaves room for a smaller plan. */
  1: { id: 1, name: 'Ethereum', maxLogRange: 10_000n, blockTimeSec: 12, defaultRpcUrl: null, confirmations: 64n }, // two epochs, ~13 min
  /**
   * BNB Chain (CAKE). Blocks every ~0.45s (measured 2026-10-12 over 1M blocks), so a day is ~192k blocks. Alchemy served
   * 200k-block ranges with blockTimestamp in under 2 seconds; 50,000 keeps each call small. No keyless default: every public
   * endpoint tried on 2026-10-12 capped ranged logs or refused archive reads, so ORION_BNB_RPC_URL must be set.
   */
  56: { id: 56, name: 'BNB Chain', maxLogRange: 50_000n, blockTimeSec: 0.45, defaultRpcUrl: null, confirmations: 2000n }, // ~15 min
  /**
   * The Aero chains read by pool tape (Phase 3 R4). Measured 2026-11-27 on Alchemy (eth_chainId, mean block time over
   * 200k blocks, eth_getLogs span): every one spans at least 1M blocks per call except Ink (10,000). None has a keyless
   * default: the reads are archive eth_calls, so each chain's env var (chainRpcEnv.ts) must be set. Confirmations are
   * 30-36 min of blocks at the nominal block time.
   */
  10: { id: 10, name: 'optimism', maxLogRange: 1_000_000n, blockTimeSec: 2, defaultRpcUrl: null, confirmations: 900n },
  42161: { id: 42161, name: 'arbitrum', maxLogRange: 1_000_000n, blockTimeSec: 0.3, defaultRpcUrl: null, confirmations: 7200n },
  57073: { id: 57073, name: 'ink', maxLogRange: 10_000n, blockTimeSec: 1, defaultRpcUrl: null, confirmations: 1800n },
  4663: { id: 4663, name: 'robinhood', maxLogRange: 1_000_000n, blockTimeSec: 0.11, defaultRpcUrl: null, confirmations: 18_000n },
  5042: { id: 5042, name: 'arc', maxLogRange: 1_000_000n, blockTimeSec: 0.5, defaultRpcUrl: null, confirmations: 3600n },
  99901: { id: 99901, name: 'elysium', maxLogRange: 1_000_000n, blockTimeSec: 0.15, defaultRpcUrl: null, confirmations: 12_000n },
};

export function chainInfo(chainId: number): ChainInfo | undefined {
  return CHAINS[chainId];
}

export function supportedChainIds(): number[] {
  return Object.keys(CHAINS).map(Number).sort((a, b) => a - b);
}
