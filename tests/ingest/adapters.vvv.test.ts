import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { STAKING } from '../helpers/ingestAsset.js';
import { fixture, NOW_ISO, sourceCtx } from '../helpers/sourceCtx.js';

const VENICE = 'https://outerface.venice.ai/api/app/vvv';

/** The on-chain tables follow 90 * e^(2 * (supply / target)^3) in 500-DIEM buckets (verified live, target 40,000). */
function diemTables(target: number, entries = 256): Record<string, bigint> {
  const calls: Record<string, bigint> = {};
  for (let i = 0; i < entries; i++) {
    const supply = 500 * (i + 1);
    const rate = Math.min(90 * Math.exp(2 * (supply / target) ** 3), 1e30); // capped: a uint256 cannot hold Infinity
    calls[callKey(STAKING, 'diemSupply', [BigInt(i)])] = BigInt(supply) * 10n ** 18n;
    calls[callKey(STAKING, 'diemMintRates', [BigInt(i)])] = BigInt(Math.round(rate * 1e6)) * 10n ** 12n;
  }
  return calls;
}

async function chainCtx(calls: Record<string, bigint | Error>) {
  const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 500n, calls });
  return { ctx: sourceCtx({ rpc, block: await rpc.latestBlock() }), rpc };
}

describe('VVV adapters', () => {
  it('are registered by name', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['vvv.burn_history_tokens', 'vvv.diem_target_supply', 'vvv.staker_emission_share', 'vvv.staker_share_from_api']));
    expect(getAdapter('vvv.staker_emission_share').needsRpc).toBe(true);
    expect(getAdapter('vvv.diem_target_supply').needsRpc).toBe(true);
    expect(getAdapter('vvv.staker_share_from_api').needsRpc).toBe(false);
  });

  it('computes the staker emission share from fractions scaled by 1e18', async () => {
    // Values read live on 2026-09-19: Venice takes 0 percent on unlocked stake and 20 percent on DIEM-locked stake.
    const { ctx, rpc } = await chainCtx({
      [callKey(STAKING, 'veniceEmissionsPercentage')]: 0n,
      [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
      [callKey(STAKING, 'totalSupply')]: 33941208987993140790795723n,
      [callKey(STAKING, 'totalLockedStakedVVV')]: 8954489934888212779041642n,
    });
    const v = await getAdapter('vvv.staker_emission_share').run(ctx, {});
    expect(v).toMatchObject({ kind: 'level', source: 'onchain', observedAt: new Date((1_700_000_001 + 1000) * 1000).toISOString(), detail: 'block 500' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(0.9472352918362107, 12);
    expect(rpc.stats.multicall).toBe(1);
  });

  it('weights both percentages: a take on unlocked stake lowers the share too', async () => {
    const { ctx } = await chainCtx({
      [callKey(STAKING, 'veniceEmissionsPercentage')]: 100000000000000000n, // 10 percent
      [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
      [callKey(STAKING, 'totalSupply')]: 100n * 10n ** 18n,
      [callKey(STAKING, 'totalLockedStakedVVV')]: 25n * 10n ** 18n,
    });
    const v = await getAdapter('vvv.staker_emission_share').run(ctx, { staking_contract: 'staking' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(1 - (0.1 * 75 + 0.2 * 25) / 100, 12);
  });

  it('fails the staker share when a read fails or nothing is staked', async () => {
    const base = {
      [callKey(STAKING, 'veniceEmissionsPercentage')]: 0n,
      [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
      [callKey(STAKING, 'totalLockedStakedVVV')]: 0n,
    };
    await expect(getAdapter('vvv.staker_emission_share').run((await chainCtx({ ...base, [callKey(STAKING, 'totalSupply')]: 0n })).ctx, {})).rejects.toThrow(/nothing is staked/);
    await expect(getAdapter('vvv.staker_emission_share').run((await chainCtx(base)).ctx, {})).rejects.toThrow(/totalSupply/);
    await expect(getAdapter('vvv.staker_emission_share').run(sourceCtx(), {})).rejects.toThrow(/RPC/);
  });

  it('finds the DIEM target supply where the mint rate reaches base * e^k, in one multicall', async () => {
    const { ctx, rpc } = await chainCtx(diemTables(40_000));
    const v = await getAdapter('vvv.diem_target_supply').run(ctx, {});
    expect(v.kind === 'level' && v.value).toBeCloseTo(40_000, 2);
    expect(v).toMatchObject({ source: 'onchain', detail: 'block 500' });
    expect(rpc.stats.multicall).toBe(1);
  });

  it('interpolates linearly between the two bracketing buckets', async () => {
    const { ctx } = await chainCtx(diemTables(42_250)); // between the 42,000 and 42,500 buckets
    const v = await getAdapter('vvv.diem_target_supply').run(ctx, {});
    // Linear interpolation of a convex curve lands slightly below the true 42,250.
    expect(v.kind === 'level' && v.value).toBeCloseTo(42_244.08, 1);
  });

  it('fails the DIEM target when the table cannot bracket the rate or a read fails', async () => {
    await expect(getAdapter('vvv.diem_target_supply').run((await chainCtx(diemTables(40_000, 8))).ctx, { entries: 8 })).rejects.toThrow(/never reaches/);
    await expect(getAdapter('vvv.diem_target_supply').run((await chainCtx(diemTables(100))).ctx, {})).rejects.toThrow(/first bucket/);
    const broken = { ...diemTables(40_000), [callKey(STAKING, 'diemMintRates', [7n])]: new Error('reverted') };
    await expect(getAdapter('vvv.diem_target_supply').run((await chainCtx(broken)).ctx, {})).rejects.toThrow(/diemMintRates\(7\)/);
  });

  it('reads the staker share from the Venice API as a ratio of two fields', async () => {
    const url = `${VENICE}/vvv_staking_yield`;
    const ctx = sourceCtx({ http: fakeHttp({ [url]: fixture('venice_vvv_staking_yield.json') }) });
    const v = await getAdapter('vvv.staker_share_from_api').run(ctx, { url });
    expect(v).toMatchObject({ kind: 'level', source: 'api', observedAt: NOW_ISO });
    expect(v.kind === 'level' && v.value).toBeCloseTo(0.9471936034203345, 12);
    await expect(getAdapter('vvv.staker_share_from_api').run(ctx, {})).rejects.toThrow(/url/);
  });

  it('turns the Venice burn history into a monthly token series', async () => {
    const url = `${VENICE}/vvv_burn_history`;
    const ctx = sourceCtx({ http: fakeHttp({ [url]: fixture('venice_vvv_burn_history.json') }) });
    const v = await getAdapter('vvv.burn_history_tokens').run(ctx, { url });
    if (v.kind !== 'monthly_series') throw new Error('expected a monthly series');
    expect(v.points).toHaveLength(12);
    expect(v.points.find((p) => p.month === '2026-08')!.value).toBeCloseTo(55498.417825166835, 6);
    expect(v.points.find((p) => p.month === '2026-10')!.value).toBe(0);
    const bad = sourceCtx({ http: fakeHttp({ [url]: { burnHistory: [{ yearMonth: 'August', burnedCryptoBaseUnit: '1' }] } }) });
    await expect(getAdapter('vvv.burn_history_tokens').run(bad, { url })).rejects.toThrow(/malformed/);
  });
});
