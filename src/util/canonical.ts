import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
