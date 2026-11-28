import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { describe, expect, it } from 'vitest';
import { VRM_ABI } from '../../../src/ingest/poolscan/abi.js';
import { rpcChainReader } from '../../../src/ingest/poolscan/reader.js';
import { discoverVrms, programs, streamedDay, type Program } from '../../../src/ingest/poolscan/incentives.js';
import type { TokenAmounts } from '../../../src/ingest/poolscan/types.js';
import { OrionError } from '../../../src/types.js';
import { fakeRpc } from '../../helpers/fakeRpc.js';
import {
  dayStartSec, fixturePrograms, incentivesConfig, incentivesReader, loadIncentivesFixture, type FxExpectRow, type IncentivesFixture,
} from '../../helpers/poolscanIncentives.js';

const fx = loadIncentivesFixture();
// Spec §11, copied exactly (mixed case on purpose: the comparison is case-insensitive).
const SUBSIDY_CREATORS = ['0x7269de76188E6597444D0859C4e5c336D3c39dDb', '0x42255e3c2d0b71a0b006243148fdf1a71d054ce0'];
const SAFE_80F7 = '0x80f7153d9bc853a9bf8bc21f2517c0acee2fdf75';
// Synthetic day blocks: the engine reads the supply history at e − 1.
const BLOCKS = { s: 1_000n, e: 2_000n };

const INFI_VRM = '0xeeb3ca51d05edd037489fe5f45e756b42bbeb652';
const OP_ZERO_VRM = '0x2735e91b68298b9179a98d65bee01a2ef8981553';
const OP_USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
const SCOPING_CLASS: Record<FxExpectRow['class'], 'vote_incentives' | 'protocol_subsidy'> = {
  third_party: 'vote_incentives',
  foundation_signer_safe_80f7: 'vote_incentives',
  foundation_subsidy: 'protocol_subsidy',
  aero_admin_safe_42255: 'protocol_subsidy',
};

function program(fx: IncentivesFixture, chain: string, vrm: string, id: number) {
  const p = fx.programs.find((q) => q.chain === chain && q.vrm === vrm && q.id === id);
  if (!p) throw new Error(`no fixture program ${chain} ${vrm} ${id}`);
  return p;
}

/** The scoping's per-(class, token) token units for one chain-day (optionally some VRMs only), and programs per token. */
function scopingByClass(chain: string, day: string, vrms?: string[]) {
  const out = { vote_incentives: new Map<string, number>(), protocol_subsidy: new Map<string, number>(), n: new Map<string, number>() };
  for (const r of fx.expect.program_days) {
    if (r.chain !== chain || r.day !== day || (vrms && !vrms.includes(r.vrm))) continue;
    const m = out[SCOPING_CLASS[r.class]];
    const token = program(fx, chain, r.vrm, r.id).token;
    m.set(token, (m.get(token) ?? 0) + r.allocated);
    out.n.set(token, (out.n.get(token) ?? 0) + 1);
  }
  return out;
}

const decimalsOf = (chain: string, token: string) => fx.programs.find((p) => p.chain === chain && p.token === token)!.decimals;
const units = (chain: string, token: string, raw: bigint) => Number(raw) / 10 ** decimalsOf(chain, token);

/**
 * Engine raw amounts vs scoping token units: same token set, each within 1e-9 relative (the scoping used floats) or one
 * raw unit per program streaming the token (the engine floors each program's amount, as the contract's integer math does).
 */
function expectSameAmounts(chain: string, got: TokenAmounts, want: Map<string, number>, label: string, n?: Map<string, number>) {
  const nonZero = [...want].filter(([, v]) => v > 0).map(([t]) => t).sort();
  expect([...got.keys()].sort(), label).toEqual(nonZero);
  for (const [token, v] of want) {
    const g = units(chain, token, got.get(token) ?? 0n);
    const rawUnits = (n?.get(token) ?? 1) + 1;
    expect(Math.abs(g - v) <= Math.max(1e-9 * v, rawUnits / 10 ** decimalsOf(chain, token)), `${label} ${token}: ${g} vs ${v}`).toBe(true);
  }
}

