import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { useTestDb } from '../helpers/db.js';
import { harness } from '../helpers/fetchHarness.js';
import { getAdapter } from '../../src/ingest/adapters/registry.js';
import { adapterSource } from '../../src/ingest/sources/adapter.js';
import type { SourceContext, SourceValue } from '../../src/ingest/types.js';
import { ADAPTER_SOURCE_TYPES } from '../../src/report/sourceTypes.js';
import { ADAPTER_ENDPOINTS } from '../../tools/sources-register/generate.js';
import { paramsOf, poolWorld, POOL_METRICS, unregPool, W, type PoolWorld, type WorldChain } from '../helpers/poolWorld.js';

/**
 * pool.tape_fees_daily / pool.vrm_incentives_daily (Phase 3 R4 Task 7) over a SYNTHETIC two-chain world
 * (tests/helpers/poolWorld.ts) served through ctx.rpcFor + fakeRpc: the real engine (scan, pricing, incentives) runs.
 */

const NOW = '2026-11-27T12:00:00.000Z'; // yesterday = 2026-11-26
const REVISION = ['2026-11-24', '2026-11-25', '2026-11-26'];
const TAPE = 'pool.tape_fees_daily';
const VRM = 'pool.vrm_incentives_daily';
const ALL = Object.values(POOL_METRICS);

type Series = Extract<SourceValue, { kind: 'daily_series' }>;
const adapterOf = (m: string) => (m === POOL_METRICS.vote_incentives || m === POOL_METRICS.protocol_subsidy ? VRM : TAPE);
async function run(world: PoolWorld, ctx: SourceContext, metric: string): Promise<Series> {
  const v = await getAdapter(adapterOf(metric)).run(ctx, paramsOf(world, ctx, metric));
  if (v.kind !== 'daily_series') throw new Error(`not a daily series: ${v.kind}`);
  return v;
}
const days = (s: Series) => s.points.map((p) => p.day);
const value = (s: Series, day: string) => s.points.find((p) => p.day === day)!.value;
const two = (over: Partial<WorldChain> = {}, over10: Partial<WorldChain> = {}): WorldChain[] => [
  { chainId: 8453, vote: 864, subsidy: 432, ...over },
  { chainId: 10, vote: 86.4, subsidy: 0, ...over10 },
];
const dayRange = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const count = (world: PoolWorld, chain: number, fn: string) => world.calls.get(chain)!.get(fn) ?? 0;

