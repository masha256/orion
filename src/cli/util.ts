import { join } from 'node:path';
import { openDb, type Db } from '../db/connection.js';
import type { Signal } from '../signals/schema.js';
import { OrionError } from '../types.js';

export interface CliContext {
  home: string;
  stdout: (line: string) => void;
  now: () => Date;
}

export function dbPath(ctx: CliContext): string {
  return join(ctx.home, 'orion.db');
}

export function withDb<T>(ctx: CliContext, fn: (db: Db) => T): T {
  const db = openDb(dbPath(ctx));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function output(ctx: CliContext, json: boolean | undefined, data: unknown, text: () => string[]): void {
  if (json) ctx.stdout(JSON.stringify(data, null, 2));
  else for (const line of text()) ctx.stdout(line);
}

export function parseNumber(text: string, label: string): number {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) throw new OrionError('invalid_number', `${label} must be a number, got "${text}"`);
  return n;
}

export const fmt = (n: number): string => n.toFixed(4);

export function signalSummary(s: Signal): string[] {
  const lines = [`${s.asset.toUpperCase()}  ${s.status}  grade ${s.data_quality.grade}  (${s.signal_id})`];
  if (s.spot) lines.push(`spot ${fmt(s.spot.price)} at ${s.spot.ts}`);
  for (const [name, h] of Object.entries(s.horizons ?? {})) {
    lines.push(
      `${name}  expected ${fmt(h.expected_target)}  upside ${h.upside_pct.toFixed(1)}%  staked total return ${h.staked_total_return_pct.toFixed(1)}%  dispersion ${h.dispersion.toFixed(2)}`,
    );
    lines.push(
      '     ' + (['bear', 'base', 'bull'] as const).map((k) => `${k} ${fmt(h.scenarios[k].target)} (${(h.scenarios[k].probability * 100).toFixed(0)}%)`).join('  '),
    );
    lines.push(
      '     ' + Object.entries(h.modules).map(([id, m]) => `${id} ${fmt(m.value)}${m.weight === null ? ' (component)' : ` (w ${m.weight.toFixed(2)})`}`).join('  '),
    );
    for (const [id, v] of Object.entries(h.extras)) lines.push(`     ${id} ${v.toFixed(1)}%`);
  }
  if (s.status_reasons.length > 0) lines.push(`reasons: ${s.status_reasons.join('; ')}`);
  if (s.data_quality.stale_metrics.length > 0) lines.push(`stale: ${s.data_quality.stale_metrics.join(', ')}`);
  if (s.data_quality.provisional_metrics.length > 0) lines.push(`provisional: ${s.data_quality.provisional_metrics.join(', ')}`);
  const anomalies = s.data_quality.anomalies ?? []; // signals stored before sub-project 2 have no list
  if (anomalies.length > 0) {
    lines.push(`open anomalies: ${anomalies.map((a) => `#${a.id} ${a.kind}${a.metric ? ` on ${a.metric}` : ''} (${a.severity})`).join('; ')}`);
  }
  if (s.change.prev_signal_id) {
    const delta = s.change.target_delta_pct === null ? 'n/a' : `${s.change.target_delta_pct.toFixed(1)}%`;
    lines.push(`change: ${s.change.cause}, 12m target ${delta} vs ${s.change.prev_signal_id}${s.change.rationale ? ` (${s.change.rationale})` : ''}`);
  }
  return lines;
}
