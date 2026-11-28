import { OrionError } from '../../types.js';
import { chainInfo } from '../transport/chains.js';
import type { BlockLog } from '../transport/rpc.js';
import { MULTICALL_DATA_CHUNK } from '../transport/rpc.js';
import { CL_POOL_TAPE_ABI, FACTORY_ABI, FACTORY_REGISTRY_ABI, FEES_COLLECTED_TOPIC, GAUGE_ABI, POOL_ABI, POOL_TAPE_ABI, ROOT_VOTER_ABI } from './abi.js';
import type { ChainReader, TypedCall } from './reader.js';
import type { ChainDayScan, ChainScan, Drift, PoolFees, ScanFactory, TokenAmounts } from './types.js';

/**
 * One (chain, UTC day) of the pool scan (Phase 3 R4, spec §4.1; method: phase3-r4-scoping onchain-revenue.md §3-§6,
 * scripts/measure.py and poolenum.py):
 *
 * 1. Day blocks: s = first block at or after D 00:00Z, e = first block at or after D+1 00:00Z (reader.blockAt). A call at
 *    block N returns the state after N, so every read is at s−1 and e−1 and the day covers exactly [s, e).
 * 2. Pools: per configured factory `allPoolsLength` / `allPools(i)` at e−1 (at s−1 only the length, to mark pools created
 *    during the day; required: a chain is scanned only from its `since`, when its factories exist); the factory's own `poolTape()` / `clPoolTape()` at e−1, which is the tape its pools are read from
 *    (the configured tape is only compared: a mismatch is `tape` drift); per CL pool its swap hook.
 * 3. Registration: that tape's `allowedCaller(pool)` at e−1; 0 = unregistered, so the tape never recorded it: counted and
 *    listed, its accumulators not read, and an ungauged one books zero gross. For a gauged pool registered at e−1 and
 *    present at s−1, `allowedCaller` at s−1 too. A gauged pool NOT registered at s−1 (absent then, registered during
 *    the day, or still unregistered at e−1) books per token max(tape delta, allocator accrual (point 5)), the tape
 *    delta being 0 while unregistered; `credit0/1` keep the excess over the tape delta. Why: registration lags pool
 *    creation (Arbitrum 2026-10-26/27: new pools gauged at once, registered up to a day later), so the gauge collects
 *    fees from swaps before registration that the tape never saw. A tape-only gross would put allocator above gross.
 *    A pool registered at both s−1 and e−1 keeps its tape delta, and the adapter's allocator ≤ gross bound judges it.
 * 4. Gross: `accumulators(pool)` on that tape at e−1 minus at s−1. A pool absent at s−1 comes back as the mapping's zero
 *    struct (a public mapping read never reverts; every scoping chain-day confirms it), and a pool still on the
 *    registration's 1-wei sentinel has lastSwapTimestamp 0: either way the start is 0. lastSwapTimestamp 0 at e−1: no swap
 *    yet, the day's fee is 0. A null accumulator at either block is a failed read and fails the scan.
 * 5. Allocator, per gauged pool (FactoryRegistry gaugeFactories → factoryToGauges → gaugeToTarget): Δ raw pending
 *    (CL `pool.gaugeFees()`, V2 `pool.pendingFees(gauge)`) between s−1 and e−1 plus Σ VRM `FeesCollected` in [s, e−1]
 *    (one eth_getLogs per log-range window over all the chain's VRMs, topic0 only).
 * 6. Drift (warn only): a factory's tape getter ≠ configured tape, a CL pool's hook ≠ configured hook, a registry target
 *    factory not configured, a gauge on an unregistered pool, a second gauge on one pool (the first is kept), a negative
 *    per-pool accrual (taken as 0).
 *
 * Every read the result depends on fails the scan when it reverts or does not decode (OrionError
 * `pool_scan_read_failed`, naming the chain, day, contract and read): factory lengths (at s−1 and e−1), tape getters and pools, registry
 * lists, pool tokens, `allowedCaller` (e−1; s−1 for gauged pools), `gaugeToTarget`, VRMs, accumulators at both blocks and pending at both blocks. The
 * one null accepted is a pool's pending at s−1 when the pool was created during the day (no code at s−1, so the call
 * returns no data). A partial chain-day is never returned.
 */
