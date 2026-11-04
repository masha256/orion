import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../../src/agent/ledger.js';
import type { Db, OrionDb, SqlParam, TxOptions } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { testDbPair } from '../helpers/db.js';
import { harness } from '../helpers/fetchHarness.js';

/**
 * Two pools on ONE schema, which is what a scheduled run and a manual command are. Every transaction that reads before
 * it writes takes the asset's transaction lock (`tx({ lockAsset })`), so a second connection's write to the same asset
 * waits for the commit instead of landing between the check and the insert, and a transaction that finds the lock held
 * waits for it rather than failing.
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
 * transaction under test begins. (Test setup only: the hook wraps the tx handle, R-b5.)
 */
function interleaving(db: OrionDb, onFirstRead: () => Promise<void>, when: (params: readonly SqlParam[]) => boolean = () => true): OrionDb {
  let fired = false;
  const watch = <H extends Db>(handle: H): H =>
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
    });
  return watch(db);
}

const OTHER_AT = '2026-09-19T00:00:00.000Z';
/** The other connection's row (the fetch writes staked_supply too, at its own time). */
const otherRows = async (db: Db) => (await listActiveObservations(db, 'mini', 'staked_supply')).filter((o) => o.observedAt === OTHER_AT);

const otherWrite = async (db: Db) =>
  await insertObservation(db, { assetId: 'mini', metricKey: 'staked_supply', observedAt: OTHER_AT, value: 50, source: 'onchain', fetchedAt: '2026-09-19' });

/** B opens a transaction on the asset's lock, writes, holds it `ms`, and commits. Resolves once B holds the lock. */
async function holdAssetTransaction(db: OrionDb, ms: number): Promise<{ done: Promise<void> }> {
  let begun!: () => void;
  const holding = new Promise<void>((resolve) => { begun = resolve; });
  const done = db.tx(async (t) => {
    await otherWrite(t);
    begun();
    await new Promise((resolve) => setTimeout(resolve, ms));
  }, { lockAsset: 'mini' });
  await holding;
  return { done };
}

describe('Ledger.commit against a second connection', () => {
  it('commits normally when nothing else holds the asset, whatever the other connection wrote before it', async () => {
    await otherWrite(B);
    const summary = await ledger.commit(A, { agentRunId: null, now: NOW });
    expect(summary.observationIds).toHaveLength(1);
    expect((await listActiveObservations(B, 'mini', 'revenue_run_rate_usd')).map((o) => o.id)).toEqual(summary.observationIds); // the other connection sees it
    expect(await otherRows(B)).toHaveLength(1);
  });

  it('concurrency (Postgres): a write by another connection between the ledger\'s check and its insert waits for the commit, then lands', async () => {
    const order: string[] = [];
    let theOtherWrite: Promise<void> | null = null;
    const watched = interleaving(A, async () => {
      // started, not awaited: it must wait on the ledger's lock, so awaiting it here would deadlock the test
      theOtherWrite = otherWrite(B).then(() => { order.push('B wrote'); });
      await new Promise((resolve) => setTimeout(resolve, 100)); // give it every chance to land early
    });
    const summary = await ledger.commit(watched, { agentRunId: null, now: NOW });
    order.push('A committed');
    expect(theOtherWrite).not.toBeNull();
    await theOtherWrite;
    expect(order).toEqual(['A committed', 'B wrote']);
    expect(summary.observationIds).toHaveLength(1);
    expect(await listActiveObservations(A, 'mini', 'revenue_run_rate_usd')).toHaveLength(1);
    expect(await otherRows(A)).toHaveLength(1);
  });

  it('concurrency: the ledger waits for another connection\'s open asset transaction', async () => {
    const other = await holdAssetTransaction(B, 250);
    const startedAt = Date.now();
    const summary = await ledger.commit(A, { agentRunId: null, now: NOW });
    const waited = Date.now() - startedAt;
    await other.done;
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(summary.observationIds).toHaveLength(1);
    expect(await listActiveObservations(A, 'mini', 'revenue_run_rate_usd')).toHaveLength(1);
    expect(await otherRows(A)).toHaveLength(1);
  });
});

describe('the flow ingest against a second connection', () => {
  // The day transaction's first read is insertObservation's supersede lookup, bound as (asset, metric, observed_at). The scan's own
  // conflict search reads the same metric earlier but binds only (asset, metric), so the length check keeps the hook out of it.
  const insideDayTransaction = (params: readonly SqlParam[]) => params.length === 3 && params[1] === 'flow_usd.fees' && typeof params[2] === 'string';

  it('concurrency (Postgres): a write by another connection inside a flow day transaction waits for its commit, then lands', async () => {
    const order: string[] = [];
    let theOtherWrite: Promise<void> | null = null;
    const watched = interleaving(A, async () => {
      theOtherWrite = otherWrite(B).then(() => { order.push('B wrote'); });
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push('day transaction read');
    }, insideDayTransaction);
    const h = harness(watched);
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    order.push('fetch done');
    expect(theOtherWrite).not.toBeNull();
    await theOtherWrite;
    expect(r.sources.find((s) => s.sourceId.startsWith('transfer_flow'))!.status).toBe('ok');
    // B landed after the day transaction it tried to slip into, never inside it
    expect(order[0]).toBe('day transaction read');
    expect(order).toContain('B wrote');
    expect((await listActiveObservations(B, 'mini', 'flow_usd.fees')).length).toBeGreaterThan(0);
    expect(await otherRows(B)).toHaveLength(1);
  });

  it('concurrency: a flow day transaction waits for another connection\'s open asset transaction', async () => {
    const h = harness(A);
    const other = await holdAssetTransaction(B, 250);
    const startedAt = Date.now();
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    const waited = Date.now() - startedAt;
    await other.done;
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(r.sources.find((s) => s.sourceId.startsWith('transfer_flow'))!.status).toBe('ok');
    expect((await listActiveObservations(A, 'mini', 'flow_usd.fees')).length).toBeGreaterThan(0);
    expect(await otherRows(A)).toHaveLength(1);
  });
});
