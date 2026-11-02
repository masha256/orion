import { join } from 'node:path';
import { anthropicModelClient, type ModelClient } from '../agent/model.js';
import { openDb, type Db } from '../db/connection.js';
import { realFetchDeps } from '../ingest/deps.js';
import type { FetchDeps, FetchResult } from '../ingest/run.js';
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

/** Opens the database for one command, and closes it once `fn` has settled, whether it resolved or threw. */
export async function withDb<T>(ctx: CliContext, fn: (db: Db) => Promise<T> | T): Promise<T> {
  const db = openDb(dbPath(ctx));
  try {
    return await fn(db);
  } finally {
    await db.close();
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
  for (const f of r.watch) lines.push(`  watch: ${f.metric} ${f.rule} ${trim(f.value)}${f.previous === null ? '' : ` (was ${trim(f.previous)})`} ${f.day}`);
  return lines;
}
