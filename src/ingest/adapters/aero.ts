import { DAYS_PER_YEAR } from '../../types.js';
import type { SourceContext } from '../types.js';
import { unitsToNumber } from '../units.js';
import { number, onchain, readAll, text, view } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Aerodrome's Minter in its tail regime (verified live on 2026-09-23: weekly() sits at TAIL_START, tailEmissionRate 21,
 * teamRate 228). Each epoch it mints base = totalSupply * tailEmissionRate / 10_000 to the gauges, a rebase
 * growth = base * ((total - locked) / total)^2 / 2 to veAERO lockers, and team = teamRate * (growth + base) / (10_000 - teamRate).
 * Outside the tail the Minter decays `weekly` by 1 percent per epoch instead, which these adapters do not model: they refuse.
 */

const TOKEN_DECIMALS = 18;
const BPS = 10_000;
/** Epochs in the engine's 365-day year: the annual rate is what the engine spreads over its horizon. */
const WEEKS_PER_YEAR = DAYS_PER_YEAR / 7;
/** The Minter's TAIL_START, in AERO: the weekly base emission below which the tail regime is on. */
const TAIL_START_AERO = 8_969_150;

interface TailEmissions {
  base: number;
  growth: number;
  team: number;
  gross: number;
  tailRate: number;
  teamRate: number;
}

async function tailEmissions(ctx: SourceContext, params: Record<string, unknown>): Promise<TailEmissions> {
  const token = ctx.contract(text(params, 'token', 'token'));
  const ve = ctx.contract(text(params, 've', 've'));
  const minter = ctx.contract(text(params, 'minter', 'minter'));
  const [totalRaw, lockedRaw, weeklyRaw, tailRateRaw, teamRateRaw] = await readAll(ctx, [
    { address: token, signature: view('totalSupply'), functionName: 'totalSupply' },
    { address: ve, signature: view('supply'), functionName: 'supply' },
    { address: minter, signature: view('weekly'), functionName: 'weekly' },
    { address: minter, signature: view('tailEmissionRate'), functionName: 'tailEmissionRate' },
    { address: minter, signature: view('teamRate'), functionName: 'teamRate' },
  ]);
  const total = unitsToNumber(totalRaw, TOKEN_DECIMALS);
  const locked = unitsToNumber(lockedRaw, TOKEN_DECIMALS);
  const weekly = unitsToNumber(weeklyRaw, TOKEN_DECIMALS);
  const tailStart = number(params, 'tail_start', TAIL_START_AERO);
  if (!(weekly < tailStart)) {
    throw new Error(`the Minter is not in its tail regime (weekly ${weekly} is not below ${tailStart}); these adapters model tail emissions only`);
  }
  if (!(total > 0)) throw new Error('AERO total supply is not positive');
  if (locked > total) throw new Error(`locked AERO (${locked}) exceeds the total supply (${total})`);
  const tailRate = Number(tailRateRaw);
  const teamRate = Number(teamRateRaw);
  if (teamRate >= BPS) throw new Error(`teamRate ${teamRate} is not below ${BPS} basis points`);
  const base = (total * tailRate) / BPS;
  const unlockedShare = (total - locked) / total;
  const growth = (base * unlockedShare * unlockedShare) / 2;
  const team = (teamRate * (growth + base)) / (BPS - teamRate);
  return { base, growth, team, gross: base + growth + team, tailRate, teamRate };
}

const detailOf = (e: TailEmissions): string =>
  `tail ${e.tailRate} bps, team ${e.teamRate} bps; per week base ${e.base.toFixed(0)}, rebase ${e.growth.toFixed(0)}, team ${e.team.toFixed(0)} AERO`;

/** Gross annual emissions (gauges plus rebase plus team) at this week's tail rate, as the schedule step in force. */
const emissionRateAnnual: AdapterDef = {
  name: 'aero.emission_rate_annual',
  needsRpc: true,
  async run(ctx, params) {
    const e = await tailEmissions(ctx, params);
    return onchain(ctx, e.gross * WEEKS_PER_YEAR, detailOf(e));
  },
};

/** The rebase's share of the gross weekly mint: what reaches veAERO lockers of every token emitted. */
const stakerEmissionShare: AdapterDef = {
  name: 'aero.staker_emission_share',
  needsRpc: true,
  async run(ctx, params) {
    const e = await tailEmissions(ctx, params);
    return onchain(ctx, e.growth / e.gross, detailOf(e));
  },
};

export const aeroAdapters: AdapterDef[] = [emissionRateAnnual, stakerEmissionShare];
