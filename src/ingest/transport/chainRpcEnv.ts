import { OrionError } from '../../types.js';
import { CHAINS } from './chains.js';
import type { RpcFactory, RpcTransport } from './rpc.js';

/**
 * The env var naming each EVM chain's RPC URL, shared by the price writer (PRICE_RPC_ENV) and the adapters'
 * `ctx.rpcFor`. Base alone falls back to its keyless public endpoint (chains.ts) when its var is unset.
 */
export const CHAIN_RPC_ENV: Readonly<Record<number, string>> = {
  1: 'ORION_ETH_RPC_URL',
  10: 'ORION_OP_RPC_URL',
  56: 'ORION_BNB_RPC_URL',
  4663: 'ORION_ROBINHOOD_RPC_URL',
  5042: 'ORION_ARC_RPC_URL',
  8453: 'ORION_BASE_RPC_URL',
  42161: 'ORION_ARB_RPC_URL',
  57073: 'ORION_INK_RPC_URL',
  99901: 'ORION_ELYSIUM_RPC_URL',
};

/**
 * One transport per chain from the environment's RPC URLs, made through `factory` on first use and cached for the
 * caller's lifetime (one run). Refuses with no_rpc_url, naming the env var, when a chain has no URL.
 */
export function chainRpcFor(env: Record<string, string | undefined>, factory: RpcFactory): (chainId: number) => RpcTransport {
  const rpcs = new Map<number, RpcTransport>();
  return (chainId) => {
    const hit = rpcs.get(chainId);
    if (hit) return hit;
    const name = CHAIN_RPC_ENV[chainId];
    if (name === undefined) throw new OrionError('no_rpc_url', `chain ${chainId} has no RPC (only ${Object.keys(CHAIN_RPC_ENV).join(', ')})`);
    const url = env[name]?.trim() || CHAINS[chainId]?.defaultRpcUrl;
    if (!url) throw new OrionError('no_rpc_url', `${name} is not set (environment or <ORION_HOME>/.env): chain ${chainId} has no keyless default`);
    const rpc = factory(url, chainId);
    rpcs.set(chainId, rpc);
    return rpc;
  };
}
