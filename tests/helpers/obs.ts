import type { Observation } from '../../src/db/observations.js';

export const AS_OF = '2026-06-30T00:00:00.000Z';

let nextId = 1;

export function obs(metricKey: string, value: number, observedAt: string, opts: Partial<Observation> = {}): Observation {
  const iso = new Date(observedAt).toISOString();
  return {
    id: nextId++,
    assetId: 'mini',
    metricKey,
    observedAt: iso,
    periodDays: null,
    value,
    source: 'onchain',
    sourceDetail: null,
    status: 'confirmed',
    citationUrl: null,
    quotedText: null,
    fetchedAt: iso,
    supersededBy: null,
    ...opts,
  };
}

export interface MiniOverrides {
  price?: number; revenue?: number; supply?: number; staked?: number;
  emission?: number; share?: number; flowAnnual?: number; flowMetric?: string;
}

/** A complete observation set for the mini asset. Defaults: price 10, revenue 1000, supply 100, flow 100/yr. */
export function miniObservations(o: MiniOverrides = {}): Observation[] {
  const flowAnnual = o.flowAnnual ?? 100;
  return [
    obs('price_usd', o.price ?? 10, '2026-06-29'),
    obs('revenue_run_rate_usd', o.revenue ?? 1000, '2026-06-15'),
    obs('effective_supply', o.supply ?? 100, '2026-06-29'),
    obs('staked_supply', o.staked ?? 50, '2026-06-29'),
    obs('staker_emission_share', o.share ?? 1, '2026-06-29'),
    obs('emission_rate_annual', o.emission ?? 0, '2026-01-01', { fetchedAt: '2026-06-29T00:00:00.000Z' }),
    obs(o.flowMetric ?? 'flow_usd.fees', (flowAnnual * 90) / 365, AS_OF, { periodDays: 90 }),
  ];
}
