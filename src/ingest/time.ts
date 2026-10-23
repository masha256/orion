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
