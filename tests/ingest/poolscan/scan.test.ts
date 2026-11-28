import { decodeFunctionData, encodeFunctionResult, pad } from 'viem';
import { describe, expect, it } from 'vitest';
import { CL_POOL_TAPE_ABI, FACTORY_ABI, FEES_COLLECTED_TOPIC, POOL_ABI, ROOT_VOTER_ABI } from '../../../src/ingest/poolscan/abi.js';
import { rpcChainReader } from '../../../src/ingest/poolscan/reader.js';
import { allocatorAsGross, checkRootChains, scanChainDay } from '../../../src/ingest/poolscan/scan.js';
import { ScanConfigSchema, driftDedupeKey, driftKey, type ChainDayScan } from '../../../src/ingest/poolscan/types.js';
import { fakeChainReader } from '../../helpers/fakeChainReader.js';
import { fakeRpc } from '../../helpers/fakeRpc.js';
import { dayStartSec, fixtureConfig, fixtureReader, loadPoolscanFixture, type FxPool, type PoolscanFixture } from '../../helpers/poolscanFixture.js';

const DAY = '2026-11-26';
const ZERO = '0x0000000000000000000000000000000000000000';
const CL_TAPE = '0x27d5eb73e7406675f6b0cbd037490ec3dba935a4';
const LITE_CL_TAPE = '0x967f5352a6448e22d7361e149103350c49345ee9';
const ROOT_VOTER = '0x49d7d4f17ec56ef8fa04e464af5d1a4942cc31e6';
/** Base root Voter chains() on 2026-11-27 (incentives-and-events.md §5 row 1, MEASURED). */
const AERO_CHAINS = [8453, 10, 1, 42161, 57073, 4663, 5042, 99901];

const poolOf = (scan: ChainDayScan, addr: string) => {
  const p = scan.pools.find((q) => q.pool === addr);
  if (!p) throw new Error(`scan lists no pool ${addr}`);
  return p;
};
const expectedAllocator = (p: FxPool): [bigint, bigint] => {
  const v = (a: [string, string] | null | undefined, i: number) => (a ? BigInt(a[i]) : 0n);
  return [0, 1].map((i) => v(p.pend_e, i) - v(p.pend_s, i) + v(p.collected, i)) as [bigint, bigint];
};
const registered = (p: FxPool) => p.allowed_caller !== ZERO;

