import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { OrionEnv } from '../../src/cli/paths.js';
import { defaultHandlers, type JobContext } from '../../src/daemon/daemon.js';
import {
  DEFAULT_REFRESH_DUMP, ENV_LOCAL_TABLES, makeStagingRefreshHandler, PG_BIN_DIR, PROD_LOAD_DUMP, REFRESH_DUMP_MAX_AGE_MS, UPLOADED_DUMP,
  type CommandRunner,
} from '../../src/daemon/jobs/stagingRefresh.js';
import { openDb, type OrionDb } from '../../src/db/connection.js';
import { enqueueJob, type Job } from '../../src/db/jobs.js';
import { loadMigrations, migrationStatus } from '../../src/db/pg/migrate.js';
import { insertRegistryRow, listRegistry } from '../../src/db/registry.js';
import { loadAssetYamls } from '../../src/registry/reconcile.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { FakeClock } from '../helpers/clock.js';
import { useTestDb } from '../helpers/db.js';
import { createTestSchema, dropTestSchema, newTestSchemaName, requireTestDatabaseUrl } from '../setup/pgGlobal.js';

const db = useTestDb();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NOW = '2026-11-08T10:30:00.000Z';
const HOUR = 3_600_000;
const job = { id: 7, kind: 'staging_refresh', assetId: null, slot: NOW } as unknown as Job;

/** Every table the migrations create that a refresh RESTORES from prod (the rest are ENV_LOCAL_TABLES). */
const PROD_DATA_TABLES = [
  'observations', 'fetch_runs', 'fetch_cursors', 'anomalies', 'coverage', 'agent_runs', 'agent_transcripts', 'proposals', 'journal', 'documents',
  'check_results', // 0003: computed from prod's observations, so prod's rows come with them
  'tokens', 'prices', // 0005: the tokens prod's flow rows refer to, and the hourly prices prod loaded
];

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A config root with `assets/mini.yaml` (the registry row the tests seed). */
function configRoot(): string {
  const root = scratch('orion-sr-root-');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  return root;
}

/** A dump file at `ageMs` old (contents unread by the fake runner). */
function dumpFile(ageMs: number, now = NOW): string {
  const file = join(scratch('orion-sr-dump-'), 'latest.dump');
  writeFileSync(file, 'PGDMP fake');
  const t = new Date(Date.parse(now) - ageMs);
  utimesSync(file, t, t);
  return file;
}

interface World {
  ctx: JobContext;
  posts: string[];
  logs: string[];
}

function world(o: { env?: OrionEnv; dump?: string | null; db?: OrionDb; root?: string; url?: string } = {}): World {
  const posts: string[] = [];
  const logs: string[] = [];
  const root = o.root ?? configRoot();
  const envVars: Record<string, string | undefined> = { ORION_DATABASE_URL: o.url ?? requireTestDatabaseUrl() };
  if (o.dump !== null) envVars.ORION_REFRESH_DUMP = o.dump ?? dumpFile(HOUR);
  const ctx: JobContext = {
    db: o.db ?? db(), clock: new FakeClock(NOW), env: o.env ?? 'stage',
    paths: { home: root, configRoot: root, envFile: join(root, 'no.env'), release: { tag: 'orion-2026.11.08-1', commit: 'abc', schema: 2, builtAt: NOW } },
    envVars, notify: { post: async (text) => { posts.push(text); return { ok: true, attempts: 1 }; } },
    signal: new AbortController().signal, enqueue: async (j) => await enqueueJob(o.db ?? db(), j), log: (l) => logs.push(l),
  };
  return { ctx, posts, logs };
}

