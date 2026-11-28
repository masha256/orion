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
 *    during the day); the factory's own `poolTape()` / `clPoolTape()`; per CL pool its swap hook.
 * 3. Registration: the configured tape's `allowedCaller(pool)` at e−1; 0 = unregistered, so the tape never recorded it:
 *    counted and listed with zero gross, its accumulators not read.
 * 4. Gross: `accumulators(pool)` on the configured tape at e−1 minus at s−1. Absent at s−1 (a revert, or the tape's zero
 *    struct), or still the registration's 1-wei sentinel (lastSwapTimestamp 0): the start is 0. lastSwapTimestamp 0 at
 *    e−1: no swap yet, the day's fee is 0.
 * 5. Allocator, per gauged pool (FactoryRegistry gaugeFactories → factoryToGauges → gaugeToTarget): Δ raw pending
 *    (CL `pool.gaugeFees()`, V2 `pool.pendingFees(gauge)`) between s−1 and e−1 plus Σ VRM `FeesCollected` in [s, e−1]
 *    (one eth_getLogs per log-range window over all the chain's VRMs, topic0 only).
 * 6. Drift (warn only): a factory's tape getter ≠ configured tape, a CL pool's hook ≠ configured hook, a registry target
 *    factory not configured, a gauge on an unregistered pool, a negative per-pool accrual (taken as 0).
 *
 * Any read the scan cannot do without (a factory length or pool, a pool's tokens, a registered pool's e−1 accumulator, a
 * gauge's VRM or e−1 pending) failing throws: a partial chain-day is never returned.
 */
export async function scanChainDay(reader: ChainReader, cfg: ChainScan, day: string): Promise<ChainDayScan> {
  if (reader.chainId !== cfg.chain_id) throw new OrionError('pool_scan_config', `reader is chain ${reader.chainId}, config is chain ${cfg.chain_id}`);
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
    const actual = r1[2 * i + 1] as string | null;
    if (actual === null || lc(actual) !== f.tape) warn('tape', f.address, { configured: f.tape, actual: actual === null ? null : lc(actual) });
  });
  const targets = need(r1[2 * factories.length] as readonly string[] | null, `${registry}.targetFactories()`).map(lc);
  const gaugeFactories = need(r1[2 * factories.length + 1] as readonly string[] | null, `${registry}.gaugeFactories()`).map(lc);
  const configured = new Set(factories.map((f) => f.address));
  for (const t of targets) if (!configured.has(t)) warn('factory', t, { registry });

  // Round 2 (e−1): every pool of every factory, in index order; and each gauge factory's gauges.
  const poolCalls: TypedCall[] = [];
  const poolMeta: { factory: (typeof factories)[number]; index: number; newInDay: boolean }[] = [];
  factories.forEach((f, i) => {
    const startLen = Number(lenS[i] ?? 0n); // a factory that did not exist at s−1 had no pools
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
    const caller = slot[2];
    if (p.factory.kind === 'cl' && p.factory.hook) {
      const hook = slot[3] === null ? null : lc(slot[3]);
      if (hook !== p.factory.hook) warn('hook', p.pool, { factory: p.factory.address, configured: p.factory.hook, actual: hook });
    }
    return {
      ...p,
      token0: lc(need(slot[0], `${p.pool}.token0()`)),
      token1: lc(need(slot[1], `${p.pool}.token1()`)),
      registered: caller !== null && BigInt(caller) !== 0n,
      gauge: null as string | null,
      vrm: null as string | null,
    };
  });
  const byPool = new Map(info.map((p) => [p.pool, p]));
  gauges.forEach((g, i) => {
    const target = r3[at + 2 * i];
    const p = target === null ? undefined : byPool.get(lc(target));
    if (!p) return; // a gauge on a pool of a factory the config does not scan (that factory raised `factory` drift)
    p.gauge = g;
    p.vrm = lc(need(r3[at + 2 * i + 1], `${g}.votingRewardsManager()`));
  });
  const gauged = info.filter((p) => p.gauge !== null);
  for (const p of gauged) if (!p.registered) warn('gauged_unregistered', p.pool, { gauge: p.gauge, factory: p.factory.address });

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
    const start = r4s[i] === null ? null : decodeAcc(p.factory, r4s[i]);
    const fees: [bigint, bigint] = [0n, 0n];
    if (end.last !== 0n) {
      const base = start === null || start.last === 0n ? [0n, 0n] : start.fees;
      for (const k of [0, 1]) {
        const d = end.fees[k] - base[k];
        if (d < 0n) warn('negative_gross', p.pool, { token: k === 0 ? p.token0 : p.token1, delta: d.toString() });
        fees[k] = d < 0n ? 0n : d;
      }
    }
    gross.set(p.pool, fees);
  });

  // FeesCollected over [s, e−1] for every VRM, one request per log-range window (and per 500 addresses, as measured).
  const collected = new Map<string, bigint>(); // `${vrm}:${token}` → amount
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
    const ps = r4s[off + i] === null ? [0n, 0n] : pair(r4s[off + i]);
    const amounts: TokenAmounts = new Map();
    [p.token0, p.token1].forEach((token, k) => {
      const v = pe[k] - ps[k] + (collected.get(`${p.vrm}:${token}`) ?? 0n);
      if (v < 0n) warn('negative_allocator', p.pool, { token, accrual: v.toString() });
      amounts.set(token, v < 0n ? 0n : v);
    });
    allocatorByPool.set(p.pool, amounts);
  });

  const out: PoolFees[] = info.map((p) => {
    const [fee0, fee1] = gross.get(p.pool) ?? [0n, 0n];
    return { pool: p.pool, factory: p.factory.address, token0: p.token0, token1: p.token1, fee0, fee1, registered: p.registered, newInDay: p.newInDay, gauge: p.gauge };
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

/** FeesCollected(_gauge indexed, _token indexed, _amount): keyed by (emitting VRM, topics[2] token), amount = data word 0. */
function addCollected(into: Map<string, bigint>, log: BlockLog): void {
  if (log.topics[0]?.toLowerCase() !== FEES_COLLECTED_TOPIC || log.topics.length < 3) return;
  const token = `0x${log.topics[2].slice(-40)}`.toLowerCase();
  const key = `${log.address.toLowerCase()}:${token}`;
  into.set(key, (into.get(key) ?? 0n) + BigInt(log.data.slice(0, 66)));
}
