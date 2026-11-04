import { describe, expect, it } from 'vitest';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { dbDayBlocks } from '../../src/db/dayBlocks.js';
import { getCursor } from '../../src/db/fetchCursors.js';
import { scanFlowGroup, type FlowScanArgs } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset } from '../../src/ingest/run.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { createViemRpc } from '../../src/ingest/transport/viemRpc.js';
import { chainInfo, supportedChainIds } from '../../src/ingest/transport/chains.js';
import { CG_CHART, harness, hourlyPrices, NOW, type Harness } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, POOL, SAFE } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

const E18 = 10n ** 18n;
const ms = (iso: string) => Date.parse(iso);
const BASE = 8453;

/** The mini asset under another id: the same chain, token and sink, so the same day boundaries. */
const otherAsset = (id: string): LoadedAsset => parseAssetYaml(INGEST_ASSET_YAML.replace('id: mini\n', `id: ${id}\n`));

function world(over: Parameters<typeof harness>[1] = {}): Harness {
  const probe = harness(testDb());
  const at = (iso: string) => probe.rpc.blockAtOrAfter(ms(iso) / 1000);
  let n = 0;
  const log = (iso: string, from: string, tokens: bigint): Omit<TransferLog, 'timestamp'> => ({
    blockNumber: at(iso), logIndex: n++, txHash: `0xtx${n}`, from, value: tokens * E18,
  });
  const logs = [log('2026-09-16T10:00:00Z', POOL, 2n), log('2026-09-17T00:00:00Z', SAFE, 3n), log('2026-09-18T20:00:00Z', POOL, 4n)];
  return harness(testDb(), { routes: { [CG_CHART]: hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', () => 10) }, logs, ...over });
}

async function argsFor(h: Harness, over: Partial<FlowScanArgs> = {}): Promise<FlowScanArgs> {
  const loaded = over.asset ? { config: over.asset } : h.loaded;
  return {
    db: h.db, asset: loaded.config, group: buildPlan(loaded.config).flowGroups[0], rpc: h.rpc, latest: await h.rpc.latestBlock(), http: h.http, env: {},
    sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false, ...over,
  };
}

const scanKey = (h: Harness): string => buildPlan(h.loaded.config).flowGroups[0].scanKey;
const values = (r: Awaited<ReturnType<typeof scanFlowGroup>>) => r.written.map((w) => [w.metricKey, w.observedAt, w.value]);
const cached = async (db: Db) => (await db.all<{ day: string }>('SELECT day FROM day_blocks ORDER BY day')).map((r) => r.day);

describe('day-boundary block cache (N9)', () => {
  it('dayBlocks: the store round-trips a block and keeps the first one written', async () => {
    const c = dbDayBlocks(testDb(), BASE);
    expect(await c.get('2026-09-17')).toBeNull();
    await c.put('2026-09-17', { number: 123n, timestamp: 1_789_000_000 });
    await c.put('2026-09-17', { number: 999n, timestamp: 1 });
    expect(await c.get('2026-09-17')).toEqual({ number: 123n, timestamp: 1_789_000_000 });
    expect(await dbDayBlocks(testDb(), 1).get('2026-09-17')).toBeNull(); // per chain
  });

  it('dayBlocks: the second scan of the same chain and day makes no boundary search calls', async () => {
    const h = world();
    const first = await scanFlowGroup(await argsFor(h, { dayBlocks: dbDayBlocks(h.db, BASE) }));
    expect(first.outcome.status).toBe('ok');
    expect(h.rpc.stats.getBlock).toBeGreaterThan(0);
    // The range starts on the 16th; the scan ends at the first block of the 19th, 12 h before the head.
    expect(await cached(h.db)).toEqual(['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']);

    const before = h.rpc.stats.getBlock;
    const second = await scanFlowGroup(await argsFor(h, { asset: otherAsset('mini2').config, dayBlocks: dbDayBlocks(h.db, BASE) }));
    expect(h.rpc.stats.getBlock - before).toBe(0);
    // Which calls are made changes; what is written does not.
    expect(values(second)).toEqual(values(first));
    const [a, b] = [await getCursor(h.db, 'mini', scanKey(h)), await getCursor(h.db, 'mini2', scanKey(h))];
    expect(a).toMatchObject({ lastDay: '2026-09-18' });
    expect(b).toEqual(a);
  });

  it('dayBlocks: a cached scan and an uncached scan store identical rows (detail included)', async () => {
    const plain = world();
    await scanFlowGroup(await argsFor(plain));
    const rowsOf = async (id: string) =>
      (await plain.db.all<{ metric_key: string; observed_at: string; value: number; source_detail: string }>(
        'SELECT metric_key, observed_at, value, source_detail FROM observations WHERE asset_id = $1 ORDER BY metric_key, observed_at', [id],
      )).map((r) => ({ ...r }));
    const uncached = await rowsOf('mini');
    const c = dbDayBlocks(plain.db, BASE);
    await scanFlowGroup(await argsFor(plain, { asset: otherAsset('warm').config, dayBlocks: c }));
    await scanFlowGroup(await argsFor(plain, { asset: otherAsset('hot').config, dayBlocks: c }));
    expect(await rowsOf('warm')).toEqual(uncached);
    expect(await rowsOf('hot')).toEqual(uncached);
  });

  it('dayBlocks: fetchAsset takes the cache from FetchDeps.dayBlocks, per chain id', async () => {
    const h = world();
    const chains: number[] = [];
    const deps = { ...h.deps, dayBlocks: (chainId: number) => (chains.push(chainId), dbDayBlocks(h.db, chainId)) };
    await fetchAsset(h.db, h.loaded, NOW, deps);
    const before = h.rpc.stats.getBlock;
    const second = await fetchAsset(h.db, otherAsset('mini2'), NOW, deps);
    expect(second.outcome).not.toBe('failed');
    expect(h.rpc.stats.getBlock - before).toBe(0);
    expect(new Set(chains)).toEqual(new Set([BASE]));
  });

  it('dayBlocks: a dry run reads the cache but writes nothing', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h, { dryRun: true, dayBlocks: dbDayBlocks(h.db, BASE) }));
    expect(await cached(h.db)).toEqual([]);

    await scanFlowGroup(await argsFor(h, { dayBlocks: dbDayBlocks(h.db, BASE) }));
    const before = h.rpc.stats.getBlock;
    const dry = await scanFlowGroup(await argsFor(h, { asset: otherAsset('mini2').config, dryRun: true, dayBlocks: dbDayBlocks(h.db, BASE) }));
    expect(dry.outcome.status).toBe('ok');
    expect(h.rpc.stats.getBlock - before).toBe(0);
  });

  it('dayBlocks: a boundary within 1 h of the upper bound is not cached', async () => {
    // The head is 30 min past midnight of the 19th: that boundary is 30 min old, so it could still be reorged away.
    const h = world({ now: new Date('2026-09-19T00:30:00.000Z') });
    const r = await scanFlowGroup(await argsFor(h, { dayBlocks: dbDayBlocks(h.db, BASE) }));
    expect(r.outcome.status).toBe('ok');
    expect(await cached(h.db)).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);
  });
});