export async function scanChainDay(reader: ChainReader, cfg: ChainScan, day: string): Promise<ChainDayScan> {
  if (reader.chainId !== cfg.chain_id) throw new OrionError('pool_scan_config', `reader is chain ${reader.chainId}, config is chain ${cfg.chain_id}`);
  if (cfg.since !== undefined && day < cfg.since) throw new OrionError('pool_scan_config', `chain ${cfg.chain_id} ${day}: before the chain's since ${cfg.since} (not scanned)`);
  const t0 = dayStartSec(day);
  const rpc = { calls: 0, requests: 0, logs: 0 };
  const read = async <T>(calls: TypedCall[], block: bigint): Promise<(T | null)[]> => {
    if (calls.length === 0) return [];
    rpc.calls += calls.length;
    rpc.requests += Math.ceil(calls.length / MULTICALL_DATA_CHUNK);
    return reader.call<T>(calls, block);
  };
  const need = <T>(v: T | null, what: string): T => {
    if (v === null || v === undefined) throw new OrionError('pool_scan_read_failed', `chain ${cfg.chain_id} ${day}: ${what} failed`);
    return v;
  };

  const s = (await reader.blockAt(t0)).number;
  const e = (await reader.blockAt(t0 + 86_400)).number;
  if (s < 1n || e <= s) throw new OrionError('pool_scan_blocks', `chain ${cfg.chain_id} ${day}: day blocks s=${s} e=${e}`);
  const atS = s - 1n;
  const atE = e - 1n;
  const drift: Drift[] = [];
  const warn = (kind: Drift['kind'], id: string, detail: Record<string, unknown>) => drift.push({ kind, chainId: cfg.chain_id, id, detail });

  const factories = cfg.factories.map((f) => ({ ...f, address: lc(f.address), tape: lc(f.tape), hook: f.hook ? lc(f.hook) : undefined }));
  const registry = lc(cfg.factory_registry);

  // Round 1 (e−1): factory lengths and tape getters, the registry's factory lists; (s−1): factory lengths.
  const tapeGetter = (f: ScanFactory) => (f.kind === 'cl' ? 'clPoolTape' : 'poolTape');
  const r1 = await read<unknown>(
    [
      ...factories.flatMap((f): TypedCall[] => [
        { address: f.address, abi: FACTORY_ABI, functionName: 'allPoolsLength' },
        { address: f.address, abi: FACTORY_ABI, functionName: tapeGetter(f) },
      ]),
      { address: registry, abi: FACTORY_REGISTRY_ABI, functionName: 'targetFactories' },
      { address: registry, abi: FACTORY_REGISTRY_ABI, functionName: 'gaugeFactories' },
    ],
    atE,
  );
  const lenS = await read<bigint>(factories.map((f) => ({ address: f.address, abi: FACTORY_ABI, functionName: 'allPoolsLength' })), atS);
  const lengths = factories.map((f, i) => Number(need(r1[2 * i] as bigint | null, `${f.address}.allPoolsLength() at e−1`)));
  factories.forEach((f, i) => {
    // The factory's live getter names the tape its pools record on; the config value is only compared.
    const live = lc(need(r1[2 * i + 1] as string | null, `${f.address}.${tapeGetter(f)}() at e−1`));
    if (live !== f.tape) warn('tape', f.address, { configured: f.tape, actual: live });
    f.tape = live;
  });
  const targets = need(r1[2 * factories.length] as readonly string[] | null, `${registry}.targetFactories()`).map(lc);
  const gaugeFactories = need(r1[2 * factories.length + 1] as readonly string[] | null, `${registry}.gaugeFactories()`).map(lc);
  const configured = new Set(factories.map((f) => f.address));
  for (const t of targets) if (!configured.has(t)) warn('factory', t, { registry });

  // Round 2 (e−1): every pool of every factory, in index order; and each gauge factory's gauges.
  const poolCalls: TypedCall[] = [];
  const poolMeta: { factory: (typeof factories)[number]; index: number; newInDay: boolean }[] = [];
  factories.forEach((f, i) => {
    // Required at s−1 too: a chain is scanned only from its `since`, when every configured factory already has code.
    const startLen = Number(need(lenS[i], `${f.address}.allPoolsLength() at s−1`));
    for (let k = 0; k < lengths[i]; k++) {
      poolCalls.push({ address: f.address, abi: FACTORY_ABI, functionName: 'allPools', args: [BigInt(k)] });
      poolMeta.push({ factory: f, index: k, newInDay: k >= startLen });
    }
  });
  const r2 = await read<unknown>(
    [...poolCalls, ...gaugeFactories.map((gf): TypedCall => ({ address: registry, abi: FACTORY_REGISTRY_ABI, functionName: 'factoryToGauges', args: [gf] }))],
    atE,
  );
  const pools = poolMeta.map((m, i) => ({ ...m, pool: lc(need(r2[i] as string | null, `${m.factory.address}.allPools(${m.index})`)) }));
  const gauges = [...new Set(gaugeFactories.flatMap((gf, i) => need(r2[poolCalls.length + i] as readonly string[] | null, `${registry}.factoryToGauges(${gf})`).map(lc)))];

  // Round 3 (e−1): tokens, registration and (CL) swap hook per pool; each gauge's pool and VRM.
  const perPool = (p: (typeof pools)[number]): TypedCall[] => [
    { address: p.pool, abi: POOL_ABI, functionName: 'token0' },
    { address: p.pool, abi: POOL_ABI, functionName: 'token1' },
    { address: p.factory.tape, abi: tapeAbi(p.factory), functionName: 'allowedCaller', args: [p.pool] },
    ...(p.factory.kind === 'cl' && p.factory.hook ? [{ address: p.factory.address, abi: FACTORY_ABI, functionName: 'getPoolSwapHook', args: [p.pool] }] : []),
  ];
  const poolCalls3 = pools.map(perPool);
  const r3 = await read<string>(
    [
      ...poolCalls3.flat(),
      ...gauges.flatMap((g): TypedCall[] => [
        { address: registry, abi: FACTORY_REGISTRY_ABI, functionName: 'gaugeToTarget', args: [g] },
        { address: g, abi: GAUGE_ABI, functionName: 'votingRewardsManager' },
      ]),
    ],
    atE,
  );
  let at = 0;
  const info = pools.map((p, i) => {
    const slot = r3.slice(at, at + poolCalls3[i].length);
    at += poolCalls3[i].length;
    const caller = need(slot[2], `${p.factory.tape}.allowedCaller(${p.pool}) at e−1`);
    if (p.factory.kind === 'cl' && p.factory.hook) {
      const hook = slot[3] === null ? null : lc(slot[3]);
      if (hook !== p.factory.hook) warn('hook', p.pool, { factory: p.factory.address, configured: p.factory.hook, actual: hook });
    }
    return {
      ...p,
      token0: lc(need(slot[0], `${p.pool}.token0()`)),
      token1: lc(need(slot[1], `${p.pool}.token1()`)),
      registered: BigInt(caller) !== 0n,
      gauge: null as string | null,
      vrm: null as string | null,
    };
  });
  const byPool = new Map(info.map((p) => [p.pool, p]));
  gauges.forEach((g, i) => {
    const target = need(r3[at + 2 * i], `${registry}.gaugeToTarget(${g}) at e−1`);
    const p = byPool.get(lc(target));
    if (!p) return; // a gauge on a pool of a factory the config does not scan (that factory raised `factory` drift)
    if (p.gauge !== null) {
      // A second gauge on one pool (a legacy gauge reactivated?): keep the first, in registry order, and say so.
      warn('double_gauge', p.pool, { kept: p.gauge, ignored: g });
      return;
    }
    p.gauge = g;
    p.vrm = lc(need(r3[at + 2 * i + 1], `${g}.votingRewardsManager()`));
  });
  const gauged = info.filter((p) => p.gauge !== null);
  for (const p of gauged) if (!p.registered) warn('gauged_unregistered', p.pool, { gauge: p.gauge, factory: p.factory.address });

  // Round 3b (s−1): registration at the day's start, for gauged pools registered at e−1 that existed then (point 3).
  const startCheck = gauged.filter((p) => p.registered && !p.newInDay);
  const r3s = await read<string>(startCheck.map((p): TypedCall => ({ address: p.factory.tape, abi: tapeAbi(p.factory), functionName: 'allowedCaller', args: [p.pool] })), atS);
  const registeredAtS = new Set(startCheck.filter((p, i) => BigInt(need(r3s[i], `${p.factory.tape}.allowedCaller(${p.pool}) at s−1`)) !== 0n).map((p) => p.pool));

  // Round 4 (s−1 and e−1): accumulators of the registered pools, raw pending of the gauged ones.
  const registeredPools = info.filter((p) => p.registered);
  const r4 = (block: bigint) =>
    read<unknown>(
      [
        ...registeredPools.map((p): TypedCall => ({ address: p.factory.tape, abi: tapeAbi(p.factory), functionName: 'accumulators', args: [p.pool] })),
        ...gauged.map((p): TypedCall =>
          p.factory.kind === 'cl'
            ? { address: p.pool, abi: POOL_ABI, functionName: 'gaugeFees' }
            : { address: p.pool, abi: POOL_ABI, functionName: 'pendingFees', args: [p.gauge] },
        ),
      ],
      block,
    );
  const [r4s, r4e] = [await r4(atS), await r4(atE)];
  const gross = new Map<string, [bigint, bigint]>();
  registeredPools.forEach((p, i) => {
    const end = decodeAcc(p.factory, need(r4e[i], `${p.factory.tape}.accumulators(${p.pool}) at e−1`));
    const start = decodeAcc(p.factory, need(r4s[i], `${p.factory.tape}.accumulators(${p.pool}) at s−1`));
    const fees: [bigint, bigint] = [0n, 0n];
    if (end.last !== 0n) {
      const base = start.last === 0n ? [0n, 0n] : start.fees;
      for (const k of [0, 1]) {
        const d = end.fees[k] - base[k];
        if (d < 0n) warn('negative_gross', p.pool, { token: k === 0 ? p.token0 : p.token1, delta: d.toString() });
        fees[k] = d < 0n ? 0n : d;
      }
    }
    gross.set(p.pool, fees);
  });

  // FeesCollected over [s, e−1] for every VRM, one request per log-range window (and per 500 addresses, as measured).
  const collected = new Map<string, bigint>(); // `${vrm}:${gauge}:${token}` → amount
  const vrms = [...new Set(gauged.map((p) => p.vrm!))].sort();
  if (vrms.length > 0) {
    const range = BigInt(cfg.log_range ?? Number(chainInfo(cfg.chain_id)?.maxLogRange ?? 2000n));
    for (let from = s; from <= atE; from += range) {
      const to = from + range - 1n < atE ? from + range - 1n : atE;
      for (let i = 0; i < vrms.length; i += LOG_ADDRESS_CHUNK) {
        rpc.logs++;
        rpc.requests++;
        for (const log of await reader.logs(vrms.slice(i, i + LOG_ADDRESS_CHUNK), FEES_COLLECTED_TOPIC, from, to)) addCollected(collected, log);
      }
    }
  }
  const allocatorByPool = new Map<string, TokenAmounts>();
  const off = registeredPools.length;
  gauged.forEach((p, i) => {
    const pe = pair(need(r4e[off + i], `pending fees of ${p.pool} at e−1`));
    // Only a pool created during the day may answer nothing at s−1 (no code there yet): its pending started at 0.
    const ps = r4s[off + i] === null && p.newInDay ? [0n, 0n] : pair(need(r4s[off + i], `pending fees of ${p.pool} at s−1`));
    const amounts: TokenAmounts = new Map();
    [p.token0, p.token1].forEach((token, k) => {
      const v = pe[k] - ps[k] + (collected.get(`${p.vrm}:${p.gauge}:${token}`) ?? 0n);
      if (v < 0n) warn('negative_allocator', p.pool, { token, accrual: v.toString() });
      amounts.set(token, v < 0n ? 0n : v);
    });
    allocatorByPool.set(p.pool, amounts);
  });

  const out: PoolFees[] = info.map((p) => {
    const tape = p.registered ? gross.get(p.pool)! : ([0n, 0n] as [bigint, bigint]);
    // Registration (point 3): a gauged pool not registered at s−1 books max(tape delta, allocator accrual) per token.
    const credited = p.gauge !== null && !registeredAtS.has(p.pool);
    const alloc = credited ? allocatorAsGross(cfg.chain_id, day, p, allocatorByPool.get(p.pool)!) : tape;
    const [fee0, fee1] = [0, 1].map((k) => (alloc[k] > tape[k] ? alloc[k] : tape[k]));
    return {
      pool: p.pool, factory: p.factory.address, token0: p.token0, token1: p.token1, fee0, fee1, credit0: fee0 - tape[0], credit1: fee1 - tape[1],
      registered: p.registered, newInDay: p.newInDay, gauge: p.gauge,
    };
  });
  return {
    chainId: cfg.chain_id,
    day,
    blocks: { s, e },
    pools: out,
    counts: { pools: out.length, registered: registeredPools.length, gauged: gauged.length, newInDay: out.filter((p) => p.newInDay).length },
    allocatorByPool,
    drift,
    rpc,
  };
}

