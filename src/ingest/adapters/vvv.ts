import type { ContractCall } from '../transport/rpc.js';
import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber, unitsToNumber } from '../units.js';
import type { AdapterDef } from './registry.js';

// Verified live on 2026-09-19: both emission percentages are FRACTIONS scaled by 1e18 (20 percent
// reads as 200000000000000000), and both DIEM tables are 18-decimal with 256 entries.
const FRACTION_DECIMALS = 18;
const TOKEN_DECIMALS = 18;

const view = (name: string, input = ''): string => `function ${name}(${input}) view returns (uint256)`;

function chain(ctx: SourceContext) {
  if (!ctx.rpc || !ctx.block) throw new Error('this adapter needs an RPC connection and a block');
  return { rpc: ctx.rpc, block: ctx.block };
}

const text = (params: Record<string, unknown>, key: string, fallback: string): string =>
  typeof params[key] === 'string' ? (params[key] as string) : fallback;
const number = (params: Record<string, unknown>, key: string, fallback: number): number =>
  typeof params[key] === 'number' ? (params[key] as number) : fallback;

function requiredUrl(params: Record<string, unknown>): string {
  if (typeof params.url !== 'string' || params.url === '') throw new Error('the "url" param is required');
  return params.url;
}

async function readAll(ctx: SourceContext, calls: ContractCall[]): Promise<bigint[]> {
  const { rpc, block } = chain(ctx);
  const results = await rpc.multicall(calls, block.number);
  return results.map((r, i) => {
    if (!r.ok) throw new Error(`${calls[i].functionName}(${(calls[i].args ?? []).join(',')}): ${r.error}`);
    return r.value;
  });
}

const onchain = (ctx: SourceContext, value: number): SourceValue => {
  const { block } = chain(ctx);
  return { kind: 'level', value, observedAt: new Date(block.timestamp * 1000).toISOString(), source: 'onchain', detail: `block ${block.number}` };
};

/** Share of gross emissions paid to stakers: 1 - [p_unlocked * (staked - locked) + p_locked * locked] / staked. */
const stakerEmissionShare: AdapterDef = {
  name: 'vvv.staker_emission_share',
  needsRpc: true,
  async run(ctx, params) {
    const address = ctx.contract(text(params, 'staking_contract', 'staking'));
    const names = ['veniceEmissionsPercentage', 'veniceEmissionsPercentageWhenLocked', 'totalSupply', 'totalLockedStakedVVV'];
    const [pUnlockedRaw, pLockedRaw, stakedRaw, lockedRaw] = await readAll(ctx, names.map((n) => ({ address, signature: view(n), functionName: n })));
    const staked = unitsToNumber(stakedRaw, TOKEN_DECIMALS);
    if (!(staked > 0)) throw new Error('nothing is staked, so the staker share is undefined');
    const locked = unitsToNumber(lockedRaw, TOKEN_DECIMALS);
    const pUnlocked = unitsToNumber(pUnlockedRaw, FRACTION_DECIMALS);
    const pLocked = unitsToNumber(pLockedRaw, FRACTION_DECIMALS);
    return onchain(ctx, 1 - (pUnlocked * (staked - locked) + pLocked * locked) / staked);
  },
};

/** The DIEM supply at which the mint rate reaches mint_base_rate * e^mint_curve_k: the target supply of the on-chain curve. */
const diemTargetSupply: AdapterDef = {
  name: 'vvv.diem_target_supply',
  needsRpc: true,
  async run(ctx, params) {
    const address = ctx.contract(text(params, 'staking_contract', 'staking'));
    const entries = number(params, 'entries', 256);
    const threshold = number(params, 'mint_base_rate', 90) * Math.exp(number(params, 'mint_curve_k', 2));

    const calls: ContractCall[] = [];
    for (let i = 0; i < entries; i++) {
      calls.push({ address, signature: view('diemSupply', 'uint256'), functionName: 'diemSupply', args: [BigInt(i)] });
      calls.push({ address, signature: view('diemMintRates', 'uint256'), functionName: 'diemMintRates', args: [BigInt(i)] });
    }
    const raw = await readAll(ctx, calls); // one multicall: the public RPC throttles bursts of separate calls
    const supply = (i: number) => unitsToNumber(raw[2 * i], TOKEN_DECIMALS);
    const rate = (i: number) => unitsToNumber(raw[2 * i + 1], TOKEN_DECIMALS);

    let at = -1;
    for (let i = 0; i < entries && at < 0; i++) if (rate(i) >= threshold) at = i;
    if (at < 0) throw new Error(`the mint-rate table never reaches ${threshold.toFixed(3)} VVV per DIEM`);
    if (at === 0) throw new Error(`the mint rate already exceeds ${threshold.toFixed(3)} at the first bucket; the target cannot be bracketed`);
    const fraction = (threshold - rate(at - 1)) / (rate(at) - rate(at - 1));
    return onchain(ctx, supply(at - 1) + fraction * (supply(at) - supply(at - 1)));
  },
};

/** Cross-check only: staker distribution over total emissions, from Venice's vvv_staking_yield. */
const stakerShareFromApi: AdapterDef = {
  name: 'vvv.staker_share_from_api',
  needsRpc: false,
  async run(ctx, params) {
    const url = requiredUrl(params);
    const body = (await ctx.http.getJson(url)) as Record<string, unknown> | null;
    const stakers = toFiniteNumber(body?.stakerDistributionCryptoBaseUnit);
    const total = toFiniteNumber(body?.totalEmissionsCryptoBaseUnit);
    if (stakers === null || total === null || !(total > 0)) throw new Error(`${url}: stakerDistribution or totalEmissions is missing or not positive`);
    return { kind: 'level', value: stakers / total, observedAt: ctx.nowIso, source: 'api', detail: `${url} stakerDistribution / totalEmissions` };
  },
};

/** Cross-check only: Venice's monthly burn history in tokens, for the monthly_sum comparison. */
const burnHistoryTokens: AdapterDef = {
  name: 'vvv.burn_history_tokens',
  needsRpc: false,
  async run(ctx, params) {
    const url = requiredUrl(params);
    const history = ((await ctx.http.getJson(url)) as { burnHistory?: unknown } | null)?.burnHistory;
    if (!Array.isArray(history)) throw new Error(`${url}: no burnHistory array`);
    const points = history.map((entry) => {
      const e = entry as { yearMonth?: unknown; burnedCryptoBaseUnit?: unknown } | null;
      const burned = toFiniteNumber(e?.burnedCryptoBaseUnit);
      if (typeof e?.yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(e.yearMonth) || burned === null) {
        throw new Error(`${url}: malformed burnHistory entry ${JSON.stringify(entry)}`);
      }
      return { month: e.yearMonth, value: burned / 10 ** TOKEN_DECIMALS };
    });
    return { kind: 'monthly_series', points, detail: `${url} burnHistory[].burnedCryptoBaseUnit` };
  },
};

export const vvvAdapters: AdapterDef[] = [stakerEmissionShare, diemTargetSupply, stakerShareFromApi, burnHistoryTokens];