/** `pg_restore -l -v` of a whole prod database: every migration table in `schema`, with its dependents. */
function fakeToc(schema: string): string {
  const lines = [
    ';', '; Archive created at 2026-11-08 08:30:02 UTC', ';     dbname: orion_prod', ';', '; Selected TOC Entries:', ';',
    '4001; 0 0 ENCODING - ENCODING ', '4002; 0 0 STDSTRINGS - STDSTRINGS ', '4003; 0 0 SEARCHPATH - SEARCHPATH ',
    '4004; 1262 16386 DATABASE - orion_prod orion_prod', '4005; 0 0 DATABASE PROPERTIES - orion_prod orion_prod',
    `6; 2615 20000 SCHEMA - ${schema} orion_prod`,
  ];
  let id = 100;
  const tables = [...PROD_DATA_TABLES, ...ENV_LOCAL_TABLES];
  for (const t of tables) {
    const tid = ++id;
    lines.push(`${tid}; 1259 ${30000 + tid} TABLE ${schema} ${t} orion_prod`, ';\tdepends on: 6');
    const seq = ++id;
    lines.push(`${seq}; 1259 ${30000 + seq} SEQUENCE ${schema} ${t}_id_seq orion_prod`, `;\tdepends on: ${tid} 6`);
    lines.push(`${++id}; 0 ${30000 + tid} TABLE DATA ${schema} ${t} orion_prod`, `;\tdepends on: ${tid}`);
    lines.push(`${++id}; 0 0 SEQUENCE SET ${schema} ${t}_id_seq orion_prod`, `;\tdepends on: ${seq}`);
    lines.push(`${++id}; 2606 ${30000 + id} CONSTRAINT ${schema} ${t} ${t}_pkey orion_prod`, `;\tdepends on: ${tid}`);
    lines.push(`${++id}; 1259 ${30000 + id} INDEX ${schema} idx_${t}_x orion_prod`, `;\tdepends on: ${tid}`);
    lines.push(`${++id}; 0 0 COMMENT ${schema} TABLE ${t} orion_prod`, `;\tdepends on: ${tid}`);
    lines.push(`${++id}; 0 0 ACL ${schema} TABLE ${t} orion_prod`, `;\tdepends on: ${tid}`);
  }
  lines.push(`${++id}; 2606 ${30000 + id} FK CONSTRAINT ${schema} proposals proposals_agent_run_id_fkey orion_prod`, ';\tdepends on: 101 102');
  return `${lines.join('\n')}\n`;
}

/** `pg_restore -f - --data-only -t schema_migrations` of a dump at the given migration ids (real names and sha256). */
function fakeMigrationsCopy(schema: string, ids: number[]): string {
  const byId = new Map(loadMigrations().map((m) => [m.id, m]));
  const rows = ids.map((id) => `${id}\t${byId.get(id)?.name ?? `future_${id}`}\t${byId.get(id)?.sha256 ?? 'f'.repeat(64)}\t2026-11-01 00:00:00+00`);
  return [
    '--', '-- PostgreSQL database dump', '--', "SELECT pg_catalog.set_config('search_path', '', false);",
    `COPY ${schema}.schema_migrations (id, name, sha256, applied_at) FROM stdin;`, ...rows, '\\.', '',
  ].join('\n');
}

interface Fake {
  run: CommandRunner;
  calls: string[][];
  /** The `-L` list file's text, read while the restore "ran". */
  restoreList: () => string | null;
}

function fakeRunner(o: { schema: string; ids?: number[]; restoreCode?: number }): Fake {
  const calls: string[][] = [];
  let list: string | null = null;
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('-l')) return { code: 0, stdout: fakeToc(o.schema), stderr: '' };
    if (args.includes('--data-only')) return { code: 0, stdout: fakeMigrationsCopy(o.schema, o.ids ?? loadMigrations().map((m) => m.id)), stderr: '' };
    if (args.includes('--clean')) {
      list = readFileSync(args[args.indexOf('-L') + 1]!, 'utf8');
      return o.restoreCode ? { code: o.restoreCode, stdout: '', stderr: 'pg_restore: error: could not execute query: ERROR:  boom\n' } : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { run, calls, restoreList: () => list };
}

const restoreCalls = (f: Fake): string[][] => f.calls.filter((c) => c.includes('--clean') || c.includes('-d'));

async function seedStaging(d: OrionDb, hash = 'h-stage'): Promise<void> {
  await insertRegistryRow(d, 'mini', 'active', hash, { at: '2026-11-01T00:00:00.000Z', by: 'raymond', reason: 'staging seed', releaseTag: null });
}