describe('poolscan scanChainDay (2026-11-26 scoping fixtures)', () => {
  it('Base fixture gross per pool equals the scoping raw deltas', async () => {
    const fx = loadPoolscanFixture('base');
    const scan = await scanChainDay(fixtureReader(fx), fixtureConfig(fx), DAY);
    expect(scan.chainId).toBe(8453);
    expect(scan.pools).toHaveLength(Object.keys(fx.pools).length);
    expect(Object.keys(fx.pools).length).toBeLessThanOrEqual(40);
    for (const [addr, p] of Object.entries(fx.pools)) {
      const got = poolOf(scan, addr);
      expect([got.fee0, got.fee1], addr).toEqual([BigInt(p.expect.fee0), BigInt(p.expect.fee1)]);
      expect(got.factory).toBe(p.factory);
      expect([got.token0, got.token1]).toEqual([p.token0, p.token1]);
    }
    // The two pools whose first swap fell inside the day start from the tape's 1-wei sentinel (lastSwapTimestamp 0 at s):
    // the whole e accumulator is the day's fee, sentinel included, exactly as measure.py took it.
    const sentinel = Object.entries(fx.pools).filter(([, p]) => p.acc_s?.last === 0 && (p.acc_e?.last ?? 0) !== 0);
    expect(sentinel).toHaveLength(2);
    for (const [addr, p] of sentinel) expect(poolOf(scan, addr).fee0).toBe(BigInt(p.acc_e!.fee0));
    expect(scan.drift).toEqual([]);
  });

  it('reads at s-1 and e-1', async () => {
    const fx = loadPoolscanFixture('base');
    const reader = fixtureReader(fx);
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    const t0 = dayStartSec(DAY);
    expect(reader.stats.blockAt).toEqual([t0, t0 + 86_400]);
    expect(scan.blocks).toEqual({ s: BigInt(fx.blocks.s + 1), e: BigInt(fx.blocks.e + 1) });
    const blocks = new Set(reader.stats.calls.map((c) => c.block));
    expect([...blocks].sort()).toEqual([BigInt(fx.blocks.s), BigInt(fx.blocks.e)]); // s−1 and e−1 only
    const acc = reader.stats.calls.filter((c) => c.functionName === 'accumulators');
    expect(new Set(acc.filter((c) => c.block === BigInt(fx.blocks.s)).map((c) => c.args[0]))).toEqual(
      new Set(acc.filter((c) => c.block === BigInt(fx.blocks.e)).map((c) => c.args[0])),
    );
    // FeesCollected over [s, e−1], contiguous, at the chain's log range (Base CHAINS 2,000 without a log_range).
    const ranges = reader.stats.logs;
    expect(ranges[0].from).toBe(scan.blocks.s);
    expect(ranges.at(-1)!.to).toBe(scan.blocks.e - 1n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBe(ranges[i - 1].to + 1n);
    expect(ranges.every((r) => r.to - r.from + 1n <= 2000n)).toBe(true);
    expect(ranges.every((r) => r.topic0 === FEES_COLLECTED_TOPIC)).toBe(true);
  });

  it('a pool absent at s-1 contributes its whole e-1 accumulator', async () => {
    const fx = loadPoolscanFixture('base');
    const [mid, p] = Object.entries(fx.pools).find(([, q]) => q.new_in_day)!;
    const f = fx.factories.find((q) => q.address === p.factory)!;
    expect(f.pools.indexOf(mid)).toBeGreaterThanOrEqual(f.length_s);
    // Synthetic: the real mid-day pools were unregistered with $0 of tape fees (onchain-revenue.md §8), so give this one a
    // registration and an e−1 accumulator. At s−1 the tape returns its zero struct for the not-yet-existing pool (a public
    // mapping read: every new_in_day pool of the 45 scoping chain-days has an all-zero acc_s, none a failed read).
    const registeredMid: PoolscanFixture = structuredClone(fx);
    Object.assign(registeredMid.pools[mid], { allowed_caller: f.hook, acc_s: null, acc_e: { fee0: '12345', fee1: '678', last: 1795737000, swaps: 3 } });
    const scan = await scanChainDay(fixtureReader(registeredMid), fixtureConfig(registeredMid), DAY);
    expect(poolOf(scan, mid)).toMatchObject({ fee0: 12345n, fee1: 678n, registered: true, newInDay: true });
    expect(scan.counts.newInDay).toBe(1);
    // A reverted s−1 accumulator is a failed read, even for a mid-day pool: never "absent" (it would book a lifetime).
    const reverting = fixtureReader(registeredMid, {
      override: (c, at) => (at === 's' && c.functionName === 'accumulators' && c.args?.[0] === mid ? null : undefined),
    });
    await expect(scanChainDay(reverting, fixtureConfig(registeredMid), DAY)).rejects.toMatchObject({ code: 'pool_scan_read_failed', message: expect.stringContaining(`accumulators(${mid}) at s−1`) });
  });

  it('a gauged pool created during the day may answer no pending at s-1 (no code yet)', async () => {
    const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('base'));
    const [mid, p] = Object.entries(fx.pools).find(([, q]) => q.new_in_day)!;
    // Synthetic: gauge the mid-day CL pool; its pool has no code at s−1, so gaugeFees() returns no data (null).
    const gauge = '0x2222222222222222222222222222222222222222';
    const vrm = '0x3333333333333333333333333333333333333333';
    Object.assign(p, { gauge, vrm, pend_s: null, pend_e: ['40', '50'], collected: ['0', '0'] });
    fx.registry.factory_to_gauges['0xf437f62053acb121665b8fdbfea8f214fb8e589d'].push(gauge);
    const reader = fixtureReader(fx, { override: (c, at) => (at === 's' && c.address === mid && c.functionName === 'gaugeFees' ? null : undefined) });
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    expect(scan.allocatorByPool.get(mid)).toEqual(new Map([[p.token0, 40n], [p.token1, 50n]]));
  });

  describe('a failed read fails the scan (never a benign default)', () => {
    const fx = loadPoolscanFixture('base');
    const entries = Object.entries(fx.pools);
    const [regPool, rp] = entries.find(([, p]) => registered(p) && p.gauge && !p.new_in_day && fx.factories.find((f) => f.address === p.factory)!.kind === 'cl')!;
    const [v2Pool] = entries.find(([, p]) => registered(p) && p.gauge && fx.factories.find((f) => f.address === p.factory)!.kind !== 'cl')!;
    const cases: [string, 's' | 'e', (c: { address: string; functionName: string; args?: readonly unknown[] }) => boolean, string][] = [
      ['allowedCaller', 'e', (c) => c.functionName === 'allowedCaller' && c.args?.[0] === regPool, `allowedCaller(${regPool}) at e−1`],
      ['gaugeToTarget', 'e', (c) => c.functionName === 'gaugeToTarget' && c.args?.[0] === rp.gauge, `gaugeToTarget(${rp.gauge}) at e−1`],
      ['accumulators at s−1', 's', (c) => c.functionName === 'accumulators' && c.args?.[0] === regPool, `accumulators(${regPool}) at s−1`],
      ['accumulators at e−1', 'e', (c) => c.functionName === 'accumulators' && c.args?.[0] === regPool, `accumulators(${regPool}) at e−1`],
      ['CL pending at s−1', 's', (c) => c.functionName === 'gaugeFees' && c.address === regPool, `pending fees of ${regPool} at s−1`],
      ['CL pending at e−1', 'e', (c) => c.functionName === 'gaugeFees' && c.address === regPool, `pending fees of ${regPool} at e−1`],
      ['V2 pending at s−1', 's', (c) => c.functionName === 'pendingFees' && c.address === v2Pool, `pending fees of ${v2Pool} at s−1`],
      ['a factory tape getter', 'e', (c) => c.functionName === 'clPoolTape', 'clPoolTape() at e−1'],
      ['votingRewardsManager', 'e', (c) => c.functionName === 'votingRewardsManager' && c.address === rp.gauge, `${rp.gauge}.votingRewardsManager()`],
    ];
    for (const [what, when, hit, msg] of cases) {
      it(what, async () => {
        const reader = fixtureReader(fx, { override: (c, at) => (at === when && hit(c) ? null : undefined) });
        const err = await scanChainDay(reader, fixtureConfig(fx), DAY).catch((x: unknown) => x);
        expect(err).toMatchObject({ code: 'pool_scan_read_failed' });
        expect((err as Error).message).toContain('chain 8453 2026-11-26');
        expect((err as Error).message).toContain(msg);
      });
    }
  });

  it('unregistered pools are counted, excluded from gross, listed', async () => {
    const fx = loadPoolscanFixture('base');
    const reader = fixtureReader(fx);
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    const unreg = Object.entries(fx.pools).filter(([, p]) => !registered(p)).map(([a]) => a);
    expect(unreg.length).toBe(3); // 2 chosen + the mid-day pool
    expect(scan.counts).toMatchObject({ pools: 40, registered: 37 });
    for (const a of unreg) expect(poolOf(scan, a)).toMatchObject({ registered: false, fee0: 0n, fee1: 0n });
    // Their accumulators are never read: the tape drops an unregistered pool's swaps (fail-open record()).
    const accRead = new Set(reader.stats.calls.filter((c) => c.functionName === 'accumulators').map((c) => c.args[0]));
    for (const a of unreg) expect(accRead.has(a)).toBe(false);
  });

  it('a gauged unregistered pool raises drift', async () => {
    const fx = loadPoolscanFixture('ethereum');
    const scan = await scanChainDay(fixtureReader(fx), fixtureConfig(fx), DAY);
    const pool = '0x26e9a8313b62db29c7aac1715e6ffc91d1f756c9'; // onchain-revenue.md §4: the one gauged unregistered pool (Ethereum)
    expect(scan.drift.map(driftKey)).toEqual([`gauged_unregistered:${pool}`]);
    expect(scan.drift[0]).toMatchObject({ chainId: 1, detail: { gauge: fx.pools[pool].gauge } });
    expect(driftDedupeKey(scan.drift[0])).toBe(`pool_scan:gauged_unregistered:1:${pool}`);
    // Its fees still reach allocators through gaugeFees, so the allocator share is read anyway.
    const [a0, a1] = expectedAllocator(fx.pools[pool]);
    expect(scan.allocatorByPool.get(pool)).toEqual(new Map([[fx.pools[pool].token0, a0], [fx.pools[pool].token1, a1]]));
    expect(poolOf(scan, pool)).toMatchObject({ registered: false, fee0: 0n, fee1: 0n, gauge: fx.pools[pool].gauge });
  });

  it('a gauged pool unregistered at e-1 books its allocator accrual as gross (fees before registration never reach the tape)', async () => {
    const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('ethereum'));
    const pool = '0x26e9a8313b62db29c7aac1715e6ffc91d1f756c9';
    // Synthetic accrual (the real 11-26 one was 0): Δ pending 600/700 plus FeesCollected 5/6.
    Object.assign(fx.pools[pool], { pend_s: ['100', '200'], pend_e: ['700', '900'], collected: ['5', '6'] });
    const reader = fixtureReader(fx);
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    const { token0, token1 } = fx.pools[pool];
    expect(scan.allocatorByPool.get(pool)).toEqual(new Map([[token0, 605n], [token1, 706n]]));
    expect(poolOf(scan, pool)).toMatchObject({ registered: false, fee0: 605n, fee1: 706n, credit0: 605n, credit1: 706n });
    expect(scan.counts.registered).toBe(Object.values(fx.pools).filter(registered).length);
    // Still drift, and the tape is still never read for it.
    expect(scan.drift.map(driftKey)).toEqual([`gauged_unregistered:${pool}`]);
    expect(reader.stats.calls.some((c) => c.functionName === 'accumulators' && c.args[0] === pool)).toBe(false);
  });

  describe('a gauged pool registered during the day books max(tape delta, allocator accrual) per token', () => {
    // 0x45ad… (Base V2 stable, gauged, registered at e−1): tape delta a little above its allocator accrual (11-26).
    const POOL = '0x45adce4be5f602273c6e883a4c94133309af1d09';
    const lateRegistered = (bump: bigint): PoolscanFixture => {
      const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('base'));
      const p = fx.pools[POOL];
      p.allowed_caller_s = ZERO; // synthetic: unregistered at s−1
      p.pend_e = [String(BigInt(p.pend_e![0]) + bump), String(BigInt(p.pend_e![1]) + bump)];
      return fx;
    };

    it('tape delta below allocator: gross == allocator, the excess credited', async () => {
      const fx = lateRegistered(10n ** 15n);
      const scan = await scanChainDay(fixtureReader(fx), fixtureConfig(fx), DAY);
      const [a0, a1] = expectedAllocator(fx.pools[POOL]);
      const [t0, t1] = [BigInt(fx.pools[POOL].expect.fee0), BigInt(fx.pools[POOL].expect.fee1)];
      expect(a0 > t0 && a1 > t1).toBe(true);
      expect(poolOf(scan, POOL)).toMatchObject({ registered: true, fee0: a0, fee1: a1, credit0: a0 - t0, credit1: a1 - t1 });
      expect(scan.drift).toEqual([]);
    });

    it('tape delta above allocator: gross == tape delta, nothing credited', async () => {
      const fx = lateRegistered(0n);
      const scan = await scanChainDay(fixtureReader(fx), fixtureConfig(fx), DAY);
      const [a0, a1] = expectedAllocator(fx.pools[POOL]);
      const [t0, t1] = [BigInt(fx.pools[POOL].expect.fee0), BigInt(fx.pools[POOL].expect.fee1)];
      expect(t0 > a0 && t1 > a1).toBe(true);
      expect(poolOf(scan, POOL)).toMatchObject({ fee0: t0, fee1: t1, credit0: 0n, credit1: 0n });
    });

    it('registered all day: the tape delta even when the allocator is above it (the adapter bound judges it)', async () => {
      const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('base'));
      const p = fx.pools[POOL];
      p.pend_e = [String(BigInt(p.pend_e![0]) + 10n ** 15n), String(BigInt(p.pend_e![1]) + 10n ** 15n)];
      const scan = await scanChainDay(fixtureReader(fx), fixtureConfig(fx), DAY);
      expect(poolOf(scan, POOL)).toMatchObject({ fee0: BigInt(p.expect.fee0), fee1: BigInt(p.expect.fee1), credit0: 0n, credit1: 0n });
      // Every other scoping pool is registered all day or ungauged: nothing is credited anywhere.
      expect(scan.pools.filter((q) => q.credit0 > 0n || q.credit1 > 0n).map((q) => q.pool)).toEqual([]);
    });

    it('allowedCaller at s−1 is read for gauged pools only, and a failed read fails the scan', async () => {
      const fx = loadPoolscanFixture('base');
      const reader = fixtureReader(fx);
      await scanChainDay(reader, fixtureConfig(fx), DAY);
      const atS = reader.stats.calls.filter((c) => c.block === BigInt(fx.blocks.s) && c.functionName === 'allowedCaller').map((c) => c.args[0]);
      const expected = Object.entries(fx.pools).filter(([, q]) => q.gauge && registered(q) && !q.new_in_day).map(([a]) => a);
      expect(new Set(atS)).toEqual(new Set(expected));
      const failing = fixtureReader(fx, { override: (c, at) => (at === 's' && c.functionName === 'allowedCaller' && c.args?.[0] === POOL ? null : undefined) });
      const err = await scanChainDay(failing, fixtureConfig(fx), DAY).catch((x: unknown) => x);
      expect(err).toMatchObject({ code: 'pool_scan_read_failed' });
      expect((err as Error).message).toContain(`allowedCaller(${POOL}) at s−1`);
    });
  });

  it('allocatorAsGross: an allocator token outside the pool pair is inconsistent', () => {
    const p = { pool: '0x0000000000000000000000000000000000000001', token0: '0x00000000000000000000000000000000000000a0', token1: '0x00000000000000000000000000000000000000a1' };
    expect(allocatorAsGross(1, DAY, p, new Map([[p.token1, 7n]]))).toEqual([0n, 7n]);
    const other = '0x00000000000000000000000000000000000000ff';
    const err = (() => {
      try {
        allocatorAsGross(1, DAY, p, new Map([[p.token0, 1n], [other, 2n]]));
      } catch (x) {
        return x;
      }
    })();
    expect(err).toMatchObject({ code: 'pool_scan_inconsistent' });
    for (const s of ['chain 1 2026-11-26', p.pool, other]) expect((err as Error).message).toContain(s);
  });

  it('Arc Lite pools read the Lite tape named by their factory', async () => {
    const fx = loadPoolscanFixture('arc');
    const reader = fixtureReader(fx);
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    const lite = Object.entries(fx.pools).filter(([, p]) => p.factory === '0xb89df768af2cfe637ceb352c587fe8edaf491d03').map(([a]) => a);
    expect(lite).toHaveLength(3);
    const tapeOf = (pool: string) => new Set(reader.stats.calls.filter((c) => c.args[0] === pool && (c.functionName === 'accumulators' || c.functionName === 'allowedCaller')).map((c) => c.address));
    for (const a of lite) expect(tapeOf(a)).toEqual(new Set([LITE_CL_TAPE]));
    for (const [a, p] of Object.entries(fx.pools)) {
      if (p.factory === '0x7f83235643181e440433400a027618cd50879751') expect(tapeOf(a)).toEqual(new Set([CL_TAPE]));
      expect([poolOf(scan, a).fee0, poolOf(scan, a).fee1], a).toEqual([BigInt(p.expect.fee0), BigInt(p.expect.fee1)]);
    }
    expect(scan.counts).toEqual({ pools: 12, registered: 10, gauged: 8, newInDay: 0 });
    expect(scan.drift).toEqual([]); // the Lite hook and tapes are configured; the empty Lite V2 factories too
  });

  it('allocator = delta pending + FeesCollected; never negative per pool', async () => {
    const fx = loadPoolscanFixture('ink'); // every Ink pool of the day: counts are the scoping's
    const reader = fixtureReader(fx);
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    expect(scan.counts).toEqual({ pools: fx.scoping_counts.pools, registered: fx.scoping_counts.registered, gauged: fx.scoping_counts.gauged, newInDay: 1 });
    expect(scan.counts).toMatchObject({ pools: 40, registered: 32, gauged: 28 });
    const gauged = Object.entries(fx.pools).filter(([, p]) => p.gauge);
    expect(scan.allocatorByPool.size).toBe(gauged.length);
    for (const [a, p] of gauged) {
      const [a0, a1] = expectedAllocator(p);
      expect(scan.allocatorByPool.get(a), a).toEqual(new Map([[p.token0, a0], [p.token1, a1]]));
      for (const v of scan.allocatorByPool.get(a)!.values()) expect(v >= 0n).toBe(true);
    }
    // The real day: 86,400 Ink blocks in [s, e−1] at Ink's 10,000-block log range = 9 requests.
    expect(reader.stats.logs).toHaveLength(9);
    expect(scan.rpc.logs).toBe(9);

    // Synthetic: drop one pool's FeesCollected so its pending falls with nothing collected: taken as 0, with drift.
    const [victim, vp] = gauged.find(([, p]) => p.pend_s && BigInt(p.pend_s[0]) > BigInt(p.pend_e![0]))!;
    const noLogs = structuredClone(fx);
    noLogs.pools[victim].collected = ['0', '0'];
    const scan2 = await scanChainDay(fixtureReader(noLogs), fixtureConfig(noLogs), DAY);
    expect(scan2.allocatorByPool.get(victim)!.get(vp.token0)).toBe(0n);
    expect(scan2.drift.map(driftKey)).toContain(`negative_allocator:${victim}`);
  });

  it('Ink logs over 25,000 blocks take 3 requests', async () => {
    const fx = loadPoolscanFixture('ink');
    const wide: PoolscanFixture = structuredClone(fx);
    wide.blocks.e = wide.blocks.s + 25_000; // synthetic span: [s, e−1] = 25,000 blocks
    const reader = fixtureReader(wide);
    const scan = await scanChainDay(reader, fixtureConfig(wide), DAY);
    const s = BigInt(wide.blocks.s + 1);
    expect(reader.stats.logs.map((r) => [r.from, r.to])).toEqual([
      [s, s + 9_999n], [s + 10_000n, s + 19_999n], [s + 20_000n, s + 24_999n],
    ]);
    expect(scan.rpc.logs).toBe(3);
    // Every VRM in each request, and no request without one.
    const vrms = new Set(Object.values(fx.pools).filter((p) => p.vrm).map((p) => p.vrm));
    for (const r of reader.stats.logs) expect(new Set(r.address)).toEqual(vrms);
  });

  it('a configured log_range overrides the chain default', async () => {
    const fx = loadPoolscanFixture('base');
    const reader = fixtureReader(fx);
    await scanChainDay(reader, { ...fixtureConfig(fx), log_range: 500_000 }, DAY);
    expect(reader.stats.logs).toHaveLength(1);
  });

  it('a chain with no gauge sends no log request', async () => {
    const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('ethereum'));
    for (const k of Object.keys(fx.registry.factory_to_gauges)) fx.registry.factory_to_gauges[k] = [];
    const reader = fixtureReader(fx);
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    expect(reader.stats.logs).toEqual([]);
    expect(scan.counts.gauged).toBe(0);
    expect(scan.allocatorByPool.size).toBe(0);
  });

  it('a CL hook or a registry factory that differs from config raises drift', async () => {
    const fx = loadPoolscanFixture('base');
    const cl = fx.factories.find((f) => f.kind === 'cl')!;
    const clPool = cl.pools[0];
    const stranger = '0x1111111111111111111111111111111111111111';
    const reader = fixtureReader(fx, {
      override: (c, at) => {
        if (at !== 'e') return undefined;
        if (c.address === cl.address && c.functionName === 'getPoolSwapHook' && c.args?.[0] === clPool) return stranger;
        if (c.functionName === 'targetFactories') return [...fx.registry.target_factories, stranger];
        return undefined;
      },
    });
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    expect(scan.drift.map(driftKey).sort()).toEqual([`factory:${stranger}`, `hook:${clPool}`].sort());
    expect(poolOf(scan, clPool).fee0).toBe(BigInt(fx.pools[clPool].expect.fee0));
  });

  it("pools are read from the factory's live tape getter; a config tape that differs raises drift", async () => {
    const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('base'));
    const cfg = fixtureConfig(fx); // keeps the configured CLPoolTape
    const cl = fx.factories.find((f) => f.kind === 'cl')!;
    const moved = '0x4444444444444444444444444444444444444444';
    cl.tape = moved; // synthetic: the factory's clPoolTape() now names another tape, which holds these pools' accumulators
    const reader = fixtureReader(fx);
    const scan = await scanChainDay(reader, cfg, DAY);
    expect(scan.drift.map(driftKey)).toEqual([`tape:${cl.address}`]);
    expect(scan.drift[0].detail).toEqual({ configured: CL_TAPE, actual: moved });
    const tapeReads = reader.stats.calls.filter((c) => (c.functionName === 'accumulators' || c.functionName === 'allowedCaller') && cl.pools.includes(c.args[0] as string));
    expect(tapeReads.length).toBeGreaterThan(0);
    expect(new Set(tapeReads.map((c) => c.address))).toEqual(new Set([moved]));
    for (const a of cl.pools) expect([poolOf(scan, a).fee0, poolOf(scan, a).fee1], a).toEqual([BigInt(fx.pools[a].expect.fee0), BigInt(fx.pools[a].expect.fee1)]);
  });

  it('a falling accumulator raises negative_gross and counts 0 for that token', async () => {
    const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('base'));
    const [a, p] = Object.entries(fx.pools).find(([, q]) => registered(q) && BigInt(q.expect.fee0) > 0n && q.acc_s && q.acc_s.last !== 0)!;
    p.acc_e = { ...p.acc_e!, fee0: (BigInt(p.acc_s!.fee0) - 1n).toString() }; // synthetic: the tape was reset below its s−1 value
    const scan = await scanChainDay(fixtureReader(fx), fixtureConfig(fx), DAY);
    expect(poolOf(scan, a)).toMatchObject({ fee0: 0n, fee1: BigInt(p.expect.fee1) });
    expect(scan.drift.map(driftKey)).toEqual([`negative_gross:${a}`]);
    expect(scan.drift[0].detail).toEqual({ token: p.token0, delta: '-1' });
  });

  it('an RPC answer missing where the scan needs it fails the scan', async () => {
    const fx = loadPoolscanFixture('arc');
    const reader = fixtureReader(fx, { override: (c, at) => (at === 'e' && c.functionName === 'allPoolsLength' ? null : undefined) });
    await expect(scanChainDay(reader, fixtureConfig(fx), DAY)).rejects.toThrow(/allPoolsLength/);
  });

  it('a failed allPoolsLength at s-1 fails the scan (never counted as 0)', async () => {
    const fx = loadPoolscanFixture('arc');
    const reader = fixtureReader(fx, { override: (c, at) => (at === 's' && c.functionName === 'allPoolsLength' ? null : undefined) });
    const err = await scanChainDay(reader, fixtureConfig(fx), DAY).catch((x: unknown) => x);
    expect(err).toMatchObject({ code: 'pool_scan_read_failed' });
    expect((err as Error).message).toMatch(/allPoolsLength\(\) at s−1/);
  });

  it('a day before the chain\'s since is refused before any read', async () => {
    const fx = loadPoolscanFixture('arc');
    const reader = fixtureReader(fx);
    await expect(scanChainDay(reader, { ...fixtureConfig(fx), since: '2026-11-27' }, DAY)).rejects.toMatchObject({ code: 'pool_scan_config' });
    expect(reader.stats.blockAt).toEqual([]);
    expect(reader.stats.calls).toEqual([]);
    await expect(scanChainDay(fixtureReader(fx), { ...fixtureConfig(fx), since: DAY }, DAY)).resolves.toMatchObject({ day: DAY });
  });

  it('FeesCollected is keyed by the event gauge: one VRM serving two gauged pools that share a token counts each once', async () => {
    const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('base'));
    const gauged = Object.entries(fx.pools).filter(([, p]) => p.gauge && p.vrm && registered(p) && !p.new_in_day);
    // Two gauged pools sharing a token (synthetic: both get collected amounts on it, and the second's VRM becomes the first's).
    let pair: [[string, FxPool], [string, FxPool], string] | undefined;
    for (const [i, a] of gauged.entries()) {
      for (const b of gauged.slice(i + 1)) {
        const shared = [a[1].token0, a[1].token1].find((t) => t === b[1].token0 || t === b[1].token1);
        if (shared) { pair = [a, b, shared]; break; }
      }
      if (pair) break;
    }
    expect(pair).toBeDefined();
    const [[aAddr, a], [bAddr, b], shared] = pair!;
    const addCollected = (p: FxPool, amount: bigint) => {
      const c: [string, string] = [...(p.collected ?? ['0', '0'])] as [string, string];
      const k = p.token0 === shared ? 0 : 1;
      c[k] = (BigInt(c[k]) + amount).toString();
      p.collected = c;
    };
    addCollected(a, 1000n);
    addCollected(b, 7000n);
    b.vrm = a.vrm; // one VRM, two gauges: each FeesCollected names its own gauge in topics[1]
    const scan = await scanChainDay(fixtureReader(fx), fixtureConfig(fx), DAY);
    for (const [addr, p] of [[aAddr, a], [bAddr, b]] as const) {
      const [x0, x1] = expectedAllocator(p);
      expect(scan.allocatorByPool.get(addr), addr).toEqual(new Map([[p.token0, x0], [p.token1, x1]]));
    }
  });

  it('two gauges on one pool raise double_gauge drift; the first gauge (registry order) is kept', async () => {
    const fx: PoolscanFixture = structuredClone(loadPoolscanFixture('base'));
    const [pool, p] = Object.entries(fx.pools).find(([, q]) => q.gauge && registered(q) && !q.new_in_day)!;
    const second = '0x5555555555555555555555555555555555555555';
    fx.registry.factory_to_gauges[p.gauge_factory ?? Object.keys(fx.registry.factory_to_gauges)[0]].push(second);
    const reader = fixtureReader(fx, {
      override: (c) => {
        if (c.functionName === 'gaugeToTarget' && c.args?.[0] === second) return pool;
        if (c.functionName === 'votingRewardsManager' && c.address === second) return '0x6666666666666666666666666666666666666666';
        return undefined;
      },
    });
    const scan = await scanChainDay(reader, fixtureConfig(fx), DAY);
    expect(scan.drift.map(driftKey)).toEqual([`double_gauge:${pool}`]);
    expect(scan.drift[0].detail).toEqual({ kept: p.gauge, ignored: second });
    expect(driftDedupeKey(scan.drift[0])).toBe(`pool_scan:double_gauge:8453:${pool}`);
    expect(poolOf(scan, pool).gauge).toBe(p.gauge);
  });

  it('rejects a malformed day', async () => {
    const fx = loadPoolscanFixture('arc');
    await expect(scanChainDay(fixtureReader(fx), fixtureConfig(fx), '2026-11-31')).rejects.toThrow(/day/);
  });

  it('the fixture configs parse as a ScanConfig', () => {
    const chains = ['base', 'arc', 'ink', 'ethereum'].map((c) => loadPoolscanFixture(c).config);
    expect(() => ScanConfigSchema.parse({ chains, subsidy_creators: [], root_voter: { chain_id: 8453, address: ROOT_VOTER } })).not.toThrow();
    expect(() => ScanConfigSchema.parse({ chains, subsidy_creators: [], extra: 1 })).toThrow();
  });
});

