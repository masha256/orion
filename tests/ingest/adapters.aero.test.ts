import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

// Aerodrome on Base, read live at block 51,704,207 (2026-09-23T21:09Z): see the AERO onboarding spec, section 2.1.
const TOKEN = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const VE = '0xebf418fe2512e7e6bd9b87a8f0f294acdc67e6b4';
const MINTER = '0xeb018363f0a9af8f91f06fee6613a751b2a33fe5';
const TOTAL = 1983240735576791446735550579n;
const LOCKED = 1051061695973990144830875038n;
const WEEKLY = 8969149540107574558747588n; // equal to TAIL_START less a rounding: the tail regime is on
const ACTIVE_PERIOD = 1789603200n; // 2026-09-17T00:00Z, read live
const VE_TOTAL_AT = 1027321406167859438293364475n; // ve.totalSupplyAt(activePeriod - 1): voting power, read live as totalSupply()
const LIVE = { [callKey(TOKEN, 'totalSupply')]: TOTAL, [callKey(VE, 'supply')]: LOCKED, [callKey(MINTER, 'weekly')]: WEEKLY, [callKey(MINTER, 'tailEmissionRate')]: 21n, [callKey(MINTER, 'teamRate')]: 228n, [callKey(MINTER, 'activePeriod')]: ACTIVE_PERIOD, [callKey(VE, 'totalSupplyAt', [ACTIVE_PERIOD - 1n])]: VE_TOTAL_AT };
const contract = (name: string) => ({ token: TOKEN, ve: VE, minter: MINTER })[name] ?? (() => { throw new Error(`no contract ${name}`); })();

async function chainCtx(calls: Record<string, bigint | Error>) {
  const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 500n, calls });
  return { ctx: sourceCtx({ rpc, block: await rpc.latestBlock(), contract }), rpc };
}

/** The Minter's own arithmetic on the live reads, in plain numbers. */
function expected() {
  const total = Number(TOTAL) / 1e18;
  const veTotal = Number(VE_TOTAL_AT) / 1e18;
  const base = (total * 21) / 10_000;
  const growth = (base * ((total - veTotal) / total) ** 2) / 2;
  const weekly = Number(WEEKLY) / 1e18;
  const team = (228 * (growth + weekly)) / (10_000 - 228);
  return { base, growth, team, gross: base + growth + team };
}