describe('stagingRefresh', () => {
  it('stagingRefresh: the default dump path and the handler are wired', async () => {
    expect(DEFAULT_REFRESH_DUMP).toBe('/home/orion-refresh/latest.dump');
    expect(REFRESH_DUMP_MAX_AGE_MS).toBe(36 * HOUR);
    expect(PG_BIN_DIR).toBe('/usr/lib/postgresql/18/bin');
    expect(await defaultHandlers().staging_refresh!(job, world({ env: 'dev' }).ctx)).toEqual({ status: 'skipped', result: { reason: 'not stage' } });
  });

  it('stagingRefresh: every table a migration creates is decided (env-local or restored from prod)', () => {
    const created = new Set<string>();
    for (const m of loadMigrations()) for (const x of m.sql.matchAll(/CREATE TABLE ([a-z_]+)/g)) created.add(x[1]!);
    created.add('schema_migrations');
    expect([...created].sort()).toEqual([...ENV_LOCAL_TABLES, ...PROD_DATA_TABLES].sort());
    expect(ENV_LOCAL_TABLES.filter((t) => PROD_DATA_TABLES.includes(t))).toEqual([]);
  });

  it('stagingRefresh: skipped outside stage', async () => {
    for (const env of ['dev', 'prod'] as const) {
      const f = fakeRunner({ schema: db().schema });
      const w = world({ env });
      const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
      expect(out).toEqual({ status: 'skipped', result: { reason: 'not stage' } });
      expect(f.calls).toEqual([]);
      expect(w.posts).toEqual([]);
    }
  });

  it('stagingRefresh: no dump yet is skipped quietly (the prod dump timer is not enabled yet)', async () => {
    const f = fakeRunner({ schema: db().schema });
    const w = world({ dump: join(scratch('orion-sr-none-'), 'latest.dump') });
    const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
    expect(out.status).toBe('skipped');
    expect(out).toMatchObject({ result: { reason: 'no dump yet' } });
    expect(f.calls).toEqual([]);
    expect(w.posts).toEqual([]);
    expect(w.logs.join('\n')).toMatch(/no dump yet/);
  });

  it('stagingRefresh: a stale or unreadable dump fails and alerts', async () => {
    const f = fakeRunner({ schema: db().schema });
    const w = world({ dump: dumpFile(37 * HOUR) });
    const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
    expect(out.status).toBe('failed');
    expect(out).toMatchObject({ error: expect.stringMatching(/older than 36 h/) });
    expect(f.calls).toEqual([]);
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toMatch(/^ORION ALERT stage staging_refresh: dump .* is 37 h old \(older than 36 h\)/);

    const dir = scratch('orion-sr-dir-');
    const w2 = world({ dump: dir }); // a directory where the file should be
    const out2 = await makeStagingRefreshHandler({ run: f.run })(job, w2.ctx);
    expect(out2.status).toBe('failed');
    expect(w2.posts[0]).toMatch(/^ORION ALERT stage staging_refresh: dump .* is not a file/);
  });

  it('stagingRefresh: schema mismatch is refused before any restore command', async () => {
    await seedStaging(db());
    for (const [ids, text] of [[[1], 'prod 1, staging 7'], [[1, 2, 3, 4, 5, 6, 7, 8], 'prod 8, staging 7']] as const) {
      const f = fakeRunner({ schema: db().schema, ids: [...ids] });
      const w = world();
      const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
      expect(out).toMatchObject({ status: 'failed', error: `schema mismatch: ${text}; refresh after both run the same schema` });
      expect(restoreCalls(f)).toEqual([]);
      expect(w.posts).toEqual([`ORION ALERT stage staging_refresh: schema mismatch: ${text}; refresh after both run the same schema`]);
    }
  });

  it('stagingRefresh: a dump of another schema is refused before any restore command', async () => {
    const f = fakeRunner({ schema: 'orion_elsewhere' });
    const w = world();
    const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(new RegExp(`no table of schema ${db().schema}.*orion_elsewhere`)) });
    expect(restoreCalls(f)).toEqual([]);
    expect(w.posts).toHaveLength(1);
  });

  it('stagingRefresh: the restore list excludes every env-local table', async () => {
    await seedStaging(db());
    const f = fakeRunner({ schema: db().schema });
    const dump = dumpFile(2 * HOUR);
    const w = world({ dump });
    const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
    expect(out.status).toBe('done');
    const [restore] = restoreCalls(f);
    expect(restore).toBeDefined();
    expect(restore![0]).toBe(existsSync(join(PG_BIN_DIR, 'pg_restore')) ? join(PG_BIN_DIR, 'pg_restore') : 'pg_restore');
    for (const flag of ['--clean', '--if-exists', '--no-owner', '--role=orion_stage', '--no-privileges', '--single-transaction', '-d']) {
      expect(restore).toContain(flag);
    }
    expect(restore![restore!.indexOf('-d') + 1]).toBe(requireTestDatabaseUrl());
    expect(restore!.at(-1)).toBe(dump);
    const list = f.restoreList()!;
    const entries = list.split('\n').filter((l) => /^\d+;/.test(l));
    for (const t of ENV_LOCAL_TABLES) {
      // No line names the table, its sequence, its index or its constraint.
      expect(entries.filter((l) => l.split(' ').some((tok) => tok === t || tok === `${t}_id_seq` || tok === `idx_${t}_x` || tok === `${t}_pkey`))).toEqual([]);
    }
    for (const t of PROD_DATA_TABLES) expect(entries.some((l) => l.includes(` TABLE DATA ${db().schema} ${t} `))).toBe(true);
    expect(entries.filter((l) => / (SCHEMA|DATABASE|DATABASE PROPERTIES) - /.test(l))).toEqual([]);
    expect(entries.filter((l) => / (ENCODING|STDSTRINGS|SEARCHPATH) - /.test(l))).toHaveLength(3);
    expect(entries.some((l) => l.includes('FK CONSTRAINT') && l.includes('proposals_agent_run_id_fkey'))).toBe(true);
    const mtime = statSync(dump).mtime.toISOString();
    expect(w.posts).toEqual([`ORION STAGING REFRESH done: restored ${mtime}, ${PROD_DATA_TABLES.length} tables`]);
    expect(out).toMatchObject({ result: { dumpMtime: mtime, tables: PROD_DATA_TABLES.length, delivered: true } });
    // The list file is removed afterwards.
    expect(existsSync(restore![restore!.indexOf('-L') + 1]!)).toBe(false);
  });

  it('stagingRefresh: a failed restore alerts with pg_restore\'s error', async () => {
    await seedStaging(db());
    const f = fakeRunner({ schema: db().schema, restoreCode: 1 });
    const w = world();
    const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
    expect(out).toMatchObject({ status: 'failed', error: 'pg_restore exit 1: pg_restore: error: could not execute query: ERROR:  boom' });
    expect(w.posts).toEqual(['ORION ALERT stage staging_refresh: pg_restore exit 1: pg_restore: error: could not execute query: ERROR:  boom']);
  });

  it('stagingRefresh: an uploaded dump (refresh-staging --stdin) is restored in place of prod\'s, then removed', async () => {
    expect(UPLOADED_DUMP).toBe(join('incoming', 'staging-refresh.dump'));
    await seedStaging(db());
    const prodDump = dumpFile(2 * HOUR);
    const root = configRoot();
    const uploaded = join(root, UPLOADED_DUMP);
    mkdirSync(join(root, 'incoming'), { mode: 0o700 });
    const upload = (): void => {
      writeFileSync(uploaded, 'PGDMP uploaded', { mode: 0o600 });
      const t = new Date(Date.parse(NOW) - 60_000); // sent a minute ago
      utimesSync(uploaded, t, t);
    };
    upload();
    const f = fakeRunner({ schema: db().schema });
    const w = world({ dump: prodDump, root });
    const out = await makeStagingRefreshHandler({ run: f.run })(job, w.ctx);
    expect(out.status).toBe('done');
    // The same three pg_restore calls (TOC, schema_migrations, the filtered restore), all on the uploaded file.
    expect(f.calls).toHaveLength(3);
    for (const c of f.calls) expect(c.at(-1)).toBe(uploaded);
    const mtime = new Date(Date.parse(NOW) - 60_000).toISOString();
    expect(w.posts).toEqual([`ORION STAGING REFRESH done: restored the uploaded dump (${mtime}), ${PROD_DATA_TABLES.length} tables`]);
    expect(out).toMatchObject({ result: { source: 'upload', tables: PROD_DATA_TABLES.length } });
    expect(existsSync(uploaded)).toBe(false);
    expect(existsSync(prodDump)).toBe(true);

    // A refused upload (another schema's dump) is removed too, so the weekly job never picks it up later.
    upload();
    const bad = fakeRunner({ schema: 'orion_elsewhere' });
    const w2 = world({ dump: prodDump, root });
    const out2 = await makeStagingRefreshHandler({ run: bad.run })(job, w2.ctx);
    expect(out2).toMatchObject({ status: 'failed', result: { source: 'upload' } });
    expect(w2.posts[0]).toMatch(/^ORION ALERT stage staging_refresh: the dump holds no table of schema/);
    expect(existsSync(uploaded)).toBe(false);

    // Without an upload, the weekly job reads prod's dump as before.
    const f3 = fakeRunner({ schema: db().schema });
    const out3 = await makeStagingRefreshHandler({ run: f3.run })(job, world({ dump: prodDump, root }).ctx);
    expect(out3).toMatchObject({ status: 'done', result: { source: 'prod' } });
    expect(f3.calls.at(-1)!.at(-1)).toBe(prodDump);
  });

  it('stagingRefresh: on prod, only the one-time initial load (load-prod --stdin) runs, and only into an empty prod', async () => {
    expect(PROD_LOAD_DUMP).toBe(join('incoming', 'prod-initial-load.dump'));
    const root = configRoot();
    const load = join(root, PROD_LOAD_DUMP);
    mkdirSync(join(root, 'incoming'), { mode: 0o700 });
    const upload = (): void => {
      writeFileSync(load, 'PGDMP initial', { mode: 0o600 });
      const t = new Date(Date.parse(NOW) - 60_000);
      utimesSync(load, t, t);
    };
    // A staging-style upload on prod is never read.
    writeFileSync(join(root, UPLOADED_DUMP), 'PGDMP staging', { mode: 0o600 });

    // 1. No initial-load file: skipped as before, nothing run.
    const f0 = fakeRunner({ schema: db().schema });
    const out0 = await makeStagingRefreshHandler({ run: f0.run })(job, world({ env: 'prod', root }).ctx);
    expect(out0).toEqual({ status: 'skipped', result: { reason: 'not stage' } });
    expect(f0.calls).toEqual([]);

    // 2. An empty prod (registry rows only, as after the daemon's first start): restored as orion_prod's role, then removed.
    await insertRegistryRow(db(), 'mini', 'inactive', 'h-prod', { at: '2026-11-01T00:00:00.000Z', by: 'daemon', reason: 'first start', releaseTag: null });
    upload();
    const f = fakeRunner({ schema: db().schema });
    const w = world({ env: 'prod', root, dump: null });
    const out = await makeStagingRefreshHandler({ run: f.run, role: undefined })(job, w.ctx);
    expect(out).toMatchObject({ status: 'done', result: { source: 'initial_load', tables: PROD_DATA_TABLES.length } });
    expect(f.calls).toHaveLength(3);
    for (const c of f.calls) expect(c.at(-1)).toBe(load);
    expect(restoreCalls(f)[0]).toContain('--role=orion_prod');
    const mtime = new Date(Date.parse(NOW) - 60_000).toISOString();
    expect(w.posts).toEqual([`ORION PROD INITIAL LOAD done: restored the uploaded dump (${mtime}), ${PROD_DATA_TABLES.length} tables`]);
    expect(existsSync(load)).toBe(false);
    expect(existsSync(join(root, UPLOADED_DUMP))).toBe(true);
    // The env-local tables stay out of the prod restore list too.
    expect(f.restoreList()!.split('\n').filter((l) => / TABLE DATA \S+ (jobs|asset_registry|daemon_heartbeat) /.test(l))).toEqual([]);

    // 3. A prod that holds data: refused before any pg_restore call, alerted as prod, and the file is removed.
    await db().run(`INSERT INTO fetch_runs (asset_id, started_at, ended_at, outcome, detail_json) VALUES ('mini', '2026-11-05T00:00:00Z', '2026-11-05T00:01:00Z', 'ok', '{}')`);
    upload();
    const f2 = fakeRunner({ schema: db().schema });
    const w2 = world({ env: 'prod', root, dump: null });
    const out2 = await makeStagingRefreshHandler({ run: f2.run })(job, w2.ctx);
    expect(out2).toMatchObject({ status: 'failed', result: { source: 'initial_load' } });
    expect((out2 as { error?: string }).error).toMatch(/^prod already holds data \(0 observations, 1 fetch runs\)/);
    expect(f2.calls).toEqual([]);
    expect(w2.posts).toHaveLength(1);
    expect(w2.posts[0]).toMatch(/^ORION ALERT prod initial_load: prod already holds data/);
    expect(existsSync(load)).toBe(false);
  });

  it('stagingRefresh: a password in ORION_DATABASE_URL goes to PGPASSWORD, never on argv', async () => {
    await seedStaging(db());
    const seen: { args: string[]; env: Record<string, string> }[] = [];
    const f = fakeRunner({ schema: db().schema });
    const run: CommandRunner = async (cmd, args, opts) => {
      seen.push({ args, env: opts.env });
      return await f.run(cmd, args, opts);
    };
    const w = world({ url: 'postgresql://orion_stage:s3cret@/orion_stage?host=/var/run/postgresql' });
    const out = await makeStagingRefreshHandler({ run })(job, w.ctx);
    expect(out.status).toBe('done');
    const restore = seen.find((s) => s.args.includes('--clean'))!;
    expect(restore.args.join(' ')).not.toContain('s3cret');
    expect(restore.args[restore.args.indexOf('-d') + 1]).toBe('postgresql://orion_stage@/orion_stage?host=/var/run/postgresql');
    expect(restore.env.PGPASSWORD).toBe('s3cret');
    expect(JSON.stringify(out)).not.toContain('s3cret');
  });
});

