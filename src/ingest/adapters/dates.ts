/** Calendar helpers shared by the unlock-schedule adapters (`lit.unlocks_next_year`, `schedule.unlocks_next_year`). */

/** `y-m-d` moved by `months` (negative allowed), same day of month clamped to the month's end, as UTC midnight in ms. */
export function addMonthsClamped(y: number, m: number, d: number, months: number): number {
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d, lastDay));
}

/** A real calendar date written YYYY-MM-DD, as [y, m, d]; else null. */
export function isoDate(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

/** An integer in [lo, hi]. */
export const intIn = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
