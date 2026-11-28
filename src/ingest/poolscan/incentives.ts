import { OrionError } from '../../types.js';
import { MULTICALL_DATA_CHUNK } from '../transport/rpc.js';
import { FACTORY_REGISTRY_ABI, GAUGE_ABI, LEAF_VOTER_ABI, VRM_ABI } from './abi.js';
import type { ChainReader, TypedCall } from './reader.js';
import type { ChainScan, TokenAmounts } from './types.js';

/**
 * VRM incentive streams (Phase 3 R4, spec §3 "Incentives" / §4.1 step 5; method: phase3-r4-scoping
 * incentives-and-events.md §1-§3, mirroring metadex-public V3/src RewardsLogicLibrary._zeroSupplySecondsInRange).
 *
 * - Discovery is state only: LeafVoter.FACTORY_REGISTRY() → FactoryRegistry.gaugeFactories() → factoryToGauges(gf) →
 *   gauge.votingRewardsManager(). VotingRewardsFactory keeps no registry, so this is the registry (scoping path B).
 * - Programs are immutable once created (token, amount, rate, start, end, creator; rate = amount × 1e18 / duration):
 *   read once per run, at the run's latest scanned day, ids 1..incentiveCount() per VRM.
 * - Streamed for day D, per program: rate × (overlap − zero-allocation seconds within the overlap) / 1e18, where
 *   overlap = [max(start, D 00:00Z), min(end, D+1 00:00Z)). That is the accrual allocators can claim; the rest is what
 *   `sweep()` would return to the creator. Never the raw overlap.
 * - Zero-allocation seconds come from a cumulative Z(t) per VRM, computed as the contract will store it once the
 *   checkpoints up to t exist: idx = getPriorSupplyIndex(t), pt = globalRewardPointHistory(idx), Z(t) =
 *   pt.zeroSupplySeconds + the zero intervals since pt. The contract writes the weekly checkpoints it skipped lazily, at
 *   the next checkpoint, and prices each interval [p, q) between pt, the week boundaries w (multiples of WEEK) and t as
 *   zero iff supply(q − 1) == 0 (VotingRewardsManager._createGlobalRewardPoints). So with supplyAt(t − 1) == 0 the
 *   engine reads supplyAt(w − 1) at every skipped boundary and adds the zero intervals only; with supplyAt(t − 1) > 0 it
 *   adds nothing (no checkpoint → supply only decays → it was above 0 all along). Lock ends are week-aligned, so when a
 *   VRM's last allocation expires the supply hits 0 exactly at a boundary w and only [w, t) counts, never [pt.ts, w).
 *   (incentives-and-events.md §2's shortcut "+ (t − pt.ts)" is this formula without the skipped boundaries.)
 *   Seconds in [a, b) = Z(b) − Z(a). Before the VRM's first checkpoint (idx 0) every second is zero-allocation (the
 *   contract's leading partial with index 0), so Z(t) = t − point(1).ts there (t when there is no checkpoint at all).
 * - Ambiguous: a zero interval whose start still had supply (the decay reached 0 inside it; with week-aligned lock ends
 *   only rounding gets there). The contract prices the whole interval as zero, but a program bound inside it is priced
 *   by `_zeroSupplySecondsInRange` from the clipped end, so Z(b) − Z(a) can overcount. Such points are listed in
 *   `ambiguous` (the caller warns) and that VRM's zero seconds are clamped to [0, overlap]; the scoping saw none in
 *   1,904 points.
 * - The supply history is read at e − 1 (the day's last block); every t ≤ D+1 00:00Z. Checkpoints written later can
 *   only add the skipped weekly points, which the boundary reads above already price the contract's way, so the
 *   answer is the one a later read would give.
 * - Class: `protocol_subsidy` iff the creator is in the subsidy list (case-insensitive), else `vote_incentives`.
 *
 * A failed read (revert or undecodable return) of anything the result depends on throws OrionError
 * `pool_scan_read_failed` naming the chain, day or block, contract and read. A supply history that yields negative or
 * more-than-overlap zero seconds (with no ambiguous point on that VRM) throws `pool_scan_inconsistent`.
 */

export interface Program {
  vrm: string;
  id: number;
  token: string;
  /** Tokens per second × 1e18 (IncentiveProgram.rate). */
  rate: bigint;
  /** Unix seconds; the program streams over [start, end). */
  start: number;
  end: number;
  creator: string;
}

export type IncentiveClass = 'vote_incentives' | 'protocol_subsidy';

