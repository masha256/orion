import type { Observation } from '../db/observations.js';

export interface ScheduleStep {
  from: string;
  value: number;
}

/** Newer observedAt wins; ties go to the higher id. */
function newer(a: Observation, b: Observation): Observation {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b;
  return a.id > b.id ? a : b;
}

export function latestLevel(obs: Observation[], asOf: string): Observation | undefined {
  let best: Observation | undefined;
  for (const o of obs) {
    if (o.observedAt > asOf) continue;
    best = best ? newer(best, o) : o;
  }
  return best;
}

export function buildSchedule(obs: Observation[], asOf: string): { steps: ScheduleStep[]; used: Observation[] } {
  const sorted = [...obs].sort((a, b) => (a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1));
  const inForce = latestLevel(sorted, asOf);
  const used = sorted.filter((o) => o === inForce || o.observedAt > asOf);
  return { steps: used.map((o) => ({ from: o.observedAt, value: o.value })), used };
}
