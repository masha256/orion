import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationStatus } from '../../db/pg/migrate.js';
import { reconcileFromDisk } from '../../registry/reconcile.js';
import type { JobContext, JobHandler, JobOutcome } from '../daemon.js';

/**
 * The weekly `staging_refresh` job (spec 8.5, plan R7): restores prod's nightly logical dump into staging, keeping
 * staging's own daemon tables. Stage only. The tables below are never restored (their TOC entries, and every entry
 * that depends on them: sequences, indexes, constraints, comments, are dropped from the restore list):
 *
 * - `jobs`: staging's queue, including this running job (prod's queue would re-run prod's slots here).
 * - `asset_registry`, `asset_state_events`: asset states are per environment (spec 8.5), with their audit trail.
 * - `latest_levels`, `watch_state`: staging's own hourly readings and fire/clear state; prod's would make staging's next
 *   levels job post transitions it never saw.
 * - `snapshots_out`: staging's outbox numbers its snapshots for orion-data-staging; prod's seqs would collide there.
 * - `daemon_heartbeat`: the live staging daemon's row (and its drain flag).
 * - `day_blocks`: a cache of chain facts staging's code computed itself (a staging release may compute them anew).
 * - `schema_migrations`: staging's record of what its release applied; the refresh only runs when the dump's
 *   migrations are the same ids and checksums, so prod's copy would add nothing but prod's applied_at times.
 *
 * Everything else (observations, fetch runs and cursors, anomalies, coverage, agent runs and transcripts, proposals,
 * journal, documents, check results) is prod's after a refresh: staging's own week of those rows is overwritten, by design.
 */
export const ENV_LOCAL_TABLES = [
  'jobs', 'asset_registry', 'asset_state_events', 'latest_levels', 'watch_state', 'snapshots_out', 'daemon_heartbeat', 'day_blocks',
  'schema_migrations',
] as const;

/** Where prod's nightly dump lands (orion-pg-dump, `postgres:orion-refresh` 640); `$ORION_REFRESH_DUMP` overrides. */
export const DEFAULT_REFRESH_DUMP = '/home/orion-refresh/latest.dump';
/**
 * Where `orion-remote refresh-staging --stdin <sha256>` puts a dump it was sent (relative to ORION_HOME, i.e.
 * `~/home/incoming/staging-refresh.dump`, 600): an import proven on the dev host and dumped there (I-1/I-2). When it
 * exists, the job restores it in place of prod's dump and removes it afterwards, whatever the outcome. orion-remote's
 * UPLOADED_DUMP names the same path (tests/release/orionRemote.test.ts).
 */
export const UPLOADED_DUMP = join('incoming', 'staging-refresh.dump');
/**
 * Prod's one-time initial load (the cutover data route, 1.5c final review I-2): `orion-remote load-prod --stdin
 * <sha256>` puts a dump proven on the dev host here (`~/home/incoming/prod-initial-load.dump`, 600) and runs this job
 * on prod. It is restored by the same steps as a staging refresh (filtered list, schema check, one transaction,
 * registry reconciliation), but only while prod holds no data yet (no `observations` and no `fetch_runs` row), so it
 * can never overwrite a live prod. The file is removed afterwards, whatever the outcome. orion-remote's
 * PROD_LOAD_DUMP names the same path (tests/release/orionRemote.test.ts).
 */
export const PROD_LOAD_DUMP = join('incoming', 'prod-initial-load.dump');
/** The dump is written daily at 08:30 UTC; one older than this means the dump timer stopped. */
export const REFRESH_DUMP_MAX_AGE_MS = 36 * 3_600_000;
/** pg_restore must be at least the dump's pg_dump version: the server's own binaries, PATH when absent. */
export const PG_BIN_DIR = '/usr/lib/postgresql/18/bin';
export const STAGING_ROLE = 'orion_stage';
export const PROD_ROLE = 'orion_prod';
const RESTORE_TIMEOUT_MS = 2 * 3_600_000;
const READ_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 10_000;
const STDERR_KEEP = 2000;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one command (tests inject fakes). Never rejects; a timeout or an abort kills it (code null). */
export type CommandRunner = (
  cmd: string, args: string[], opts: { env: Record<string, string>; timeoutMs: number; signal: AbortSignal },
) => Promise<CommandResult>;

export interface StagingRefreshOptions {
  run?: CommandRunner;
  /** `pg_restore --role`; tests use the test role. Default: orion_stage on stage, orion_prod on prod. */
  role?: string;
  /** The directory holding pg_restore; '' = PATH. Default PG_BIN_DIR when it has pg_restore. */
  pgBin?: string;
}