export interface StreamedDay {
  /** Allocator-earned raw token amounts by class, by lowercased token (tokens with a zero amount are omitted). */
  byClass: Record<IncentiveClass, TokenAmounts>;
  /** Programs whose [start, end) overlaps the day (whether or not anything was allocated). */
  programsActive: number;
  /** Zero-supply points whose zero interval started with supply (see above); counted the contract's way, clamped. */
  ambiguous: { vrm: string; t: number }[];
  /** calls = inner eth_calls; requests = eth_call chunks. */
  rpc: { calls: number; requests: number };
}

const PRECISION = 10n ** 18n; // metadex-public V3/src/libraries/ProtocolConstants.sol PRECISION
const DAY = 86_400;
const WEEK = 7 * DAY; // ProtocolConstants.WEEK; epochs start at multiples of it (ProtocolTimeLibrary.epochStart)

/** Every VRM of the chain's gauges, lowercased, sorted, deduplicated; all reads at `block` (state only, no logs). */
export async function discoverVrms(reader: ChainReader, cfg: ChainScan, block: bigint): Promise<string[]> {
  if (reader.chainId !== cfg.chain_id) throw new OrionError('pool_scan_config', `reader is chain ${reader.chainId}, config is chain ${cfg.chain_id}`);
  const where = `chain ${cfg.chain_id} block ${block}`;
  const need = <T>(v: T | null | undefined, what: string): T => {
    if (v === null || v === undefined) throw new OrionError('pool_scan_read_failed', `${where}: ${what} failed`);
    return v;
  };
  const voter = lc(cfg.leaf_voter);
  const [reg] = await reader.call<string>([{ address: voter, abi: LEAF_VOTER_ABI, functionName: 'FACTORY_REGISTRY' }], block);
  const registry = lc(need(reg, `${voter}.FACTORY_REGISTRY()`));
  // The pool scan reads gauges from the configured registry: a LeafVoter on another registry means the config is stale.
  if (registry !== lc(cfg.factory_registry)) {
    throw new OrionError('pool_scan_config', `${where}: ${voter}.FACTORY_REGISTRY() is ${registry}, config factory_registry is ${lc(cfg.factory_registry)}`);
  }
  const [gfs] = await reader.call<readonly string[]>([{ address: registry, abi: FACTORY_REGISTRY_ABI, functionName: 'gaugeFactories' }], block);
  const gaugeFactories = need(gfs, `${registry}.gaugeFactories()`).map(lc);
  const lists = await reader.call<readonly string[]>(
    gaugeFactories.map((gf) => ({ address: registry, abi: FACTORY_REGISTRY_ABI, functionName: 'factoryToGauges', args: [gf] })),
    block,
  );
  const gauges = [...new Set(gaugeFactories.flatMap((gf, i) => need(lists[i], `${registry}.factoryToGauges(${gf})`).map(lc)))];
  const vrms = await reader.call<string>(gauges.map((g) => ({ address: g, abi: GAUGE_ABI, functionName: 'votingRewardsManager' })), block);
  return [...new Set(gauges.map((g, i) => lc(need(vrms[i], `${g}.votingRewardsManager()`))))].sort();
}

/** Every program of every VRM (ids 1..incentiveCount()), read at `block`. */
export async function programs(reader: ChainReader, vrms: string[], block: bigint): Promise<Program[]> {
  const where = `chain ${reader.chainId} block ${block}`;
  const need = <T>(v: T | null | undefined, what: string): T => {
    if (v === null || v === undefined) throw new OrionError('pool_scan_read_failed', `${where}: ${what} failed`);
    return v;
  };
  const list = [...new Set(vrms.map(lc))];
  if (list.length === 0) return [];
  const counts = await reader.call<bigint>(list.map((v) => ({ address: v, abi: VRM_ABI, functionName: 'incentiveCount' })), block);
  const ids = list.flatMap((vrm, i) => {
    const n = Number(need(counts[i], `${vrm}.incentiveCount()`));
    return Array.from({ length: n }, (_, k) => ({ vrm, id: k + 1 }));
  });
  if (ids.length === 0) return [];
  const raw = await reader.call<{ token: string; rate: bigint; start: number | bigint; end: number | bigint; creator: string }>(
    ids.map(({ vrm, id }) => ({ address: vrm, abi: VRM_ABI, functionName: 'incentive', args: [BigInt(id)] })),
    block,
  );
  return ids.map(({ vrm, id }, i) => {
    const p = need(raw[i], `${vrm}.incentive(${id})`);
    return { vrm, id, token: lc(p.token), rate: BigInt(p.rate), start: Number(p.start), end: Number(p.end), creator: lc(p.creator) };
  });
}

