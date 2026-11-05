import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset } from '../../src/config/load.js';
import { emptySourceOutcome } from '../../src/db/fetchRuns.js';
import { getTokensByIds, listActiveObservations } from '../../src/db/observations.js';
import { evmTokenRef, listPrices, USD_TOKEN, solanaTokenRef } from '../../src/db/prices.js';
import { writeApiFlow } from '../../src/ingest/apiFlow.js';
import { scanFlowGroup, type FlowScanArgs } from '../../src/ingest/flow.js';
import { writePeriodicPayments } from '../../src/ingest/periodic.js';
import { buildPlan } from '../../src/ingest/plan.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { CG_CHART, harness, hourlyPrices, NOW, type Harness } from '../helpers/fetchHarness.js';
import { POOL, SAFE, TOKEN } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const testDb = useTestDb();
const E18 = 10n ** 18n;
const ms = (iso: string) => Date.parse(iso);

/** Price 10 until 2026-09-17T00:00Z, 20 from then on (the fixture of tests/ingest/flow.test.ts). */
const stepPrices = () => hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', (t) => (t < ms('2026-09-17T00:00:00Z') ? 10 : 20));

/** The flow.test.ts world, plus transfers spread over several hours of the 18th. */
function world(): Harness {
  const probe = harness(testDb());
  const at = (iso: string) => probe.rpc.blockAtOrAfter(ms(iso) / 1000);
  let n = 0;
  const log = (iso: string, from: string, tokens: bigint, frac = 0n): Omit<TransferLog, 'timestamp'> => ({
    blockNumber: at(iso), logIndex: n++, txHash: `0xtx${n}`, from, value: tokens * E18 + frac,
  });
  const logs = [
    log('2026-09-16T10:00:00Z', POOL, 2n),
    log('2026-09-16T23:59:58Z', SAFE, 100n), // the last block of the 16th: hour 23
    log('2026-09-17T00:00:00Z', POOL, 3n), // the first block of the 17th: hour 0
    log('2026-09-18T05:30:00Z', POOL, 1n, 123_456_789_012_345_678n),
    log('2026-09-18T05:59:58Z', SAFE, 7n, 1n),
    log('2026-09-18T06:00:00Z', POOL, 0n, 333_333_333_333_333_333n),
    log('2026-09-18T17:15:00Z', SAFE, 11n),
  ];
  return harness(testDb(), { routes: { [CG_CHART]: stepPrices() }, logs });
}

async function argsFor(h: Harness, over: Partial<FlowScanArgs> = {}): Promise<FlowScanArgs> {
  const latest = await h.rpc.latestBlock();
  return {
    db: h.db, asset: h.loaded.config, configHash: h.loaded.hash, group: buildPlan(h.loaded.config).flowGroups[0], rpc: h.rpc, latest, http: h.http, env: {},
    sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false, ...over,
  };
}

const rel = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));

async function tokensOf(h: Harness, metric: string) {
  const rows = await listActiveObservations(h.db, 'mini', metric);
  const t = await getTokensByIds(h.db, rows.map((r) => r.id));
  return rows.map((r, i) => ({ day: r.observedAt.slice(0, 10), value: r.value, ...t[i]! }));
}

describe('transfer scan: token amounts beside value', () => {
  it('hourly_amounts sum to amount (1e-12 rel) and each log lands in its UTC hour', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    const rows = await tokensOf(h, 'flow_tokens.fees');
    expect(rows.map((r) => r.day)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19']);
    for (const r of rows) {
      expect(r.tokenRef).toBe(evmTokenRef(8453, TOKEN));
      expect(r.hourlyAmounts).toHaveLength(24);
      expect(rel(r.hourlyAmounts!.reduce((s, x) => s + x, 0), r.amount!)).toBeLessThanOrEqual(1e-12);
      // A tokens member stores its amount as its value, summed the same way.
      expect(r.amount).toBe(r.value);
    }
    const [d16, d17, d18] = rows;
    const nonZero = (hs: number[]) => Object.fromEntries(hs.flatMap((x, i) => (x !== 0 ? [[i, x]] : [])));
    expect(nonZero(d16!.hourlyAmounts!)).toEqual({ 10: 2, 23: 100 });
    expect(nonZero(d17!.hourlyAmounts!)).toEqual({ 0: 3 });
    expect(Object.keys(nonZero(d18!.hourlyAmounts!))).toEqual(['5', '6', '17']); // 05:59:58 is still hour 5
    expect(d18!.hourlyAmounts![5]).toBeCloseTo(1.123456789012345678 + 7, 12);
    expect(d18!.hourlyAmounts![6]).toBeCloseTo(0.333333333333333333, 12);
    // The count_from [pool] member counts only the pool's transfers, in tokens of the same token.
    const prog = await tokensOf(h, 'flow_usd.fees_programmatic');
    expect(nonZero(prog[0]!.hourlyAmounts!)).toEqual({ 10: 2 });
    expect(nonZero(prog[2]!.hourlyAmounts!)).toEqual({ 5: expect.closeTo(1.123456789012345678, 12), 6: expect.closeTo(0.333333333333333333, 12) });
  });

  it('the value written is unchanged (same fixture, same USD as before Task 7)', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    // The per-transfer method: 16th 102 tokens at 10; 17th 3 at 20; 18th (1.1234... + 7.000...001 + 0.333... + 11) at 20.
    const d18 = (1 + 123_456_789_012_345_678 / 1e18) + (7 + 1 / 1e18) + 333_333_333_333_333_333 / 1e18 + 11;
    const usd = await tokensOf(h, 'flow_usd.fees');
    expect(usd.map((r) => [r.day, r.value])).toEqual([['2026-09-17', 1020], ['2026-09-18', 60], ['2026-09-19', expect.closeTo(d18 * 20, 9)]]);
    // Same sums as tests/ingest/flow.test.ts pins for this fixture (its 16th and 17th).
    expect(usd[0]!.amount).toBe(102);
    expect(usd[1]!.amount).toBe(3);
    // Every hourly point the scan loaded is in prices (the existing market_chart read; no new request).
    const prices = await listPrices(h.db, evmTokenRef(8453, TOKEN));
    expect(prices).toHaveLength(stepPrices().prices.length);
    expect(prices[0]).toMatchObject({ ts: '2026-09-10T00:00:00.000Z', priceUsd: 10, source: 'coingecko' });
    expect(h.http.calls.filter((c) => c.url.includes('market_chart'))).toHaveLength(1);
  });

  it('a dry run writes no tokens and no prices', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h, { dryRun: true }));
    expect(await listPrices(h.db, evmTokenRef(8453, TOKEN))).toEqual([]);
    expect((await h.db.one<{ n: number }>('SELECT count(*) AS n FROM tokens'))!.n).toBe(0);
  });
});