export const runCommand: CommandRunner = (cmd, args, opts) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let killTimer: NodeJS.Timeout | undefined;
  const child = spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = (): void => {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref();
  };
  const timer = setTimeout(stop, opts.timeoutMs);
  timer.unref();
  opts.signal.addEventListener('abort', stop, { once: true });
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  let spawnError: string | undefined;
  child.on('error', (err) => {
    spawnError = err.message;
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    opts.signal.removeEventListener('abort', stop);
    resolve({ code: spawnError !== undefined && code === null ? 127 : code, stdout, stderr: spawnError ? `${stderr}\n${spawnError}` : stderr });
  });
});

/** One `pg_restore -l -v` entry: `<id>; <catalog oid> <oid> <type> <schema> <name...> <owner>`, with its dependencies. */
export interface TocEntry {
  id: number;
  line: string;
  type: string;
  schema: string;
  /** The words after the schema (name, owner; for COMMENT/ACL the object type first). */
  words: string[];
  deps: number[];
}

/** pg_dump's multi-word entry types, longest first, so `TABLE DATA` is not read as `TABLE`. */
const MULTI_WORD_TYPES = [
  'PUBLICATION TABLES IN SCHEMA', 'MATERIALIZED VIEW DATA', 'FOREIGN DATA WRAPPER', 'DATABASE PROPERTIES', 'PROCEDURAL LANGUAGE',
  'EXTENDED STATISTICS', 'SUBSCRIPTION TABLE', 'SEQUENCE OWNED BY', 'PUBLICATION TABLE', 'MATERIALIZED VIEW', 'STATISTICS DATA',
  'TEXT SEARCH CONFIGURATION', 'TEXT SEARCH DICTIONARY', 'TEXT SEARCH TEMPLATE', 'TEXT SEARCH PARSER', 'OPERATOR FAMILY',
  'OPERATOR CLASS', 'FOREIGN SERVER', 'FOREIGN TABLE', 'BLOB METADATA', 'CHECK CONSTRAINT', 'EVENT TRIGGER', 'ACCESS METHOD',
  'FK CONSTRAINT', 'LARGE OBJECT', 'ROW SECURITY', 'SEQUENCE SET', 'TABLE ATTACH', 'INDEX ATTACH', 'USER MAPPING', 'DEFAULT ACL',
  'SHELL TYPE', 'TABLE DATA',
].sort((a, b) => b.length - a.length);

export function parseToc(text: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const line of text.split('\n')) {
    const dep = /^;\s*depends on:\s*(.*)$/.exec(line);
    if (dep) {
      const last = entries.at(-1);
      if (last) last.deps.push(...dep[1]!.trim().split(/\s+/).filter((d) => d !== '').map(Number));
      continue;
    }
    const m = /^(\d+); \d+ \d+ (.*)$/.exec(line);
    if (!m) continue;
    const desc = m[2]!;
    const type = MULTI_WORD_TYPES.find((t) => desc.startsWith(`${t} `)) ?? desc.split(' ', 1)[0]!;
    const [schema = '', ...words] = desc.slice(type.length + 1).split(' ');
    entries.push({ id: Number(m[1]), line, type, schema, words, deps: [] });
  }
  return entries;
}

/** Entries without a schema that a restore needs (session settings); every other one (DATABASE, SCHEMA, ...) is left out. */
const SESSION_ENTRIES = new Set(['ENCODING', 'STDSTRINGS', 'SEARCHPATH']);

export interface RestorePlan {
  keep: TocEntry[];
  /** Env-local tables and everything depending on them. */
  local: TocEntry[];
  /** Entries of other schemas, the schema itself, the database: never restored. */
  outside: TocEntry[];
}

/**
 * Splits a dump's TOC for a restore into `schema`: an entry of an env-local table (by its TABLE entry, or any entry
 * naming the table right after the schema) and, transitively, everything depending on one is local; entries outside
 * `schema` (and the SCHEMA entry itself, which --clean would try to drop) are left out.
 */
