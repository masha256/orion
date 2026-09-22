import { join } from 'node:path';
import { anthropicModelClient, type ModelClient } from '../agent/model.js';
import { openDb, type Db } from '../db/connection.js';
import { realFetchDeps } from '../ingest/deps.js';
import type { FetchDeps, FetchResult } from '../ingest/run.js';
import type { Signal } from '../signals/schema.js';
import { OrionError } from '../types.js';
import { loadEnv } from './env.js';

export interface CliContext {
  home: string;
  stdout: (line: string) => void;
  now: () => Date;
  /** Transports and environment for fetching. Tests inject fakes; by default the real ones are built. */
  ingestDeps?: () => FetchDeps;
  /** Progress lines. Never stdout, which may be carrying JSON. */
  stderr?: (line: string) => void;
  setExitCode?: (code: number) => void;
  /** The model behind `orion agent run`. Tests inject a scripted model; by default the real client is built from the environment. */
  modelClient?: () => ModelClient;
}

export function modelClientFor(ctx: CliContext): ModelClient {
  return ctx.modelClient ? ctx.modelClient() : anthropicModelClient(loadEnv(ctx.home, process.env));
}

/**
 * Runs a command action. Under `--json` an OrionError is printed as JSON on stdout, with exit code 1, instead of being
 * thrown to the top-level handler, which prints text. Anything that is not an OrionError still propagates.
 */
export async function guarded(ctx: CliContext, json: boolean | undefined, action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (!json || !(err instanceof OrionError)) throw err;
    ctx.stdout(JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2));
    ctx.setExitCode?.(1);
  }
}

export function dbPath(ctx: CliContext): string {
  return join(ctx.home, 'orion.db');
}

export function ingestDepsFor(ctx: CliContext): FetchDeps {
  return ctx.ingestDeps ? ctx.ingestDeps() : realFetchDeps(loadEnv(ctx.home, process.env), ctx.now);
}

export async function withDbAsync<T>(ctx: CliContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = openDb(dbPath(ctx));
  try {
    return await fn(db);
  } finally {
    db.close();
  }
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

export function signalSummary(s: Signal, opts: { rationale?: boolean } = {}): string[] {
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
    // `causes` and `author` are absent on signals stored before sub-project 3.
    const cause = s.change.cause === 'both' && s.change.causes ? s.change.causes.join(' + ') : s.change.cause;
    const by = s.change.author ? ` by ${s.change.author}` : '';
    lines.push(`change: ${cause}${by}, 12m target ${delta} vs ${s.change.prev_signal_id}${opts.rationale !== false && s.change.rationale ? ` (${s.change.rationale})` : ''}`);
  }
  return lines;
}

const trim = (n: number): string => String(Number(n.toPrecision(10)));

export function fetchSummary(r: FetchResult): string[] {
  const lines = [`${r.assetId.toUpperCase()} fetch ${r.outcome}${r.dryRun ? ' (dry run: nothing was written)' : ''}`];
  for (const s of r.sources) {
    const status = s.status === 'failed' ? 'FAILED' : s.status;
    const wrote = s.metricsWritten.length > 0 ? `${r.dryRun ? 'would write' : 'wrote'} ${s.metricsWritten.join(', ')}` : '';
    lines.push(`  ${status.padEnd(8)} ${s.sourceId}  ${wrote}`.trimEnd());
    if (s.error) lines.push(`    error: ${s.error}`);
    for (const c of s.crossChecks) {
      const where = c.label === 'level' ? '' : ` ${c.label}`;
      lines.push(
        `    check ${c.metricKey}${where} vs ${c.sourceId}: ${trim(c.primary)} vs ${trim(c.check)} (${c.diffPct.toFixed(2)}% ${c.ok ? 'within' : 'OUTSIDE'} ${c.tolerancePct}%)`,
      );
    }
    for (const c of s.conflicts) {
      lines.push(
        `    conflict #${c.observationId} ${c.metricKey} ${c.source} ${c.observedAt}${c.periodDays ? ` (${c.periodDays}d)` : ''} ${c.adoptable ? 'adoptable' : 'NOT adoptable'}`,
      );
    }
    if (s.retiredObservationIds.length > 0) lines.push(`    rejected manual rows: ${s.retiredObservationIds.map((id) => `#${id}`).join(', ')}`);
    for (const t of s.unlistedTransfers) lines.push(`    unlisted sender ${t.from}: ${trim(t.tokens)} tokens on ${t.day} (tx ${t.txHash})`);
    for (const note of s.notes) lines.push(`    note: ${note}`);
  }
  for (const a of r.anomalies) {
    const standing = a.status === 'acknowledged' ? ': seen again, stays acknowledged' : '';
    lines.push(`  anomaly ${a.id === null ? '(not recorded)' : `#${a.id}`} ${a.kind}${a.metricKey ? ` on ${a.metricKey}` : ''} (${a.severity})${standing}`);
  }
  return lines;
}
