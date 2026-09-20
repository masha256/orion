import { describe, expect, it } from 'vitest';
import { updateAsset } from '../../src/app/update.js';
import { decideAnomaly } from '../../src/db/anomalies.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { insertObservation } from '../../src/db/observations.js';
import { miniAssumptions } from '../helpers/assets.js';
import { CG_MARKETS, harness, NOW, STATS } from '../helpers/fetchHarness.js';

/** The two metrics the ingest asset leaves manual, and an assumption set. */
function seedManual(h: ReturnType<typeof harness>) {
  for (const [metricKey, value] of [['revenue_run_rate_usd', 1000], ['staker_emission_share', 1]] as const) {
    insertObservation(h.db, { assetId: 'mini', metricKey, observedAt: '2026-09-18', value, source: 'manual', fetchedAt: NOW.toISOString() });
  }
  createAssumptionSet(h.db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: NOW.toISOString() });
}

describe('updateAsset', () => {
  it('fetches, runs the valuation on the fetched data, and returns the signal', async () => {
    const h = harness();
    seedManual(h);
    const { fetch, signal, runId } = await updateAsset(h.db, h.loaded, NOW, h.deps);
    expect(fetch.outcome).toBe('ok');
    expect(signal.status).toBe('ok');
    expect(signal.provenance.run_id).toBe(runId);
    // The spot price is an API level, stamped with the fetch's own start time (NOW).
    expect(signal.spot).toEqual({ price: 10, ts: NOW.toISOString() });
    // The valuation runs after the fetch, at deps.now() (NOW + 5s in the harness): never at NOW itself,
    // which could already be older than a chain read the fetch just wrote (item 2 of the fix brief).
    expect(signal.generated_at).toBe(h.deps.now().toISOString());
    expect(signal.data_quality.grade).toBe('B'); // two manual metrics remain
  });

  it('values at a time no earlier than the newest thing the fetch just wrote, even when the chain head runs ahead of deps.now()', async () => {
    // The chain head sits a minute ahead of NOW while deps.now() is only 5s ahead: the naive fix of
    // "value at deps.now()" would still be too early. asOf must be the later of the two.
    const h = harness({ rpcNow: new Date(NOW.getTime() + 60_000) });
    seedManual(h);
    const { fetch, signal } = await updateAsset(h.db, h.loaded, NOW, h.deps);
    expect(fetch.outcome).toBe('ok');
    expect(signal.status).toBe('ok'); // not blocked: effective_supply etc. from this run's (future) block are usable
    const blockObservedAt = fetch.written.find((w) => w.metricKey === 'effective_supply')!.observedAt;
    expect(Date.parse(blockObservedAt)).toBeGreaterThan(h.deps.now().getTime());
    expect(Date.parse(signal.generated_at)).toBeGreaterThanOrEqual(Date.parse(blockObservedAt));
  });

  it('still runs the valuation when a source failed, on the last good observation', async () => {
    const h = harness();
    seedManual(h);
    await updateAsset(h.db, h.loaded, NOW, h.deps);
    const broken = harness({ db: h.db, routes: { [CG_MARKETS]: new Error('HTTP 429') }, now: new Date(NOW.getTime() + 86_400_000) });
    const { fetch, signal } = await updateAsset(broken.db, broken.loaded, new Date(NOW.getTime() + 86_400_000), broken.deps);
    expect(fetch.outcome).toBe('partial');
    expect(signal.status).toBe('ok');
    expect(signal.spot!.ts).toBe(NOW.toISOString()); // yesterday's price is still in force
  });

  it('returns a blocked signal when required data is missing', async () => {
    const h = harness();
    const { signal } = await updateAsset(h.db, h.loaded, NOW, h.deps);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons).toEqual(expect.arrayContaining(['missing_metric:revenue_run_rate_usd', 'no_assumption_set']));
  });
});

describe('updateAsset and a standing acknowledgement', () => {
  it('stays ok on later days once a persistent mismatch on a critical metric is acknowledged', async () => {
    const mismatching = { [STATS]: { price: 11, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } };
    const day1 = harness({ routes: mismatching });
    seedManual(day1);
    const first = await updateAsset(day1.db, day1.loaded, NOW, day1.deps);
    expect(first.signal.status).toBe('degraded');
    expect(first.signal.status_reasons).toEqual(['open_anomaly:cross_check_mismatch:price_usd']);

    decideAnomaly(day1.db, first.fetch.anomalies[0].id!, 'acknowledged', 'the second source lags', NOW.toISOString());

    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const day2 = harness({ db: day1.db, routes: mismatching, now: tomorrow });
    const second = await updateAsset(day2.db, day2.loaded, tomorrow, day2.deps);
    expect(second.signal.status).toBe('ok'); // the same mismatch was seen again; the acknowledgement stands
    expect(second.signal.data_quality).toMatchObject({ open_anomalies: 0, anomalies: [] });
    expect(second.fetch.anomalies[0]).toMatchObject({ status: 'acknowledged' });
  });
});
