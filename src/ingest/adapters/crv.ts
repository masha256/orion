import type { SourceContext, SourceValue } from '../types.js';
import { unitsToNumber } from '../units.js';
import { chain, readAll, text, view } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * CRV's emission schedule, from the token contract (CRV.vy, Curve DAO). The contract mints to gauges at `rate` per second
 * (18 decimals) for one year from `start_epoch_time`; `update_mining_parameters` then starts the next epoch, with the
 * rate divided by RATE_REDUCTION_COEFFICIENT (2^(1/4), 18 decimals). Both constants are private in the contract (no
 * getter: the calls revert, checked 2026-10-08), so they are pinned here from the published source.
 */
const RATE_REDUCTION_TIME = 365n * 86_400n;
const RATE_REDUCTION_COEFFICIENT = 1189207115002721024n;
const E18 = 10n ** 18n;
const SECONDS_PER_YEAR = 365n * 86_400n;
const DECIMALS = 18;

interface Epochs {
  /** The rate in force at the block, per second, 18 decimals. */
  rate: bigint;
  /** When the epoch in force started, unix seconds. */
  start: bigint;
  /** Epochs rolled forward because nobody has called update_mining_parameters since the last one ended. */
  rolled: number;
}

/** The contract's own step, integer division included: rate * 1e18 / COEFFICIENT. */
export function reducedRate(rate: bigint): bigint {
  return (rate * E18) / RATE_REDUCTION_COEFFICIENT;
}

/** The epoch in force at `now`: the contract's state, rolled forward as update_mining_parameters would. */
export function epochAt(rate: bigint, start: bigint, now: bigint): Epochs {
  let rolled = 0;
  while (now >= start + RATE_REDUCTION_TIME) {
    start += RATE_REDUCTION_TIME;
    rate = reducedRate(rate);
    rolled++;
  }
  return { rate, start, rolled };
}

const perYear = (rate: bigint): number => unitsToNumber(rate * SECONDS_PER_YEAR, DECIMALS);
const isoAt = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

async function emissionSchedule(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> {
  const { block } = chain(ctx);
  const token = ctx.contract(text(params, 'token', 'token'));
  const [rateRaw, startRaw] = await readAll(ctx, [
    { address: token, signature: view('rate'), functionName: 'rate' },
    { address: token, signature: view('start_epoch_time'), functionName: 'start_epoch_time' },
  ]);
  const now = BigInt(block.timestamp);
  if (rateRaw <= 0n) throw new Error('rate() is zero: the token no longer emits, or this is not the CRV contract');
  if (startRaw > now) throw new Error(`start_epoch_time ${isoAt(startRaw)} is after the block (${isoAt(now)})`);
  const e = epochAt(rateRaw, startRaw, now);
  const nextRate = reducedRate(e.rate);
  if (!(nextRate < e.rate)) throw new Error('the next epoch would not lower the rate');
  const nextStart = e.start + RATE_REDUCTION_TIME;
  const detail =
    `rate ${unitsToNumber(e.rate, DECIMALS).toFixed(6)} CRV/s from ${isoAt(e.start)}; ` +
    `next ${unitsToNumber(nextRate, DECIMALS).toFixed(6)} CRV/s from ${isoAt(nextStart)}` +
    (e.rolled > 0 ? `; ${e.rolled} epoch(s) past the contract's state, rolled forward` : '');
  return {
    kind: 'schedule_steps',
    source: 'onchain',
    detail: `block ${block.number}: ${detail}`,
    steps: [
      { value: perYear(e.rate), observedAt: isoAt(now) },
      { value: perYear(nextRate), observedAt: isoAt(nextStart) },
    ],
  };
}

/** Gross CRV emissions per year: the step in force and the next coded reduction. */
const emissionRateAnnual: AdapterDef = {
  name: 'crv.emission_rate_annual',
  needsRpc: true,
  run: emissionSchedule,
};

export const crvAdapters: AdapterDef[] = [emissionRateAnnual];