describe('poolscan checkRootChains', () => {
  const base = (ids: number[]) =>
    fakeChainReader({
      chainId: 8453,
      blockAt: () => { throw new Error('unused'); },
      answer: (c) => (c.address === ROOT_VOTER && c.functionName === 'chains' ? ids.map(BigInt) : undefined),
    });

  it('root chains() with 9 ids raises drift chain:<id>', async () => {
    const drift = await checkRootChains(base([...AERO_CHAINS, 777]), ROOT_VOTER, AERO_CHAINS, 63_000_000n);
    expect(drift.map(driftKey)).toEqual(['chain:777']);
    expect(drift[0]).toMatchObject({ chainId: 8453, detail: { in_root_voter: true, configured: false } });
    expect(driftDedupeKey(drift[0])).toBe('pool_scan:chain:8453:777');
  });

  it('the configured 8 raise nothing; a configured chain the Voter dropped raises drift', async () => {
    expect(await checkRootChains(base(AERO_CHAINS), ROOT_VOTER, AERO_CHAINS, 1n)).toEqual([]);
    const drift = await checkRootChains(base(AERO_CHAINS.filter((c) => c !== 99901)), ROOT_VOTER, AERO_CHAINS, 1n);
    expect(drift.map(driftKey)).toEqual(['chain:99901']);
    expect(drift[0].detail).toEqual({ in_root_voter: false, configured: true });
  });

  it('reads chains() at the given block', async () => {
    const r = base(AERO_CHAINS);
    await checkRootChains(r, ROOT_VOTER, AERO_CHAINS, 42n);
    expect(r.stats.calls).toEqual([{ address: ROOT_VOTER, functionName: 'chains', args: [], block: 42n }]);
  });
});

