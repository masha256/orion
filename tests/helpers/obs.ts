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