describe('API and adapter flows: token columns', () => {
  const outcome = () => emptySourceOutcome('adapter:x');
  const days = ['2026-09-16', '2026-09-17', '2026-09-18'];

  it("a USD-native first-party series stores token_ref 'usd' and amount = value; a series with no token stores none", async () => {
    const lit = loadAsset(ROOT, 'lit');
    const base = {
      db: testDb(), asset: lit.config, configHash: lit.hash, now: NOW, backfillDays: 3, rescan: false, adopt: false, dryRun: false, validate: () => null, detail: 'd',
      points: days.map((day, i) => ({ day, value: 1000.25 + i })),
    };
    await writeApiFlow({ ...base, metricKey: 'flow_usd.fees_core', scanKey: 'a>fees_core', outcome: outcome(), token: USD_TOKEN });
    await writeApiFlow({ ...base, metricKey: 'flow_usd.fees_rh', scanKey: 'a>fees_rh', outcome: outcome() });
    const of = async (m: string) => {
      const rows = await listActiveObservations(testDb(), 'lit', m);
      return (await getTokensByIds(testDb(), rows.map((r) => r.id))).map((t, i) => [rows[i]!.value, t.tokenRef, t.amount, t.hourlyAmounts]);
    };
    expect(await of('flow_usd.fees_core')).toEqual([[1000.25, 'usd', 1000.25, null], [1001.25, 'usd', 1001.25, null], [1002.25, 'usd', 1002.25, null]]);
    expect(await of('flow_usd.fees_rh')).toEqual([[1000.25, null, null, null], [1001.25, null, null, null], [1002.25, null, null, null]]);
  });

  it('a Solana supply drop stores the day in tokens with no hourly buckets; a day with no amount (DefiLlama history) stores none', async () => {
    const pump = loadAsset(ROOT, 'pump');
    const mint = pump.config.contracts.token!;
    const token = { tokenRef: solanaTokenRef(mint), symbol: 'PUMP', decimals: null, coingeckoId: 'pump-fun' };
    await writeApiFlow({
      db: testDb(), asset: pump.config, configHash: pump.hash, metricKey: 'flow_usd.buyback', scanKey: 's>b', now: NOW, backfillDays: 3, rescan: false, adopt: false,
      dryRun: false, validate: () => null, detail: 'd', outcome: outcome(), token,
      points: [{ day: days[0]!, value: 5000 }, { day: days[1]!, value: 600, amount: 120_000 }, { day: days[2]!, value: 0, amount: 0 }],
    });
    const rows = await listActiveObservations(testDb(), 'pump', 'flow_usd.buyback');
    expect((await getTokensByIds(testDb(), rows.map((r) => r.id))).map((t, i) => [rows[i]!.value, t.tokenRef, t.amount, t.hourlyAmounts])).toEqual([
      [5000, null, null, null], [600, token.tokenRef, 120_000, null], [0, token.tokenRef, 0, null],
    ]);
  });

  it("a periodic USDC payment stores token_ref 'usd' and amount = value", async () => {
    const hype = loadAsset(ROOT, 'hype');
    await writePeriodicPayments({
      db: testDb(), asset: hype.config, configHash: hype.hash, metricKey: 'flow_usd.reserve_yield', token: USD_TOKEN,
      payments: [{ from: '2026-07-01', to: '2026-07-30', value: 1000.5, paidAt: '2026-08-09T10:00:00.000Z', dueDay: '2026-08-08' }],
      due: [], payers: [], expectedPayers: [], detail: 'ledger', now: NOW, dryRun: false, outcome: outcome(), validate: () => null, raise: async () => undefined,
    });
    const rows = await listActiveObservations(testDb(), 'hype', 'flow_usd.reserve_yield');
    expect(await getTokensByIds(testDb(), rows.map((r) => r.id))).toEqual([{ id: rows[0]!.id, tokenRef: 'usd', amount: 1000.5, hourlyAmounts: null }]);
  });
});
