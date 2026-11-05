import { describe, expect, it } from 'vitest';
import { listWatchStates, putWatchStates, type WatchStateRow } from '../../src/db/watchState.js';
import { insertObservation } from '../../src/db/observations.js';
import { watchTransitions } from '../../src/levels/watchTransitions.js';
import type { WatchFiring } from '../../src/types.js';
import { harness } from '../helpers/fetchHarness.js';
import { useTestDb } from '../helpers/db.js';
import { activate, cleanupAfterAll, handlerFor, levelsContext, levelsJob, levelsWorld } from '../helpers/levelsWorld.js';
import { watchAsset, watchAssetYaml } from '../helpers/watchAsset.js';
import { TEST_PROVENANCE } from '../helpers/provenance.js';

const testDb = useTestDb();
const worlds: { cleanup(): void }[] = [];
cleanupAfterAll(worlds);

const T0 = '2026-09-19T12:15:00.000Z';
const hour = (n: number) => new Date(Date.parse(T0) + n * 3_600_000).toISOString();

describe('watchTransitions', () => {
  const firing = (value: number, previous: number | null = 10): WatchFiring => ({ metric: 'p', rule: 'change_pct', value, previous, day: '2026-09-19' });
  const state = (firingNow: boolean, since = T0): WatchStateRow => ({ assetId: 'mini', metricKey: 'p', rule: 'change_pct', firing: firingNow, since, lastValue: 1 });

  it('fires once, stays quiet while firing, clears once', () => {
    const a = watchTransitions([], [firing(12)], [{ metricKey: 'p', rule: 'change_pct', value: 12 }], hour(0), 'mini');
    expect(a.fired).toEqual([firing(12)]);
    expect(a.cleared).toEqual([]);
    expect(a.next).toEqual([{ assetId: 'mini', metricKey: 'p', rule: 'change_pct', firing: true, since: hour(0), lastValue: 12 }]);

    const b = watchTransitions(a.next, [firing(13)], [{ metricKey: 'p', rule: 'change_pct', value: 13 }], hour(1), 'mini');
    expect(b.fired).toEqual([]);
    expect(b.cleared).toEqual([]);
    expect(b.next).toEqual([{ ...a.next[0], lastValue: 13 }]); // since keeps the time it started

    const c = watchTransitions(b.next, [], [{ metricKey: 'p', rule: 'change_pct', value: 10.1 }], hour(2), 'mini');
    expect(c.fired).toEqual([]);
    expect(c.cleared).toEqual([{ metricKey: 'p', rule: 'change_pct' }]);
    expect(c.next).toEqual([{ assetId: 'mini', metricKey: 'p', rule: 'change_pct', firing: false, since: hour(2), lastValue: 10.1 }]);
  });

  it('a metric not evaluated keeps its state; above rules are never touched', () => {
    const prev = [state(true), { ...state(true), metricKey: 'f', rule: 'above' as const }];
    const out = watchTransitions(prev, [{ metric: 'f', rule: 'above', value: 5000, previous: null, day: '2026-09-18' }], [{ metricKey: 'f', rule: 'above', value: 1 }], hour(1), 'mini');
    expect(out).toEqual({ fired: [], cleared: [], next: prev });
  });

  it('a metric that was never firing and is not firing gets a quiet row', () => {
    const out = watchTransitions([], [], [{ metricKey: 'p', rule: 'outside', value: 0.06 }], hour(0), 'mini');
    expect(out.fired).toEqual([]);
    expect(out.cleared).toEqual([]);
    expect(out.next).toEqual([{ assetId: 'mini', metricKey: 'p', rule: 'outside', firing: false, since: hour(0), lastValue: 0.06 }]);
  });

  it('watch_state round-trips and upserts', async () => {
    await putWatchStates(testDb(), [state(true), { ...state(false), assetId: 'b' }]);
    await putWatchStates(testDb(), [{ ...state(false, hour(1)), lastValue: null }]);
    expect(await listWatchStates(testDb())).toEqual([
      { assetId: 'b', metricKey: 'p', rule: 'change_pct', firing: false, since: T0, lastValue: 1 },
      { assetId: 'mini', metricKey: 'p', rule: 'change_pct', firing: false, since: hour(1), lastValue: null },
    ]);
    expect(await listWatchStates(testDb(), 'b')).toHaveLength(1);
  });
});