/** One chain's allocator-earned incentive streams for UTC day `day` (programs from `programs()`, on this chain). */
export async function streamedDay(
  reader: ChainReader,
  progs: Program[],
  day: string,
  blocks: { s: bigint; e: bigint },
  subsidyCreators: readonly string[],
): Promise<StreamedDay> {
  const t0 = dayStartSec(day);
  const t1 = t0 + DAY;
  const at = blocks.e - 1n;
  const where = `chain ${reader.chainId} ${day}`;
  const rpc = { calls: 0, requests: 0 };
  const read = async <T>(calls: TypedCall[]): Promise<(T | null)[]> => {
    if (calls.length === 0) return [];
    rpc.calls += calls.length;
    rpc.requests += Math.ceil(calls.length / MULTICALL_DATA_CHUNK);
    return reader.call<T>(calls, at);
  };
  const need = <T>(v: T | null | undefined, what: string): T => {
    if (v === null || v === undefined) throw new OrionError('pool_scan_read_failed', `${where}: ${what} at e−1 failed`);
    return v;
  };

  const active = progs
    .map((p) => ({ ...p, vrm: lc(p.vrm), token: lc(p.token), a: Math.max(p.start, t0), b: Math.min(p.end, t1) }))
    .filter((p) => p.a < p.b);
  const byClass: Record<IncentiveClass, TokenAmounts> = { vote_incentives: new Map(), protocol_subsidy: new Map() };
  const ambiguous: StreamedDay['ambiguous'] = [];
  if (active.length === 0) return { byClass, programsActive: 0, ambiguous, rpc };

  // Round 1: per (VRM, overlap bound t) the checkpoint index at or before t and the supply at t − 1.
  const pointKeys = [...new Set(active.flatMap((p) => [`${p.vrm}|${p.a}`, `${p.vrm}|${p.b}`]))].map((k) => {
    const [vrm, t] = k.split('|');
    return { vrm, t: Number(t) };
  });
  const r1 = await read<bigint>(
    pointKeys.flatMap(({ vrm, t }): TypedCall[] => [
      { address: vrm, abi: VRM_ABI, functionName: 'getPriorSupplyIndex', args: [BigInt(t)] },
      { address: vrm, abi: VRM_ABI, functionName: 'supplyAt', args: [BigInt(t - 1)] },
    ]),
  );
  const seen = pointKeys.map(({ vrm, t }, i) => ({
    vrm,
    t,
    idx: BigInt(need(r1[2 * i], `${vrm}.getPriorSupplyIndex(${t})`)),
    supply: BigInt(need(r1[2 * i + 1], `${vrm}.supplyAt(${t - 1})`)),
  }));

  // Round 2: each referenced checkpoint (index 1 too where t precedes the first checkpoint).
  const wanted = [...new Set(seen.map((s) => `${s.vrm}|${s.idx === 0n ? 1n : s.idx}`))];
  const r2 = await read<GlobalPointOut>(
    wanted.map((k) => {
      const [vrm, idx] = k.split('|');
      return { address: vrm, abi: VRM_ABI, functionName: 'globalRewardPointHistory', args: [BigInt(idx)] };
    }),
  );
  const point = new Map(wanted.map((k, i) => [k, need(r2[i], `${k.split('|')[0]}.globalRewardPointHistory(${k.split('|')[1]})`)]));

  // Round 3 (zero-supply points only): the contract writes the weekly checkpoints skipped since pt lazily, at the next
  // checkpoint, pricing each interval [p, q) as zero iff supply(q − 1) == 0 (VotingRewardsManager._createGlobalRewardPoints,
  // .sol:333-381). Mirror that: for every week boundary w with pt.ts < w < t read supplyAt(w − 1), and supplyAt(w) (the
  // supply at the start of the interval after w, for the ambiguity check). supplyAt walks the same weekly slope changes
  // from pt that the backfill loop does (RewardsLogicLibrary._supplyAt), so the answer is the one the contract will store.
  // A supply above 0 at t − 1 needs no boundaries: without a checkpoint supply only decays, so it was above 0 all along.
  const backfill = seen
    .filter((s) => s.idx !== 0n && s.supply === 0n)
    .map((s) => {
      const pt = point.get(`${s.vrm}|${s.idx}`)!;
      const ts = Number(pt.ts);
      const weeks: number[] = [];
      for (let w = ts - (ts % WEEK) + WEEK; w < s.t; w += WEEK) weeks.push(w);
      return { s, weeks };
    });
  const r3 = await read<bigint>(
    backfill.flatMap(({ s, weeks }) =>
      weeks.flatMap((w): TypedCall[] => [
        { address: s.vrm, abi: VRM_ABI, functionName: 'supplyAt', args: [BigInt(w - 1)] },
        { address: s.vrm, abi: VRM_ABI, functionName: 'supplyAt', args: [BigInt(w)] },
      ]),
    ),
  );
  const weekly = new Map<string, { w: number; before: bigint; at: bigint }[]>();
  let k = 0;
  for (const { s, weeks } of backfill) {
    weekly.set(
      `${s.vrm}|${s.t}`,
      weeks.map((w) => {
        const before = BigInt(need(r3[k++], `${s.vrm}.supplyAt(${w - 1})`));
        const at = BigInt(need(r3[k++], `${s.vrm}.supplyAt(${w})`));
        return { w, before, at };
      }),
    );
  }

  const cum = new Map<string, number>(); // `${vrm}|${t}` → Z(t)
  const ambiguousVrms = new Set<string>();
  for (const s of seen) {
    let z: number;
    if (s.idx === 0n) {
      const first = point.get(`${s.vrm}|1`)!;
      const ts1 = Number(first.ts);
      z = ts1 === 0 ? s.t : s.t - ts1;
    } else {
      const pt = point.get(`${s.vrm}|${s.idx}`)!;
      const ts = Number(pt.ts);
      if (ts > s.t) throw new OrionError('pool_scan_inconsistent', `${where}: ${s.vrm}.getPriorSupplyIndex(${s.t}) = ${s.idx} has ts ${ts} > ${s.t}`);
      z = Number(pt.zeroSupplySeconds);
      if (s.supply === 0n) {
        // Intervals [pt.ts, w1), [w1, w2), …, [wn, t): each is zero iff the supply at its last second is 0.
        let start = ts;
        let startSupply = BigInt(pt.bias) + BigInt(pt.permanentStakeBalance);
        let firstZero = true;
        const close = (end: number, endZero: boolean, nextStartSupply: bigint) => {
          if (endZero) {
            z += end - start;
            // The first zero interval starting with supply: the decay hit 0 inside it (lock ends are week-aligned, so
            // only rounding gets here). The contract prices the whole interval as zero, a program bound inside it
            // can't be split exactly: counted as the contract will, and flagged.
            if (firstZero && startSupply > 0n) {
              ambiguous.push({ vrm: s.vrm, t: s.t });
              ambiguousVrms.add(s.vrm);
            }
            firstZero = false;
          }
          start = end;
          startSupply = nextStartSupply;
        };
        for (const { w, before, at } of weekly.get(`${s.vrm}|${s.t}`)!) close(w, before === 0n, at);
        close(s.t, true, 0n);
      }
    }
    cum.set(`${s.vrm}|${s.t}`, z);
  }

  const subsidy = new Set(subsidyCreators.map(lc));
  for (const p of active) {
    let zero = cum.get(`${p.vrm}|${p.b}`)! - cum.get(`${p.vrm}|${p.a}`)!;
    const overlap = p.b - p.a;
    if (zero < 0 || zero > overlap) {
      if (!ambiguousVrms.has(p.vrm)) {
        throw new OrionError('pool_scan_inconsistent', `${where}: ${p.vrm} program ${p.id}: ${zero} zero-allocation seconds in a ${overlap} s overlap`);
      }
      zero = Math.min(Math.max(zero, 0), overlap); // flagged in `ambiguous`; the caller warns
    }
    const amount = (p.rate * BigInt(overlap - zero)) / PRECISION;
    if (amount === 0n) continue;
    const m = byClass[subsidy.has(lc(p.creator)) ? 'protocol_subsidy' : 'vote_incentives'];
    m.set(p.token, (m.get(p.token) ?? 0n) + amount);
  }
  return { byClass, programsActive: active.length, ambiguous, rpc };
}

interface GlobalPointOut {
  bias: bigint;
  slope: bigint;
  ts: number | bigint;
  permanentStakeBalance: bigint;
  zeroSupplySeconds: number | bigint;
}

function dayStartSec(day: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) throw new OrionError('pool_scan_day', `not a UTC day: ${day}`);
  return ms / 1000;
}

const lc = (a: string): string => a.toLowerCase();