describe('pool.tape_fees_daily and pool.vrm_incentives_daily', () => {
  it('five metrics in one run scan each chain-day once', async () => {
    const world = poolWorld(two(), { nowIso: NOW });
    const ctx = world.ctx();
    const out: Record<string, Series> = {};
    for (const m of ALL) out[m] = await run(world, ctx, m);
    for (const m of ALL) expect(days(out[m])).toEqual(REVISION);
    for (const chain of [8453, 10]) {
      expect(count(world, chain, 'targetFactories')).toBe(3); // one scan per chain-day (5 metrics without the memo: 15)
      expect(count(world, chain, 'getCurrentBlockTimestamp')).toBe(3); // one price book per chain-day
      expect(count(world, chain, 'incentiveCount')).toBe(1); // programs once per run
      expect(count(world, chain, 'FACTORY_REGISTRY')).toBe(1); // VRM discovery once per run
      expect(count(world, chain, 'getPriorSupplyIndex')).toBe(3 * 2); // one stream read per chain-day (two bounds)
    }
    expect(count(world, 8453, 'chains')).toBe(3); // root Voter once per scanned day, on Base
    expect(count(world, 10, 'chains')).toBe(0);
    for (const d of REVISION) {
      expect(value(out[POOL_METRICS.gross], d)).toBeCloseTo(2000, 6);
      expect(value(out[POOL_METRICS.allocator], d)).toBeCloseTo(1800, 6);
      expect(value(out[POOL_METRICS.lp], d)).toBeCloseTo(200, 6);
      expect(value(out[POOL_METRICS.vote_incentives], d)).toBeCloseTo(864 + 86.4, 4);
      expect(value(out[POOL_METRICS.protocol_subsidy], d)).toBeCloseTo(432, 4);
    }
    // USD with no token: the report's onchain_usd basis.
    for (const m of ALL) expect(out[m].token).toBeUndefined();
    // Programs are read at the latest scanned day's e−1.
    const e1 = world.rpcs.get(8453)!.blockAtOrAfter(Date.parse('2026-11-27T00:00:00Z') / 1000) - 1n;
    expect(out[POOL_METRICS.gross].points[2].slice).toMatchObject({ chains: { 8453: { e: String(e1 + 1n) } } });
  });

  it('slices carry per-chain blocks and USD', async () => {
    const world = poolWorld(two({ fees: () => ({ gross: 990, unpriced: 10 }) }), { nowIso: NOW });
    const ctx = world.ctx();
    const g = await run(world, ctx, POOL_METRICS.gross);
    const slice = g.points[0].slice as { chains: Record<string, Record<string, unknown>> };
    expect(Object.keys(slice.chains).sort()).toEqual(['10', '8453']);
    expect(slice.chains['8453']).toEqual({
      s: expect.stringMatching(/^\d+$/), e: expect.stringMatching(/^\d+$/),
      grossUsd: expect.closeTo(990, 6), allocatorUsd: expect.closeTo(900, 6), unregisteredAllocatorUsd: 0, pricedPct: expect.closeTo(99, 6), unpricedUsd: expect.closeTo(10, 6),
    });
    const inc = await run(world, ctx, POOL_METRICS.vote_incentives);
    expect((inc.points[0].slice as { chains: Record<string, unknown> }).chains['8453']).toMatchObject({ vote_incentives: expect.closeTo(864, 4), protocol_subsidy: expect.closeTo(432, 4), programsActive: 2 });
  });

  it('routine run scans the 3 revision days only', async () => {
    const world = poolWorld(two(), { nowIso: NOW });
    const stored = Object.fromEntries(ALL.map((m) => [m, dayRange('2026-08-29', 90)])); // every day of the window
    const ctx = world.ctx({ stored });
    const g = await run(world, ctx, POOL_METRICS.gross);
    expect(days(g)).toEqual(REVISION);
    expect(g.detail).toContain('remaining_missing: 0');
    expect(count(world, 8453, 'targetFactories')).toBe(3);
  });

  it('a backfill of 40 missing days scans the oldest 7 and reports remaining_missing 33', async () => {
    const world = poolWorld(two(), { nowIso: NOW });
    const g = await run(world, world.ctx({ backfillDays: 40, stored: {} }), POOL_METRICS.gross);
    expect(days(g)).toEqual(dayRange('2026-10-18', 7));
    expect(g.detail).toContain('remaining_missing: 33');
    expect(count(world, 8453, 'targetFactories')).toBe(7);
  });

  it('the next run scans the next 7', async () => {
    const world = poolWorld(two(), { nowIso: NOW });
    const g = await run(world, world.ctx({ backfillDays: 40, stored: { [POOL_METRICS.gross]: dayRange('2026-10-18', 7) } }), POOL_METRICS.gross);
    expect(days(g)).toEqual(dayRange('2026-10-25', 7));
    expect(g.detail).toContain('remaining_missing: 26');
  });

  it('max_scan_days caps a run (14 at most); missing days plus the revision days, oldest first', async () => {
    const world = poolWorld(two(), { nowIso: NOW, maxScanDays: 14 });
    // Stored: everything but 2026-11-01 and 2026-11-10 in the window: 2 missing + 3 revision days.
    const window = dayRange('2026-08-29', 90).filter((d) => d !== '2026-11-01' && d !== '2026-11-10');
    const g = await run(world, world.ctx({ stored: { [POOL_METRICS.gross]: window } }), POOL_METRICS.gross);
    expect(days(g)).toEqual(['2026-11-01', '2026-11-10', ...REVISION]);
  });

  it('without --backfill-days the missing days come from the asset window, capped at the writer window (90)', async () => {
    const world = poolWorld(two(), { nowIso: NOW, maxScanDays: 14 });
    // The asset's backfill_days is 100, the series writer fills gaps over 90 days on a routine run.
    const g = await run(world, world.ctx({ stored: { [POOL_METRICS.gross]: dayRange('2026-09-10', 78) } }), POOL_METRICS.gross);
    expect(days(g)[0]).toBe('2026-08-29'); // today − 90
    expect(g.detail).toContain('remaining_missing: 0');
    expect(days(g)).toEqual([...dayRange('2026-08-29', 12), '2026-11-24', '2026-11-25']);
  });

  it('days before `since` are never scanned', async () => {
    const world = poolWorld(two(), { nowIso: NOW, since: '2026-11-20' });
    const g = await run(world, world.ctx({ backfillDays: 40, stored: {} }), POOL_METRICS.gross);
    expect(days(g)).toEqual(dayRange('2026-11-20', 7));
    expect(g.detail).toContain('remaining_missing: 0');
  });

  it('coverage 94.9% on one chain fails the run; 97% writes and warns', async () => {
    const bad = poolWorld(two({}, { fees: (d) => (d === '2026-11-25' ? { gross: 949, unpriced: 51 } : {}) }), { nowIso: NOW });
    await expect(run(bad, bad.ctx(), POOL_METRICS.gross)).rejects.toThrow(/chain 10 2026-11-25: priced 94\.9\d*% of gross/);
    await expect(run(bad, bad.ctx(), POOL_METRICS.vote_incentives)).rejects.toThrow(/priced 94\.9/);

    const warn = poolWorld(two({}, { fees: (d) => (d === '2026-11-25' ? { gross: 970, unpriced: 30 } : {}) }), { nowIso: NOW });
    const ctx = warn.ctx();
    const g = await run(warn, ctx, POOL_METRICS.gross);
    expect(value(g, '2026-11-25')).toBeCloseTo(1000 + 970, 6);
    expect(g.warnings).toEqual([{ dedupeKey: 'pool_scan:coverage:10', detail: expect.objectContaining({ chain: 10, days: [{ day: '2026-11-25', pricedPct: expect.closeTo(97, 6), unpricedUsd: expect.closeTo(30, 6) }] }) }]);
    // Engine-level warnings come only from the gross metric.
    for (const m of [POOL_METRICS.allocator, POOL_METRICS.lp, POOL_METRICS.vote_incentives, POOL_METRICS.protocol_subsidy]) expect((await run(warn, ctx, m)).warnings ?? []).toEqual([]);
  });

  it('allocator over gross by 0.6% and $2 fails; by 0.4% writes', async () => {
    const over = poolWorld(two({ fees: () => ({ gross: 400, alloc: 402.4 }) }), { nowIso: NOW });
    await expect(run(over, over.ctx(), POOL_METRICS.allocator)).rejects.toThrow(/chain 8453 2026-11-24: allocator \$402\.40 exceeds gross \$400\.00/);
    const under = poolWorld(two({ fees: () => ({ gross: 400, alloc: 401.6 }) }), { nowIso: NOW });
    const ctx = under.ctx();
    expect(value(await run(under, ctx, POOL_METRICS.allocator), '2026-11-24')).toBeCloseTo(401.6 + 900, 6);
    // lp never goes below 0 on a chain-day inside the bound.
    expect(value(await run(under, ctx, POOL_METRICS.lp), '2026-11-24')).toBeCloseTo(0 + 100, 6);
    // Over by 0.6% but only $0.60: within $1, writes.
    const small = poolWorld(two({ fees: () => ({ gross: 100, alloc: 100.6 }) }), { nowIso: NOW });
    expect(value(await run(small, small.ctx(), POOL_METRICS.gross), '2026-11-24')).toBeCloseTo(1100, 6);
  });

  it('gauged pools unregistered at e-1 (Arbitrum 10-26 shape): gross takes their allocator accrual, LP 0, no bound failure', async () => {
    // Registered P1 (gross 1000, allocator 900) plus three gauged unregistered pools accruing $362 in all: before the fix
    // their tape gross was 0, so allocator $1262 > gross $1000 failed the bound.
    const world = poolWorld(two({ unregisteredGauged: [200, 150, 12] }), { nowIso: NOW });
    const ctx = world.ctx();
    const g = await run(world, ctx, POOL_METRICS.gross);
    expect(value(g, '2026-11-24')).toBeCloseTo(1362 + 1000, 6);
    const c8453 = (g.points[0].slice as { chains: Record<string, Record<string, unknown>> }).chains['8453'];
    expect(c8453).toMatchObject({ grossUsd: expect.closeTo(1362, 6), allocatorUsd: expect.closeTo(1262, 6), unregisteredAllocatorUsd: expect.closeTo(362, 6) });
    expect((g.points[0].slice as { chains: Record<string, Record<string, unknown>> }).chains['10']).toMatchObject({ unregisteredAllocatorUsd: 0 });
    expect(value(await run(world, ctx, POOL_METRICS.allocator), '2026-11-24')).toBeCloseTo(1262 + 900, 6);
    expect(value(await run(world, ctx, POOL_METRICS.lp), '2026-11-24')).toBeCloseTo(100 + 100, 6);
    // The drift warning stays, one per pool.
    expect((g.warnings ?? []).map((w) => w.dedupeKey).filter((k) => k.startsWith('pool_scan:gauged_unregistered:')).sort()).toEqual(
      [0, 1, 2].map((i) => `pool_scan:gauged_unregistered:8453:${unregPool(i)}`).sort(),
    );
  });

  it('a registered pool whose allocator tops its gross still fails the bound beside gauged unregistered pools', async () => {
    const world = poolWorld(two({ fees: () => ({ gross: 400, alloc: 405 }), unregisteredGauged: [100] }), { nowIso: NOW });
    await expect(run(world, world.ctx(), POOL_METRICS.gross)).rejects.toThrow(/chain 8453 2026-11-24: allocator \$505\.00 exceeds gross \$500\.00/);
  });

  it('an RPC failure on any chain fails the run; nothing is written', async () => {
    const world = poolWorld(two({}, { fail: (fn, d) => fn === 'accumulators' && d === '2026-11-25' }), { nowIso: NOW });
    const ctx = world.ctx();
    for (const m of ALL) await expect(run(world, ctx, m)).rejects.toThrow(/RPC Request failed/);
    // Through the adapter source: ok false, so the run writes no day of the metric.
    const [r] = await adapterSource.fetch([{ metricKey: POOL_METRICS.gross, role: 'primary', source: ctx.asset.metrics[POOL_METRICS.gross].source!, tolerancePct: 1 }], ctx);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^adapter pool\.tape_fees_daily: .*RPC Request failed/) });
    // A read that reverts fails the same way.
    const rev = poolWorld(two({ revert: (fn) => fn === 'allowedCaller' }), { nowIso: NOW });
    await expect(run(rev, rev.ctx(), POOL_METRICS.lp)).rejects.toThrow(/allowedCaller/);
    const inc = poolWorld(two({}, { revert: (fn) => fn === 'incentive' }), { nowIso: NOW });
    await expect(run(inc, inc.ctx(), POOL_METRICS.protocol_subsidy)).rejects.toThrow(/incentive\(1\)/);
  });

  it('negative_gross and negative_allocator drift fail the run', async () => {
    const world = poolWorld(two({ fees: (d) => (d === '2026-11-26' ? { negativeGross: true } : {}) }), { nowIso: NOW });
    await expect(run(world, world.ctx(), POOL_METRICS.gross)).rejects.toThrow(/chain 8453 2026-11-26: negative_gross on 0x0+101/);
    const alloc = poolWorld(two({}, { fees: (d) => (d === '2026-11-26' ? { alloc: -5 } : {}) }), { nowIso: NOW });
    await expect(run(alloc, alloc.ctx(), POOL_METRICS.lp)).rejects.toThrow(/chain 10 2026-11-26: negative_allocator/);
  });

  it('lp = gross - allocator per day', async () => {
    const world = poolWorld(two({ fees: (d) => ({ gross: 500 + Number(d.slice(8)), alloc: 300 }) }, { fees: (d) => ({ gross: 100, alloc: Number(d.slice(8)) }) }), { nowIso: NOW });
    const ctx = world.ctx();
    const [g, al, lp] = [await run(world, ctx, POOL_METRICS.gross), await run(world, ctx, POOL_METRICS.allocator), await run(world, ctx, POOL_METRICS.lp)];
    for (const d of REVISION) {
      expect(value(lp, d)).toBeCloseTo(value(g, d) - value(al, d), 6);
      expect(value(g, d)).toBeCloseTo(600 + Number(d.slice(8)), 6);
    }
  });

  it('drift, dropped anchors and root chains warn from the gross metric only, keyed pool_scan:<what>:<chain>[:<id>]', async () => {
    // Chain 10's only anchor is stale: it has no fee that day, so nothing goes unpriced (see the next test).
    const world = poolWorld(two({ liveTape: W.otherTape, rootChains: [8453, 10, 57073] }, { feedAgeSec: 100_000, fees: () => ({ gross: 0, alloc: 0, unpriced: 0 }) }), { nowIso: NOW });
    const ctx = world.ctx();
    const g = await run(world, ctx, POOL_METRICS.gross);
    const keys = (g.warnings ?? []).map((w) => w.dedupeKey).sort();
    expect(keys).toEqual([`pool_scan:anchor_dropped:10:${W.usdc}`, 'pool_scan:chain:8453:57073', `pool_scan:tape:8453:${W.factory}`]);
    const dropped = g.warnings!.find((w) => w.dedupeKey.startsWith('pool_scan:anchor_dropped'))!;
    expect(dropped.detail).toMatchObject({ chain: 10, token: W.usdc, feed: W.feed, description: 'USDC / USD', days: REVISION });
    const tape = g.warnings!.find((w) => w.dedupeKey.startsWith('pool_scan:tape'))!;
    expect(tape.detail).toMatchObject({ kind: 'tape', chain: 8453, configured: W.tape, actual: W.otherTape, days: REVISION });
    expect(value(g, '2026-11-26')).toBeCloseTo(1000, 6);
    expect((await run(world, ctx, POOL_METRICS.allocator)).warnings ?? []).toEqual([]);
  });

  it('a chain-day with fees and nothing priced fails (every anchor dropped: the coverage graph has no root either)', async () => {
    const world = poolWorld(two({}, { feedAgeSec: 100_000 }), { nowIso: NOW });
    await expect(run(world, world.ctx(), POOL_METRICS.gross)).rejects.toThrow(/chain 10 2026-11-24: no fee priced/);
  });

  it('Elysium anchors read Base feeds (the readers map always holds Base)', async () => {
    const world = poolWorld([{ chainId: 8453 }, { chainId: 99901, feedChain: 8453 }], { nowIso: NOW });
    const g = await run(world, world.ctx(), POOL_METRICS.gross);
    expect(value(g, '2026-11-26')).toBeCloseTo(2000, 6);
    // Elysium's feed reads went to Base: Base answered 3 days × (its own + Elysium's) descriptions.
    expect(count(world, 8453, 'description')).toBe(6);
    expect(count(world, 99901, 'description')).toBe(0);
  });

  describe('a chain with its own `since` (Elysium deployed 2026-11-07 13:07-13:15Z, since 2026-11-08)', () => {
    const ELY_SINCE = '2026-11-08';
    const DEPLOY = Date.parse('2026-11-07T13:15:29Z') / 1000;
    const world2 = () => poolWorld([{ chainId: 8453, vote: 864, rootChains: [8453] }, { chainId: 99901, feedChain: 8453, since: ELY_SINCE, deployedAt: DEPLOY, vote: 86.4 }], { nowIso: NOW, since: '2026-10-22', maxScanDays: 14 });
    const elyDays = (world: PoolWorld) => [...world.callsByDay.get(99901)!.keys()].map((k) => k.split('@')[1]).sort();

    it('chain-days before its since are not scanned (no read), count 0 and are marked live: false', async () => {
      const world = world2();
      const ctx = world.ctx({ backfillDays: 40, stored: {} });
      const g = await run(world, ctx, POOL_METRICS.gross);
      expect(days(g)).toEqual(dayRange('2026-10-22', 14)); // ..11-04: Elysium is live on none of them
      for (const p of g.points) {
        expect(p.value).toBeCloseTo(1000, 6); // Base only
        expect((p.slice as { chains: Record<string, unknown> }).chains['99901']).toEqual({ live: false });
      }
      const inc = await run(world, ctx, POOL_METRICS.vote_incentives);
      for (const p of inc.points) expect((p.slice as { chains: Record<string, unknown> }).chains['99901']).toEqual({ live: false });
      expect(world.callsByDay.get(99901)!.size).toBe(0); // no Elysium read at all
      expect(world.rpcs.get(99901)!.stats.getLogs).toBe(0);
      // The root Voter's chains() lacks 99901 (as before 11-09): not drift while Elysium is not live.
      expect(g.warnings ?? []).toEqual([]);
    });

    it('a window across its since scans it from that day on, and warns root-Voter drift only on its live days', async () => {
      const world = world2();
      const g = await run(world, world.ctx({ backfillDays: 40, stored: { [POOL_METRICS.gross]: dayRange('2026-10-22', 14) } }), POOL_METRICS.gross);
      expect(days(g)).toEqual(dayRange('2026-11-05', 14)); // ..11-18
      for (const p of g.points) {
        const ely = (p.slice as { chains: Record<string, Record<string, unknown>> }).chains['99901'];
        if (p.day < ELY_SINCE) {
          expect(ely, p.day).toEqual({ live: false });
          expect(p.value, p.day).toBeCloseTo(1000, 6);
        } else {
          expect(ely, p.day).toMatchObject({ grossUsd: expect.closeTo(1000, 6) });
          expect(ely.live, p.day).toBeUndefined();
          expect(p.value, p.day).toBeCloseTo(2000, 6);
        }
      }
      // Elysium was read only for its live days: the reads of 11-08 at s−1 fall on 11-07 23:59Z, after the deploy.
      expect(elyDays(world)[0]).toBe('2026-11-07');
      expect(world.callsByDay.get(99901)!.get('targetFactories@2026-11-07')).toBeUndefined(); // no 11-07 chain-day scan
      const root = g.warnings!.find((w) => w.dedupeKey === 'pool_scan:chain:8453:99901')!;
      expect(root.detail.days).toEqual(dayRange(ELY_SINCE, 11));
    });

    it('validates: since a YYYY-MM-DD day, not before the params since', () => {
      const world = world2();
      const scan = world.scan as { chains: Record<string, unknown>[] } & Record<string, unknown>;
      const withSince = (since: unknown) => ({ ...scan, chains: [scan.chains[0], { ...scan.chains[1], since }] });
      expect(getAdapter(TAPE).validateParams!({ scan, field: 'gross', since: '2026-10-22' })).toEqual([]);
      expect(getAdapter(TAPE).validateParams!({ scan: withSince('2026-11-31'), field: 'gross' })).toEqual([expect.stringMatching(/scan\.chains\.1\.since/)]);
      expect(getAdapter(TAPE).validateParams!({ scan: withSince('2026-10-01'), field: 'gross', since: '2026-10-22' })).toEqual(['scan.chains[1].since: 2026-10-01 is before the params since 2026-10-22']);
    });
  });

  it('an unpriced incentive token warns pool_scan:incentives_unpriced:<chain> from vote_incentives, with day, tokens and amounts', async () => {
    // Program 1 streams X (outside the day's price book: X is unpriced there) on chain 10.
    const world = poolWorld(two({}, { voteToken: W.x }), { nowIso: NOW });
    const ctx = world.ctx();
    const v = await run(world, ctx, POOL_METRICS.vote_incentives);
    expect(v.warnings).toEqual([
      {
        dedupeKey: 'pool_scan:incentives_unpriced:10',
        detail: {
          chain: 10,
          days: REVISION.map((day) => ({ day, tokens: [{ token: W.x, class: 'vote_incentives', amount: expect.stringMatching(/^\d+$/) }] })),
        },
      },
    ]);
    for (const d of REVISION) expect(value(v, d)).toBeCloseTo(864, 4); // chain 10's X is skipped, never imputed
    expect((await run(world, ctx, POOL_METRICS.protocol_subsidy)).warnings ?? []).toEqual([]);
    expect((await run(world, ctx, POOL_METRICS.gross)).warnings ?? []).toEqual([]);
  });

  it('an ambiguous incentive point warns from vote_incentives only', async () => {
    const world = poolWorld(two({ ambiguousDay: '2026-11-25' }), { nowIso: NOW });
    const ctx = world.ctx();
    const v = await run(world, ctx, POOL_METRICS.vote_incentives);
    expect(v.warnings).toEqual([{ dedupeKey: `pool_scan:incentive_ambiguous:8453:${W.vrm}`, detail: expect.objectContaining({ chain: 8453, vrm: W.vrm, days: ['2026-11-25', '2026-11-26'] }) }]);
    expect((await run(world, ctx, POOL_METRICS.protocol_subsidy)).warnings ?? []).toEqual([]);
    expect((await run(world, ctx, POOL_METRICS.gross)).warnings ?? []).toEqual([]);
  });

  describe('validateParams', () => {
    const world = poolWorld(two(), { nowIso: NOW });
    const scan = world.scan as { chains: Record<string, unknown>[] } & Record<string, unknown>;
    const check = (name: string, p: Record<string, unknown>) => getAdapter(name).validateParams!(p);
    const withChain = (i: number, over: Record<string, unknown>) => ({ ...scan, chains: scan.chains.map((c, k) => (k === i ? { ...c, ...over } : c)) });
    const anchor = (over: Record<string, unknown>) => withChain(1, { anchors: [{ token: W.usdc, feed: W.feed, description: 'USDC / USD', ...over }] });

    it('accepts the world config for both adapters', () => {
      expect(check(TAPE, { scan, field: 'gross' })).toEqual([]);
      expect(check(TAPE, { scan, field: 'lp', max_scan_days: 14, since: '2026-10-22' })).toEqual([]);
      expect(check(VRM, { scan, class: 'protocol_subsidy' })).toEqual([]);
    });
    it('refuses an unknown chain id', () => {
      expect(check(TAPE, { scan: withChain(1, { chain_id: 137 }), field: 'gross' })).toEqual([expect.stringMatching(/scan\.chains\[1\]\.chain_id: chain 137 is not a known chain/)]);
    });
    it('refuses an anchor without description, and one off the allowlist (no tokenized-stock feeds)', () => {
      const { description: _d, ...bare } = { token: W.usdc, feed: W.feed, description: 'x' };
      expect(check(TAPE, { scan: withChain(1, { anchors: [bare] }), field: 'gross' })).toEqual([expect.stringMatching(/scan\.chains\.1\.anchors\.0\.description/)]);
      expect(check(TAPE, { scan: anchor({ description: 'TSLA / USD' }), field: 'gross' })).toEqual([expect.stringMatching(/anchors\[0\]\.description "TSLA \/ USD" is not an allowed anchor feed \(ETH \/ USD, BTC \/ USD/)]);
      for (const d of ['ETH / USD', 'BTC / USD', 'WBTC / USD', 'CBBTC / USD', 'USDC / USD', 'USDT / USD', 'DAI / USD', 'USDS / USD', 'USDG / USD', 'EURC / USD', 'HYPE / USD']) {
        expect(check(TAPE, { scan: anchor({ description: d }), field: 'gross' })).toEqual([]);
      }
    });
    it('refuses a duplicate factory, a duplicate chain, a duplicate anchor token', () => {
      const f = { address: W.factory, kind: 'v2_volatile', tape: W.tape };
      expect(check(TAPE, { scan: withChain(0, { factories: [f, { ...f, address: W.factory.toUpperCase().replace('0X', '0x') }] }), field: 'gross' })).toEqual([expect.stringMatching(/scan\.chains\[0\]: factory 0x0+f1 is listed twice/)]);
      expect(check(TAPE, { scan: { ...scan, chains: [scan.chains[0], scan.chains[0]] }, field: 'gross' })).toEqual([expect.stringMatching(/chain 8453 is listed twice/)]);
      const a = { token: W.usdc, feed: W.feed, description: 'USDC / USD' };
      expect(check(TAPE, { scan: withChain(0, { anchors: [a, a] }), field: 'gross' })).toEqual([expect.stringMatching(/token 0x0+c1 has two anchors/)]);
    });
    it('refuses max_scan_days 30, a bad field/class/since, unknown keys', () => {
      expect(check(TAPE, { scan, field: 'gross', max_scan_days: 30 })).toEqual(['max_scan_days: an integer 1..14, not 30']);
      expect(check(TAPE, { scan, field: 'net' })).toEqual(['field: gross, allocator or lp']);
      expect(check(VRM, { scan, class: 'bribes' })).toEqual(['class: vote_incentives or protocol_subsidy']);
      expect(check(VRM, { scan, class: 'vote_incentives', field: 'gross' })).toEqual(['unknown key "field" (scan, class, max_scan_days, since)']);
      expect(check(TAPE, { scan, field: 'gross', since: '2026-13-01' })).toEqual(['since: a YYYY-MM-DD day']);
      expect(check(TAPE, { field: 'gross' })).toEqual([expect.stringMatching(/^scan/)]);
    });
    it('refuses root_voter without Base, and an anchor feed on an unconfigured chain', () => {
      const noBase = { ...scan, chains: [scan.chains[1]], root_voter: { chain_id: 8453, address: W.rootVoter } };
      expect(check(TAPE, { scan: noBase, field: 'gross' })).toEqual(['scan.root_voter: the root Voter is read on Base (8453), which scan.chains does not list']);
      expect(check(TAPE, { scan: anchor({ feed_chain_id: 42161 }), field: 'gross' })).toEqual([expect.stringMatching(/anchors\[0\]\.feed_chain_id: chain 42161 is not in scan\.chains/)]);
    });
  });

  it('is registered on the pool_scan rung with one rpc endpoint per configured chain', () => {
    const world = poolWorld([{ chainId: 8453 }, { chainId: 10 }, { chainId: 99901 }], { nowIso: NOW });
    for (const name of [TAPE, VRM]) {
      expect(ADAPTER_SOURCE_TYPES[name]).toBe('pool_scan');
      expect(getAdapter(name).needsRpc).toBe(false); // reads through ctx.rpcFor, never the asset's ctx.rpc
      expect(getAdapter(name).paramsDoc).toMatch(/max_scan_days/);
      expect(ADAPTER_ENDPOINTS[name]({ scan: world.scan }, undefined as never)).toEqual([
        { kind: 'rpc', chainId: 8453, env: 'ORION_BASE_RPC_URL' },
        { kind: 'rpc', chainId: 10, env: 'ORION_OP_RPC_URL' },
        { kind: 'rpc', chainId: 99901, env: 'ORION_ELYSIUM_RPC_URL' },
      ]);
    }
  });

  it('refuses a run without ctx.rpcFor', async () => {
    const world = poolWorld(two(), { nowIso: NOW });
    const ctx = world.ctx({ rpcFor: undefined });
    await expect(run(world, ctx, POOL_METRICS.gross)).rejects.toThrow(/rpcFor/);
  });
});