describe('poolscan rpcChainReader (over RpcTransport)', () => {
  const FACTORY = '0x9cb220581b91b0c83223012fe69688b92ad07a76';
  const POOL = '0x4a7af46bc8abc00048c6c7920a1488daf568366c';
  const ACC = {
    lastSwapTimestamp: 1795737000, lastObservationTimestamp: 1795736000, swapCount: 1514, lastTick: -201234, intervalMaxTick: -201000,
    intervalMinTick: -202000, intervalOpenTick: -201500, volatilityCorrob: 7, cumulativeVolume0: 10n ** 30n, cumulativeVolume1: 2n * 10n ** 20n,
    intervalSwapCount: 12, cumulativeFee0: 123456789012345678901n, cumulativeFee1: 987654321n, volatilityRingHead: 3, volatilityRingCount: 9,
    cumulativeMevVolume0: 0n, cumulativeMevVolume1: 5n, nOver: 1, cumulativeMevFee0: 0n, cumulativeMevFee1: 2n,
  };

  it('encodes calls, decodes results (struct, tuple, address), and reports a revert as null', async () => {
    const seen: [string, string, bigint][] = [];
    const rpc = fakeRpc({
      genesisTs: 1_700_000_000, latest: 1_000_000n, blockTimeSec: 2,
      dataCalls: (address, data, block) => {
        if (address === FACTORY) {
          const { functionName } = decodeFunctionData({ abi: FACTORY_ABI, data: data as `0x${string}` });
          seen.push([address, functionName, block]);
          if (functionName === 'allPoolsLength') return encodeFunctionResult({ abi: FACTORY_ABI, functionName, result: 706n });
          return null; // e.g. poolTape() on a CL factory reverts
        }
        if (address === CL_TAPE) {
          const { functionName, args } = decodeFunctionData({ abi: CL_POOL_TAPE_ABI, data: data as `0x${string}` });
          seen.push([address, `${functionName}(${String(args?.[0]).toLowerCase()})`, block]);
          return encodeFunctionResult({ abi: CL_POOL_TAPE_ABI, functionName: 'accumulators', result: ACC });
        }
        if (address === POOL) return encodeFunctionResult({ abi: POOL_ABI, functionName: 'gaugeFees', result: [11n, 22n] });
        return null;
      },
    });
    const reader = rpcChainReader(rpc, 8453);
    expect(reader.chainId).toBe(8453);
    const out = await reader.call(
      [
        { address: FACTORY, abi: FACTORY_ABI, functionName: 'allPoolsLength' },
        { address: CL_TAPE, abi: CL_POOL_TAPE_ABI, functionName: 'accumulators', args: [POOL] },
        { address: POOL, abi: POOL_ABI, functionName: 'gaugeFees' },
        { address: FACTORY, abi: FACTORY_ABI, functionName: 'poolTape' },
      ],
      123n,
    );
    expect(out).toEqual([706n, ACC, [11n, 22n], null]);
    expect(seen).toEqual([[FACTORY, 'allPoolsLength', 123n], [CL_TAPE, `accumulators(${POOL})`, 123n], [FACTORY, 'poolTape', 123n]]);
    expect(rpc.stats.multicallData).toBe(1);
    expect(await reader.call([], 1n)).toEqual([]);
    expect(rpc.stats.multicallData).toBe(1); // an empty batch sends nothing
  });

  it('chunks at 400 inner calls per eth_call', async () => {
    const rpc = fakeRpc({
      genesisTs: 1_700_000_000, latest: 10n,
      dataCalls: () => encodeFunctionResult({ abi: ROOT_VOTER_ABI, functionName: 'chains', result: [8453n] }),
    });
    const reader = rpcChainReader(rpc, 8453);
    const calls = Array.from({ length: 801 }, () => ({ address: ROOT_VOTER, abi: ROOT_VOTER_ABI, functionName: 'chains' }));
    const out = await reader.call(calls, 5n);
    expect(out).toHaveLength(801);
    expect(out[800]).toEqual([8453n]);
    expect(rpc.stats.multicallData).toBe(3);
  });

  it('blockAt is the first block at or after the timestamp (firstBlockAtOrAfter)', async () => {
    const rpc = fakeRpc({ genesisTs: 1_700_000_000, latest: 1_000_000n, blockTimeSec: 2 });
    const reader = rpcChainReader(rpc, 8453);
    const ts = 1_700_000_000 + 2 * 500_000 + 1; // between blocks 500,000 and 500,001
    expect(await reader.blockAt(ts)).toEqual({ number: 500_001n, timestamp: 1_700_000_000 + 2 * 500_001 });
    expect(await reader.blockAt(1_700_000_000 + 2 * 700_000)).toEqual({ number: 700_000n, timestamp: 1_700_000_000 + 2 * 700_000 });
  });

  it('logs pass the address list and topic0 to getLogs', async () => {
    const vrm = '0x1085b4f49dc776a04a9467b57c271fe4c157789a';
    const log = { address: vrm, topics: [FEES_COLLECTED_TOPIC, pad('0x01'), pad('0x02')], data: pad('0x05'), logIndex: 0, blockNumber: 7n };
    const asked: unknown[] = [];
    const rpc = fakeRpc({ genesisTs: 0, latest: 100n, maxLogRange: 1_000n, logs: (q) => (asked.push(q), [log]) });
    const reader = rpcChainReader(rpc, 8453);
    expect(await reader.logs([vrm], FEES_COLLECTED_TOPIC, 5n, 9n)).toEqual([log]);
    expect(asked).toEqual([{ address: [vrm], topic0: FEES_COLLECTED_TOPIC, fromBlock: 5n, toBlock: 9n }]);
    await expect(reader.logs([], FEES_COLLECTED_TOPIC, 5n, 9n)).resolves.toEqual([]);
    expect(asked).toHaveLength(1); // never an empty address list (Task 2 deferred M-3)
  });

  it('refuses a transport without multicallData or getLogs', async () => {
    const { multicallData: _m, getLogs: _g, ...bare } = fakeRpc({ genesisTs: 0, latest: 10n });
    const reader = rpcChainReader(bare, 8453);
    await expect(reader.call([{ address: ROOT_VOTER, abi: ROOT_VOTER_ABI, functionName: 'chains' }], 1n)).rejects.toThrow(/multicallData/);
    await expect(reader.logs([ROOT_VOTER], FEES_COLLECTED_TOPIC, 1n, 2n)).rejects.toThrow(/getLogs/);
  });
});
