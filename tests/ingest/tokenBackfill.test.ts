import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { getTokensByIds, insertObservation, listActiveObservations, rejectObservation } from '../../src/db/observations.js';
import { evmTokenRef, listPrices } from '../../src/db/prices.js';
import { scanFlowGroup } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { backfillTokens } from '../../src/ingest/tokenBackfill.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { CG_CHART, harness, hourlyPrices, type Harness } from '../helpers/fetchHarness.js';
import { callKey } from '../helpers/fakeRpc.js';
import { INGEST_ASSET_YAML, METRICS_END, POOL, SAFE, TOKEN } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

const testDb = useTestDb();
const E18 = 10n ** 18n;
const ms = (iso: string) => Date.parse(iso);
const REF = evmTokenRef(8453, TOKEN);
const TOKEN_B = '0x5555555555555555555555555555555555555555';
const REF_B = evmTokenRef(8453, TOKEN_B);

function world(): Harness {
  const probe = harness(testDb());
  const at = (iso: string) => probe.rpc.blockAtOrAfter(ms(iso) / 1000);
  let n = 0;
  const log = (iso: string, from: string, tokens: bigint): Omit<TransferLog, 'timestamp'> => ({ blockNumber: at(iso), logIndex: n++, txHash: `0xtx${n}`, from, value: tokens * E18 });
  const logs = [
    log('2026-09-16T10:00:00Z', POOL, 2n), log('2026-09-16T23:59:58Z', SAFE, 100n), log('2026-09-17T00:00:00Z', POOL, 3n), log('2026-09-18T07:00:00Z', SAFE, 5n),
  ];
  const prices = hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', (t) => (t < ms('2026-09-17T00:00:00Z') ? 10 : 20));
  return harness(testDb(), { routes: { [CG_CHART]: prices }, logs });
}

/** Rows as a release before 0005 wrote them: the scan's rows with the token columns emptied, and no prices. */
async function preTask7(h: Harness): Promise<void> {
  const latest = await h.rpc.latestBlock();
  await scanFlowGroup({
    db: h.db, asset: h.loaded.config, configHash: h.loaded.hash, group: buildPlan(h.loaded.config).flowGroups[0], rpc: h.rpc, latest, http: h.http, env: {},
    sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false,
  });
  await h.db.run('UPDATE observations SET token_ref = NULL, amount = NULL, hourly_amounts = NULL');
  await h.db.run('DELETE FROM prices');
  await h.db.run('DELETE FROM tokens');
  h.http.calls.length = 0; // the scan's own market_chart read
}

/** Every observation's full row (all columns but the token ones), for a no-change proof. */
const snapshot = async (db: Db) =>
  await db.all('SELECT * FROM observations ORDER BY id').then((rows) => rows.map(({ token_ref: _t, amount: _a, hourly_amounts: _h, ...rest }) => rest));

const tokensOf = async (db: Db, metric: string) => {
  const rows = await listActiveObservations(db, 'mini', metric);
  return (await getTokensByIds(db, rows.map((r) => r.id))).map((t, i) => ({ day: rows[i]!.observedAt.slice(0, 10), value: rows[i]!.value, ...t }));
};

