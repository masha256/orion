import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { getTokensByIds, listActiveObservations, rejectObservation } from '../../src/db/observations.js';
import { evmTokenRef, listPrices } from '../../src/db/prices.js';
import { scanFlowGroup } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { backfillTokens } from '../../src/ingest/tokenBackfill.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { CG_CHART, harness, hourlyPrices, type Harness } from '../helpers/fetchHarness.js';
import { POOL, SAFE, TOKEN } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();
const E18 = 10n ** 18n;
const ms = (iso: string) => Date.parse(iso);
const REF = evmTokenRef(8453, TOKEN);

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
    expect(r.prices).toMatchObject([{ coingeckoId: 'mini-token', tokenRef: REF, failures: [] }]);
    expect(h.http.calls.every((c) => c.url.includes('/market_chart/range?'))).toBe(true);
    expect((await listPrices(h.db, REF)).length).toBeGreaterThan(0);

    // A second run fills nothing (amount IS NULL guards every update) and still changes no value.
    const again = await backfillTokens(h.db, h.loaded, h.deps, { days: 3 });
    expect(again).toMatchObject({ filled: 0, alreadyFilled: 9, refused: [], skipped: [] });
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
});
