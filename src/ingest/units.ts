/** Integer base units to a float, splitting whole and fraction so the whole part is not rounded twice. */
export function unitsToNumber(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

/** A finite number from a number or a numeric string ("26.69", "3.95e+22"). Anything else is null. */
export function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