describe('finalized upper bound', () => {
  /** The harness chain with a finalized tag `lag` blocks behind its head. */
  function withFinalized(rpc: Harness['rpc'], lag: bigint): RpcTransport & { finalizedCalls: number } {
    const out: RpcTransport & { finalizedCalls: number } = {
      ...rpc,
      finalizedCalls: 0,
      finalizedBlock: async () => {
        out.finalizedCalls++;
        const n = (await rpc.latestBlock()).number - lag;
        return { number: n, timestamp: rpc.timestampOf(n) };
      },
    };
    return out;
  }

  it('finalized: a scan stops at the finalized block when the transport has one', async () => {
    // The head is 10 s past midnight of the 19th; the finalized block, 10 blocks (20 s) back, is still on the 18th.
    const h = world({ now: new Date('2026-09-19T00:00:10.000Z') });
    const latest = await h.rpc.latestBlock();
    const rpc = withFinalized(h.rpc, 10n);
    const r = await scanFlowGroup(await argsFor(h, { rpc }));
    expect(rpc.finalizedCalls).toBe(1);
    expect(r.outcome.status).toBe('ok');
    const lastRead = h.rpc.stats.logRanges.at(-1)![1];
    expect(lastRead).toBeLessThanOrEqual(latest.number - 10n - 1n);
    // The 18th is not complete at the finalized block, so the scan ends with the 17th.
    expect(r.written.map((w) => w.observedAt.slice(0, 10))).not.toContain('2026-09-19');
    expect(await getCursor(h.db, 'mini', scanKey(h))).toMatchObject({ lastDay: '2026-09-17' });
  });

  it('finalized (M-7): an RPC that rejects the finalized tag falls back to latest minus the chain\'s confirmations, with a note', async () => {
    const h = world({ now: new Date('2026-09-19T00:00:10.000Z') });
    const latest = await h.rpc.latestBlock();
    let calls = 0;
    const rpc: RpcTransport = {
      ...h.rpc,
      confirmations: 10n,
      finalizedBlock: async () => {
        calls++;
        throw new Error('invalid block tag finalized');
      },
    };
    const r = await scanFlowGroup(await argsFor(h, { rpc }));
    expect(calls).toBe(1);
    expect(r.outcome.status).toBe('ok');
    expect(r.outcome.notes).toContain(`no finalized block (invalid block tag finalized): scanned up to latest - 10 (block ${latest.number - 10n})`);
    expect(h.rpc.stats.logRanges.at(-1)![1]).toBeLessThanOrEqual(latest.number - 10n - 1n);
    expect(await getCursor(h.db, 'mini', scanKey(h))).toMatchObject({ lastDay: '2026-09-17' });
    // Every chain has a depth to fall back to.
    for (const id of supportedChainIds()) expect(chainInfo(id)!.confirmations > 0n).toBe(true);
    expect(createViemRpc('http://127.0.0.1:9/', 8453).confirmations).toBe(chainInfo(8453)!.confirmations);
  });

  it('finalized: without a finalized tag the scan reads up to the latest block, as before', async () => {
    const h = world({ now: new Date('2026-09-19T00:00:10.000Z') });
    const r = await scanFlowGroup(await argsFor(h));
    expect(await getCursor(h.db, 'mini', scanKey(h))).toMatchObject({ lastDay: '2026-09-18' });
  });

  it('finalized: the viem transport reads the finalized tag', () => {
    // Built only: no request is made.
    expect(typeof createViemRpc('http://127.0.0.1:9/', 8453).finalizedBlock).toBe('function');
  });

  it('finalized: level reads keep the latest block', async () => {
    const h = world();
    const rpc = withFinalized(h.rpc, 10n);
    const blocks: bigint[] = [];
    const multicall = rpc.multicall.bind(rpc);
    rpc.multicall = async (calls, blockNumber) => (blocks.push(blockNumber), await multicall(calls, blockNumber));
    await fetchAsset(h.db, h.loaded, NOW, { ...h.deps, rpcFactory: () => rpc }, { metrics: ['total_supply'] });
    expect(blocks).toEqual([(await h.rpc.latestBlock()).number]);
    expect(rpc.finalizedCalls).toBe(0);
  });
});
