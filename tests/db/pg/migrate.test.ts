import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../../../src/db/connection.js';
import { applyMigrations, loadMigrations, migrationStatus } from '../../../src/db/pg/migrate.js';
import { openPgDb, type PgDb } from '../../../src/db/pg/pool.js';
import { createTestSchema, dropTestSchema } from '../../setup/pgGlobal.js';

const opened: { db: PgDb; config: DatabaseConfig }[] = [];
const dirs: string[] = [];

async function emptySchema(): Promise<PgDb> {
  const config = await createTestSchema({ migrate: false });
  const db = await openPgDb(config);
  opened.push({ db, config });
  return db;
}

function migrationDir(files: Record<string, string>): URL {
  const dir = mkdtempSync(join(tmpdir(), 'orion-migrations-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return pathToFileURL(dir + '/');
}

afterEach(async () => {
  for (const { db, config } of opened.splice(0)) {
    await db.close();
    await dropTestSchema(config);
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  for (const { db, config } of opened.splice(0)) {
    await db.close();
    await dropTestSchema(config);
  }
});

describe('migrate', () => {
  it('migrate: the shipped migrations apply to an empty schema (0006 only with breaking); a second run applies nothing; status is current', async () => {
    const db = await emptySchema();
    const before = await migrationStatus(db);
    expect(before).toMatchObject({ schema: db.schema, dbAt: 0, codeRequires: 7, applied: [], changed: [], state: 'behind' });
    expect(before.pending).toEqual([
      { id: 1, name: 'baseline', breaking: false }, { id: 2, name: 'daemon', breaking: false }, { id: 3, name: 'checks', breaking: false },
      { id: 4, name: 'provenance', breaking: false }, { id: 5, name: 'tokens_prices', breaking: false }, { id: 6, name: 'provenance_not_null', breaking: true },
      { id: 7, name: 'job_params', breaking: false },
    ]);

    await expect(applyMigrations(db, {})).rejects.toMatchObject({ code: 'migration_breaking', message: expect.stringContaining('6') });
    expect((await migrationStatus(db)).dbAt).toBe(0);
    expect(await applyMigrations(db, { breaking: true })).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7] });
    expect(await applyMigrations(db, {})).toEqual({ applied: [] });
    const after = await migrationStatus(db);
    const [baseline, daemon, checks, provenance, tokensPrices, notNull, jobParams] = loadMigrations();
    expect(after).toMatchObject({ dbAt: 7, codeRequires: 7, pending: [], changed: [], state: 'current' });
    expect(after.applied).toEqual([
      { id: 1, name: 'baseline', sha256: baseline!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 2, name: 'daemon', sha256: daemon!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 3, name: 'checks', sha256: checks!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 4, name: 'provenance', sha256: provenance!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 5, name: 'tokens_prices', sha256: tokensPrices!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 6, name: 'provenance_not_null', sha256: notNull!.sha256, appliedAt: expect.stringMatching(/Z$/) },
      { id: 7, name: 'job_params', sha256: jobParams!.sha256, appliedAt: expect.stringMatching(/Z$/) },
    ]);
    expect((await db.one<{ n: number }>('SELECT count(*) AS n FROM observations'))?.n).toBe(0);
  });

  it('migrate: creates the schema when it is absent', async () => {
    const db = await emptySchema();
    await db.run(`DROP SCHEMA ${db.schema}`);
    expect((await migrationStatus(db)).state).toBe('behind');
    expect(await applyMigrations(db, { breaking: true })).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7] });
    expect((await migrationStatus(db)).state).toBe('current');
  });

  it('migrate: a changed file is refused with migration_changed; a gap is migration_gap; a breaking file needs the flag', async () => {
    const v1 = { '0001_first.sql': 'CREATE TABLE a (x integer);\n' };
    const db = await emptySchema();
    expect(await applyMigrations(db, { migrations: loadMigrations(migrationDir(v1)) })).toEqual({ applied: [1] });

    // a changed file
    const changed = loadMigrations(migrationDir({ '0001_first.sql': 'CREATE TABLE a (x bigint);\n' }));
    expect(await migrationStatus(db, changed)).toMatchObject({ changed: [1], state: 'changed' });
    await expect(applyMigrations(db, { migrations: changed })).rejects.toMatchObject({
      code: 'migration_changed',
      message: expect.stringContaining('1'),
    });

    // a gap
    expect(() => loadMigrations(migrationDir({ ...v1, '0003_third.sql': 'SELECT 1;' }))).toThrow(
      expect.objectContaining({ code: 'migration_gap' }),
    );
    expect(() => loadMigrations(migrationDir({ '0002_second.sql': 'SELECT 1;' }))).toThrow(
      expect.objectContaining({ code: 'migration_gap' }),
    );

    // a breaking file
    const breaking = loadMigrations(
      migrationDir({ ...v1, '0002_drop_x.sql': '-- breaking\nALTER TABLE a DROP COLUMN x;\n' }),
    );
    expect(breaking.map((m) => [m.id, m.name, m.breaking])).toEqual([
      [1, 'first', false],
      [2, 'drop_x', true],
    ]);
    expect(await migrationStatus(db, breaking)).toMatchObject({
      dbAt: 1,
      codeRequires: 2,
      pending: [{ id: 2, name: 'drop_x', breaking: true }],
      state: 'behind',
    });
    await expect(applyMigrations(db, { migrations: breaking })).rejects.toMatchObject({ code: 'migration_breaking' });
    expect((await migrationStatus(db, breaking)).dbAt).toBe(1);
    expect(await applyMigrations(db, { migrations: breaking, breaking: true })).toEqual({ applied: [2] });

    // the code behind the database
    expect(await migrationStatus(db, loadMigrations(migrationDir(v1)))).toMatchObject({ dbAt: 2, codeRequires: 1, state: 'ahead' });
  });

  it('migrate: a failing file rolls back alone; earlier files stay applied', async () => {
    const db = await emptySchema();
    const files = loadMigrations(
      migrationDir({ '0001_ok.sql': 'CREATE TABLE a (x integer);', '0002_bad.sql': 'CREATE TABLE b (y integer);\nSELECT * FROM nope;' }),
    );
    await expect(applyMigrations(db, { migrations: files })).rejects.toThrow(/nope/);
    const status = await migrationStatus(db, files);
    expect(status).toMatchObject({ dbAt: 1, state: 'behind' });
    expect(await db.one("SELECT 1 AS x FROM pg_tables WHERE schemaname = $1 AND tablename = 'b'", [db.schema])).toBeUndefined();
  });

  it('0003 applies after 0002 and the constraint name anomalies_kind_check exists before it', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    expect(all[2]).toMatchObject({ id: 3, name: 'checks', breaking: false }); // expand-only
    expect(await applyMigrations(db, { migrations: all.slice(0, 2) })).toEqual({ applied: [1, 2] });
    // 0001's kind CHECK is unnamed inline: Postgres named it <table>_<column>_check, which 0003 drops by that name.
    const kindCheck = () => db.all<{ name: string; def: string }>(
      `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'anomalies' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%kind%'`,
      [db.schema],
    );
    const before = await kindCheck();
    expect(before.map((c) => c.name)).toEqual(['anomalies_kind_check']);
    expect(before[0]!.def).not.toContain('check_breach');
    expect(await applyMigrations(db, { migrations: all.slice(0, 3) })).toEqual({ applied: [3] });
    const after = await kindCheck();
    expect(after.map((c) => c.name)).toEqual(['anomalies_kind_check']);
    expect(after[0]!.def).toContain('check_breach');
    const cols = await db.all<{ c: string; t: string; coll: string | null }>(
      `SELECT column_name AS c, data_type AS t, collation_name AS coll FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'check_results' ORDER BY ordinal_position`,
      [db.schema],
    );
    expect(cols.map((x) => [x.c, x.t])).toEqual([
      ['asset_id', 'text'], ['check_id', 'text'], ['day', 'date'], ['type', 'text'], ['lhs', 'double precision'], ['rhs', 'double precision'],
      ['gap_pct', 'double precision'], ['status', 'text'], ['detail_json', 'json'], ['evaluated_at', 'timestamp with time zone'],
    ]);
    expect(cols.filter((x) => x.t === 'text').every((x) => x.coll === 'C')).toBe(true);
  });

  it('0004 applies after 0003: nullable provenance columns on observations, source_type and locator on latest_levels, the method index', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    expect(all[3]).toMatchObject({ id: 4, name: 'provenance', breaking: false }); // expand-only
    expect(await applyMigrations(db, { migrations: all.slice(0, 3) })).toEqual({ applied: [1, 2, 3] });
    expect(await applyMigrations(db, { migrations: all.slice(0, 4) })).toEqual({ applied: [4] });
    const cols = async (table: string) =>
      await db.all<{ c: string; t: string; n: string; coll: string | null }>(
        `SELECT column_name AS c, data_type AS t, is_nullable AS n, collation_name AS coll FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [db.schema, table],
      );
    const obs = await cols('observations');
    expect(obs.slice(-15).map((x) => [x.c, x.t, x.n])).toEqual([
      ['method', 'text', 'YES'], ['source_type', 'text', 'YES'], ['chain', 'text', 'YES'], ['locator', 'jsonb', 'YES'], ['block_from', 'bigint', 'YES'],
      ['block_to', 'bigint', 'YES'], ['tx_count', 'bigint', 'YES'], ['tx_refs', 'jsonb', 'YES'], ['tx_digest', 'text', 'YES'], ['response_digest', 'text', 'YES'],
      ['inputs', 'jsonb', 'YES'], ['formula', 'text', 'YES'], ['coverage', 'jsonb', 'YES'], ['code_version', 'text', 'YES'], ['config_hash', 'text', 'YES'],
    ]);
    expect(obs.filter((x) => x.t === 'text').every((x) => x.coll === 'C')).toBe(true);
    expect((await cols('latest_levels')).slice(-2).map((x) => [x.c, x.t, x.n])).toEqual([['source_type', 'text', 'YES'], ['locator', 'jsonb', 'YES']]);
    const idx = await db.one<{ def: string }>("SELECT indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_obs_method'", [db.schema]);
    expect(idx?.def).toMatch(/\(asset_id, metric_key, method\)/);
  });

  it('0005 applies after 0004 on a populated observations table: tokens and prices, three nullable token columns, the usd row, flow_usd_v', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    expect(all[4]).toMatchObject({ id: 5, name: 'tokens_prices', breaking: false }); // expand-only
    expect(await applyMigrations(db, { migrations: all.slice(0, 4) })).toEqual({ applied: [1, 2, 3, 4] });
    // A row as the release before 0005 inserts it (named columns, no token columns).
    await db.run(
      `INSERT INTO observations (asset_id, metric_key, observed_at, period_days, value, source, status, fetched_at)
       VALUES ('crv', 'flow_usd.fees', '2026-10-02T00:00:00Z', 1, 12.5, 'onchain', 'confirmed', now())`,
    );
    expect(await applyMigrations(db, { migrations: all.slice(0, 5) })).toEqual({ applied: [5] });
    const cols = async (table: string) =>
      await db.all<{ c: string; t: string; n: string; coll: string | null }>(
        `SELECT column_name AS c, data_type AS t, is_nullable AS n, collation_name AS coll FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [db.schema, table],
      );
    expect((await cols('observations')).slice(-3).map((x) => [x.c, x.t, x.n])).toEqual([
      ['token_ref', 'text', 'YES'], ['amount', 'double precision', 'YES'], ['hourly_amounts', 'jsonb', 'YES'],
    ]);
    expect((await cols('tokens')).map((x) => [x.c, x.t, x.n])).toEqual([
      ['token_ref', 'text', 'NO'], ['symbol', 'text', 'NO'], ['decimals', 'bigint', 'YES'], ['peg', 'text', 'YES'], ['coingecko_id', 'text', 'YES'],
    ]);
    expect((await cols('prices')).map((x) => [x.c, x.t, x.n])).toEqual([
      ['token_ref', 'text', 'NO'], ['ts', 'timestamp with time zone', 'NO'], ['price_usd', 'double precision', 'NO'], ['source', 'text', 'NO'],
      ['fetched_at', 'timestamp with time zone', 'NO'],
    ]);
    for (const t of ['tokens', 'prices', 'observations']) expect((await cols(t)).filter((x) => x.t === 'text').every((x) => x.coll === 'C'), t).toBe(true);
    expect(await db.all('SELECT token_ref, symbol, peg FROM tokens')).toEqual([{ token_ref: 'usd', symbol: 'USD', peg: 'usd' }]);
    // The old row: its value untouched, its token columns null, and the view falls back to it.
    expect(await db.one('SELECT value, token_ref, amount, hourly_amounts FROM observations')).toEqual({ value: 12.5, token_ref: null, amount: null, hourly_amounts: null });
    expect(await db.one('SELECT legacy_usd, usd, usd_basis FROM flow_usd_v')).toEqual({ legacy_usd: 12.5, usd: 12.5, usd_basis: 'legacy_no_tokens' });
    // A release before 0005 still inserts its rows (named columns) on the newer schema.
    await db.run(
      `INSERT INTO observations (asset_id, metric_key, observed_at, period_days, value, source, status, fetched_at)
       VALUES ('crv', 'flow_usd.fees', '2026-10-03T00:00:00Z', 1, 13, 'onchain', 'confirmed', now())`,
    );
    // An unknown token ref is refused (FK), and a price needs its token.
    await expect(db.run("UPDATE observations SET token_ref = 'eip155:1/0xnope' WHERE value = 13")).rejects.toThrow(/foreign key/);
    await expect(db.run("INSERT INTO prices VALUES ('eip155:1/0xnope', now(), 1, 'coingecko', now())")).rejects.toThrow(/foreign key/);
  });

  it('0006 (breaking) on a populated table: provenance NOT NULL, the disclosure citation CHECK with the pre-v2 exemption, source dropped; values kept', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    expect(all[5]).toMatchObject({ id: 6, name: 'provenance_not_null', breaking: true });
    expect(all[5]!.sql.split('\n', 1)[0]).toBe('-- breaking');
    expect(await applyMigrations(db, { migrations: all.slice(0, 5) })).toEqual({ applied: [1, 2, 3, 4, 5] });
    const insert = (value: number, cols: string, vals: string) =>
      db.run(
        `INSERT INTO observations (asset_id, metric_key, observed_at, period_days, value, source, status, fetched_at${cols})
         VALUES ('crv', 'flow_usd.fees', '2026-10-0${value}T00:00:00Z', 1, ${value}, 'onchain', 'confirmed', now()${vals})`,
      );
    const full = (sourceType: string, citation: string, codeVersion: string) =>
      [", method, source_type, locator, code_version, config_hash, citation_url", `, 'measured', '${sourceType}', '{}', '${codeVersion}', 'h', ${citation}`] as const;
    await insert(1, ...full('log_scan', 'NULL', 'abc'));
    await insert(2, ...full('disclosure', 'NULL', 'pre-v2')); // R17 2b: a pre-v2 seed without a citation
    await insert(3, ...full('disclosure', "'https://x.test'", 'abc'));
    // A row with a null provenance column refuses the migration (the pre-deploy check must read 0 first), atomically.
    await insert(4, ", method", ", 'measured'");
    await expect(applyMigrations(db, { breaking: true })).rejects.toThrow(/null values/);
    expect((await migrationStatus(db)).dbAt).toBe(5);
    await db.run('DELETE FROM observations WHERE value = 4');
    // A new-release disclosure without a citation refuses it too.
    await insert(5, ...full('disclosure', 'NULL', 'abc'));
    await expect(applyMigrations(db, { breaking: true })).rejects.toThrow(/observations_disclosure_citation/);
    await db.run('DELETE FROM observations WHERE value = 5');
    // latest_levels: every column the writers set.
    await db.run(`INSERT INTO latest_levels (asset_id, metric_key, value, observed_at, source, source_type, locator) VALUES ('crv', 'price_usd', 1, now(), 'api', 'market_data', '{}')`);
    expect(await applyMigrations(db, { migrations: all.slice(0, 6), breaking: true })).toEqual({ applied: [6] });
    const cols = async (table: string) =>
      await db.all<{ c: string; n: string }>(
        'SELECT column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
        [db.schema, table],
      );
    const obs = await cols('observations');
    expect(obs.map((x) => x.c)).not.toContain('source');
    const nullable = Object.fromEntries(obs.map((x) => [x.c, x.n]));
    for (const c of ['method', 'source_type', 'locator', 'code_version', 'config_hash']) expect(nullable[c], c).toBe('NO');
    for (const c of ['chain', 'block_from', 'tx_refs', 'formula', 'inputs', 'citation_url', 'token_ref']) expect(nullable[c], c).toBe('YES');
    const ll = Object.fromEntries((await cols('latest_levels')).map((x) => [x.c, x.n]));
    expect(ll).toMatchObject({ source: 'NO', source_type: 'NO', locator: 'NO' });
    expect((await db.all<{ value: number }>('SELECT value FROM observations ORDER BY id')).map((r) => r.value)).toEqual([1, 2, 3]);
    // The view still reads the table; a release before 0006 (it inserts source) no longer can.
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM flow_usd_v'))?.n).toBe(3);
    await expect(insert(6, ...full('log_scan', 'NULL', 'abc'))).rejects.toThrow(/column "source"/);
    await expect(
      db.run(`INSERT INTO observations (asset_id, metric_key, observed_at, value, status, fetched_at, method, source_type, locator, code_version, config_hash)
              VALUES ('crv', 'm', now(), 1, 'confirmed', now(), 'disclosed', 'disclosure', '{}', 'abc', 'h')`),
    ).rejects.toThrow(/observations_disclosure_citation/);
  });

  it('a release-N-1 insert of every old anomaly kind still works on 0003', async () => {
    const db = await emptySchema();
    await applyMigrations(db, { breaking: true });
    // The insert a release without 0003 makes (src/db/anomalies.ts raiseAnomaly), one per kind it knows.
    const insert = (kind: string, dedupe: string) => db.run(
      `INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at)
       VALUES ('mini', $1, 'm', $2, 'advisory', 'open', '{}', 1, now(), now())`,
      [kind, dedupe],
    );
    for (const kind of ['cross_check_mismatch', 'unlisted_sender', 'source_failure_streak', 'revenue_disclosure_stale', 'revenue_payment']) await insert(kind, kind);
    await insert('check_breach', 'splitter');
    expect((await db.all<{ kind: string }>('SELECT kind FROM anomalies ORDER BY id')).map((r) => r.kind)).toEqual([
      'cross_check_mismatch', 'unlisted_sender', 'source_failure_streak', 'revenue_disclosure_stale', 'revenue_payment', 'check_breach',
    ]);
    await expect(insert('made_up', 'x')).rejects.toThrow(/anomalies_kind_check/);
  });

  it('0003 applies to a populated anomalies table: every old kind inserted at 0002 survives the constraint re-add (Task 5 M6)', async () => {
    const db = await emptySchema();
    const all = loadMigrations();
    expect(await applyMigrations(db, { migrations: all.slice(0, 2) })).toEqual({ applied: [1, 2] });
    const OLD = ['cross_check_mismatch', 'unlisted_sender', 'source_failure_streak', 'revenue_disclosure_stale', 'revenue_payment'];
    for (const kind of OLD) {
      await db.run(
        `INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at)
         VALUES ('mini', $1, 'm', $1, 'advisory', 'open', '{}', 1, now(), now())`,
        [kind],
      );
    }
    // ADD CONSTRAINT validates the existing rows: a kind 0003 left out would fail the migration here.
    expect(await applyMigrations(db, { migrations: all.slice(0, 3) })).toEqual({ applied: [3] });
    expect((await db.all<{ kind: string }>('SELECT kind FROM anomalies ORDER BY id')).map((r) => r.kind)).toEqual(OLD);
  });

  it('migrate: the shipped migrations load in order from 1', () => {
    const ms = loadMigrations();
    expect(ms.map((m) => m.id)).toEqual(ms.map((_, i) => i + 1));
    expect(ms[0]).toMatchObject({ id: 1, name: 'baseline', breaking: false });
    expect(ms[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
