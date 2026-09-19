import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from 'viem';
import { base } from 'viem/chains';
import { OrionError } from '../../types.js';
import type { CallResult, RpcFactory } from './rpc.js';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** The only file that imports viem. Base only, until a second chain is actually needed. */
export const createViemRpc: RpcFactory = (url, chainId) => {
  if (chainId !== base.id) throw new OrionError('unsupported_chain', `chain_id ${chainId} is not supported; only Base (${base.id}) is`);
  const client = createPublicClient({ chain: base, transport: http(url, { retryCount: 3, retryDelay: 1000, timeout: 20_000 }) });

  return {
    async latestBlock() {
      const b = await client.getBlock();
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async getBlock(number) {
      const b = await client.getBlock({ blockNumber: number });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async multicall(calls, blockNumber) {
      // One eth_call: the public Base RPC throttles bursts of separate calls, and the default
      // viem batch size would split a large read into many requests.
      const results = await client.multicall({
        allowFailure: true,
        blockNumber,
        batchSize: 100_000,
        contracts: calls.map((c) => ({
          address: c.address as Address,
          abi: parseAbi([c.signature]),
          functionName: c.functionName,
          args: c.args ?? [],
        })),
      });
      return results.map(
        (r): CallResult => (r.status === 'success' ? { ok: true, value: BigInt(r.result as bigint | number) } : { ok: false, error: r.error.message }),
      );
    },
    async getTransferLogs(q) {
      const logs = await client.getLogs({
        address: q.token as Address,
        event: TRANSFER,
        args: { to: q.to as Address },
        fromBlock: q.fromBlock,
        toBlock: q.toBlock,
      });
      return logs.map((l) => {
        const ts = (l as { blockTimestamp?: bigint | null }).blockTimestamp;
        if (ts === undefined || ts === null) {
          throw new Error('the RPC did not return blockTimestamp on logs; use a Base RPC that does (https://mainnet.base.org does)');
        }
        if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null || l.args.from === undefined || l.args.value === undefined) {
          throw new Error('the RPC returned a pending or malformed Transfer log');
        }
        return { blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, from: l.args.from, value: l.args.value, timestamp: Number(ts) };
      });
    },
  };
};
