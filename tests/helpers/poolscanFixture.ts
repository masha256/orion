import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pad } from 'viem';
import { FEES_COLLECTED_TOPIC } from '../../src/ingest/poolscan/abi.js';
import type { TypedCall } from '../../src/ingest/poolscan/reader.js';
import { ChainScanSchema, type ChainScan } from '../../src/ingest/poolscan/types.js';
import type { BlockLog } from '../../src/ingest/transport/rpc.js';
import { fakeChainReader, type FakeChainReader } from './fakeChainReader.js';

/**
 * The poolscan fixtures (tests/fixtures/poolscan/<chain>-2026-11-26.json, trimmed from the R4 scoping raw day files by
 * trim.py there) served as a fake ChainReader. The scoping read at its own s/e; the fake answers blockAt(D) = s+1 and
 * blockAt(D+1) = e+1, so the engine's s−1/e−1 reads land on exactly the state the scoping recorded.
 */

const ZERO = '0x0000000000000000000000000000000000000000';

export interface FxAcc { fee0: string; fee1: string; last: number; swaps: number }
export interface FxPool {
  factory: string;
  token0: string;
  token1: string;
  allowed_caller: string;
  /** Synthetic: `allowedCaller` at s−1 when it differs from e−1 (a pool registered during the day); default `allowed_caller`. */
  allowed_caller_s?: string;
  hook?: string;
  acc_s: FxAcc | null;
  acc_e: FxAcc | null;
  expect: { fee0: string; fee1: string };
  new_in_day: boolean;
  gauge?: string;
  gauge_factory?: string;
  vrm?: string;
  emission_cap?: string;
  pend_s?: [string, string] | null;
  pend_e?: [string, string] | null;
  collected?: [string, string] | null;
}
export interface FxFactory { address: string; kind: string; tape: string; hook?: string; raw_kind: string; length_s: number; pools: string[] }
export interface PoolscanFixture {
  chain: string;
  day: string;
  blocks: { s: number; e: number };
  scoping_counts: { pools: number; registered: number; gauged: number; fees_collected_logs: number };
  config: unknown;
  registry: { target_factories: string[]; gauge_factories: string[]; factory_to_gauges: Record<string, string[]> };
  factories: FxFactory[];
  pools: Record<string, FxPool>;
}

export function loadPoolscanFixture(chain: string, day = '2026-11-26'): PoolscanFixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'poolscan', `${chain}-${day}.json`), 'utf8')) as PoolscanFixture;
}

export function fixtureConfig(fx: PoolscanFixture): ChainScan {
  return ChainScanSchema.parse(fx.config);
}

export const dayStartSec = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 1000;

/** The synthetic FeesCollected logs: one per (VRM, token) with a non-zero `collected` sum, in the first block of the day. */
export function fixtureLogs(fx: PoolscanFixture): BlockLog[] {
  const out: BlockLog[] = [];
  let i = 0;
  for (const p of Object.values(fx.pools)) {
    if (!p.vrm || !p.gauge || !p.collected) continue;
    [p.token0, p.token1].forEach((token, k) => {
      const amount = BigInt(p.collected![k]);
      if (amount === 0n) return;
      out.push({
        address: p.vrm!,
        topics: [FEES_COLLECTED_TOPIC, pad(p.gauge as `0x${string}`), pad(token as `0x${string}`)],
        data: pad(`0x${amount.toString(16)}`),
        logIndex: i++,
        blockNumber: BigInt(fx.blocks.s + 1),
      });
    });
  }
  return out;
}

function accValue(kind: 'v2' | 'cl', a: FxAcc | null): unknown {
  const fee0 = a ? BigInt(a.fee0) : 0n;
  const fee1 = a ? BigInt(a.fee1) : 0n;
  const last = a ? a.last : 0;
  const swaps = a ? a.swaps : 0;
  // Only fee0/fee1/lastSwapTimestamp/swapCount were kept by the scoping; the other words are 0 here.
  if (kind === 'v2') return [fee0, fee1, 0n, 0n, 0n, 0n, 0n, 0n, last, swaps] as const;
  return {
    lastSwapTimestamp: last, lastObservationTimestamp: 0, swapCount: swaps, lastTick: 0, intervalMaxTick: 0, intervalMinTick: 0,
    intervalOpenTick: 0, volatilityCorrob: 0, cumulativeVolume0: 0n, cumulativeVolume1: 0n, intervalSwapCount: 0,
    cumulativeFee0: fee0, cumulativeFee1: fee1, volatilityRingHead: 0, volatilityRingCount: 0, cumulativeMevVolume0: 0n,
    cumulativeMevVolume1: 0n, nOver: 0, cumulativeMevFee0: 0n, cumulativeMevFee1: 0n,
  };
}