export function planRestore(entries: TocEntry[], schema: string): RestorePlan {
  const localTables = new Set<string>(ENV_LOCAL_TABLES);
  const localIds = new Set<number>();
  for (const e of entries) {
    if (e.schema !== schema) continue;
    const named = e.words.slice(0, 2).some((w) => localTables.has(w));
    if (named) localIds.add(e.id);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const e of entries) {
      if (!localIds.has(e.id) && e.deps.some((d) => localIds.has(d))) {
        localIds.add(e.id);
        grew = true;
      }
    }
  }
  const plan: RestorePlan = { keep: [], local: [], outside: [] };
  for (const e of entries) {
    if (localIds.has(e.id)) plan.local.push(e);
    else if (e.schema === schema && e.type !== 'SCHEMA') plan.keep.push(e);
    else if (e.schema === '-' && SESSION_ENTRIES.has(e.type)) plan.keep.push(e);
    else plan.outside.push(e);
  }
  return plan;
}

/** `(id, sha256)` rows of a `COPY <schema>.schema_migrations (id, name, sha256, applied_at)` block. */
export function parseMigrationsCopy(text: string): { schema: string; rows: { id: number; sha256: string }[] } | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^COPY \S+\.schema_migrations \(/.test(l));
  if (start < 0) return null;
  const head = /^COPY (\S+)\.schema_migrations \(([^)]*)\)/.exec(lines[start]!)!;
  const cols = head[2]!.split(',').map((c) => c.trim());
  const idAt = cols.indexOf('id');
  const shaAt = cols.indexOf('sha256');
  const rows: { id: number; sha256: string }[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l === '\\.') break;
    const f = l.split('\t');
    rows.push({ id: Number(f[idAt]), sha256: f[shaAt] ?? '' });
  }
  return { schema: head[1]!, rows };
}

function lastLine(text: string): string {
  return (text.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? '').slice(0, 300);
}

/**
 * The URL without its password (which goes to PGPASSWORD): nothing secret is ever on argv. Parsed by hand: a socket URL
 * (`postgresql://user:pw@/db?host=...`) has an empty host, which WHATWG URL rejects.
 */
