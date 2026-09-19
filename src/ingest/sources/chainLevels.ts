import type { CallResult, ContractCall } from '../transport/rpc.js';
import { failed, level, type ReadingResult, type SourceHandler } from '../types.js';
import { unitsToNumber } from '../units.js';

export const ERC20_ABI = {
  totalSupply: 'function totalSupply() view returns (uint256)',
  decimals: 'function decimals() view returns (uint8)',
  balanceOf: 'function balanceOf(address) view returns (uint256)',
} as const;

interface Slot {
  index: number;
  label: string;
}

type Need =
  | { kind: 'erc20'; total: Slot; decimals: Slot; balances: Slot[] }
  | { kind: 'read'; call: Slot; decimals: number; scale: number; offset: number };

/** erc20_supply and contract_read: every chain level of a run in one multicall at one block. */
export const chainLevelsSource: SourceHandler = {
  id: 'chain_levels',
  async fetch(requests, ctx) {
    if (!ctx.rpc || !ctx.block) throw new Error('chain sources need an RPC connection and a block');

    const calls: ContractCall[] = [];
    const slot = (call: ContractCall, label: string): Slot => ({ index: calls.push(call) - 1, label });
    const needs: Need[] = requests.map((r) => {
      const s = r.source;
      if (s.type === 'erc20_supply') {
        const address = ctx.contract(s.token);
        return {
          kind: 'erc20',
          total: slot({ address, signature: ERC20_ABI.totalSupply, functionName: 'totalSupply' }, `totalSupply() on ${s.token}`),
          decimals: slot({ address, signature: ERC20_ABI.decimals, functionName: 'decimals' }, `decimals() on ${s.token}`),
          balances: s.subtract_balances.map((holder) =>
            slot({ address, signature: ERC20_ABI.balanceOf, functionName: 'balanceOf', args: [ctx.contract(holder)] }, `balanceOf(${holder}) on ${s.token}`),
          ),
        };
      }
      if (s.type === 'contract_read') {
        const call = { address: ctx.contract(s.contract), signature: `function ${s.function}() view returns (${s.abi_type})`, functionName: s.function };
        return { kind: 'read', call: slot(call, `${s.function}() on ${s.contract}`), decimals: s.decimals, scale: s.scale, offset: s.offset };
      }
      throw new Error(`chain_levels cannot serve a ${s.type} source`);
    });

    const results: CallResult[] = await ctx.rpc.multicall(calls, ctx.block.number);
    const observedAt = new Date(ctx.block.timestamp * 1000).toISOString();
    const detail = `block ${ctx.block.number}`;

    return needs.map((need): ReadingResult => {
      const slots = need.kind === 'erc20' ? [need.total, need.decimals, ...need.balances] : [need.call];
      const values: bigint[] = [];
      for (const s of slots) {
        const r = results[s.index];
        if (!r.ok) return failed(`${s.label}: ${r.error}`);
        values.push(r.value);
      }
      if (need.kind === 'read') return level(need.offset + need.scale * unitsToNumber(values[0], need.decimals), observedAt, 'onchain', detail);
      const [total, decimals, ...balances] = values;
      const net = balances.reduce((left, b) => left - b, total);
      return level(unitsToNumber(net, Number(decimals)), observedAt, 'onchain', detail);
    });
  },
};
