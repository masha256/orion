import { MS_PER_DAY } from '../types.js';

/** 'YYYY-MM-DD' of the UTC day containing `ms`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Exactly `YYYY-MM-DD`, and a real calendar day: `2026-02-30` does not round-trip. */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const at = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(at) && utcDay(at) === s;
}

export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * The UTC days an observation covers: from the start of the day its period begins in, up to its `observed_at`. A daily
 * row observed at the end of day D (D+1 00:00Z, period 1) covers D alone; a row not at midnight covers the day it ends
 * in as well. A null period is one day.
 */
export function observationDays(observedAt: string, periodDays: number | null): string[] {
  const endMs = new Date(observedAt).getTime();
  const days: string[] = [];
  for (let ms = dayStartMs(utcDay(endMs - (periodDays ?? 1) * MS_PER_DAY)); ms < endMs; ms += MS_PER_DAY) days.push(utcDay(ms));
  return days;
}

export function addDays(day: string, n: number): string {
  return utcDay(dayStartMs(day) + n * MS_PER_DAY);
}

/** 'YYYY-MM' of a 'YYYY-MM-DD' day. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}
