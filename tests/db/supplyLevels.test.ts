import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { purgeMetrics } from '../../src/db/purge.js';
import { rebuildSupplyLevels, supplyNotRebuildable } from '../../src/db/supplyLevels.js';
import type { HttpTransport } from '../../src/ingest/transport/http.js';
import type { RpcFactory } from '../../src/ingest/transport/rpc.js';
import { fetchedProvenance } from '../../src/provenance/locator.js';
import type { Locator } from '../../src/provenance/types.js';
import { latestLevel } from '../../src/observations/select.js';
import { callKey, fakeRpc, type FakeRpc } from '../helpers/fakeRpc.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const NOW = new Date('2026-11-20T12:00:00.000Z');
const E18 = 10n ** 18n;
const GENESIS = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
const BLOCK_SEC = 3;
const sec = (iso: string): number => Math.ceil(Date.parse(iso) / 1000);

const TOKEN = '0x00000000000000000000000000000000000000c1';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const ESCROW = '0x00000000000000000000000000000000000000e1';
const WRAPPER = '0x00000000000000000000000000000000000000f1';
const TREASURY = '0x00000000000000000000000000000000000000f2';
const FUND = '0x00000000000000000000000000000000000000a9';

const REQUIRED = `
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }`;

/** CAKE's shape: total less a burn address less a grant escrow's lockedSupply() (the escrow exists from 2026-10-01). */
const CAK_YAML = `
id: cak
symbol: CAK
name: Cake Test
contracts:
  token: "${TOKEN}"
  dead: "${DEAD}"
  grant_escrow: "${ESCROW}"
ingest: { chain_id: 56, rpc_url_env: ORION_BNB_RPC_URL, backfill_days: 100 }
metrics:${REQUIRED}
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source:
      type: adapter
      name: chain.view_sum
      params:
        terms:
          - { contract: token, function: totalSupply }
          - { contract: token, function: balanceOf, args: [ dead ], sign: -1 }
          - { contract: grant_escrow, function: lockedSupply, sign: -1 }
`;

/** A wrapper (cvxCRV's shape): was erc20_supply totalSupply(), now total less a treasury's wrapper balance. */
const WRP_YAML = `
id: wrp
symbol: WRP
name: Wrapper Test
contracts:
  token: "${WRAPPER}"
  treasury: "${TREASURY}"
ingest: { chain_id: 1, rpc_url_env: ORION_ETH_RPC_URL, backfill_days: 100 }
metrics:${REQUIRED}
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source:
      type: adapter
      name: chain.view_sum
      params:
        terms:
          - { contract: token, function: totalSupply }
          - { contract: token, function: balanceOf, args: [ treasury ], sign: -1 }
`;

/** HYPE's shape: Hyperliquid's API, no archive. */
const HYP_YAML = `
id: hyp
symbol: HYP
name: Hype Test
contracts:
  fund: "${FUND}"
metrics:${REQUIRED}
  circulating_supply: { type: level, unit: tokens, staleness_days: 14, source: { type: adapter, name: hype.circulating_supply, params: { subtract: [ fund ] } } }
`;

/** AERO's shape: on chain, with rebuild_from (rows before it are CoinGecko's, before the new token's migration). */
const AER_YAML = (rebuildFrom: string) => `
id: aer
symbol: AER
name: Aero Test
contracts:
  token: "${TOKEN}"
  dead: "${DEAD}"
ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 100 }
metrics:${REQUIRED}
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    rebuild_from: ${rebuildFrom}
    source:
      type: adapter
      name: chain.view_sum
      params:
        terms:
          - { contract: token, function: totalSupply }
          - { contract: token, function: balanceOf, args: [ dead ], sign: -1 }
`;

const load = (yaml: string): LoadedAsset => {
  const { config, hash } = parseAssetYaml(yaml);
  return { config, hash };
};

const ESCROW_FROM = '2026-10-01T00:00:00.000Z';