/**
 * The root Voter's `chains()` at `block` against the configured chain ids: one `chain` drift per id on one side only
 * (a new chain Orion does not scan, or a configured chain the Voter no longer lists). `reader` is the root Voter's chain.
 */
export async function checkRootChains(reader: ChainReader, rootVoter: string, configuredIds: number[], block: bigint): Promise<Drift[]> {
  const [ids] = await reader.call<readonly bigint[]>([{ address: lc(rootVoter), abi: ROOT_VOTER_ABI, functionName: 'chains' }], block);
  if (ids === null) throw new OrionError('pool_scan_read_failed', `${rootVoter}.chains() at ${block} failed`);
  const onChain = new Set(ids.map(Number));
  const mine = new Set(configuredIds);
  const drift: Drift[] = [];
  for (const id of [...new Set([...onChain, ...mine])].sort((a, b) => a - b)) {
    if (onChain.has(id) && mine.has(id)) continue;
    drift.push({ kind: 'chain', chainId: reader.chainId, id: String(id), detail: { in_root_voter: onChain.has(id), configured: mine.has(id) } });
  }
  return drift;
}

/**
 * A gauged pool's allocator accrual mapped onto [token0, token1], for the max with its tape delta (scan point 3). An allocator
 * token outside the pool's pair is `pool_scan_inconsistent` (the accrual is read per pool token, so it means a bug).
 */