describe('backfillTokens', () => {
  it('backfill never changes value and never inserts rows', async () => {
    const h = world();
    await preTask7(h);
    const before = await snapshot(h.db);
    const r = await backfillTokens(h.db, h.loaded, h.deps, { days: 3 });
    expect(r.refused).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.filled).toBe(9); // 3 metrics x 3 days
    expect(await snapshot(h.db)).toEqual(before); // value, provenance, status, superseded_by: all as they were; no new row
    const usd = await tokensOf(h.db, 'flow_usd.fees');
    expect(usd.map((t) => [t.day, t.value, t.tokenRef, t.amount])).toEqual([
      ['2026-09-17', 1020, REF, 102], ['2026-09-18', 60, REF, 3], ['2026-09-19', 100, REF, 5],
    ]);
    expect(usd[0]!.hourlyAmounts!.flatMap((x, i) => (x ? [[i, x]] : []))).toEqual([[10, 2], [23, 100]]);
    // The prices of the range came from market_chart/range (hourly windows), not from the nightly's request.
    expect(r.prices).toMatchObject([{ coingeckoId: 'mini-token', tokenRefs: [REF], failures: [] }]);
    expect(h.http.calls.length).toBeGreaterThan(0);
    expect(h.http.calls.every((c) => c.url.includes('/market_chart/range?'))).toBe(true);
    expect((await listPrices(h.db, REF)).length).toBeGreaterThan(0);

    // A second run fills nothing (amount IS NULL guards every update), still changes no value, and fetches nothing.
    h.http.calls.length = 0;
    const again = await backfillTokens(h.db, h.loaded, h.deps, { days: 3 });
    expect(again).toMatchObject({ filled: 0, alreadyFilled: 9, refused: [], skipped: [], prices: [{ coingeckoId: 'mini-token', requests: 0, rows: 0 }] });
    expect(h.http.calls).toEqual([]);
    expect(await snapshot(h.db)).toEqual(before);
  });

  it('backfill refuses a day whose re-scanned tokens differ from the stored flow_tokens twin', async () => {
    const h = world();
    await preTask7(h);
    // The stored token twin of the 17th says 4 tokens; the chain says 3.
    const twin = (await listActiveObservations(h.db, 'mini', 'flow_tokens.fees')).find((o) => o.observedAt.startsWith('2026-09-18'))!;
    await h.db.run('UPDATE observations SET value = 4 WHERE id = $1', [twin.id]);
    const before = await snapshot(h.db);
    const r = await backfillTokens(h.db, h.loaded, h.deps, { days: 3 });
    expect(r.refused).toEqual([{ day: '2026-09-17', reason: expect.stringMatching(/flow_tokens\.fees.*stored 4.*re-scanned 3/) }]);
    // Nothing of the refused day is filled; the other days are.
    expect((await tokensOf(h.db, 'flow_usd.fees')).map((t) => [t.day, t.amount])).toEqual([['2026-09-17', 102], ['2026-09-18', null], ['2026-09-19', 5]]);
    expect((await tokensOf(h.db, 'flow_tokens.fees')).map((t) => [t.day, t.amount])).toEqual([['2026-09-17', 102], ['2026-09-18', null], ['2026-09-19', 5]]);
    expect(r.filled).toBe(6);
    expect(await snapshot(h.db)).toEqual(before);
  });

  it('backfill skips a day with no active row and says so', async () => {
    const h = world();
    await preTask7(h);
    const row = (await listActiveObservations(h.db, 'mini', 'flow_usd.fees_programmatic')).find((o) => o.observedAt.startsWith('2026-09-19'))!;
    await rejectObservation(h.db, row.id);
    const count = (await h.db.one<{ n: number }>('SELECT count(*) AS n FROM observations'))!.n;
    const r = await backfillTokens(h.db, h.loaded, h.deps, { days: 3, metrics: ['flow_usd.fees_programmatic'] });
    expect(r.skipped).toEqual([{ day: '2026-09-18', metricKey: 'flow_usd.fees_programmatic', reason: 'no active row for the day' }]);
    expect(r.filled).toBe(2);
    // Only the asked metric was filled; the rejected row stays as it was.
    expect((await tokensOf(h.db, 'flow_usd.fees')).every((t) => t.amount === null)).toBe(true);
    expect((await getTokensByIds(h.db, [row.id]))[0]!.amount).toBeNull();
    expect((await h.db.one<{ n: number }>('SELECT count(*) AS n FROM observations'))!.n).toBe(count);
  });

  it('--dry-run writes nothing and fetches no prices', async () => {
    const h = world();
    await preTask7(h);
    const before = await h.db.all('SELECT * FROM observations ORDER BY id');
    const r = await backfillTokens(h.db, h.loaded, h.deps, { days: 3, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, filled: 9, refused: [], skipped: [] }); // would fill
    expect(await h.db.all('SELECT * FROM observations ORDER BY id')).toEqual(before);
    expect(await listPrices(h.db, REF)).toEqual([]);
    expect((await h.db.one<{ n: number }>('SELECT count(*) AS n FROM tokens'))!.n).toBe(0);
    expect(h.http.calls).toEqual([]);
  });
  it('fetches one market_chart range per CoinGecko id, stores it under every token ref sharing the id, and never re-fetches stored hours', async () => {
    // A second scanned token priced at the same CoinGecko id (two refs, one id).
    const withB = INGEST_ASSET_YAML.replace(`  safe: "${SAFE}"\n`, `  safe: "${SAFE}"\n  token_b: "${TOKEN_B}"\n`).replace(
      METRICS_END,
      `  flow_usd.fees_b:
    type: flow
    unit: usd
    staleness_days: 45
    source: { type: transfer_flow, token: token_b, to: burn_sink, from_allowlist: [pool], unit: usd, price_coingecko_id: mini-token }
${METRICS_END}`,
    );
    const h = harness(testDb(), {
      loaded: parseAssetYaml(withB), routes: { [CG_CHART]: hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', () => 10) },
      calls: { [callKey(TOKEN_B, 'decimals')]: 18n }, logs: [],
    });
    await scanAll(h);
    await h.db.run('UPDATE observations SET token_ref = NULL, amount = NULL, hourly_amounts = NULL');
    await h.db.run('DELETE FROM prices');
    h.http.calls.length = 0;
    const r = await backfillTokens(h.db, h.loaded, h.deps, { days: 3 });
    expect(r.refused).toEqual([]);
    expect(r.filled).toBe(12);
    expect(r.prices).toMatchObject([{ coingeckoId: 'mini-token', tokenRefs: [REF, REF_B].sort() }]);
    const ranges = h.http.calls.filter((c) => c.url.includes('/market_chart/range?'));
    expect(ranges.length).toBe(r.prices[0]!.requests);
    expect(ranges.length).toBe(1); // three days: one window
    const a = await listPrices(h.db, REF);
    expect(a.length).toBe(72); // the 72 hours of the three days with rows to fill
    expect((await listPrices(h.db, REF_B)).map((p) => [p.ts, p.priceUsd])).toEqual(a.map((p) => [p.ts, p.priceUsd]));

    // Rows to fill again, but every hour they need is stored: no request.
    await h.db.run('UPDATE observations SET token_ref = NULL, amount = NULL, hourly_amounts = NULL');
    h.http.calls.length = 0;
    const again = await backfillTokens(h.db, h.loaded, h.deps, { days: 3 });
    expect(again).toMatchObject({ filled: 12, refused: [], prices: [{ coingeckoId: 'mini-token', requests: 0, rows: 0 }] });
    expect(h.http.calls).toEqual([]);
  });

  it('a transfer stamped outside its day is counted in the edge hour and noted', async () => {
    const h = world();
    await preTask7(h);
    // A stored day boundary 10 seconds late for the 17th: the 00:00:00 transfer is scanned with the 16th.
    const late = { number: h.rpc.blockAtOrAfter(ms('2026-09-17T00:00:10Z') / 1000), timestamp: 0 };
    late.timestamp = h.rpc.timestampOf(late.number);
    h.deps.dayBlocks = () => ({ get: async (d) => (d === '2026-09-17' ? late : null), put: async () => undefined });
    const r = await backfillTokens(h.db, h.loaded, h.deps, { days: 3, metrics: ['flow_usd.fees_programmatic'] });
    expect(r.refused).toEqual([]);
    expect(r.notes).toContainEqual(expect.stringMatching(/1 transfer\(s\) stamped outside their day's hours, counted in its first or last hour/));
    const [d16] = await tokensOf(h.db, 'flow_usd.fees_programmatic');
    expect(d16!.amount).toBe(5);
    expect(d16!.hourlyAmounts!.flatMap((x, i) => (x ? [[i, x]] : []))).toEqual([[10, 2], [23, 3]]);
  });

  it('a failure part-way through leaves whole days: the days before it filled, it and the rest untouched', async () => {
    const h = world();
    await preTask7(h);
    const before = await snapshot(h.db);
    const day17 = h.rpc.blockAtOrAfter(ms('2026-09-17T00:00:00Z') / 1000);
    const day18 = h.rpc.blockAtOrAfter(ms('2026-09-18T00:00:00Z') / 1000);
    const real = h.rpc.getTransferLogs.bind(h.rpc);
    h.rpc.getTransferLogs = async (q) => {
      if (q.fromBlock >= day17 && q.fromBlock < day18) throw new Error('fake RPC outage');
      return await real(q);
    };
    await expect(backfillTokens(h.db, h.loaded, h.deps, { days: 3 })).rejects.toThrow(/fake RPC outage/);
    for (const metric of ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic']) {
      expect((await tokensOf(h.db, metric)).map((t) => [t.day, t.amount === null])).toEqual([['2026-09-17', false], ['2026-09-18', true], ['2026-09-19', true]]);
    }
    expect(await snapshot(h.db)).toEqual(before);
    // A re-run resumes: the filled day is left alone, the rest is filled.
    h.rpc.getTransferLogs = real;
    expect(await backfillTokens(h.db, h.loaded, h.deps, { days: 3 })).toMatchObject({ filled: 6, alreadyFilled: 3, refused: [] });
  });

  it('a row superseded during the run is skipped as such, not counted as filled', async () => {
    const h = world();
    await preTask7(h);
    const row = (await listActiveObservations(h.db, 'mini', 'flow_usd.fees')).find((o) => o.observedAt.startsWith('2026-09-18'))!;
    const day17 = h.rpc.blockAtOrAfter(ms('2026-09-17T00:00:00Z') / 1000);
    const real = h.rpc.getTransferLogs.bind(h.rpc);
    let done = false;
    h.rpc.getTransferLogs = async (q) => {
      // Another writer retires the 17th's row after the backfill read it and before its transaction.
      if (!done && q.fromBlock >= day17) {
        done = true;
        await rejectObservation(h.db, row.id);
      }
      return await real(q);
    };
    const r = await backfillTokens(h.db, h.loaded, h.deps, { days: 3 });
    expect(r).toMatchObject({ filled: 8, alreadyFilled: 0, refused: [] });
    expect(r.skipped).toEqual([{ day: '2026-09-17', metricKey: 'flow_usd.fees', reason: `the row #${row.id} was superseded or rejected during the run` }]);
    expect((await getTokensByIds(h.db, [row.id]))[0]!.amount).toBeNull();
  });
});

describe('backfillTokens: USD-native first-party rows (ruling R18)', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const load = (id: string) => parseAssetYaml(readFileSync(`${ROOT}/assets/${id}.yaml`, 'utf8'));
  const row = async (db: Db, assetId: string, metricKey: string, day: string, value: number, over: { source?: 'api' | 'manual'; detail?: string; periodDays?: number } = {}) =>
    await insertObservation(db, {
      assetId, metricKey, observedAt: new Date(ms(`${day}T00:00:00Z`) + (over.periodDays ?? 1) * 86_400_000).toISOString(), periodDays: over.periodDays ?? 1, value,
      sourceDetail: over.detail ?? 'hyperliquid userFillsByTime 0xfefe @107 buys', fetchedAt: '2026-09-20T06:00:00Z', provenance: testProvenance(over.source ?? 'api', true),
      ...(over.source === 'manual' ? { citationUrl: 'https://example.test/c' } : {}),
    });

  it('fills token_ref usd, amount = value, no hourly buckets, on the dollar series written before 0005; no RPC or HTTP call; idempotent', async () => {
    const h = harness(testDb(), { loaded: load('hype') });
    const db = h.db;
    const buys = [await row(db, 'hype', 'flow_usd.af_buys_direct', '2026-09-16', 1234.5), await row(db, 'hype', 'flow_usd.af_buys_direct', '2026-09-17', 0)];
    const paid = await row(db, 'hype', 'flow_usd.reserve_yield', '2026-08-26', 52000.25, { periodDays: 30, detail: 'hyperliquid userNonFundingLedgerUpdates a -> b USDC; covers 2026-08-26 to 2026-09-24' });
    // Not first-party dollars: a DefiLlama series (af_buyback), a DefiLlama history row on a dollar metric, a hand-entered row.
    const llama = await row(db, 'hype', 'flow_usd.af_buyback', '2026-09-16', 99, { detail: 'https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyHoldersRevenue' });
    const llamaHist = await row(db, 'hype', 'flow_usd.af_buys_direct', '2026-09-15', 98, { detail: 'https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyHoldersRevenue' });
    const manual = await row(db, 'hype', 'flow_usd.af_buys_direct', '2026-09-14', 97, { source: 'manual', detail: 'typed in' });
    const before = await snapshot(db);
    const r = await backfillTokens(db, h.loaded, h.deps, {});
    expect(r.refused).toEqual([]);
    expect(r.filled).toBe(3);
    expect(r.skipped).toEqual([
      { day: '2026-09-14', metricKey: 'flow_usd.af_buys_direct', reason: `the active row #${manual.id} is manual, not the first-party series` },
      { day: '2026-09-15', metricKey: 'flow_usd.af_buys_direct', reason: `the active row #${llamaHist.id} was read from DefiLlama, not the first-party series` },
    ]);
    expect(await getTokensByIds(db, [...buys.map((b) => b.id), paid.id, llama.id, llamaHist.id, manual.id])).toEqual([
      { id: buys[0]!.id, tokenRef: 'usd', amount: 1234.5, hourlyAmounts: null },
      { id: buys[1]!.id, tokenRef: 'usd', amount: 0, hourlyAmounts: null },
      { id: paid.id, tokenRef: 'usd', amount: 52000.25, hourlyAmounts: null },
      { id: llama.id, tokenRef: null, amount: null, hourlyAmounts: null },
      { id: llamaHist.id, tokenRef: null, amount: null, hourlyAmounts: null },
      { id: manual.id, tokenRef: null, amount: null, hourlyAmounts: null },
    ]);
    expect(await snapshot(db)).toEqual(before); // value and every other column unchanged; no new row
    expect(h.http.calls).toEqual([]);
    expect(h.rpc.stats).toMatchObject({ getBlock: 0, multicall: 0, logRanges: [] });
    const view = await db.all<{ id: number; usd: number; usd_basis: string }>('SELECT id, usd, usd_basis FROM flow_usd_v WHERE id = ANY($1::bigint[]) ORDER BY id', [[buys[0]!.id, paid.id]]);
    expect(view).toEqual([{ id: buys[0]!.id, usd: 1234.5, usd_basis: 'usd_native' }, { id: paid.id, usd: 52000.25, usd_basis: 'usd_native' }]);

    const again = await backfillTokens(db, h.loaded, h.deps, {});
    expect(again).toMatchObject({ filled: 0, alreadyFilled: 3, refused: [] });
    expect(await snapshot(db)).toEqual(before);
  });

  it('LIT: the dollar exchange-fee and treasury-buy series are filled without opening the RPC; LIT-denominated series are not', async () => {
    const h = harness(testDb(), { loaded: load('lit') });
    const fees = await row(h.db, 'lit', 'flow_usd.fees_core', '2026-09-16', 41000, { detail: 'lighter exchangeMetrics mainnet.zklighter.elliot.ai maker_fee+taker_fee (7 days)' });
    const buys = await row(h.db, 'lit', 'flow_usd.buyback', '2026-09-16', 39000, { detail: 'lighter trades account 0 market 2049 buys (12 trades, 1 pages)' });
    const r = await backfillTokens(h.db, h.loaded, h.deps, { metrics: ['flow_usd.fees_core', 'flow_usd.buyback'] });
    expect(r).toMatchObject({ filled: 2, refused: [], skipped: [] });
    expect((await getTokensByIds(h.db, [fees.id, buys.id])).map((t) => [t.tokenRef, t.amount])).toEqual([['usd', 41000], ['usd', 39000]]);
    expect(h.rpc.stats).toMatchObject({ getBlock: 0, multicall: 0, logRanges: [] });
    await expect(backfillTokens(h.db, h.loaded, h.deps, { metrics: ['flow_tokens.buyback'] })).rejects.toMatchObject({ code: 'not_a_transfer_flow' });
  });
});

async function scanAll(h: Harness): Promise<void> {
  const latest = await h.rpc.latestBlock();
  for (const group of buildPlan(h.loaded.config).flowGroups) {
    await scanFlowGroup({
      db: h.db, asset: h.loaded.config, configHash: h.loaded.hash, group, rpc: h.rpc, latest, http: h.http, env: {},
      sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false,
    });
  }
}