describe('poolscan VRM incentive streams', () => {
  it('a program spanning midnight splits by overlap', async () => {
    // Base INFI program (VRM 0xeeb3…, id 1, creator Safe 0x80f7) starts 2026-11-17 15:30Z: 30,600 s on 11-17, a full day on 11-18.
    const infi = fixturePrograms(fx, 'base', (p) => p.vrm === INFI_VRM && p.id === 1);
    expect(infi[0].start).toBe(dayStartSec('2026-11-17') + 55_800);
    const token = infi[0].token;
    const d17 = await streamedDay(incentivesReader(fx, 'base'), infi, '2026-11-17', BLOCKS, SUBSIDY_CREATORS);
    const d18 = await streamedDay(incentivesReader(fx, 'base'), infi, '2026-11-18', BLOCKS, SUBSIDY_CREATORS);
    const rate = infi[0].rate;
    expect(d17.byClass.vote_incentives.get(token)).toBe((rate * 30_600n) / 10n ** 18n);
    expect(d18.byClass.vote_incentives.get(token)).toBe((rate * 86_400n) / 10n ** 18n);
    expect(d17.programsActive).toBe(1);
    for (const [day, r] of [['2026-11-17', d17], ['2026-11-18', d18]] as const) {
      const row = fx.expect.program_days.find((x) => x.chain === 'base' && x.day === day && x.vrm === INFI_VRM && x.id === 1)!;
      expectSameAmounts('base', r.byClass.vote_incentives, new Map([[token, row.allocated]]), day);
    }
    // The day's other programs on the VRM, read together, still equal the scoping per token.
    for (const day of ['2026-11-17', '2026-11-18']) {
      const all = await streamedDay(incentivesReader(fx, 'base'), fixturePrograms(fx, 'base', (p) => p.vrm === INFI_VRM), day, BLOCKS, SUBSIDY_CREATORS);
      const want = scopingByClass('base', day, [INFI_VRM]);
      expectSameAmounts('base', all.byClass.vote_incentives, want.vote_incentives, day, want.n);
      expect(all.byClass.protocol_subsidy.size).toBe(0);
    }
  });

  it('zero-allocation seconds are excluded (never the raw overlap)', async () => {
    // OP 0x5c1e… USDC program (VRM 0x2735…, id 1, 10-30 12:30Z → 11-01 12:30Z) streamed while the VRM had no allocation:
    // the raw overlap is positive every day, the allocator-earned stream is 0.
    const zeroProg = fixturePrograms(fx, 'optimism', (p) => p.vrm === OP_ZERO_VRM && p.id === 1);
    expect(zeroProg[0].creator).toBe('0x5c1e6716f59f3c12c2b23163e9ab42ee0027cd93');
    for (const day of ['2026-10-30', '2026-10-31', '2026-11-01']) {
      const row = fx.expect.program_days.find((r) => r.chain === 'optimism' && r.day === day && r.vrm === OP_ZERO_VRM && r.id === 1)!;
      expect(row.streamed).toBeGreaterThan(0);
      expect(row.allocated).toBe(0);
      const r = await streamedDay(incentivesReader(fx, 'optimism'), zeroProg, day, BLOCKS, SUBSIDY_CREATORS);
      expect(r.byClass.vote_incentives.get(OP_USDC) ?? 0n, day).toBe(0n);
      expect(r.programsActive).toBe(1);
    }
    // Its second program starts 11-04 09:00Z with zero allocation until the VRM's first vote: 23,497 of 54,000 s are excluded.
    const second = fixturePrograms(fx, 'optimism', (p) => p.vrm === OP_ZERO_VRM && p.id === 2);
    const r = await streamedDay(incentivesReader(fx, 'optimism'), second, '2026-11-04', BLOCKS, SUBSIDY_CREATORS);
    expect(r.byClass.vote_incentives.get(OP_USDC)).toBe((second[0].rate * (54_000n - 23_497n)) / 10n ** 18n);
    const row = fx.expect.program_days.find((x) => x.chain === 'optimism' && x.day === '2026-11-04' && x.vrm === OP_ZERO_VRM && x.id === 2)!;
    expect(Math.abs(units('optimism', OP_USDC, r.byClass.vote_incentives.get(OP_USDC)!) - row.allocated)).toBeLessThan(1e-6);
    expect(row.allocated).toBeLessThan(row.streamed);
    // The supply history is read at e − 1 of the day.
    const reader = incentivesReader(fx, 'optimism');
    await streamedDay(reader, second, '2026-11-04', BLOCKS, SUBSIDY_CREATORS);
    expect(new Set(reader.stats.calls.map((c) => c.block))).toEqual(new Set([BLOCKS.e - 1n]));
    expect(reader.stats.calls.filter((c) => c.functionName === 'supplyAt').map((c) => c.args[0]).sort()).toEqual(
      [BigInt(second[0].start - 1), BigInt(dayStartSec('2026-11-05') - 1)].sort(),
    );
  });

  it('creator 0x7269… and 0x42255… book protocol_subsidy; 0x80f7… books vote_incentives', async () => {
    // Base 10-29: a Foundation TGE (0x7269) AERO program that ends that day, the 0x80f7 RSGP program, a third-party VVV.
    const vrms = ['0x4d22c68f996ed9abf0d1bb02ac070462a1b4e40e', '0x4ad4efa871b9a9d943cd69fd779c4d0230eb021f', '0xe43e4d06d85abfed8bd998c5df2dcfe272c4e8c9'];
    const base = fixturePrograms(fx, 'base', (p) => vrms.includes(p.vrm));
    const creators = new Set(base.filter((p) => p.start < dayStartSec('2026-10-30') && p.end > dayStartSec('2026-10-29')).map((p) => p.creator));
    expect(creators.has('0x7269de76188e6597444d0859c4e5c336d3c39ddb') && creators.has(SAFE_80F7)).toBe(true);
    const b = await streamedDay(incentivesReader(fx, 'base'), base, '2026-10-29', BLOCKS, SUBSIDY_CREATORS);
    const want = scopingByClass('base', '2026-10-29', vrms);
    expect(want.protocol_subsidy.size).toBeGreaterThan(0);
    expectSameAmounts('base', b.byClass.protocol_subsidy, want.protocol_subsidy, 'base protocol_subsidy', want.n);
    expectSameAmounts('base', b.byClass.vote_incentives, want.vote_incentives, 'base vote_incentives', want.n);
    const RSGP = program(fx, 'base', '0x4ad4efa871b9a9d943cd69fd779c4d0230eb021f', 1);
    expect(RSGP.creator).toBe(SAFE_80F7);
    expect(b.byClass.vote_incentives.get(RSGP.token)).toBeGreaterThan(0n);
    expect(b.byClass.protocol_subsidy.has(RSGP.token)).toBe(false);
    // Ethereum 10-23: every program is the governance multisig 0x42255's → all protocol_subsidy.
    const eth = fixturePrograms(fx, 'ethereum');
    const e = await streamedDay(incentivesReader(fx, 'ethereum'), eth, '2026-10-23', BLOCKS, SUBSIDY_CREATORS);
    const wantEth = scopingByClass('ethereum', '2026-10-23');
    expect(wantEth.vote_incentives.size).toBe(0);
    expectSameAmounts('ethereum', e.byClass.protocol_subsidy, wantEth.protocol_subsidy, 'eth protocol_subsidy', wantEth.n);
    expect(e.byClass.vote_incentives.size).toBe(0);
    expect(e.programsActive).toBe(fx.expect.program_days.filter((r) => r.chain === 'ethereum' && r.day === '2026-10-23').length);
    // Case-insensitive both ways: lower-case config, checksummed creators.
    const upper = eth.map((p) => ({ ...p, creator: `0x${p.creator.slice(2).toUpperCase()}` }));
    const e2 = await streamedDay(incentivesReader(fx, 'ethereum'), upper, '2026-10-23', BLOCKS, SUBSIDY_CREATORS.map((c) => c.toLowerCase()));
    expect(e2.byClass.protocol_subsidy).toEqual(e.byClass.protocol_subsidy);
  });

  it('discovery by state finds the scoping VRM count per chain', async () => {
    const want: Record<string, number> = { base: 321, ethereum: 62, optimism: 32, arbitrum: 56, ink: 28, robinhood: 81, arc: 8, elysium: 8 };
    for (const [chain, n] of Object.entries(want)) {
      expect(fx.discovery[chain].scoping_vrms, chain).toBe(n);
      const reader = incentivesReader(fx, chain);
      const vrms = await discoverVrms(reader, incentivesConfig(fx, chain), 123n);
      expect(vrms.length, chain).toBe(n);
      expect(new Set(vrms).size).toBe(n);
      expect(vrms).toEqual([...vrms].sort());
      expect(vrms.every((v) => v === v.toLowerCase())).toBe(true);
      // State only: no logs, every read at the given block, through LeafVoter → FactoryRegistry.
      expect(reader.stats.logs).toHaveLength(0);
      expect(new Set(reader.stats.calls.map((c) => c.block))).toEqual(new Set([123n]));
      expect(reader.stats.calls[0]).toMatchObject({ address: fx.leaf_voter, functionName: 'FACTORY_REGISTRY' });
    }
  });

  it("discovery fails when the LeafVoter's FactoryRegistry is not the configured one", async () => {
    const reader = incentivesReader(fx, 'optimism', { override: (c) => (c.functionName === 'FACTORY_REGISTRY' ? '0x1111111111111111111111111111111111111111' : undefined) });
    await expect(discoverVrms(reader, incentivesConfig(fx, 'optimism'), 1n)).rejects.toThrow(/FACTORY_REGISTRY/);
  });

  it('2026-11-26: vote_incentives and protocol_subsidy token amounts equal incentives-data/daily.json', async () => {
    for (const chain of ['base', 'optimism']) {
      const vrms = Object.keys(fx.incentive_counts).filter((k) => k.startsWith(`${chain}|`)).map((k) => k.split('|')[1]);
      const reader = incentivesReader(fx, chain);
      const progs = await programs(reader, vrms, 777n);
      expect(progs.length).toBe(vrms.reduce((n, v) => n + fx.incentive_counts[`${chain}|${v}`], 0));
      const r = await streamedDay(reader, progs, '2026-11-26', BLOCKS, SUBSIDY_CREATORS);
      const want = scopingByClass(chain, '2026-11-26');
      expectSameAmounts(chain, r.byClass.vote_incentives, want.vote_incentives, `${chain} vote_incentives`, want.n);
      expectSameAmounts(chain, r.byClass.protocol_subsidy, want.protocol_subsidy, `${chain} protocol_subsidy`, want.n);
      expect(r.programsActive).toBe(fx.expect.program_days.filter((x) => x.chain === chain && x.day === '2026-11-26').length);
      // Priced at the scoping's day-end prices, the amounts give daily.json's USD by class (Safe 0x80f7 + third parties =
      // vote_incentives; 0x7269 / 0x42255 = protocol_subsidy, none that day).
      const daily = fx.expect.daily_2026_11_26[chain]!;
      const price = new Map(fx.expect.program_days.filter((x) => x.chain === chain && x.day === '2026-11-26').map((x) => [program(fx, chain, x.vrm, x.id).token, x.price_usd]));
      const usd = (m: TokenAmounts) => [...m].reduce((s, [t, a]) => s + units(chain, t, a) * price.get(t)!, 0);
      const wantVote = (daily['third_party|allocated_usd'] ?? 0) + (daily['foundation_signer_safe_80f7|allocated_usd'] ?? 0);
      const wantSub = (daily['foundation_subsidy|allocated_usd'] ?? 0) + (daily['aero_admin_safe_42255|allocated_usd'] ?? 0);
      expect(Math.abs(usd(r.byClass.vote_incentives) - wantVote), chain).toBeLessThan(0.011);
      expect(usd(r.byClass.protocol_subsidy)).toBe(wantSub);
    }
    expect(Object.entries(fx.expect.daily_2026_11_26).filter(([, v]) => v !== null).map(([c]) => c).sort()).toEqual(['base', 'optimism']);
  });

  it('programs() reads incentiveCount and incentive(1..n) of each VRM at the given block', async () => {
    const reader = incentivesReader(fx, 'optimism');
    const got = await programs(reader, [OP_ZERO_VRM.toUpperCase().replace('0X', '0x')], 55n);
    expect(got.map((p) => p.id)).toEqual([1, 2]);
    expect(got[0]).toEqual({
      vrm: OP_ZERO_VRM, id: 1, token: OP_USDC, rate: 1409450231481481481n, start: 1793363400, end: 1793536200,
      creator: '0x5c1e6716f59f3c12c2b23163e9ab42ee0027cd93',
    } satisfies Program);
    expect(reader.stats.calls.filter((c) => c.functionName === 'incentive').map((c) => c.args[0])).toEqual([1n, 2n]);
    expect(new Set(reader.stats.calls.map((c) => c.block))).toEqual(new Set([55n]));
    // A VRM with no programs costs only its incentiveCount; no VRMs, no reads.
    expect(await programs(incentivesReader(fx, 'optimism', { override: (c) => (c.functionName === 'incentiveCount' ? 0n : undefined) }), [OP_ZERO_VRM], 1n)).toEqual([]);
    const idle = incentivesReader(fx, 'optimism');
    expect(await programs(idle, [], 1n)).toEqual([]);
    expect(idle.stats.batches).toBe(0);
  });

  it('a failed read fails the run (never a benign 0)', async () => {
    const fails = async (p: Promise<unknown>, what: RegExp) => {
      const err = await p.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OrionError);
      expect((err as OrionError).code).toBe('pool_scan_read_failed');
      expect(String((err as Error).message)).toMatch(what);
    };
    const nullOn = (fn: string) => ({ override: (c: { functionName: string }) => (c.functionName === fn ? null : undefined) });
    await fails(discoverVrms(incentivesReader(fx, 'optimism', nullOn('votingRewardsManager')), incentivesConfig(fx, 'optimism'), 1n), /chain 10 .*votingRewardsManager/);
    await fails(discoverVrms(incentivesReader(fx, 'optimism', nullOn('factoryToGauges')), incentivesConfig(fx, 'optimism'), 1n), /factoryToGauges/);
    await fails(programs(incentivesReader(fx, 'optimism', nullOn('incentiveCount')), [OP_ZERO_VRM], 1n), new RegExp(`${OP_ZERO_VRM}.incentiveCount`));
    await fails(programs(incentivesReader(fx, 'optimism', nullOn('incentive')), [OP_ZERO_VRM], 1n), /incentive\(1\)/);
    const second = fixturePrograms(fx, 'optimism', (p) => p.vrm === OP_ZERO_VRM && p.id === 2);
    for (const fn of ['getPriorSupplyIndex', 'supplyAt', 'globalRewardPointHistory']) {
      await fails(streamedDay(incentivesReader(fx, 'optimism', nullOn(fn)), second, '2026-11-04', BLOCKS, SUBSIDY_CREATORS), new RegExp(`chain 10 2026-11-04: ${OP_ZERO_VRM}.${fn}`));
    }
  });

  it('a day no program overlaps reads nothing', async () => {
    const reader = incentivesReader(fx, 'optimism');
    const second = fixturePrograms(fx, 'optimism', (p) => p.vrm === OP_ZERO_VRM);
    const r = await streamedDay(reader, second, '2026-11-20', BLOCKS, SUBSIDY_CREATORS);
    expect(r.programsActive).toBe(0);
    expect(r.byClass.vote_incentives.size + r.byClass.protocol_subsidy.size).toBe(0);
    expect(reader.stats.batches).toBe(0);
  });

  it('seconds before a VRM’s first checkpoint are zero-allocation (getPriorSupplyIndex 0)', async () => {
    // SYNTHETIC: a VRM whose first checkpoint is at 12:00Z on the day; the program runs the whole day.
    const VRM = '0x9999999999999999999999999999999999999999';
    const t0 = dayStartSec('2026-11-20');
    const prog: Program = { vrm: VRM, id: 1, token: OP_USDC, rate: 10n ** 18n, start: t0 - 100, end: t0 + 200_000, creator: SAFE_80F7 };
    const first = { bias: 5n, slope: 0n, ts: t0 + 43_200, permanentStakeBalance: 0n, zeroSupplySeconds: 0 };
    const reader = incentivesReader(fx, 'optimism', {
      zero: { [`${VRM}|${t0}`]: [0, 0n], [`${VRM}|${t0 + 86_400}`]: [1, 5n] },
      points: { [`${VRM}|1`]: first, [`${VRM}|0`]: { bias: 0n, slope: 0n, ts: 0, permanentStakeBalance: 0n, zeroSupplySeconds: 0 } },
    });
    const r = await streamedDay(reader, [prog], '2026-11-20', BLOCKS, SUBSIDY_CREATORS);
    expect(r.byClass.vote_incentives.get(OP_USDC)).toBe(43_200n);
    expect(r.ambiguous).toEqual([]);
  });

  it('a zero-supply point whose checkpoint still had supply is flagged ambiguous (the contract prices it as zero)', async () => {
    // SYNTHETIC: supplyAt(t1 − 1) = 0 but the last checkpoint (06:00Z) had bias > 0: the decay hit 0 somewhere in between.
    const VRM = '0x8888888888888888888888888888888888888888';
    const t0 = dayStartSec('2026-11-20');
    const prog: Program = { vrm: VRM, id: 1, token: OP_USDC, rate: 10n ** 18n, start: t0, end: t0 + 86_400, creator: SAFE_80F7 };
    const pt = { bias: 7n, slope: 1n, ts: t0 + 21_600, permanentStakeBalance: 0n, zeroSupplySeconds: 1_000 };
    const reader = incentivesReader(fx, 'optimism', {
      zero: { [`${VRM}|${t0}`]: [3, 9n], [`${VRM}|${t0 + 86_400}`]: [4, 0n] },
      points: { [`${VRM}|3`]: { ...pt, ts: t0 - 50, zeroSupplySeconds: 1_000 }, [`${VRM}|4`]: pt },
    });
    const r = await streamedDay(reader, [prog], '2026-11-20', BLOCKS, SUBSIDY_CREATORS);
    // Z(t1) = 1,000 + (86,400 − 21,600); Z(t0) = 1,000 → 64,800 s excluded, as RewardsLogicLibrary would sweep them.
    expect(r.byClass.vote_incentives.get(OP_USDC)).toBe(21_600n);
    expect(r.ambiguous).toEqual([{ vrm: VRM, t: t0 + 86_400 }]);
  });

  it('an impossible supply history (more zero seconds than the overlap) fails', async () => {
    const VRM = '0x7777777777777777777777777777777777777777';
    const t0 = dayStartSec('2026-11-20');
    const prog: Program = { vrm: VRM, id: 1, token: OP_USDC, rate: 10n ** 18n, start: t0, end: t0 + 86_400, creator: SAFE_80F7 };
    const reader = incentivesReader(fx, 'optimism', {
      zero: { [`${VRM}|${t0}`]: [3, 9n], [`${VRM}|${t0 + 86_400}`]: [4, 9n] },
      points: {
        [`${VRM}|3`]: { bias: 9n, slope: 0n, ts: t0 - 50, permanentStakeBalance: 0n, zeroSupplySeconds: 0 },
        [`${VRM}|4`]: { bias: 9n, slope: 0n, ts: t0 + 10, permanentStakeBalance: 0n, zeroSupplySeconds: 90_000 },
      },
    });
    await expect(streamedDay(reader, [prog], '2026-11-20', BLOCKS, SUBSIDY_CREATORS)).rejects.toThrow(/zero-allocation/);
  });

  it('the VRM structs decode through rpcChainReader into the fields the engine reads', async () => {
    const VRM = OP_ZERO_VRM;
    const prog = { token: OP_USDC as `0x${string}`, amount: 243552n, rate: 1409450231481481481n, start: 1793363400, end: 1793536200, creator: '0x5c1e6716f59f3c12c2b23163e9ab42ee0027cd93' as `0x${string}` };
    const point = { bias: 7n, slope: 3n, ts: 1793360823, permanentStakeBalance: 0n, zeroSupplySeconds: 0 };
    const rpc = fakeRpc({
      genesisTs: 1_700_000_000, latest: 1_000_000n, blockTimeSec: 2,
      dataCalls: (address, data) => {
        if (address !== VRM) return null;
        const { functionName } = decodeFunctionData({ abi: VRM_ABI, data: data as `0x${string}` });
        if (functionName === 'incentiveCount') return encodeFunctionResult({ abi: VRM_ABI, functionName, result: 1n });
        if (functionName === 'incentive') return encodeFunctionResult({ abi: VRM_ABI, functionName, result: prog });
        if (functionName === 'globalRewardPointHistory') return encodeFunctionResult({ abi: VRM_ABI, functionName, result: point });
        return null;
      },
    });
    const reader = rpcChainReader(rpc, 10);
    const [p] = await programs(reader, [VRM], 5n);
    expect(p).toEqual({ vrm: VRM, id: 1, token: OP_USDC, rate: prog.rate, start: prog.start, end: prog.end, creator: prog.creator });
    const [pt] = await reader.call<Record<string, unknown>>([{ address: VRM, abi: VRM_ABI, functionName: 'globalRewardPointHistory', args: [1n] }], 5n);
    expect(pt).toEqual(point);
  });

  describe('a VRM whose last allocation expires at a week boundary w, with no checkpoint after w (SYNTHETIC)', () => {
    // The contract writes the skipped weekly point at w lazily, pricing [pt.ts, w) from supply(w − 1) > 0 (allocated) and
    // [w, …) from supply 0 (zero). Thursday 2026-11-26 00:00Z is an epoch start (a multiple of WEEK).
    const WEEK = 604_800;
    const w = dayStartSec('2026-11-26');
    const VRM = '0x6666666666666666666666666666666666666666';
    const slope = 10n ** 12n;
    const pt = { bias: slope * 259_200n, slope, ts: w - 259_200, permanentStakeBalance: 0n, zeroSupplySeconds: 500 };
    const supply = (vrm: string, ts: number) => (vrm !== VRM ? undefined : ts < pt.ts ? 1n : ts >= w ? 0n : pt.bias - slope * BigInt(ts - pt.ts));
    const prog: Program = { vrm: VRM, id: 1, token: OP_USDC, rate: 10n ** 18n, start: w - 5 * 86_400, end: w + 5 * 86_400, creator: SAFE_80F7 };
    const reader = (bounds: number[]) =>
      incentivesReader(fx, 'optimism', { zero: Object.fromEntries(bounds.map((b) => [`${VRM}|${b}`, [5, 0n]])), points: { [`${VRM}|5`]: pt }, supply });
    const day = (d: number) => new Date(d * 1000).toISOString().slice(0, 10);

    it('Z matches the contract backfill on D = w − 1, w and w + 1, and the run does not throw', async () => {
      expect(w % WEEK).toBe(0);
      const got: bigint[] = [];
      for (const d of [w - 86_400, w, w + 86_400]) {
        const r = await streamedDay(reader([d, d + 86_400]), [prog], day(d), BLOCKS, SUBSIDY_CREATORS);
        got.push(r.byClass.vote_incentives.get(OP_USDC) ?? 0n);
        expect(r.ambiguous, day(d)).toEqual([]);
        expect(r.programsActive).toBe(1);
      }
      // w − 1: allocated all day; w and w + 1: Z(t) = 500 + (t − w), so every second is zero-allocation.
      expect(got).toEqual([86_400n, 0n, 0n]);
    });

    it('reads supplyAt(w − 1) at the skipped boundary and counts only [w, t)', async () => {
      // Program starting mid-day on w + 1: Z(a) = 500 + (a − w), Z(b) = 500 + (b − w); [pt.ts, w) is never zero.
      const mid: Program = { ...prog, start: w + 86_400 + 43_200 };
      const r0 = reader([mid.start, w + 2 * 86_400]);
      const r = await streamedDay(r0, [mid], day(w + 86_400), BLOCKS, SUBSIDY_CREATORS);
      expect(r.byClass.vote_incentives.size).toBe(0);
      const supplyArgs = r0.stats.calls.filter((c) => c.functionName === 'supplyAt').map((c) => Number(c.args[0]));
      expect(supplyArgs).toContain(w - 1);
      expect(supplyArgs).toContain(w);
      // A failed boundary read fails the run.
      const bad = incentivesReader(fx, 'optimism', {
        zero: { [`${VRM}|${w}`]: [5, 0n], [`${VRM}|${w + 86_400}`]: [5, 0n] }, points: { [`${VRM}|5`]: pt },
        supply: (v, ts) => (ts === w - 1 ? (null as unknown as bigint) : supply(v, ts)),
      });
      await expect(streamedDay(bad, [prog], day(w), BLOCKS, SUBSIDY_CREATORS)).rejects.toThrow(new RegExp(`${VRM}.supplyAt\\(${w - 1}\\)`));
    });

    it('a decay that reaches 0 inside an interval (not at a boundary) is flagged ambiguous and clamped, not thrown', async () => {
      // Lock ends are week-aligned, so only rounding gets here: supply hits 0 at w − 1 day, the next boundary is w.
      const early = { ...pt, bias: slope * 172_800n };
      const sup = (v: string, ts: number) => (v !== VRM ? undefined : ts >= w - 86_400 ? 0n : early.bias - slope * BigInt(ts - pt.ts));
      const d = w - 86_400;
      const r0 = incentivesReader(fx, 'optimism', {
        zero: { [`${VRM}|${d}`]: [5, 0n], [`${VRM}|${w}`]: [5, 0n] }, points: { [`${VRM}|5`]: early }, supply: sup,
      });
      const r = await streamedDay(r0, [prog], day(d), BLOCKS, SUBSIDY_CREATORS);
      expect(r.byClass.vote_incentives.size).toBe(0);
      expect(r.ambiguous.map((a) => a.vrm)).toContain(VRM);
    });
  });
});