export function allocatorAsGross(chainId: number, day: string, p: { pool: string; token0: string; token1: string }, amounts: TokenAmounts): [bigint, bigint] {
  for (const t of amounts.keys()) {
    if (t !== p.token0 && t !== p.token1) {
      throw new OrionError('pool_scan_inconsistent', `chain ${chainId} ${day}: pool ${p.pool}'s allocator accrual holds token ${t}, neither its token0 ${p.token0} nor token1 ${p.token1}`);
    }
  }
  return [amounts.get(p.token0) ?? 0n, amounts.get(p.token1) ?? 0n];
}

/** VRM addresses per eth_getLogs request (measure.py chunked at 500). */
export const LOG_ADDRESS_CHUNK = 500;

function dayStartSec(day: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) throw new OrionError('pool_scan_day', `not a UTC day: ${day}`);
  return ms / 1000;
}

const lc = (a: string): string => a.toLowerCase();

const tapeAbi = (f: ScanFactory) => (f.kind === 'cl' ? CL_POOL_TAPE_ABI : POOL_TAPE_ABI);

/** V2: the 10-value tuple (fee0 = [0], fee1 = [1], lastSwapTimestamp = [8]); CL: the Accumulator struct. */
function decodeAcc(f: ScanFactory, v: unknown): { fees: [bigint, bigint]; last: bigint } {
  if (f.kind === 'cl') {
    const a = v as { cumulativeFee0: bigint; cumulativeFee1: bigint; lastSwapTimestamp: number | bigint };
    return { fees: [BigInt(a.cumulativeFee0), BigInt(a.cumulativeFee1)], last: BigInt(a.lastSwapTimestamp) };
  }
  const a = v as readonly (bigint | number)[];
  return { fees: [BigInt(a[0]), BigInt(a[1])], last: BigInt(a[8]) };
}

function pair(v: unknown): [bigint, bigint] {
  const a = v as readonly (bigint | number)[];
  return [BigInt(a[0]), BigInt(a[1])];
}

/**
 * FeesCollected(_gauge indexed, _token indexed, _amount): keyed by (emitting VRM, topics[1] gauge, topics[2] token),
 * amount = data word 0. The VRM emits it as `FeesCollected(gauge, token0|token1, collected)` with its own gauge
 * (VotingRewardsManager.sol settle path), so a VRM serving two gauges never books one gauge's fees on the other's pool.
 */
function addCollected(into: Map<string, bigint>, log: BlockLog): void {
  if (log.topics[0]?.toLowerCase() !== FEES_COLLECTED_TOPIC || log.topics.length < 3) return;
  const gauge = `0x${log.topics[1].slice(-40)}`.toLowerCase();
  const token = `0x${log.topics[2].slice(-40)}`.toLowerCase();
  const key = `${log.address.toLowerCase()}:${gauge}:${token}`;
  into.set(key, (into.get(key) ?? 0n) + BigInt(log.data.slice(0, 66)));
}
