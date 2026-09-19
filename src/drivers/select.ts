import type { Observation } from '../db/observations.js';
import { DAYS_PER_YEAR, MS_PER_DAY, PROVENANCE_RANK, type Provenance } from '../types.js';

export interface ScheduleStep {
  from: string;
  value: number;
}

const ms = (iso: string) => new Date(iso).getTime();

/** Newer observedAt wins; ties go to the higher id. */
function newer(a: Observation, b: Observation): Observation {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b;
  return a.id > b.id ? a : b;
}

export function obsProvenance(o: Observation): Provenance {
  return o.status === 'provisional' ? 'provisional' : o.source;
}

export function worstProvenance(list: Provenance[]): Provenance {
  let worst: Provenance = 'onchain';
  for (const p of list) if (PROVENANCE_RANK[p] > PROVENANCE_RANK[worst]) worst = p;
  return worst;
}

export function latestLevel(obs: Observation[], asOf: string): Observation | undefined {
  let best: Observation | undefined;
  for (const o of obs) {
    if (o.observedAt > asOf) continue;
    best = best ? newer(best, o) : o;
  }
  return best;
}

export function trailingFlowAnnualized(
  obs: Observation[],
  asOf: string,
  windowDays: number,
): { annualized: number; used: Observation[] } {
  const windowEnd = ms(asOf);
  const windowStart = windowEnd - windowDays * MS_PER_DAY;
  let sum = 0;
  const used: Observation[] = [];
  for (const o of obs) {
    if (o.observedAt > asOf) continue;
    const period = (o.periodDays ?? 1) * MS_PER_DAY;
    const end = ms(o.observedAt);
    const start = end - period;
    const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart);
    if (overlap <= 0) continue;
    sum += o.value * (overlap / period);
    used.push(o);
  }
  return { annualized: (sum * DAYS_PER_YEAR) / windowDays, used };
}

export function buildSchedule(obs: Observation[], asOf: string): { steps: ScheduleStep[]; used: Observation[] } {
  const sorted = [...obs].sort((a, b) => (a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1));
  const inForce = latestLevel(sorted, asOf);
  const used = sorted.filter((o) => o === inForce || o.observedAt > asOf);
  return { steps: used.map((o) => ({ from: o.observedAt, value: o.value })), used };
}

export function isStale(freshnessIso: string, asOf: string, stalenessDays: number): boolean {
  return ms(asOf) - ms(freshnessIso) > stalenessDays * MS_PER_DAY;
}
