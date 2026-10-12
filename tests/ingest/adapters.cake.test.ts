import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

// MasterChef v2 on BNB Chain, read live on 2026-10-12: special farms 0.11329234384 CAKE a block, regular 4e-11.
const CHEF = '0xa5f8c5dbd5f286960b9d90548680ae5ebff07652';
const SPECIAL = 113292343840000000n;
const REGULAR = 40000000n;
const LIVE = { [callKey(CHEF, 'cakePerBlock', [true])]: REGULAR, [callKey(CHEF, 'cakePerBlock', [false])]: SPECIAL };
const contract = (name: string) => ({ masterchef_v2: CHEF })[name] ?? (() => { throw new Error(`no contract ${name}`); })();

async function chainCtx(calls: Record<string, bigint | Error>, blockTimeSec = 0.45, latest = 2_000_000n) {
  const rpc = fakeRpc({ genesisTs: 1_790_000_000, blockTimeSec, latest, calls });
  return { ctx: sourceCtx({ rpc, block: await rpc.latestBlock(), contract }), rpc };
}

describe('the CAKE emission rate', () => {
  it('is registered and needs the chain', () => {
    expect(adapterNames()).toContain('cake.emission_rate_annual');
    expect(getAdapter('cake.emission_rate_annual').needsRpc).toBe(true);
  });

  it('sums the farm rates per block and scales by the blocks a year measured on the chain: 7.94M CAKE at 0.45s', async () => {
    const { ctx, rpc } = await chainCtx(LIVE);
    const v = await getAdapter('cake.emission_rate_annual').run(ctx, {});
    expect(v.kind).toBe('level');
    if (v.kind !== 'level') return;
    expect(v.source).toBe('onchain');
    const perBlock = 0.11329234388;
    expect(v.value).toBeCloseTo((perBlock * 365 * 86_400) / 0.45, 0);
    expect(v.value / 1e6).toBeCloseTo(7.9396, 3);
    expect(v.detail).toContain('0.113292 CAKE/block; 0.4500s/block over 1000000 blocks');
    expect(rpc.stats.multicall).toBe(1);
  });

  it('follows the chain when its block time changes (a hard fork): the same rate per block emits more a year', async () => {
    const { ctx } = await chainCtx(LIVE, 0.75);
    const slow = await getAdapter('cake.emission_rate_annual').run(ctx, {});
    const { ctx: fast } = await chainCtx(LIVE, 0.45);
    const quick = await getAdapter('cake.emission_rate_annual').run(fast, {});
    if (slow.kind !== 'level' || quick.kind !== 'level') throw new Error('expected levels');
    expect(quick.value / slow.value).toBeCloseTo(0.75 / 0.45, 9);
  });

  it('fails rather than guessing on a chain shorter than its sample, or when a rate cannot be read', async () => {
    const { ctx: short } = await chainCtx(LIVE, 0.45, 500n);
    await expect(getAdapter('cake.emission_rate_annual').run(short, {})).rejects.toThrow(/shorter than the 1000000-block sample/);
    const { ctx: broken } = await chainCtx({ [callKey(CHEF, 'cakePerBlock', [true])]: new Error('execution reverted') });
    await expect(getAdapter('cake.emission_rate_annual').run(broken, {})).rejects.toThrow(/cakePerBlock\(true\)/);
  });
});
