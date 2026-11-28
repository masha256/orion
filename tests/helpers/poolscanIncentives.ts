import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TypedCall } from '../../src/ingest/poolscan/reader.js';
import { ChainScanSchema, type ChainScan } from '../../src/ingest/poolscan/types.js';
import { fakeChainReader, type FakeChainReader } from './fakeChainReader.js';

/**
 * The incentive fixture (tests/fixtures/poolscan/incentives.json, trimmed by trim_incentives.py from the R4 scoping
 * incentives-data files) served as fake ChainReaders: LeafVoter → FactoryRegistry → gauges → VRMs (discovery), the VRM
 * program getters, and the VRM supply history the zero-allocation seconds come from.
 */

export interface FxProgram {
  chain: string;
  vrm: string;
  id: number;
  token: string;
  amount: string;
  rate: string;
  start: number;
  end: number;
  creator: string;
  symbol: string;
  decimals: number;
}
export interface FxDiscovery {
  chain_id: number;
  factory_registry: string;
  gauge_factories: string[];
  /** gauge factory → [gauge, VRM] pairs (FactoryRegistry.factoryToGauges, gauge.votingRewardsManager()). */
  gauges: Record<string, [string, string][]>;
  scoping_vrms: number;
}
export interface FxExpectRow {
  chain: string;
  day: string;
  vrm: string;
  id: number;
  class: 'third_party' | 'foundation_subsidy' | 'aero_admin_safe_42255' | 'foundation_signer_safe_80f7';
  /** Token units (scoping floats): rate × overlap, and rate × (overlap − zero-allocation seconds). */
  streamed: number;
  allocated: number;
  price_usd: number;
}
export interface IncentivesFixture {
  leaf_voter: string;
  chain_ids: Record<string, number>;
  discovery: Record<string, FxDiscovery>;
  programs: FxProgram[];
  /** `chain|vrm` → incentiveCount(). */
  incentive_counts: Record<string, number>;
  /** `chain|vrm|t` → [Z(t) cumulative zero-allocation seconds, getPriorSupplyIndex(t), supplyAt(t − 1)]. */
  zero_points: Record<string, [number, number, string]>;
  expect: { program_days: FxExpectRow[]; daily_2026_11_26: Record<string, Record<string, number> | null> };
}

let cached: IncentivesFixture | null = null;
export function loadIncentivesFixture(): IncentivesFixture {
  cached ??= JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'poolscan', 'incentives.json'), 'utf8')) as IncentivesFixture;
  return cached;
}

/** A ChainScan for discovery: only `leaf_voter` / `factory_registry` / `chain_id` matter; the factory is a placeholder. */
export function incentivesConfig(fx: IncentivesFixture, chain: string): ChainScan {
  const d = fx.discovery[chain];
  return ChainScanSchema.parse({
    chain_id: d.chain_id,
    factories: [{ address: '0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2', kind: 'v2_volatile', tape: '0x34bdD64B19D8631F936c2D07F19AAa6B83515992' }],
    factory_registry: d.factory_registry,
    leaf_voter: fx.leaf_voter,
    anchors: [],
  });
}

interface Point { bias: bigint; slope: bigint; ts: number; permanentStakeBalance: bigint; zeroSupplySeconds: number }

/**
 * `globalRewardPointHistory(idx)` per `chain|vrm|idx`, derived from the scoping's Z(t) points:
 * - a point seen with supplyAt(t − 1) > 0: zeroSupplySeconds = Z(t) (measured: Z adds nothing past a point with supply);
 *   SYNTHETIC ts = the earliest t that point answers for (any ts ≤ t gives the same Z), bias/slope 0 and
 *   permanentStakeBalance = that supply (only the "point had supply" bit is ever read).
 * - a point seen only with supplyAt(t − 1) = 0 (in the fixture: OP 0x2735…'s first point, idx 1): zeroSupplySeconds 0
 *   (the contract's first point always starts at 0) and ts = t − Z(t), which every such t agrees on; bias and
 *   permanentStakeBalance 0 (scoping §2: no zero-supply point whose last checkpoint still had supply).
 */