/**
 * A 3 s chain from 2026-01-01: totalSupply = 1,000,000 + block tokens, dead holds 100,000, the escrow's lockedSupply()
 * 50,000 from its first block (2026-10-01) and reverts before (no code yet).
 */
function chain(): FakeRpc {
  const latest = BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS) / BLOCK_SEC));
  const escrowBlock = BigInt(Math.ceil((sec(ESCROW_FROM) - GENESIS) / BLOCK_SEC));
  return fakeRpc({
    genesisTs: GENESIS, latest, blockTimeSec: BLOCK_SEC,
    callsAt: (b) => ({
      [callKey(TOKEN, 'totalSupply')]: (1_000_000n + b) * E18,
      [callKey(TOKEN, 'balanceOf', [DEAD])]: 100_000n * E18,
      [callKey(ESCROW, 'lockedSupply')]: b < escrowBlock ? new Error('execution reverted') : 50_000n * E18,
      [callKey(WRAPPER, 'totalSupply')]: (2_000_000n + b) * E18,
      [callKey(WRAPPER, 'balanceOf', [TREASURY])]: 300_000n * E18,
    }),
  });
}

const noHttp: HttpTransport = {
  async getJson() {
    throw new Error('no HTTP in this test');
  },
  async postJson() {
    throw new Error('no HTTP in this test');
  },
} as unknown as HttpTransport;

const deps = (rpc: FakeRpc) => {
  const urls: string[] = [];
  const factory: RpcFactory = (url) => {
    urls.push(url);
    return rpc;
  };
  return { rpc: factory, http: noHttp, env: { ORION_BNB_RPC_URL: 'http://bnb.test', ORION_ETH_RPC_URL: 'http://eth.test', ORION_BASE_RPC_URL: 'http://base.test' }, urls };
};

const noRpc = { rpc: (() => { throw new Error('the rebuild opened an RPC'); }) as RpcFactory, http: noHttp, env: {} };

/** A CoinGecko-era circulating row (`market_data`), as the nightly wrote it. */
async function seedMarket(d: Db, assetId: string, observedAt: string, value: number): Promise<number> {
  return (await insertObservation(d, {
    assetId, metricKey: 'circulating_supply', observedAt, value, periodDays: null, fetchedAt: observedAt,
    provenance: { method: 'measured', sourceType: 'market_data', chain: null, locator: { provider: 'coingecko', endpoint: '/coins/markets', id: 'x', field: 'circulating_supply' }, codeVersion: 'test', configHash: 'h' },
  })).id;
}

/** A contract_state row with a given locator (the wrappers' old erc20_supply rows; a row of the current source). */
async function seedChain(d: Db, assetId: string, observedAt: string, value: number, locator: Locator): Promise<number> {
  return (await insertObservation(d, {
    assetId, metricKey: 'circulating_supply', observedAt, value, periodDays: null, fetchedAt: observedAt,
    provenance: { method: 'measured', sourceType: 'contract_state', chain: 'eip155:1', locator, blockFrom: 1, blockTo: 1, codeVersion: 'test', configHash: 'h' },
  })).id;
}

const obsCount = async (): Promise<number> => Number((await db().one<{ n: number }>('SELECT count(*)::bigint AS n FROM observations'))!.n);

const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return 'no error';
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'orion-supply-'));
  dirs.push(d);
  return d;
}

