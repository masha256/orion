import { describe, expect, it } from 'vitest';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import type { ReadingResult } from '../../src/ingest/types.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { SINK, STAKING, TOKEN } from '../helpers/ingestAsset.js';
import { req, sourceCtx } from '../helpers/sourceCtx.js';

// Values read live from Base on 2026-09-19 (tests/fixtures/ingest/research-2026-09-19/chain_reads.json).
const CALLS = {
  [callKey(TOKEN, 'totalSupply')]: 114886562770481399543309743n,
  [callKey(TOKEN, 'decimals')]: 18n,
  [callKey(TOKEN, 'balanceOf', [SINK])]: 33877292523889967424801955n,
  [callKey(STAKING, 'totalSupply')]: 33941208987993140790795723n,
  [callKey(STAKING, 'emissionRatePerSecond')]: 79274479959411466n,
  [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
};

const read = (fn: string, over: Partial<{ decimals: number; scale: number; offset: number }> = {}) =>
  ({ type: 'contract_read', contract: 'staking', function: fn, abi_type: 'uint256', decimals: 18, scale: 1, offset: 0, ...over }) as const;
const levelOf = (r: ReadingResult): number => {
  if (!r.ok || r.value.kind !== 'level') throw new Error(`expected a level reading, got ${JSON.stringify(r)}`);
  return r.value.value;
};

describe('chain level sources', () => {
  const requests = [
    req('effective_supply', { type: 'erc20_supply', token: 'token', subtract_balances: ['burn_sink'] }),
    req('staked_supply', read('totalSupply')),
    req('emission_rate_annual', read('emissionRatePerSecond', { scale: 31_536_000 })),
    req('diem_locked_yield_share', read('veniceEmissionsPercentageWhenLocked', { scale: -1, offset: 1 })),
  ];

  it('reads every level in one multicall at one block and stamps it with the block time', async () => {
    const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 1000n, calls: CALLS });
    const block = await rpc.latestBlock();
    const out = await getSourceHandler('erc20_supply').fetch(requests, sourceCtx({ rpc, block }));
    expect(rpc.stats.multicall).toBe(1);
    expect(levelOf(out[0])).toBeCloseTo(81009270.24659143, 4); // totalSupply minus the zero-address balance
    expect(levelOf(out[1])).toBeCloseTo(33941208.98799314, 4);
    expect(levelOf(out[2])).toBeCloseTo(2_500_000, 3);
    expect(levelOf(out[3])).toBeCloseTo(0.8, 12); // 1 - 0.2: fractions are scaled by 1e18
    const stamp = new Date((1_700_000_001 + 2000) * 1000).toISOString();
    for (const r of out) expect(r).toMatchObject({ ok: true, value: { observedAt: stamp, source: 'onchain', detail: 'block 1000' } });
  });

  it('serves both source types from the same handler', () => {
    expect(getSourceHandler('contract_read')).toBe(getSourceHandler('erc20_supply'));
  });

  it('fails only the readings that needed a failed call', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 10n, calls: { ...CALLS, [callKey(TOKEN, 'balanceOf', [SINK])]: new Error('execution reverted') } });
    const out = await getSourceHandler('contract_read').fetch(requests, sourceCtx({ rpc, block: await rpc.latestBlock() }));
    expect(out[0]).toEqual({ ok: false, error: 'balanceOf(burn_sink) on token: execution reverted' });
    expect(out[1].ok).toBe(true);
  });

  it('fails the whole batch without an RPC connection or a block', async () => {
    await expect(getSourceHandler('contract_read').fetch(requests, sourceCtx())).rejects.toThrow(/RPC/);
  });
});