export function derivePoints(fx: IncentivesFixture): Map<string, Point> {
  const by = new Map<string, { t: number; z: number; supply: bigint }[]>();
  for (const [k, [z, idx, supply]] of Object.entries(fx.zero_points)) {
    const [chain, vrm, t] = k.split('|');
    const key = `${chain}|${vrm}|${idx}`;
    by.set(key, [...(by.get(key) ?? []), { t: Number(t), z, supply: BigInt(supply) }]);
  }
  const out = new Map<string, Point>();
  for (const [key, seen] of by) {
    const withSupply = seen.filter((s) => s.supply > 0n);
    if (withSupply.length > 0) {
      if (withSupply.length !== seen.length || new Set(withSupply.map((s) => s.z)).size !== 1) throw new Error(`fixture: inconsistent point ${key}`);
      out.set(key, { bias: 0n, slope: 0n, ts: Math.min(...seen.map((s) => s.t)), permanentStakeBalance: withSupply[0].supply, zeroSupplySeconds: withSupply[0].z });
    } else {
      if (!key.endsWith('|1') || new Set(seen.map((s) => s.t - s.z)).size !== 1) throw new Error(`fixture: zero-supply point ${key} is not a consistent first point`);
      out.set(key, { bias: 0n, slope: 0n, ts: seen[0].t - seen[0].z, permanentStakeBalance: 0n, zeroSupplySeconds: 0 });
    }
  }
  return out;
}

export interface IncentivesReaderOptions {
  /** Return non-undefined to replace the fixture's answer (null = the call reverts). */
  override?: (call: TypedCall, block: bigint) => unknown;
  /** Extra supply history: `vrm|t` → [idx, supplyAt(t − 1)], and `vrm|idx` → point (synthetic tests). */
  zero?: Record<string, [number, bigint]>;
  points?: Record<string, Point>;
  /** Synthetic supplyAt(ts) for a VRM (checked before `zero` and the fixture); undefined = no answer here. */
  supply?: (vrm: string, ts: number) => bigint | undefined;
}

/** A fake ChainReader for one fixture chain: discovery getters, VRM programs and supply history; anything else is undefined. */
export function incentivesReader(fx: IncentivesFixture, chain: string, o: IncentivesReaderOptions = {}): FakeChainReader {
  const d = fx.discovery[chain];
  const points = derivePoints(fx);
  const vrmOf = new Map(Object.values(d.gauges).flat().map(([g, v]) => [g, v]));
  const programs = new Map(fx.programs.filter((p) => p.chain === chain).map((p) => [`${p.vrm}|${p.id}`, p]));
  const lc = (a: unknown) => String(a).toLowerCase();
  return fakeChainReader({
    chainId: d.chain_id,
    blockAt: () => {
      throw new Error('incentives never search blocks');
    },
    answer(call, block) {
      const hit = o.override?.(call, block);
      if (hit !== undefined) return hit;
      const at = lc(call.address);
      const arg = call.args?.[0];
      switch (call.functionName) {
        case 'FACTORY_REGISTRY':
          return at === fx.leaf_voter ? d.factory_registry : undefined;
        case 'gaugeFactories':
          return at === d.factory_registry ? d.gauge_factories : undefined;
        case 'factoryToGauges':
          return at === d.factory_registry ? (d.gauges[lc(arg)] ?? []).map(([g]) => g) : undefined;
        case 'votingRewardsManager':
          return vrmOf.get(at);
        case 'incentiveCount': {
          const n = fx.incentive_counts[`${chain}|${at}`];
          return n === undefined ? undefined : BigInt(n);
        }
        case 'incentive': {
          const p = programs.get(`${at}|${Number(arg)}`);
          return p && { token: p.token, amount: BigInt(p.amount), rate: BigInt(p.rate), start: p.start, end: p.end, creator: p.creator };
        }
        case 'getPriorSupplyIndex': {
          const syn = o.zero?.[`${at}|${Number(arg)}`];
          if (syn) return BigInt(syn[0]);
          const z = fx.zero_points[`${chain}|${at}|${Number(arg)}`];
          return z && BigInt(z[1]);
        }
        case 'supplyAt': {
          // The engine asks supplyAt(t − 1); the fixture keys the answer by t.
          const fn = o.supply?.(at, Number(arg));
          if (fn !== undefined) return fn;
          const t = Number(arg) + 1;
          const syn = o.zero?.[`${at}|${t}`];
          if (syn) return syn[1];
          const z = fx.zero_points[`${chain}|${at}|${t}`];
          return z && BigInt(z[2]);
        }
        case 'globalRewardPointHistory':
          return o.points?.[`${at}|${Number(arg)}`] ?? points.get(`${chain}|${at}|${Number(arg)}`);
        default:
          return undefined;
      }
    },
  });
}

/** Fixture programs of one chain in the engine's Program shape. */
export function fixturePrograms(fx: IncentivesFixture, chain: string, filter: (p: FxProgram) => boolean = () => true) {
  return fx.programs
    .filter((p) => p.chain === chain && filter(p))
    .map((p) => ({ vrm: p.vrm, id: p.id, token: p.token, rate: BigInt(p.rate), start: p.start, end: p.end, creator: p.creator }));
}

export const dayStartSec = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 1000;