describe('rebuildSupplyLevels', () => {
  it('a CoinGecko row is rebuilt by the configured source at the first block at or after its observed_at; a revert at an old block is refused', async () => {
    const d = db();
    const rpc = chain();
    const cg = await seedMarket(d, 'cak', '2026-10-20T00:47:00.000Z', 1);
    const midnight = await seedMarket(d, 'cak', '2026-10-21T00:00:00.000Z', 2);
    // Before the escrow existed: its lockedSupply() reverts at that block -> refused, never a sum missing the term.
    const old = await seedMarket(d, 'cak', '2026-09-15T00:47:00.000Z', 3);
    const loaded = load(CAK_YAML);
    const current = fetchedProvenance(loaded, 'circulating_supply');
    const cur = await seedChain(d, 'cak', '2026-11-20T00:47:00.000Z', 4, current.locator);
    const before = await obsCount();

    const dry = await rebuildSupplyLevels(d, loaded, deps(rpc), { yes: false, now: NOW.toISOString() });
    expect(dry).toEqual({
      asset: 'cak', applied: false, metric: 'circulating_supply', rows: 3, rebuilt: 2, unchanged: 1,
      refused: [{ id: old, observedAt: '2026-09-15T00:47:00.000Z', reason: expect.stringMatching(/lockedSupply\(\) at block \d+: execution reverted/) }],
      notRebuildable: [], calls: expect.any(Number),
    });
    expect(dry.calls).toBeGreaterThan(3);
    expect(await obsCount()).toBe(before);
    expect(await d.one('SELECT 1 FROM day_blocks')).toBeUndefined();

    const r = await rebuildSupplyLevels(d, loaded, deps(rpc), { yes: true, now: NOW.toISOString(), release: 'orion-2026.11.21.1' });
    expect(r).toMatchObject({ applied: true, rows: 3, rebuilt: 2, unchanged: 1, refused: [{ id: old }] });
    expect(await obsCount()).toBe(before + 2);

    const b1 = rpc.blockAtOrAfter(sec('2026-10-20T00:47:00.000Z'));
    const b2 = rpc.blockAtOrAfter(sec('2026-10-21T00:00:00.000Z'));
    const rows = await d.all<{
      id: number; observed_at: string; value: number; method: string; source_type: string; chain: string; locator: Record<string, unknown>;
      block_from: string; block_to: string; superseded_by: number | null; code_version: string; config_hash: string; source_detail: string;
    }>(
      `SELECT id, observed_at, value, method, source_type, chain, locator, block_from, block_to, superseded_by, code_version, config_hash, source_detail
         FROM observations WHERE asset_id = 'cak' AND source_type <> 'market_data' AND id <> $1 ORDER BY observed_at`,
      [cur],
    );
    expect(rows.map((x) => [new Date(x.observed_at).toISOString(), x.value])).toEqual([
      ['2026-10-20T00:47:00.000Z', 850_000 + Number(b1)],
      ['2026-10-21T00:00:00.000Z', 850_000 + Number(b2)],
    ]);
    expect(rows[0]).toMatchObject({
      method: 'measured', source_type: 'contract_state', chain: 'eip155:56', superseded_by: null, code_version: 'orion-2026.11.21.1', config_hash: loaded.hash,
      locator: { ...current.locator, rebuilt: { at: NOW.toISOString(), release: 'orion-2026.11.21.1', from_id: cg } },
    });
    expect([Number(rows[0]!.block_from), Number(rows[0]!.block_to)]).toEqual([Number(b1), Number(b1)]);
    expect(rows[0]!.source_detail).toContain(`block ${b1}`);
    expect(rows[1]!.locator.rebuilt).toEqual({ at: NOW.toISOString(), release: 'orion-2026.11.21.1', from_id: midnight });
    // The midnight row's block is the day boundary: cached in day_blocks, as a scan would.
    expect(await d.all('SELECT chain_id, day::text AS day, first_block::text AS b FROM day_blocks')).toEqual([{ chain_id: 56, day: '2026-10-21', b: String(b2) }]);

    // The CoinGecko rows are superseded (never deleted here); the refused row is left active, value and all.
    const sup = new Map((await d.all<{ id: number; superseded_by: number | null; value: number }>(
      "SELECT id, superseded_by, value FROM observations WHERE source_type = 'market_data'",
    )).map((x) => [Number(x.id), x]));
    expect(sup.get(cg)!.superseded_by).not.toBeNull();
    expect(sup.get(midnight)!.superseded_by).not.toBeNull();
    expect(sup.get(old)).toMatchObject({ superseded_by: null, value: 3 });

    // A second dry run after --yes rebuilds 0: the rebuilt rows are the current source's (unchanged).
    const again = await rebuildSupplyLevels(d, loaded, deps(rpc), { yes: false, now: NOW.toISOString() });
    expect(again).toMatchObject({ rows: 1, rebuilt: 0, unchanged: 3, refused: [{ id: old }], notRebuildable: [] });
    const yes2 = await rebuildSupplyLevels(d, loaded, deps(rpc), { yes: true, now: NOW.toISOString() });
    expect(yes2.rebuilt).toBe(0);
    expect(await obsCount()).toBe(before + 2);
  });

  it("a wrapper's old erc20_supply (contract_state, totalSupply()) row is rebuilt; a row of the current adapter is unchanged", async () => {
    const d = db();
    const rpc = chain();
    const loaded = load(WRP_YAML);
    const oldLocator = { contracts: [WRAPPER], call: 'totalSupply()', args: [], subtract_balances: {} };
    const old = await seedChain(d, 'wrp', '2026-10-20T00:47:00.000Z', 2_100_000, oldLocator);
    const cur = await seedChain(d, 'wrp', '2026-11-19T00:47:00.000Z', 1, fetchedProvenance(loaded, 'circulating_supply').locator);
    const r = await rebuildSupplyLevels(d, loaded, deps(rpc), { yes: true, now: NOW.toISOString() });
    expect(r).toMatchObject({ rows: 1, rebuilt: 1, unchanged: 1, refused: [], notRebuildable: [] });
    const b = rpc.blockAtOrAfter(sec('2026-10-20T00:47:00.000Z'));
    const active = await listActiveObservations(d, 'wrp', 'circulating_supply');
    expect(active.map((o) => [o.observedAt, o.value])).toEqual([['2026-10-20T00:47:00.000Z', 1_700_000 + Number(b)], ['2026-11-19T00:47:00.000Z', 1]]);
    expect((await d.one<{ superseded_by: number | null }>('SELECT superseded_by FROM observations WHERE id = $1', [old]))!.superseded_by).not.toBeNull();
    expect((await d.one<{ superseded_by: number | null }>('SELECT superseded_by FROM observations WHERE id = $1', [cur]))!.superseded_by).toBeNull();
  });

  it('HYPE: an API source has no archive, every row is notRebuildable (listed with its day, untouched, no RPC opened)', async () => {
    const d = db();
    const a = await seedMarket(d, 'hyp', '2026-10-20T00:47:00.000Z', 1);
    const b = await seedMarket(d, 'hyp', '2026-10-21T00:47:00.000Z', 2);
    const loaded = load(HYP_YAML);
    const r = await rebuildSupplyLevels(d, loaded, noRpc, { yes: true, now: NOW.toISOString() });
    expect(r).toEqual({
      asset: 'hyp', applied: true, metric: 'circulating_supply', rows: 2, rebuilt: 0, unchanged: 0, refused: [], calls: 0,
      notRebuildable: [{ id: a, observedAt: '2026-10-20T00:47:00.000Z', day: '2026-10-20' }, { id: b, observedAt: '2026-10-21T00:47:00.000Z', day: '2026-10-21' }],
    });
    expect((await listActiveObservations(d, 'hyp', 'circulating_supply')).map((o) => o.value)).toEqual([1, 2]);
    expect(supplyNotRebuildable(loaded, '2026-11-20T00:00:00.000Z')).toBe(true);
  });

  it('AERO: rows before rebuild_from are notRebuildable; a row from that day on is rebuilt', async () => {
    const d = db();
    const rpc = chain();
    const loaded = load(AER_YAML('2026-11-10'));
    const pre = await seedMarket(d, 'aer', '2026-11-09T23:59:59.000Z', 1);
    const on = await seedMarket(d, 'aer', '2026-11-10T00:00:00.000Z', 2);
    const r = await rebuildSupplyLevels(d, loaded, deps(rpc), { yes: true, now: NOW.toISOString() });
    expect(r).toMatchObject({ rows: 2, rebuilt: 1, refused: [], notRebuildable: [{ id: pre, observedAt: '2026-11-09T23:59:59.000Z', day: '2026-11-09' }] });
    expect((await d.one<{ superseded_by: number | null }>('SELECT superseded_by FROM observations WHERE id = $1', [on]))!.superseded_by).not.toBeNull();
    expect((await d.one<{ superseded_by: number | null }>('SELECT superseded_by FROM observations WHERE id = $1', [pre]))!.superseded_by).toBeNull();
    expect(supplyNotRebuildable(loaded, '2026-11-09T23:59:59.999Z')).toBe(true);
    expect(supplyNotRebuildable(loaded, '2026-11-10T00:00:00.000Z')).toBe(false);
    expect(supplyNotRebuildable(load(CAK_YAML), '2020-01-01T00:00:00.000Z')).toBe(false);
  });

  it('run_in_progress while another holder has the asset lock; the dry run still classifies', async () => {
    const d = db();
    await seedMarket(d, 'cak', '2026-10-20T00:47:00.000Z', 1);
    const before = await obsCount();
    const held = await d.tryAssetRunLock('cak', 'tick pid 1');
    try {
      expect(await errCode(rebuildSupplyLevels(d, load(CAK_YAML), deps(chain()), { yes: true, now: NOW.toISOString() }))).toBe('run_in_progress');
      expect((await rebuildSupplyLevels(d, load(CAK_YAML), deps(chain()), { yes: false, now: NOW.toISOString() })).rebuilt).toBe(1);
    } finally {
      await held!.release();
    }
    expect(await obsCount()).toBe(before);
  });

  it('a metric without circulating_supply has nothing to rebuild', async () => {
    const r = await rebuildSupplyLevels(db(), load(`\nid: nos\nsymbol: NOS\nname: None\nmetrics:${REQUIRED}\n`), noRpc, { yes: false, now: NOW.toISOString() });
    expect(r).toEqual({ asset: 'nos', applied: false, metric: 'circulating_supply', rows: 0, rebuilt: 0, unchanged: 0, refused: [], notRebuildable: [], calls: 0 });
  });
});

