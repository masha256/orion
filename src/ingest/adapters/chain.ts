import type { ContractCall } from '../transport/rpc.js';
import type { SourceContext, SourceValue } from '../types.js';

/** What every chain-reading adapter needs: one multicall at the run's block, and a level stamped with that block's time. */

export const view = (name: string, input = ''): string => `function ${name}(${input}) view returns (uint256)`;

export function chain(ctx: SourceContext): { rpc: NonNullable<SourceContext['rpc']>; block: NonNullable<SourceContext['block']> } {
  if (!ctx.rpc || !ctx.block) throw new Error('this adapter needs an RPC connection and a block');
  return { rpc: ctx.rpc, block: ctx.block };
}

export const text = (params: Record<string, unknown>, key: string, fallback: string): string =>
  typeof params[key] === 'string' ? (params[key] as string) : fallback;
export const number = (params: Record<string, unknown>, key: string, fallback: number): number =>
  typeof params[key] === 'number' ? (params[key] as number) : fallback;

/** Every call in one multicall at the run's block; the first failed call fails the adapter, naming the call. */
export async function readAll(ctx: SourceContext, calls: ContractCall[]): Promise<bigint[]> {
  const { rpc, block } = chain(ctx);
  const results = await rpc.multicall(calls, block.number);
  return results.map((r, i) => {
    if (!r.ok) throw new Error(`${calls[i].functionName}(${(calls[i].args ?? []).join(',')}): ${r.error}`);
    return r.value;
  });
}

export function onchain(ctx: SourceContext, value: number, detail = ''): SourceValue {
  const { block } = chain(ctx);
  return { kind: 'level', value, observedAt: new Date(block.timestamp * 1000).toISOString(), source: 'onchain', detail: `block ${block.number}${detail ? `: ${detail}` : ''}` };
}
