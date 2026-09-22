import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../../src/agent/ledger.js';
import { runValuation } from '../../src/app/valuation.js';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import { createAssumptionSet, getLatestAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { getLatestSignal } from '../../src/db/runs.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { harness } from '../helpers/fetchHarness.js';
import { miniObservations } from '../helpers/obs.js';

/**
 * Two connections to ONE file database, which is what a scheduled run and a manual command are. `openDb` puts SQLite in
 * WAL mode, so readers never block; what matters is when a transaction takes the WRITE lock. A deferred transaction
 * takes it at its first write, after its reads, and SQLite then refuses it outright rather than waiting.
 */

const NOW = new Date('2026-09-20T00:00:00.000Z');
let dir: string;
let A: Db;
let B: Db;
let asset: AssetConfig;
let ledger: Ledger;
let priceId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orion-concurrency-'));
  A = openDb(join(dir, 'orion.db'));
  B = openDb(join(dir, 'orion.db'));
  asset = parseAssetYaml(MINI_ASSET_YAML).config;
  const set = createAssumptionSet(A, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: '2026-09-01T00:00:00Z' });
  priceId = insertObservation(A, { assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-09-19', value: 10, source: 'onchain', fetchedAt: '2026-09-19' }).id;
  ledger = new Ledger('mini', 'analyst', set);
  ledger.stageAssumptionChange({ key: 'rev_growth_y1', scenario: 'base', value: 0.1, rationale: 'up', evidence: [priceId] });
  ledger.setJournal({ thesis: 't', openQuestions: [], summary: 's' });
});

afterEach(() => {
  A.close();
  B.close();
});

type AnyFn = (...args: unknown[]) => unknown;

/**
 * The real connection, with one hook: the moment a statement prepared on it first reads rows, `onFirstRead` fires, once.
 * That is the instant a second connection can slip a write into, and the only way to reach it from a test, because
 * better-sqlite3 runs a transaction synchronously and nothing outside it can interleave. `when` narrows "first read" to
 * the first read whose bound parameters satisfy it, for code that reads before the transaction under test begins.
 */
function interleaving(db: Db, onFirstRead: () => void, when: (args: unknown[]) => boolean = () => true): Db {
  let fired = false;
  const watchStatement = (stmt: object): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const out = (value as AnyFn).apply(target, args);
          if ((prop === 'get' || prop === 'all') && !fired && when(args)) {
            fired = true;
            onFirstRead();
          }
          return out;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      if (prop !== 'prepare') return (...args: unknown[]) => (value as AnyFn).apply(target, args);
      return (...args: unknown[]) => watchStatement((value as AnyFn).apply(target, args) as object);
    },
  }) as Db;
}

const otherWrite = (db: Db) =>
  insertObservation(db, { assetId: 'mini', metricKey: 'staked_supply', observedAt: '2026-09-19', value: 50, source: 'onchain', fetchedAt: '2026-09-19' });

describe('Ledger.commit against a second connection', () => {
  it('commits normally when nothing else holds the write lock, whatever the other connection wrote before it', () => {
    otherWrite(B);
    const summary = ledger.commit(A, asset, { agentRunId: null, now: NOW });
    expect(summary.setVersion).toBe(2);
    expect(getLatestAssumptionSet(B, 'mini')!.version).toBe(2); // the other connection sees it
    expect(listActiveObservations(B, 'mini', 'staked_supply')).toHaveLength(1);
  });

  it('holds the write lock across its own reads, so the other connection cannot commit underneath it', () => {
    B.pragma('busy_timeout = 50');
    let theOtherWrite = 'never attempted';
    const watched = interleaving(A, () => {
      try {
        otherWrite(B);
        theOtherWrite = 'committed';
      } catch (err) {
        theOtherWrite = err instanceof Error ? err.message : String(err);
      }
    });
    // Deferred, this is where it comes apart: B commits against the same snapshot A just read, and A's first write is
    // then refused with SQLITE_BUSY_SNAPSHOT, which no timeout can retry away.
    const summary = ledger.commit(watched, asset, { agentRunId: null, now: NOW });
    expect(summary.setVersion).toBe(2);
    expect(theOtherWrite).toMatch(/database is locked/);
    expect(listActiveObservations(A, 'mini', 'staked_supply')).toHaveLength(0);
  });

  it('waits for a write lock another connection holds instead of giving up the moment it wants to write', () => {
    // A DEFERRED transaction reads first and only then asks for the write lock. SQLite will not run the busy handler
    // for that upgrade (a waiting reader can deadlock), so it fails at once, and busy_timeout buys nothing. An
    // IMMEDIATE transaction asks at BEGIN, holding nothing, so the busy handler runs and it waits out the timeout.
    A.pragma('busy_timeout = 250');
    B.exec('BEGIN IMMEDIATE');
    otherWrite(B);
    const startedAt = Date.now();
    expect(() => ledger.commit(A, asset, { agentRunId: null, now: NOW })).toThrow(/database is locked/);
    const waited = Date.now() - startedAt;
    B.exec('ROLLBACK');
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(getLatestAssumptionSet(A, 'mini')!.version).toBe(1); // nothing was written
  });
});

describe('runValuation against a second connection', () => {
  it('holds the write lock across the snapshot reads, so a commit underneath it waits rather than failing the valuation', () => {
    for (const o of miniObservations()) {
      insertObservation(A, { assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt });
    }
    B.pragma('busy_timeout = 50');
    let theOtherWrite = 'never attempted';
    const watched = interleaving(A, () => {
      try {
        otherWrite(B);
        theOtherWrite = 'committed';
      } catch (err) {
        theOtherWrite = err instanceof Error ? err.message : String(err);
      }
    });
    const { signal } = runValuation(watched, parseAssetYaml(MINI_ASSET_YAML), NOW);
    expect(signal.status).not.toBe('blocked');
    expect(theOtherWrite).toMatch(/database is locked/);
    expect(getLatestSignal(B, 'mini')!.signal_id).toBe(signal.signal_id);
  });
});

describe('the flow ingest against a second connection', () => {
  it('holds the write lock across each day\'s supersede reads, so a commit underneath it waits rather than failing the scan', async () => {
    B.pragma('busy_timeout = 50');
    let theOtherWrite = 'never attempted';
    // The day transaction's first read is insertObservation's supersede lookup: (asset, metric, observed_at). The scan's
    // own conflict search reads the same metric earlier, with a LIMIT argument instead of a timestamp.
    const insideDayTransaction = (args: unknown[]) => args.length === 3 && args[1] === 'flow_usd.fees' && typeof args[2] === 'string';
    const watched = interleaving(A, () => {
      try {
        otherWrite(B);
        theOtherWrite = 'committed';
      } catch (err) {
        theOtherWrite = err instanceof Error ? err.message : String(err);
      }
    }, insideDayTransaction);
    const h = harness({ db: watched });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(r.sources.find((s) => s.sourceId.startsWith('transfer_flow'))!.status).toBe('ok');
    expect(theOtherWrite).toMatch(/database is locked/);
    expect(listActiveObservations(B, 'mini', 'flow_usd.fees').length).toBeGreaterThan(0);
  });
});
