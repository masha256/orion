import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../../src/agent/ledger.js';
import type { Db, OrionDb, SqlParam, TxOptions } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { testDbPair } from '../helpers/db.js';
import { harness } from '../helpers/fetchHarness.js';

/**
 * Two connections to ONE file database, which is what a scheduled run and a manual command are. `openDb` puts SQLite in
 * WAL mode, so readers never block; what matters is when a transaction takes the WRITE lock. A deferred transaction
 * takes it at its first write, after its reads, and SQLite then refuses it outright rather than waiting.
 */

const NOW = new Date('2026-09-20T00:00:00.000Z');
const pair = testDbPair();
let A: OrionDb;
let B: OrionDb;
let ledger: Ledger;

beforeEach(() => {
  [A, B] = pair();
  ledger = new Ledger('mini', 'analyst');
  ledger.stageObservation({
    metricKey: 'revenue_run_rate_usd', value: 1100, observedAt: '2026-09-18', periodDays: null, citationUrl: 'doc:1', quotedText: 'annualized revenue of $1,100', live: false,
  });
  ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's', catalysts: [] });
});

type AnyFn = (...args: unknown[]) => unknown;

/**
 * The real connection, with one hook: the moment a query on it (or on a transaction's handle) first reads rows,
 * `onFirstRead` runs, once, and the read waits for it. That is the instant a second connection can slip a write into.
 * `when` narrows "first read" to the first read whose bound parameters satisfy it, for code that reads before the
 * transaction under test begins.
 */
function interleaving(db: Db, onFirstRead: () => Promise<void>, when: (params: readonly SqlParam[]) => boolean = () => true): Db {
  let fired = false;
  const watch = (handle: Db): Db =>
    new Proxy(handle, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        // A transaction's statements run on its tx handle, so the handle is watched too.
        if (prop === 'tx') return (fn: (t: Db) => Promise<unknown>, opts?: TxOptions) => target.tx((t) => fn(watch(t)), opts);
        if (prop !== 'all' && prop !== 'one') return (...args: unknown[]) => (value as AnyFn).apply(target, args);
        return async (sql: string, params: readonly SqlParam[] = []) => {
          const out = await (value as AnyFn).apply(target, [sql, params]);
          if (!fired && when(params)) {
            fired = true;
            await onFirstRead();
          }
          return out;
        };
      },
    }) as Db;
  return watch(db);
}

const otherWrite = async (db: Db) =>
  await insertObservation(db, { assetId: 'mini', metricKey: 'staked_supply', observedAt: '2026-09-19', value: 50, source: 'onchain', fetchedAt: '2026-09-19' });

describe('Ledger.commit against a second connection', () => {
  it('commits normally when nothing else holds the write lock, whatever the other connection wrote before it', async () => {
    await otherWrite(B);
    const summary = await ledger.commit(A, { agentRunId: null, now: NOW });
    expect(summary.observationIds).toHaveLength(1);
    expect((await listActiveObservations(B, 'mini', 'revenue_run_rate_usd')).map((o) => o.id)).toEqual(summary.observationIds); // the other connection sees it
    expect(await listActiveObservations(B, 'mini', 'staked_supply')).toHaveLength(1);
  });

  it('holds the write lock across its own reads, so the other connection cannot commit underneath it', async () => {
    B.pragma('busy_timeout = 50');
    let theOtherWrite = 'never attempted';
    const watched = interleaving(A, async () => {
      try {
        await otherWrite(B);
        theOtherWrite = 'committed';
      } catch (err) {
        theOtherWrite = err instanceof Error ? err.message : String(err);
      }
    });
    // Deferred, this is where it comes apart: B commits against the same snapshot A just read, and A's first write is
    // then refused with SQLITE_BUSY_SNAPSHOT, which no timeout can retry away.
    const summary = await ledger.commit(watched, { agentRunId: null, now: NOW });
    expect(summary.observationIds).toHaveLength(1);
    expect(theOtherWrite).toMatch(/database is locked/);
    expect(await listActiveObservations(A, 'mini', 'staked_supply')).toHaveLength(0);
  });

  it('waits for a write lock another connection holds instead of giving up the moment it wants to write', async () => {
    // A DEFERRED transaction reads first and only then asks for the write lock. SQLite will not run the busy handler
    // for that upgrade (a waiting reader can deadlock), so it fails at once, and busy_timeout buys nothing. An
    // IMMEDIATE transaction asks at BEGIN, holding nothing, so the busy handler runs and it waits out the timeout.
    A.pragma('busy_timeout = 250');
    // B takes the write lock (BEGIN IMMEDIATE), writes, and holds the transaction open until `release`; it then rolls back.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let begun!: () => void;
    const holding = new Promise<void>((resolve) => { begun = resolve; });
    const rollback = new Error('rollback');
    const other = B.tx(async (t) => {
      await otherWrite(t);
      begun();
      await held;
      throw rollback;
    });
    await holding;
    const startedAt = Date.now();
    await expect(ledger.commit(A, { agentRunId: null, now: NOW })).rejects.toThrow(/database is locked/);
    const waited = Date.now() - startedAt;
    release();
    await expect(other).rejects.toBe(rollback);
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(await listActiveObservations(A, 'mini', 'revenue_run_rate_usd')).toEqual([]); // nothing was written
  });
});

describe('the flow ingest against a second connection', () => {
  it('holds the write lock across each day\'s supersede reads, so a commit underneath it waits rather than failing the scan', async () => {
    B.pragma('busy_timeout = 50');
    let theOtherWrite = 'never attempted';
    // The day transaction's first read is insertObservation's supersede lookup, bound as (asset, metric, observed_at). The scan's own
    // conflict search reads the same metric earlier but binds only (asset, metric), so the length check keeps the hook out of it.
    const insideDayTransaction = (params: readonly SqlParam[]) => params.length === 3 && params[1] === 'flow_usd.fees' && typeof params[2] === 'string';
    const watched = interleaving(A, async () => {
      try {
        await otherWrite(B);
        theOtherWrite = 'committed';
      } catch (err) {
        theOtherWrite = err instanceof Error ? err.message : String(err);
      }
    }, insideDayTransaction);
    const h = harness(watched);
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(r.sources.find((s) => s.sourceId.startsWith('transfer_flow'))!.status).toBe('ok');
    expect(theOtherWrite).toMatch(/database is locked/);
    expect((await listActiveObservations(B, 'mini', 'flow_usd.fees')).length).toBeGreaterThan(0);
  });
});