export interface FixtureReaderOptions {
  /** Answer this call first (return undefined to fall through to the fixture). */
  override?(call: TypedCall, at: 's' | 'e'): unknown;
  /** Extra logs on top of the fixture's. */
  logs?: BlockLog[];
}

/** A fake ChainReader answering from one fixture. Calls at any block but the scoping's s and e fail the test. */
export function fixtureReader(fx: PoolscanFixture, opts: FixtureReaderOptions = {}): FakeChainReader {
  const t0 = dayStartSec(fx.day);
  const chainId = (fx.config as { chain_id: number }).chain_id;
  const factories = new Map(fx.factories.map((f) => [f.address, f]));
  const tapes = new Map<string, 'v2' | 'cl'>(fx.factories.map((f) => [f.tape, f.kind === 'cl' ? 'cl' : 'v2']));
  const gaugeToPool = new Map(Object.entries(fx.pools).filter(([, p]) => p.gauge).map(([a, p]) => [p.gauge!, a]));
  const vrmOf = new Map(Object.values(fx.pools).filter((p) => p.gauge).map((p) => [p.gauge!, p.vrm!]));
  const logs = [...fixtureLogs(fx), ...(opts.logs ?? [])];
  const registry = (fx.config as { factory_registry: string }).factory_registry;
  return fakeChainReader({
    chainId,
    blockAt(ts) {
      if (ts === t0) return { number: BigInt(fx.blocks.s + 1), timestamp: ts };
      if (ts === t0 + 86_400) return { number: BigInt(fx.blocks.e + 1), timestamp: ts };
      throw new Error(`fixture has no block for ${ts}`);
    },
    answer(c, block) {
      const at = block === BigInt(fx.blocks.s) ? 's' : block === BigInt(fx.blocks.e) ? 'e' : null;
      if (at === null) throw new Error(`fixture read at block ${block}: only ${fx.blocks.s} / ${fx.blocks.e} were recorded`);
      const o = opts.override?.(c, at);
      if (o !== undefined) return o;
      const addr = c.address.toLowerCase();
      const arg0 = typeof c.args?.[0] === 'string' ? (c.args[0] as string).toLowerCase() : c.args?.[0];
      const f = factories.get(addr);
      if (f) {
        const len = at === 's' ? f.length_s : f.pools.length;
        switch (c.functionName) {
          case 'allPoolsLength': return BigInt(len);
          case 'allPools': return Number(arg0) < len ? f.pools[Number(arg0)] : null;
          case 'poolTape': return f.kind === 'cl' ? null : f.tape;
          case 'clPoolTape': return f.kind === 'cl' ? f.tape : null;
          case 'getPoolSwapHook': return fx.pools[arg0 as string]?.hook ?? ZERO;
        }
      }
      if (addr === registry) {
        switch (c.functionName) {
          case 'targetFactories': return fx.registry.target_factories;
          case 'gaugeFactories': return fx.registry.gauge_factories;
          case 'factoryToGauges': return fx.registry.factory_to_gauges[arg0 as string] ?? [];
          case 'gaugeToTarget': return gaugeToPool.get(arg0 as string) ?? ZERO;
        }
      }
      const tapeKind = tapes.get(addr);
      if (tapeKind) {
        const p = fx.pools[arg0 as string];
        // A tape answers only for the pools of the factories that record on it; any other pool is unknown to it.
        const mine = p !== undefined && factories.get(p.factory)?.tape === addr;
        if (c.functionName === 'allowedCaller') return mine ? (at === 's' ? (p.allowed_caller_s ?? p.allowed_caller) : p.allowed_caller) : ZERO;
        if (c.functionName === 'accumulators') return accValue(tapeKind, mine ? (at === 's' ? p.acc_s : p.acc_e) : null);
      }
      const pool = fx.pools[addr];
      if (pool) {
        const pend = (v: [string, string] | null | undefined) => (v ? [BigInt(v[0]), BigInt(v[1])] : [0n, 0n]);
        switch (c.functionName) {
          case 'token0': return pool.token0;
          case 'token1': return pool.token1;
          case 'gaugeFees': return pend(at === 's' ? pool.pend_s : pool.pend_e);
          case 'pendingFees': return arg0 === pool.gauge ? pend(at === 's' ? pool.pend_s : pool.pend_e) : [0n, 0n];
        }
      }
      if (c.functionName === 'votingRewardsManager' && vrmOf.has(addr)) return vrmOf.get(addr);
      return undefined;
    },
    logs(address, topic0, from, to) {
      const want = new Set(address.map((a) => a.toLowerCase()));
      return logs.filter((l) => want.has(l.address) && l.topics[0] === topic0 && l.blockNumber >= from && l.blockNumber <= to);
    },
  });
}