/** Rows of `table` in a stable order, as JSON text. */
async function tableJson(d: OrionDb, table: string): Promise<string> {
  const row = await d.one<{ j: string | null }>(`SELECT json_agg(t ORDER BY t::text)::text AS j FROM ${table} t`);
  return row?.j ?? '[]';
}

async function sql(text: string): Promise<void> {
  const c = new pg.Client({ connectionString: requireTestDatabaseUrl() });
  await c.connect();
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
}

describe('stagingRefresh (real pg_dump / pg_restore)', () => {
  it.each(['prod', 'upload'] as const)("stagingRefresh: staging's registry rows survive; prod's data replaces staging's (%s dump)", async (source) => {
    const bin = existsSync(join(PG_BIN_DIR, 'pg_dump')) ? PG_BIN_DIR : '';
    const pgDump = bin ? join(bin, 'pg_dump') : 'pg_dump';
    // "prod": its own schema, filled, dumped; then renamed away (kept as the reference), and "staging" created under
    // the same name, since prod and staging both use schema `orion` in their own databases.
    const prodCfg = await createTestSchema();
    const name = prodCfg.schema;
    const refName = newTestSchemaName();
    // The release's config root doubles as ORION_HOME: an upload lands in its incoming/ (refresh-staging --stdin).
    const root = configRoot();
    const work = scratch('orion-sr-real-');
    if (source === 'upload') mkdirSync(join(root, 'incoming'), { mode: 0o700 });
    const dump = source === 'upload' ? join(root, UPLOADED_DUMP) : join(work, 'latest.dump');
    let staging: OrionDb | null = null;
    const created = [prodCfg.schema];
    try {
      const prod = await openDb(prodCfg);
      try {
        await insertRegistryRow(prod, 'prodonly', 'active', 'h-prod', { at: '2026-10-01T00:00:00.000Z', by: 'import', reason: 'prod', releaseTag: null });
        await prod.run("INSERT INTO jobs (kind, slot, run_after, priority, status, max_attempts) VALUES ('levels', '2026-11-08T08:15:00Z', '2026-11-08T08:15:00Z', 40, 'done', 1)");
        await prod.run("INSERT INTO coverage VALUES ('mini', 'p-prod', '2026-10-01T00:00:00Z'), ('other', 'p-prod', '2026-10-02T00:00:00Z')");
        for (let i = 0; i < 3; i++) {
          await prod.run(`INSERT INTO observations (asset_id, metric_key, observed_at, value, status, fetched_at, method, source_type, locator, code_version, config_hash)
            VALUES ('mini', 'price_usd', $1, $2, 'confirmed', $1, 'measured', 'market_data', '{}', 'dev', 'h')`, [`2026-11-0${i + 1}T00:00:00Z`, 10 + i]);
        }
        await prod.run("INSERT INTO day_blocks VALUES (1, '2026-11-07', 100, 1762473600)");
        await prod.run("INSERT INTO latest_levels VALUES ('prodonly', 'price_usd', 1, '2026-11-08T08:15:00Z', 'api', null, 1, 'market_data', '{}')");
      } finally {
        await prod.close();
      }
      execFileSync(pgDump, ['-Fc', '-n', name, '-f', dump, requireTestDatabaseUrl()]);
      await sql(`ALTER SCHEMA ${name} RENAME TO ${refName}`);
      created.push(refName);
      const ref = await openDb({ url: requireTestDatabaseUrl(), schema: refName });

      await createTestSchema({ schema: name });
      staging = await openDb({ url: requireTestDatabaseUrl(), schema: name });
      // The registry row matches the release's YAML, so reconciliation after the restore changes nothing.
      await seedStaging(staging, loadAssetYamls(root)[0]!.hash);
      const running = await enqueueJob(staging, { kind: 'staging_refresh', assetId: null, slot: NOW });
      await staging.run("UPDATE jobs SET status = 'running', lease_owner = 'stage-daemon', attempts = 1 WHERE id = $1", [running!.id]);
      await staging.run("INSERT INTO daemon_heartbeat VALUES ('stage-daemon', 42, 'venus', 'orion-2026.11.08-1', $1, $1, $2, 'running', null)", [NOW, running!.id]);
      await staging.run("INSERT INTO latest_levels VALUES ('mini', 'price_usd', 12, '2026-11-08T08:15:00Z', 'api', null, 1, 'market_data', '{}')");
      await staging.run("INSERT INTO watch_state VALUES ('mini', 'price_usd', 'change_pct', true, '2026-11-07T00:00:00Z', 12)");
      await staging.run("INSERT INTO snapshots_out (kind, seq, snapshot_id, sha256, body, created_at) VALUES ('levels', 1, 's1', 'x', '{}', $1)", [NOW]);
      await staging.run("INSERT INTO day_blocks VALUES (1, '2026-11-08', 200, 1762560000)");
      await staging.run("INSERT INTO coverage VALUES ('stageonly', 'p-stage', '2026-11-01T00:00:00Z')");
      await staging.run(`INSERT INTO observations (asset_id, metric_key, observed_at, value, status, fetched_at, method, source_type, locator, code_version, config_hash)
        VALUES ('stageonly', 'price_usd', '2026-11-05T00:00:00Z', 99, 'confirmed', '2026-11-05T00:00:00Z', 'measured', 'market_data', '{}', 'dev', 'h')`);
      const before = new Map<string, string>();
      for (const t of ENV_LOCAL_TABLES) before.set(t, await tableJson(staging, t));

      const mtime = statSync(dump).mtime;
      const w = world({ db: staging, dump: source === 'upload' ? join(work, 'none.dump') : dump, root });
      w.ctx.clock = new FakeClock(new Date(mtime.getTime() + HOUR));
      const out = await makeStagingRefreshHandler({ role: 'orion_dev' })(job, w.ctx);
      expect(out).toMatchObject({ status: 'done', result: { source } });
      const what = source === 'upload' ? `the uploaded dump (${mtime.toISOString()})` : mtime.toISOString();
      expect(w.posts).toEqual([`ORION STAGING REFRESH done: restored ${what}, ${PROD_DATA_TABLES.length} tables`]);
      // An upload is consumed by the run; prod's dump is left for the next week.
      expect(existsSync(dump)).toBe(source === 'prod');

      for (const t of ENV_LOCAL_TABLES) expect({ t, rows: await tableJson(staging, t) }).toEqual({ t, rows: before.get(t) });
      expect((await listRegistry(staging)).map((r) => r.assetId)).toEqual(['mini']);
      for (const t of PROD_DATA_TABLES) expect({ t, rows: await tableJson(staging, t) }).toEqual({ t, rows: await tableJson(ref, t) });
      expect(await tableJson(staging, 'coverage')).not.toContain('stageonly');
      // Identity sequences come over with the data: a new row continues after prod's ids.
      const next = await staging.one<{ id: number }>(`INSERT INTO observations (asset_id, metric_key, observed_at, value, status, fetched_at, method, source_type, locator, code_version, config_hash)
        VALUES ('mini', 'price_usd', '2026-11-09T00:00:00Z', 1, 'confirmed', '2026-11-09T00:00:00Z', 'measured', 'market_data', '{}', 'dev', 'h') RETURNING id`);
      expect(next!.id).toBe(4);
      expect((await migrationStatus(staging)).state).toBe('current');
      await ref.close();
    } finally {
      if (staging) await staging.close();
      for (const s of created) await dropTestSchema({ url: requireTestDatabaseUrl(), schema: s });
      rmSync(dump, { force: true });
    }
    expect(readdirSync(work)).toEqual([]);
  }, 60_000);
});
