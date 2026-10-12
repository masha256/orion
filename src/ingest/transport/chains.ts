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
}

export const CHAINS: Readonly<Record<number, ChainInfo>> = {
  /** https://mainnet.base.org caps eth_getLogs at 2,000 blocks per call (error -32614 beyond that). */
  8453: { id: 8453, name: 'Base', maxLogRange: 2000n, blockTimeSec: 2, defaultRpcUrl: 'https://mainnet.base.org' },
  /** 10,000 blocks is about 33 hours; Alchemy serves 100,000 in one call, so 10,000 leaves room for a smaller plan. */
  1: { id: 1, name: 'Ethereum', maxLogRange: 10_000n, blockTimeSec: 12, defaultRpcUrl: null },
  /**
   * BNB Chain (CAKE). Blocks every ~0.45s (measured 2026-10-12 over 1M blocks), so a day is ~192k blocks. Alchemy served
   * 200k-block ranges with blockTimestamp in under 2 seconds; 50,000 keeps each call small. No keyless default: every public
   * endpoint tried on 2026-10-12 capped ranged logs or refused archive reads, so ORION_BNB_RPC_URL must be set.
   */
  56: { id: 56, name: 'BNB Chain', maxLogRange: 50_000n, blockTimeSec: 0.45, defaultRpcUrl: null },
};

export function chainInfo(chainId: number): ChainInfo | undefined {
  return CHAINS[chainId];
}

export function supportedChainIds(): number[] {
  return Object.keys(CHAINS).map(Number).sort((a, b) => a - b);
}