describe('watch posts from the hourly levels job', () => {
  const E18 = 10n ** 18n;
  async function setup() {
    const w = levelsWorld({ mini: watchAssetYaml({ changePct: 5 }) });
    worlds.push(w);
    const db = testDb();
    await activate(db, ['mini']);
    // The newest nightly row: the baseline every hourly change_pct compares with (R13).
    await insertObservation(db, { provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: 'stats_price', observedAt: '2026-09-19T00:45:00.000Z', value: 10, source: 'api', sourceDetail: null, fetchedAt: '2026-09-19T00:45:00.000Z' });
    const price = { now: '10' as string | Error };
    const stats = () => {
      if (price.now instanceof Error) throw price.now;
      return { price: price.now, apr: 0.06, supply: { totalBaseUnit: (100n * E18).toString() } };
    };
    return { w, db, price, stats };
  }

  async function run(s: Awaited<ReturnType<typeof setup>>, n: number) {
    const h = harness(s.db, { loaded: watchAsset({ changePct: 5 }), routes: { 'https://api.example.test/stats': s.stats }, now: new Date(hour(n)) });
    const r = levelsContext(s.db, s.w.root, hour(n));
    const out = await handlerFor(r, h.deps)(levelsJob(n + 1, hour(n)), r.ctx);
    return { ...r, out };
  }

  it('watch: not firing to firing posts once; staying firing posts nothing; clearing posts once', async () => {
    const s = await setup();
    s.price.now = '12';
    const one = await run(s, 0);
    expect(one.posts).toEqual(['ORION WATCH MINI: stats_price change_pct 12 (was 10)']);
    expect(one.out).toMatchObject({ status: 'done', result: { fired: ['ORION WATCH MINI: stats_price change_pct 12 (was 10)'], cleared: [] } });

    s.price.now = '12.5';
    const two = await run(s, 1);
    expect(two.posts).toEqual([]);

    s.price.now = '10.2';
    const three = await run(s, 2);
    expect(three.posts).toEqual(['ORION WATCH MINI cleared: stats_price change_pct']);
    expect(await listWatchStates(s.db, 'mini')).toEqual([
      { assetId: 'mini', metricKey: 'stats_apr', rule: 'outside', firing: false, since: hour(0), lastValue: 0.06 },
      { assetId: 'mini', metricKey: 'stats_price', rule: 'change_pct', firing: false, since: hour(2), lastValue: 10.2 },
    ]);
  });

  it('watch: a failed read keeps the firing state', async () => {
    const s = await setup();
    s.price.now = '12';
    expect((await run(s, 0)).posts).toHaveLength(1);

    s.price.now = new Error('stats down');
    const two = await run(s, 1);
    expect(two.posts).toEqual([]);
    expect((await listWatchStates(s.db, 'mini')).find((r) => r.metricKey === 'stats_price')).toMatchObject({ firing: true, since: hour(0), lastValue: 12 });

    s.price.now = '12.4';
    expect((await run(s, 2)).posts).toEqual([]); // still firing: nothing new to say
    s.price.now = '10';
    expect((await run(s, 3)).posts).toEqual(['ORION WATCH MINI cleared: stats_price change_pct']);
  });

  it('watch: flow watches are left to the nightly', async () => {
    const s = await setup();
    await putWatchStates(s.db, [{ assetId: 'mini', metricKey: 'flow_usd.revenue', rule: 'above', firing: true, since: T0, lastValue: 5000 }]);
    const one = await run(s, 0);
    expect(one.posts).toEqual([]);
    expect((await listWatchStates(s.db, 'mini')).find((r) => r.metricKey === 'flow_usd.revenue')).toMatchObject({ firing: true, lastValue: 5000 });
  });
});