describe('rebuild_from (Ruling R6)', () => {
  it('is an optional real ISO day on a level metric; anything else is refused at load', () => {
    expect(load(AER_YAML('2026-11-10')).config.metrics.circulating_supply!.rebuild_from).toBe('2026-11-10');
    expect(load(AER_YAML('"2026-11-10"')).config.metrics.circulating_supply!.rebuild_from).toBe('2026-11-10');
    expect(load(CAK_YAML).config.metrics.circulating_supply).not.toHaveProperty('rebuild_from');
    for (const bad of ['2026-02-30', '2026-11-10T00:00:00Z', '20261110', '"2026-1-10"', 'yesterday', '""']) {
      expect(() => parseAssetYaml(AER_YAML(bad)), bad).toThrow(/rebuild_from/);
    }
    const flow = `\nid: flo\nsymbol: FLO\nname: Flow\nmetrics:${REQUIRED}\n  flow_usd.fees: { type: flow, unit: usd, staleness_days: 4, rebuild_from: 2026-11-10 }\n`;
    expect(() => parseAssetYaml(flow)).toThrow(/rebuild_from/);
  });
});

describe('Review Focus 5: no circulating row is purged before its rebuild, except the notRebuildable ones', () => {
  const purge = async (d: Db, loaded: LoadedAsset, apply: boolean) =>
    await purgeMetrics(d as never, loaded, { metrics: ['circulating_supply'], sourceType: 'market_data', apply, exportDir: join(scratch(), 'purged'), now: NOW });

  it('CAKE: refused (dry run and --yes, nothing deleted) before the rebuild; after it the purge deletes them and every day keeps a level', async () => {
    const d = db();
    const days = ['2026-10-20', '2026-10-21', '2026-10-22'];
    const ids: number[] = [];
    for (const day of days) ids.push(await seedMarket(d, 'cak', `${day}T00:47:00.000Z`, 1));
    const loaded = load(CAK_YAML);
    const before = await obsCount();
    for (const apply of [false, true]) {
      let err: { code?: string; message?: string } = {};
      try {
        await purge(d, loaded, apply);
      } catch (e) {
        err = e as typeof err;
      }
      expect(err.code).toBe('purge_unreplaced_supply_level');
      expect(err.message).toContain(`#${ids[0]} 2026-10-20T00:47:00.000Z`);
      expect(err.message).toContain('rebuild-supply-levels');
      expect(await obsCount()).toBe(before);
    }
    await rebuildSupplyLevels(d, loaded, deps(chain()), { yes: true, now: NOW.toISOString() });
    const yes = await purge(d, loaded, true);
    expect(yes.perMetric).toMatchObject([{ metric: 'circulating_supply', observations: 3, superseded: 3, withoutReplacement: [] }]);
    expect(await d.one("SELECT 1 FROM observations WHERE source_type = 'market_data'")).toBeUndefined();
    const active = await listActiveObservations(d, 'cak', 'circulating_supply');
    for (const day of days) expect(latestLevel(active, `${day}T23:59:59.999Z`)!.observedAt.slice(0, 10)).toBe(day);
  });

  it('HYPE: allowed, every row deleted without replacement and listed (id, day)', async () => {
    const d = db();
    const a = await seedMarket(d, 'hyp', '2026-10-20T00:47:00.000Z', 1);
    const b = await seedMarket(d, 'hyp', '2026-10-21T00:47:00.000Z', 2);
    const withoutReplacement = [{ id: a, observedAt: '2026-10-20T00:47:00.000Z', day: '2026-10-20' }, { id: b, observedAt: '2026-10-21T00:47:00.000Z', day: '2026-10-21' }];
    expect((await purge(d, load(HYP_YAML), false)).perMetric).toMatchObject([{ observations: 2, withoutReplacement }]);
    expect((await purge(d, load(HYP_YAML), true)).perMetric).toMatchObject([{ observations: 2, withoutReplacement }]);
    expect(await d.one("SELECT 1 FROM observations WHERE asset_id = 'hyp'")).toBeUndefined();
  });

  it('AERO: rows before rebuild_from go without replacement; one on or after it with no rebuilt row refuses', async () => {
    const d = db();
    const pre = await seedMarket(d, 'aer', '2026-11-09T00:47:00.000Z', 1);
    const on = await seedMarket(d, 'aer', '2026-11-10T00:47:00.000Z', 2);
    const loaded = load(AER_YAML('2026-11-10'));
    let err: { code?: string; message?: string } = {};
    try {
      await purge(d, loaded, false);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe('purge_unreplaced_supply_level');
    expect(err.message).toContain(`#${on} `);
    expect(err.message).not.toContain(`#${pre} `);
    await rebuildSupplyLevels(d, loaded, deps(chain()), { yes: true, now: NOW.toISOString() });
    const yes = await purge(d, loaded, true);
    expect(yes.perMetric).toMatchObject([{ observations: 2, withoutReplacement: [{ id: pre, observedAt: '2026-11-09T00:47:00.000Z', day: '2026-11-09' }] }]);
  });

  it('a purge of another source type, or of another metric, is not a supply-level purge', async () => {
    const d = db();
    await seedMarket(d, 'cak', '2026-10-20T00:47:00.000Z', 1);
    const tp = await purgeMetrics(d as never, load(CAK_YAML), { metrics: ['circulating_supply'], sourceType: 'third_party', apply: false, exportDir: join(scratch(), 'purged'), now: NOW });
    expect(tp.perMetric[0]).not.toHaveProperty('withoutReplacement');
  });
});