export function splitPassword(url: string): { url: string; password: string | null } {
  const m = /^(postgres(?:ql)?:\/\/)([^:@/?#]*):([^@/?#]*)@/.exec(url);
  if (!m) return { url, password: null };
  let password = m[3]!;
  try {
    password = decodeURIComponent(password);
  } catch {
    // not percent-encoded: as written
  }
  return { url: `${m[1]}${m[2]}@${url.slice(m[0].length)}`, password };
}

type Check = { ok: true } | { ok: false; error: string };

/**
 * `stagingRefreshHandler(job, ctx)`: refuses unless `ctx.env === 'stage'` (`skipped`, `not stage`). An uploaded dump
 * (`<ORION_HOME>/incoming/staging-refresh.dump`, from `orion-remote refresh-staging --stdin`) is restored in place of
 * prod's, by the same steps, and removed afterwards (`result.source`: `upload` or `prod`). No dump file at
 * `$ORION_REFRESH_DUMP` (default /home/orion-refresh/latest.dump) is `skipped` quietly (`no dump yet`: prod's dump
 * timer is not enabled yet); a dump that is not a readable file or is older than 36 h fails with an alert. Refuses a
 * dump whose migrations (ids and checksums) differ from staging's, or that holds no table of staging's schema, before
 * any restore command. Then `pg_restore --clean --if-exists --no-owner --no-privileges --role=orion_stage
 * --single-transaction` of the filtered list (a failure rolls back: staging is unchanged), registry reconciliation
 * from the release's YAML, and a migration status check. Posts `ORION STAGING REFRESH done: ...` or `ORION ALERT ...`.
 * It runs as one job at priority 5, so the single worker runs nothing else meanwhile.
 *
 * On prod the job is the one-time initial load only: without `<ORION_HOME>/incoming/prod-initial-load.dump` it is
 * `skipped` (`not stage`) as before; with it, it fails (`ORION ALERT prod initial_load: prod already holds data ...`)
 * unless prod has no observations and no fetch runs, then restores the file by the same steps as `--role=orion_prod`
 * (`result.source`: `initial_load`; posts `ORION PROD INITIAL LOAD done: ...`) and removes it.
 */
export function makeStagingRefreshHandler(o: StagingRefreshOptions = {}): JobHandler {
  const run = o.run ?? runCommand;
  const consume = (ctx: JobContext, file: string): void => {
    // Consumed: never restored a second time, and never left to raise the weekly job's "older than 36 h".
    try {
      unlinkSync(file);
    } catch (err) {
      ctx.log(`the uploaded dump ${file} could not be removed: ${(err as Error).message}`);
    }
  };
  return async (_job, ctx): Promise<JobOutcome> => {
    if (ctx.env === 'prod') {
      const load = join(ctx.paths.home, PROD_LOAD_DUMP);
      if (!existsSync(load)) {
        ctx.log('not stage: skipped (on prod this job only runs the one-time initial load, from load-prod --stdin)');
        return { status: 'skipped', result: { reason: 'not stage' } };
      }
      try {
        const held = await ctx.db.one<{ obs: string | number; runs: string | number }>(
          'SELECT (SELECT count(*) FROM observations) AS obs, (SELECT count(*) FROM fetch_runs) AS runs');
        const obs = Number(held?.obs ?? 0);
        const runs = Number(held?.runs ?? 0);
        if (obs > 0 || runs > 0) {
          return await failJob(ctx, `prod already holds data (${obs} observations, ${runs} fetch runs): the initial load only runs into an empty prod; nothing restored`, { source: 'initial_load' });
        }
        return await refresh(ctx, load, 'initial_load');
      } finally {
        consume(ctx, load);
      }
    }
    if (ctx.env !== 'stage') {
      ctx.log('not stage: skipped (the refresh only ever restores into staging)');
      return { status: 'skipped', result: { reason: 'not stage' } };
    }
    const uploaded = join(ctx.paths.home, UPLOADED_DUMP);
    if (!existsSync(uploaded)) return await refresh(ctx, ctx.envVars.ORION_REFRESH_DUMP?.trim() || DEFAULT_REFRESH_DUMP, 'prod');
    try {
      return await refresh(ctx, uploaded, 'upload');
    } finally {
      consume(ctx, uploaded);
    }
  };

  async function refresh(ctx: JobContext, dump: string, source: 'prod' | 'upload' | 'initial_load'): Promise<JobOutcome> {
    const role = o.role ?? (ctx.env === 'prod' ? PROD_ROLE : STAGING_ROLE);
    const fail = async (error: string, result: Record<string, unknown> = {}): Promise<JobOutcome> => await failJob(ctx, error, { ...result, source });
    let mtime: Date;
    try {
      const st = statSync(dump);
      if (!st.isFile()) return await fail(`dump ${dump} is not a file`);
      accessSync(dump, constants.R_OK);
      mtime = st.mtime;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        ctx.log(`no dump yet at ${dump} (prod's nightly dump is not enabled): skipped`);
        return { status: 'skipped', result: { reason: 'no dump yet', dump, source } };
      }
      return await fail(`dump ${dump} cannot be read: ${code ?? (err as Error).message}`);
    }
    const ageMs = ctx.clock.now().getTime() - mtime.getTime();
    if (ageMs > REFRESH_DUMP_MAX_AGE_MS) {
      return await fail(`dump ${dump} is ${Math.floor(ageMs / 3_600_000)} h old (older than 36 h): prod's nightly dump has stopped`);
    }
    const dumpMtime = mtime.toISOString();
    const urlRaw = ctx.envVars.ORION_DATABASE_URL?.trim();
    if (!urlRaw) return await fail('ORION_DATABASE_URL is not set');
    const { url, password } = splitPassword(urlRaw);
    const bin = o.pgBin ?? (existsSync(join(PG_BIN_DIR, 'pg_restore')) ? PG_BIN_DIR : '');
    const pgRestore = bin ? join(bin, 'pg_restore') : 'pg_restore';
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', PGAPPNAME: source === 'initial_load' ? 'orion initial_load' : 'orion staging_refresh' };
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (password !== null) env.PGPASSWORD = password;
    const schema = ctx.db.schema;

    // 1. The dump's TOC and its schema version, read from the file only.
    const toc = await run(pgRestore, ['-l', '-v', dump], { env, timeoutMs: READ_TIMEOUT_MS, signal: ctx.signal });
    if (toc.code !== 0) return await fail(`pg_restore -l exit ${toc.code}: ${lastLine(toc.stderr)}`);
    const entries = parseToc(toc.stdout);
    const plan = planRestore(entries, schema);
    const tables = plan.keep.filter((e) => e.type === 'TABLE');
    if (tables.length === 0) {
      const schemas = [...new Set(entries.filter((e) => e.type === 'TABLE').map((e) => e.schema))].sort();
      return await fail(`the dump holds no table of schema ${schema} (its schemas: ${schemas.join(', ') || 'none'})`);
    }
    const versions = await run(pgRestore, ['-f', '-', '--data-only', '-n', schema, '-t', 'schema_migrations', dump], { env, timeoutMs: READ_TIMEOUT_MS, signal: ctx.signal });
    if (versions.code !== 0) return await fail(`pg_restore of schema_migrations exit ${versions.code}: ${lastLine(versions.stderr)}`);
    const prodRows = parseMigrationsCopy(versions.stdout)?.rows ?? [];
    const stageRows = await ctx.db.all<{ id: number; sha256: string }>('SELECT id, sha256 FROM schema_migrations ORDER BY id');
    const same = checkSameSchema(prodRows, stageRows);
    if (!same.ok) return await fail(same.error);
    if (ctx.signal.aborted) return { status: 'failed', result: { dumpMtime, source }, error: 'aborted before the restore' };

    // 2. The restore: one transaction, so a failure leaves staging as it was.
    const dir = mkdtempSync(join(tmpdir(), 'orion-staging-refresh-'));
    const listFile = join(dir, 'restore.list');
    let restore: CommandResult;
    try {
      writeFileSync(listFile, `${plan.keep.map((e) => e.line).join('\n')}\n`, { mode: 0o600 });
      ctx.log(`restoring ${dump} (${dumpMtime}): ${tables.length} tables, ${plan.local.length} env-local entries kept out, ${plan.outside.length} outside ${schema}`);
      restore = await run(pgRestore, [
        '--clean', '--if-exists', '--no-owner', '--no-privileges', `--role=${role}`, '--single-transaction',
        '-L', listFile, '-d', url, dump,
      ], { env, timeoutMs: RESTORE_TIMEOUT_MS, signal: ctx.signal });
    } finally {
      try {
        unlinkSync(listFile);
      } catch {
        // never written
      }
      rmdirSync(dir);
    }
    const base = { dumpMtime, tables: tables.length, localEntries: plan.local.length, outsideEntries: plan.outside.length, source };
    if (restore.code !== 0) {
      return await fail(`pg_restore exit ${restore.code}: ${lastLine(restore.stderr)}`, { ...base, stderr: restore.stderr.slice(-STDERR_KEEP) });
    }

    // 3. Staging's own registry against its release's YAML, then the schema must still be current.
    let reconciled: Record<string, unknown>;
    try {
      const diff = await reconcileFromDisk(ctx.db, ctx.paths.configRoot, ctx.paths.release?.tag ?? null, ctx.clock.now());
      reconciled = diff as unknown as Record<string, unknown>;
    } catch (err) {
      return await fail(`restored, but registry reconciliation failed: ${(err as Error).message}`, base);
    }
    const status = await migrationStatus(ctx.db);
    if (status.pending.length > 0 || status.state === 'changed') {
      return await fail(`restored, but the schema is ${status.state} (pending ${status.pending.map((p) => p.id).join(', ') || 'none'})`, base);
    }
    const what = source === 'prod' ? dumpMtime : `the uploaded dump (${dumpMtime})`;
    const head = source === 'initial_load' ? 'ORION PROD INITIAL LOAD done' : 'ORION STAGING REFRESH done';
    const res = await ctx.notify.post(`${head}: restored ${what}, ${tables.length} tables`);
    if (!res.ok) ctx.log('the done line was not delivered');
    return { status: 'done', result: { ...base, reconciled, delivered: res.ok } };
  }
}

/** The dump's migrations must be staging's: the same ids with the same checksums. */
function checkSameSchema(prod: { id: number; sha256: string }[], stage: { id: number; sha256: string }[]): Check {
  const max = (rows: { id: number }[]): number => rows.reduce((m, r) => Math.max(m, r.id), 0);
  const key = (rows: { id: number; sha256: string }[]): string => rows.map((r) => `${r.id}:${r.sha256}`).sort().join(' ');
  if (key(prod) === key(stage)) return { ok: true };
  const a = max(prod);
  const b = max(stage);
  const detail = a === b ? ' (same id, different migration checksums)' : '';
  return { ok: false, error: `schema mismatch: prod ${a}, staging ${b}${detail}; refresh after both run the same schema` };
}

/** Posts the one ALERT line (the fenced notifier drops it once the job was aborted) and fails the job (no retry). */
async function failJob(ctx: JobContext, error: string, result: Record<string, unknown> = {}): Promise<JobOutcome> {
  ctx.log(error);
  const res = await ctx.notify.post(ctx.env === 'prod' ? `ORION ALERT prod initial_load: ${error}` : `ORION ALERT stage staging_refresh: ${error}`);
  return { status: 'failed', result: { ...result, delivered: res.ok }, error };
}

export const stagingRefreshHandler: JobHandler = makeStagingRefreshHandler();