describe('AERO adapters', () => {
  it('are registered and need the chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['aero.emission_rate_annual', 'aero.staker_emission_share']));
    expect(getAdapter('aero.emission_rate_annual').needsRpc).toBe(true);
    expect(getAdapter('aero.staker_emission_share').needsRpc).toBe(true);
  });

  it('computes gross annual emissions in the tail regime from two multicalls: about 254M AERO a year today', async () => {
    const { ctx, rpc } = await chainCtx(LIVE);
    const v = await getAdapter('aero.emission_rate_annual').run(ctx, {});
    const e = expected();
    expect(v).toMatchObject({ kind: 'level', source: 'onchain', observedAt: new Date((1_700_000_001 + 1000) * 1000).toISOString() });
    expect(v.kind === 'level' && v.value).toBeCloseTo((e.gross * 365) / 7, 3);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(245e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(262e6);
    expect(v.detail).toMatch(/^block 500: tail 21 bps, team 228 bps; per week base 41648\d\d, rebase 48378\d, team 22055\d AERO$/);
    expect(rpc.stats.multicall).toBe(2);
  });

  it('gives the rebase share of the gross mint: about a tenth today', async () => {
    const { ctx } = await chainCtx(LIVE);
    const v = await getAdapter('aero.staker_emission_share').run(ctx, {});
    const e = expected();
    expect(v.kind === 'level' && v.value).toBeCloseTo(e.growth / e.gross, 12);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(0.09);
    expect(v.kind === 'level' && v.value).toBeLessThan(0.11);
  });

  it('follows the governed tail rate and the voting power: more locked, smaller rebase', async () => {
    const { ctx } = await chainCtx({ ...LIVE, [callKey(MINTER, 'tailEmissionRate')]: 22n, [callKey(VE, 'totalSupplyAt', [ACTIVE_PERIOD - 1n])]: (TOTAL * 3n) / 4n });
    const rate = await getAdapter('aero.emission_rate_annual').run(ctx, {});
    const share = await getAdapter('aero.staker_emission_share').run(ctx, {});
    const total = Number(TOTAL) / 1e18;
    const base = (total * 22) / 10_000;
    const growth = (base * 0.25 ** 2) / 2;
    const team = (228 * (growth + Number(WEEKLY) / 1e18)) / (10_000 - 228);
    expect(rate.kind === 'level' && rate.value).toBeCloseTo(((base + growth + team) * 365) / 7, 3);
    expect(share.kind === 'level' && share.value).toBeCloseTo(growth / (base + growth + team), 12);
  });

  it('refuses outside the tail regime, on a failed read, and without a chain', async () => {
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'weekly')]: 9_000_000n * 10n ** 18n })).ctx, {})).rejects.toThrow(/not in its tail regime/);
    await expect(getAdapter('aero.staker_emission_share').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'teamRate')]: new Error('boom') })).ctx, {})).rejects.toThrow(/teamRate\(\): boom/);
    await expect(getAdapter('aero.emission_rate_annual').run(sourceCtx({ contract }), {})).rejects.toThrow(/RPC/);
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(VE, 'supply')]: TOTAL * 2n })).ctx, {})).rejects.toThrow(/exceeds the total supply/);
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(VE, 'totalSupplyAt', [ACTIVE_PERIOD - 1n])]: TOTAL * 2n })).ctx, {})).rejects.toThrow(/voting power/);
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'tailEmissionRate')]: 0n })).ctx, {})).rejects.toThrow(/outside the Minter's 1 to 100/);
  });

  it('refuses a team rate of 10000 basis points: the team share would divide by zero', async () => {
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'teamRate')]: 10_000n })).ctx, {})).rejects.toThrow(/not a rate in basis points below 10000/);
  });

  it('refuses an activePeriod of 0: the Minter has never flipped an epoch, so there is no epoch start to read', async () => {
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'activePeriod')]: 0n })).ctx, {})).rejects.toThrow(/not an epoch start/);
  });

  it('refuses at weekly exactly equal to TAIL_START: the contract\'s rule is strict', async () => {
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'weekly')]: 8_969_150n * 10n ** 18n })).ctx, {})).rejects.toThrow(/not in its tail regime/);
  });

  it('allows weekly one wei below TAIL_START', async () => {
    const { ctx } = await chainCtx({ ...LIVE, [callKey(MINTER, 'weekly')]: 8_969_150n * 10n ** 18n - 1n });
    const v = await getAdapter('aero.emission_rate_annual').run(ctx, {});
    expect(v.kind === 'level' && v.value).toBeGreaterThan(0);
  });

  it('reproduces the 2026-09-17 mint recorded on chain (tx 0xd75b...288f) to the coin', async () => {
    // Derived from the mint at block 51,407,018: 4,154,745.63 AERO to the Voter (base = total * 21 / 10_000),
    // 481,314.48 to the RewardsDistributor (rebase, from voting power at the epoch's start), 220,497.93 to the team.
    const TOTAL_0917 = 1978450301428571428571428571n;
    const VE_0917 = 1026131435967671900000000000n;
    const { ctx } = await chainCtx({
      [callKey(TOKEN, 'totalSupply')]: TOTAL_0917,
      [callKey(VE, 'supply')]: LOCKED,
      [callKey(MINTER, 'weekly')]: WEEKLY,
      [callKey(MINTER, 'tailEmissionRate')]: 21n,
      [callKey(MINTER, 'teamRate')]: 228n,
      [callKey(MINTER, 'activePeriod')]: 1789603200n,
      [callKey(VE, 'totalSupplyAt', [1789603199n])]: VE_0917,
    });
    const v = await getAdapter('aero.emission_rate_annual').run(ctx, {});
    expect(v.detail).toMatch(/per week base 4154746, rebase 48131\d, team 220498 AERO$/);
    expect(v.kind === 'level' && v.value).toBeCloseTo(((4154745.63 + 481314.48 + 220497.93) * 365) / 7, -3);
  });

  it('takes contract names and the tail threshold from params', async () => {
    const other = (name: string) => ({ aero: TOKEN, escrow: VE, mint: MINTER })[name] ?? (() => { throw new Error(`no contract ${name}`); })();
    const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 500n, calls: LIVE });
    const ctx = sourceCtx({ rpc, block: await rpc.latestBlock(), contract: other });
    const v = await getAdapter('aero.staker_emission_share').run(ctx, { token: 'aero', ve: 'escrow', minter: 'mint', tail_start: 9_000_000 });
    expect(v.kind === 'level' && v.value).toBeCloseTo(expected().growth / expected().gross, 12);
    await expect(getAdapter('aero.staker_emission_share').run(ctx, { token: 'aero', ve: 'escrow', minter: 'mint', tail_start: 8_000_000 })).rejects.toThrow(/not in its tail regime/);
  });
});
