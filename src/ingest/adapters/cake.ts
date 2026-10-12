import type { SourceContext, SourceValue } from '../types.js';
import { unitsToNumber } from '../units.js';
import { chain, onchain, readAll, text } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * CAKE's gross emissions, from MasterChef v2 (BNB Chain). The v1 chef mints MASTERCHEF_CAKE_PER_BLOCK (40) a block into v2
 * (its only pool), and v2 splits each block by three rates (12 decimals, summing to 1e12): to burn, to regular farms, to
 * special farms. The burn share goes straight back to the burner and was never in circulation, so only the farm shares are
 * emissions: cakePerBlock(true) + cakePerBlock(false), per block, times the chain's blocks a year.
 *
 * Read 2026-10-12: burn 99.7167691403%, special farms 0.2832308596%, regular 1e-12, so about 0.1133 CAKE a block, or
 * about 7.9M CAKE a year at 0.45s blocks; the chef's own non-burn payouts were 6.7M a year over 100 days (MasterChef v3 and
 * the other farms draw from them).
 *
 * BNB Chain's block time changes by hard fork (Lorentz 0.75s, Maxwell 0.45s in 2025), so the blocks a year come from the
 * chain itself: the run's block against the one `params.sample_blocks` (default 1,000,000, about 5 days) before it.
 */
const SECONDS_PER_YEAR = 365 * 86_400;
const DECIMALS = 18;

async function emissionRateAnnual(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const { rpc, block } = chain(ctx);
  const chef = ctx.contract(text(params, 'chef', 'masterchef_v2'));
  const sample = BigInt(typeof params.sample_blocks === 'number' ? params.sample_blocks : 1_000_000);
  const [regular, special] = await readAll(ctx, [
    { address: chef, signature: 'function cakePerBlock(bool) view returns (uint256)', functionName: 'cakePerBlock', args: [true] },
    { address: chef, signature: 'function cakePerBlock(bool) view returns (uint256)', functionName: 'cakePerBlock', args: [false] },
  ]);
  if (block.number <= sample) throw new Error(`the chain is shorter than the ${sample}-block sample`);
  const earlier = await rpc.getBlock(block.number - sample);
  const secPerBlock = (block.timestamp - earlier.timestamp) / Number(sample);
  if (!(secPerBlock > 0)) throw new Error(`block time ${secPerBlock}s over the last ${sample} blocks is not positive`);
  const perBlock = unitsToNumber(regular + special, DECIMALS);
  const blocksPerYear = SECONDS_PER_YEAR / secPerBlock;
  const value = perBlock * blocksPerYear;
  const detail = `cakePerBlock regular ${unitsToNumber(regular, DECIMALS)} + special ${unitsToNumber(special, DECIMALS)} = ${perBlock.toFixed(6)} CAKE/block; ${secPerBlock.toFixed(4)}s/block over ${sample} blocks`;
  return onchain(ctx, value, detail);
}

/** Gross CAKE emissions per year to farms (the MasterChef burn share excluded). */
const emissionRate: AdapterDef = { name: 'cake.emission_rate_annual', needsRpc: true, run: emissionRateAnnual };

export const cakeAdapters: AdapterDef[] = [emissionRate];