/** Through fetchAsset and the series writer (Postgres test DB): the run's wiring, not only the adapter. */
describe('pool.tape_fees_daily in a fetch', () => {
  const testDb = useTestDb();
  const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
  const LINE = 'source: { type: defillama, slug: hyperliquid, data_type: dailyHoldersRevenue }';
  const METRIC = 'flow_usd.buyback';
  // One database per test (testDb() is the same one within a test): the second run sees the first run's rows.
  const fetchWith = async (world: PoolWorld, db = testDb(), since = '2026-11-20') => {
    const params = { scan: world.scan, field: 'gross', since };
    if (!FIXTURE.includes(LINE)) throw new Error('the fixture no longer has the line this test edits');
    const loaded = parseAssetYaml(FIXTURE.replace(LINE, `source: { type: adapter, name: ${TAPE}, params: ${JSON.stringify(params)} }`));
    const h = harness(db, { loaded, now: new Date(NOW), env: { ORION_BASE_RPC_URL: 'http://base.test', ORION_OP_RPC_URL: 'http://op.test', ORION_ELYSIUM_RPC_URL: 'http://elysium.test' } });
    h.deps.rpcFactory = (_url, chainId) => world.rpcs.get(chainId)!;
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    return { h, r, source: r.sources.find((x) => x.sourceId === `adapter:${TAPE}`)! };
  };

  it('writes onchain rows from `since`, reads them back as stored on the next run, raises warnings as advisory anomalies', async () => {
    const world = poolWorld(two({}, { fees: (d) => (d === '2026-11-21' ? { gross: 970, unpriced: 30 } : {}) }), { nowIso: NOW });
    const first = await fetchWith(world);
    expect(first.source).toMatchObject({ status: 'ok', metricsWritten: [METRIC], conflicts: [] });
    const rows = await listActiveObservations(first.h.db, 'hype', METRIC);
    expect(rows.map((o) => [o.observedAt.slice(0, 10), o.source])).toEqual(dayRange('2026-11-21', 7).map((d) => [d, 'onchain']));
    expect(rows.find((o) => o.observedAt.startsWith('2026-11-22'))!.value).toBeCloseTo(1970, 6);
    expect(first.r.anomalies.map((a) => [a.kind, a.severity, a.dedupeKey])).toEqual([['cross_check_mismatch', 'advisory', 'pool_scan:coverage:10']]);
    // The next run: every day stored, so only the 3 revision days are scanned, and nothing changed.
    const next = poolWorld(two({}, { fees: (d) => (d === '2026-11-21' ? { gross: 970, unpriced: 30 } : {}) }), { nowIso: NOW });
    const second = await fetchWith(next);
    expect(second.source).toMatchObject({ status: 'ok', metricsWritten: [], conflicts: [] });
    expect(count(next, 8453, 'targetFactories')).toBe(3);
  });

  it('gauged unregistered pools with accrual: the fetch writes every day, gross including their allocator accrual', async () => {
    const world = poolWorld(two({ unregisteredGauged: [200, 150, 12] }), { nowIso: NOW });
    const { h, source } = await fetchWith(world);
    expect(source).toMatchObject({ status: 'ok', metricsWritten: [METRIC], conflicts: [] });
    const rows = await listActiveObservations(h.db, 'hype', METRIC);
    expect(rows.map((o) => o.observedAt.slice(0, 10))).toEqual(dayRange('2026-11-21', 7));
    for (const o of rows) expect(o.value).toBeCloseTo(1362 + 1000, 6);
  });

  it('a negative_gross chain-day fails the source and writes nothing', async () => {
    const world = poolWorld(two({ fees: (d) => (d === '2026-11-23' ? { negativeGross: true } : {}) }), { nowIso: NOW });
    const { h, source } = await fetchWith(world);
    expect(source.status).toBe('failed');
    expect(source.error).toMatch(/chain 8453 2026-11-23: negative_gross/);
    expect(await listActiveObservations(h.db, 'hype', METRIC)).toEqual([]);
  });

  it('a scan planned over 2026-10-22..11-26 with Elysium since 11-08 writes every day and never reads Elysium before its deploy', async () => {
    const DEPLOY = Date.parse('2026-11-07T13:15:29Z') / 1000;
    const world = poolWorld([{ chainId: 8453, rootChains: [8453] }, { chainId: 99901, feedChain: 8453, since: '2026-11-08', deployedAt: DEPLOY }], { nowIso: NOW });
    const db = testDb();
    let h: Awaited<ReturnType<typeof fetchWith>>['h'] | undefined;
    for (let i = 0; i < 6; i++) {
      const r = await fetchWith(world, db, '2026-10-22'); // 7 days a run, oldest missing first: 6 runs reach 11-26
      expect(r.source.status, `run ${i + 1}: ${r.source.error ?? ''}`).toBe('ok');
      h = r.h;
    }
    const rows = await listActiveObservations(h!.db, 'hype', METRIC);
    // observed_at = D+1 00:00Z: the covered days 10-22..11-26, one row each.
    expect(rows.map((o) => o.observedAt.slice(0, 10))).toEqual(dayRange('2026-10-23', 36));
    for (const o of rows) {
      const day = new Date(Date.parse(o.observedAt) - 86_400_000).toISOString().slice(0, 10);
      expect(o.value, day).toBeCloseTo(day < '2026-11-08' ? 1000 : 2000, 6);
    }
    // No Elysium read before its contracts existed (every read there would have answered no data and failed the run).
    const ely = [...world.callsByDay.get(99901)!.keys()].map((k) => k.split('@')[1]).sort();
    expect(ely[0]).toBe('2026-11-07');
  });

  it('a failed chain-day fails the source and writes nothing', async () => {
    const world = poolWorld(two({}, { fail: (fn, d) => fn === 'getReserves' && d === '2026-11-23' }), { nowIso: NOW });
    const { h, source } = await fetchWith(world);
    expect(source.status).toBe('failed');
    expect(source.error).toMatch(/RPC Request failed/);
    expect(await listActiveObservations(h.db, 'hype', METRIC)).toEqual([]);
  });
});
