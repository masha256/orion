import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAsset } from '../../src/config/load.js';
import type { Observation } from '../../src/db/observations.js';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import type { SourceContext, SourceValue } from '../../src/ingest/types.js';
import { ADAPTER_ORIGINS, originOf, SERIES_ORIGIN } from '../../src/provenance/origin.js';
import { ADAPTER_SOURCE_TYPES } from '../../src/report/sourceTypes.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { ingestAsset, STAKING } from '../helpers/ingestAsset.js';
import { fixture, sourceCtx } from '../helpers/sourceCtx.js';

/**
 * Task 10 fix round 1 (review I-1): since 0006 a row's origin is read back from its provenance (`originOf`), so the origin
 * an adapter's writer stamps must be the one `originOf` gives for that adapter's provenance, or its own rows read back as
 * another origin (a contract-state series declared `onchain` would see its own rows as foreign conflicts and stall). Every
 * registered adapter is run once here on fakes; its writer's stamp (a level's or schedule's `source`; `SERIES_ORIGIN`
 * for a daily series or periodic payments, which `writeApiFlow` / `writePeriodicPayments` stamp) must equal
 * `originOf(measured, its rung, { adapter })`, and a contract-state adapter must be declared in ADAPTER_ORIGINS.
 */
type Stamp = 'onchain' | 'api';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DAY = 86_400_000;
const E18 = 10n ** 18n;

/** The origin the writer of this reading stamps; null for a monthly series (a cross-check, never stored). */
function stampOf(v: SourceValue): Stamp | null {
  switch (v.kind) {
    case 'level':
    case 'schedule_steps':
      return v.source;
    case 'daily_series':
    case 'periodic_payments':
      return SERIES_ORIGIN;
    case 'monthly_series':
      return null;
  }
}

/** Every adapter whose writer's stamp is not what `originOf` reads back for its provenance, as `name: stamp vs origin`. */
function mismatches(stamps: ReadonlyMap<string, Stamp | null>): string[] {
  const out: string[] = [];
  for (const [name, stamp] of stamps) {
    const sourceType = ADAPTER_SOURCE_TYPES[name];
    if (sourceType === 'contract_state' && ADAPTER_ORIGINS[name] === undefined) out.push(`${name}: a contract-state adapter missing from ADAPTER_ORIGINS`);
    if (stamp === null) continue;
    const origin = originOf({ method: 'measured', sourceType, locator: { adapter: name, params: {} }, formula: null });
    if (origin !== stamp) out.push(`${name}: stamps ${stamp}, reads back ${origin}`);
  }
  return out.sort();
}

// --- fakes, one successful read per adapter (shapes from the adapters' own tests) ---

const evm = async (calls: Record<string, bigint>, earlier: Record<string, bigint> = {}, names: Record<string, string> = {}) => {
  const rpc = fakeRpc({ genesisTs: 1_792_000_000, latest: 1_000_000n, calls, callsAt: (n) => (n < 1_000_000n ? earlier : undefined) });
  return sourceCtx({ rpc, block: await rpc.latestBlock(), contract: (n) => names[n] ?? (() => { throw new Error(`no contract ${n}`); })() });
};
const A = { token: '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee', ve: '0xbf7977e1521e9a3032bf7243ee4712f311f13915', minter: '0x59268a34ba897e82368fee39839ffc661d4f9c97', pool: '0xf634058dc94e6bf8e828e27621320c423bc8b18e', clpool: '0xd0acf293547457fb4fe9ee32ca93e89497626816', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', feed: '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b' };
const AERO_NAMES = { token: A.token, ve: A.ve, minter: A.minter, price_pool: A.pool, price_check_pool: A.clpool, usdc: A.usdc, usdc_usd_feed: A.feed };
const cum = (ts: number, k: bigint) => ({
  [`${callKey(A.pool, 'currentCumulativePrices')}[0]`]: 5n * E18 + 27_230_000n * E18 * k,
  [`${callKey(A.pool, 'currentCumulativePrices')}[1]`]: 7n + 15_570_000n * 10n ** 6n * k,
  [`${callKey(A.pool, 'currentCumulativePrices')}[2]`]: BigInt(ts),
});
const NOW_TS = 1_792_000_000 + 2 * 1_000_000;

const SOL_KEYED = 'https://solana-mainnet.g.alchemy.com/v2/sol_SECRETKEY';
const SOL_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
const SOL_NOW = '2026-10-16T06:00:00.000Z';
const supplyReply = (raw: string) => ({ jsonrpc: '2.0', id: 1, result: { context: { slot: 77 }, value: { amount: raw, decimals: 6, uiAmount: Number(raw) / 1e6 } } });
const solCtx = (over: Partial<SourceContext> = {}): SourceContext => {
  const pump = loadAsset(ROOT, 'pump').config;
  const http = fakeHttp({
    [SOL_KEYED]: (_u: string, body?: unknown) => ((body as { method: string }).method === 'getTokenSupply' ? supplyReply('896000000000000000') : { jsonrpc: '2.0', id: 1, result: { context: { slot: 78 }, value: [] } }),
    'https://api.coingecko.com/api/v3/coins/pump-fun/market_chart': (() => {
      const prices: [number, number][] = [];
      for (let t = Date.parse(SOL_NOW) - 30 * DAY; t <= Date.parse(SOL_NOW); t += 3_600_000) prices.push([t, 0.005]);
      return { prices, market_caps: [], total_volumes: [] };
    })(),
    'https://api.llama.fi/summary/fees/pump?dataType=dailyHoldersRevenue': (() => {
      const totalDataChart: [number, number][] = [];
      for (let t = Math.floor(Date.parse(SOL_NOW) / DAY) * DAY - 400 * DAY; t < Date.parse(SOL_NOW); t += DAY) totalDataChart.push([t / 1000, 1_000_000]);
      return { totalDataChart };
    })(),
  });
  return sourceCtx({ asset: pump, nowIso: SOL_NOW, http, env: { ORION_SOL_RPC_URL: SOL_KEYED }, ...over });
};
const supplyRow = (observedAt: string, value: number): Observation => ({
  id: 1, assetId: 'pump', metricKey: 'total_supply', observedAt, periodDays: null, value, source: 'onchain',
  sourceDetail: `solana getTokenSupply ${SOL_MINT} slot 1`, status: 'confirmed', citationUrl: null, quotedText: null, fetchedAt: observedAt, supersededBy: null,
});

const HL = 'https://api.hyperliquid.xyz/info';
const HL_FUND = '0xfefefefefefefefefefefefefefefefefefefefe';
const HL_INTEREST = '0x5000000000000000000000000000000000000000';
const hlRecorded = (name: string): unknown => JSON.parse(readFileSync(`${ROOT}/tests/fixtures/hype/${name}.json`, 'utf8')) as unknown;
const hypeCtx = (nowIso: string, route: (url: string, body?: unknown) => unknown): SourceContext => {
  const contracts: Record<string, string> = { assistance_fund: HL_FUND, system_interest: HL_INTEREST, aqa_treasury: '0x1111111111111111111111111111111111111111' };
  const asset = { ...ingestAsset().config, contracts, external_ids: { hyperliquid_info: HL, hyperliquid_token: '0x0d01dc56dcaaca66ad901c959b4011ec' } };
  return sourceCtx({ asset, nowIso, http: fakeHttp({ [HL]: route }), contract: (n) => contracts[n]! });
};
const hypeInfo = (_u: string, body?: unknown): unknown => {
  const { type } = body as { type: string };
  if (type === 'spotMetaAndAssetCtxs') return hlRecorded('spotMetaAndAssetCtxs');
  if (type === 'validatorSummaries') return hlRecorded('validatorSummaries');
  throw new Error(`no fixture for ${type}`);
};

const LIGHTER = 'https://mainnet.zklighter.elliot.ai/api/v1';
const VENICE = 'https://outerface.venice.ai/api/app/vvv';

const SAMPLES: Record<string, () => Promise<SourceValue>> = {
  'cake.emission_rate_annual': async () => {
    const chef = '0xa5f8c5dbd5f286960b9d90548680ae5ebff07652';
    const rpc = fakeRpc({ genesisTs: 1_790_000_000, blockTimeSec: 0.45, latest: 2_000_000n, calls: { [callKey(chef, 'cakePerBlock', [true])]: 40000000n, [callKey(chef, 'cakePerBlock', [false])]: 113292343840000000n } });
    return getAdapter('cake.emission_rate_annual').run(sourceCtx({ rpc, block: await rpc.latestBlock(), contract: () => chef }), {});
  },
  'chain.counter_rate': async () =>
    getAdapter('chain.counter_rate').run(await evm({ [callKey(A.minter, 'emissionsMinted')]: 10_000_000n * E18 }, { [callKey(A.minter, 'emissionsMinted')]: 3_000_000n * E18 }, AERO_NAMES), {
      contract: 'minter', function: 'emissionsMinted', direction: 'rise', days: 7,
    }),
  'chain.view_sum': async () =>
    getAdapter('chain.view_sum').run(await evm({ [callKey(A.token, 'totalSupply')]: 2_000n * E18, [callKey(A.ve, 'supply')]: 1_000n * E18 }, {}, AERO_NAMES), {
      terms: [{ contract: 'token', function: 'totalSupply' }, { contract: 've', function: 'supply', sign: -1 }],
    }),
  'chain.v2_pool_twap_price': async () => {
    const now = { ...cum(NOW_TS, 3600n), [callKey(A.pool, 'token0')]: BigInt(A.token), [callKey(A.pool, 'token1')]: BigInt(A.usdc), [callKey(A.feed, 'latestAnswer')]: 99_975_857n };
    return getAdapter('chain.v2_pool_twap_price').run(await evm(now, cum(NOW_TS - 3600, 0n), AERO_NAMES), { pool: 'price_pool', token: 'token', quote_decimals: 6, seconds: 3600, usd_feed: 'usdc_usd_feed' });
  },
  'chain.cl_pool_spot_price': async () => {
    const sqrt = BigInt(Math.round(Math.sqrt(0.5699e-12) * 2 ** 96));
    const live = { [`${callKey(A.clpool, 'slot0')}[0]`]: sqrt, [callKey(A.clpool, 'token0')]: BigInt(A.token), [callKey(A.clpool, 'token1')]: BigInt(A.usdc), [callKey(A.feed, 'latestAnswer')]: 99_975_857n };
    return getAdapter('chain.cl_pool_spot_price').run(await evm(live, {}, AERO_NAMES), { pool: 'price_check_pool', token: 'token', quote_decimals: 6, usd_feed: 'usdc_usd_feed' });
  },
  'crv.emission_rate_annual': async () => {
    const crv = '0xd533a949740bb3306d119cc777fa900ba034cd52';
    const rpc = fakeRpc({ genesisTs: 1791444000 - 12 * 500, blockTimeSec: 12, latest: 500n, calls: { [callKey(crv, 'rate')]: 3080982847903985532n, [callKey(crv, 'start_epoch_time')]: 1786573048n } });
    return getAdapter('crv.emission_rate_annual').run(sourceCtx({ rpc, block: await rpc.latestBlock(), contract: () => crv }), {});
  },
  'hype.total_supply': async () => getAdapter('hype.total_supply').run(hypeCtx('2026-09-24T12:00:00.000Z', hypeInfo), {}),
  'hype.staked_supply': async () => getAdapter('hype.staked_supply').run(hypeCtx('2026-09-24T12:00:00.000Z', hypeInfo), {}),
  'hype.emission_rate_annual': async () => getAdapter('hype.emission_rate_annual').run(hypeCtx('2026-09-24T12:00:00.000Z', hypeInfo), {}),
  'hype.fund_buys_daily': async () => {
    const today = Date.parse('2026-09-19T00:00:00Z');
    const fills = [{ time: today - DAY + 1000, coin: '@107', side: 'B', px: '40', sz: '2', hash: '0x1' }];
    const ctx = hypeCtx('2026-09-19T12:00:00.000Z', (_u, body) => {
      const b = body as { startTime: number; endTime: number };
      return fills.filter((x) => x.time >= b.startTime && x.time <= b.endTime);
    });
    return getAdapter('hype.fund_buys_daily').run(ctx, { pair: '@107', days: 3 });
  },
  'hype.reserve_yield_payments': async () => {
    const send = (iso: string, amount: string) => ({ time: Date.parse(iso), hash: `0x${Date.parse(iso)}`, delta: { type: 'send', token: 'USDC', user: HL_INTEREST, destination: HL_FUND, amount } });
    const ledger = [send('2026-09-09T10:00:00Z', '100'), send('2026-10-08T10:00:00Z', '50')];
    return getAdapter('hype.reserve_yield_payments').run(hypeCtx('2026-10-20T12:00:00.000Z', () => ledger), {
      interest: 'system_interest', fund: 'assistance_fund', treasury: ['aqa_treasury'], token: 'USDC', started: '2026-08-01', interval_days: 30, lag_days: 8,
    });
  },
  'lit.treasury_buys_daily': async () => {
    const today = Date.parse('2026-10-16T00:00:00Z');
    const trades = [{ timestamp: today - 1000, price: '3.0', size: '10', bid_account_id: 0, ask_account_id: 77, market_id: 2049 }];
    const http = fakeHttp({ [`${LIGHTER}/trades`]: () => ({ code: 200, trades }) });
    return getAdapter('lit.treasury_buys_daily').run(sourceCtx({ nowIso: '2026-10-16T12:00:00.000Z', http, backfillDays: 3 }), { account: 0, market: 2049 });
  },
  'lit.exchange_fees_daily': async () => {
    const today = Date.parse('2026-10-23T00:00:00Z');
    const rows = { code: 200, metrics: [2, 1, 0].map((ago) => ({ timestamp: (today - ago * DAY) / 1000, data: ago })) };
    const http = fakeHttp({ [`${LIGHTER}/exchangeMetrics`]: () => structuredClone(rows) });
    return getAdapter('lit.exchange_fees_daily').run(sourceCtx({ nowIso: '2026-10-23T12:00:00.000Z', http }), { kinds: ['maker_fee'], days: 2 });
  },
  'lit.app_fee_share': async () => {
    const app = 'https://app.lighter.xyz';
    const http = fakeHttp({
      [`${app}/stats`]: '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-AAA.js"></script></head></html>',
      [`${app}/assets/index-AAA.js`]: 'const a=()=>import("./exchange-stats-BBB.js");export{a};',
      [`${app}/assets/exchange-stats-BBB.js`]: 'var x=1;q=new Set([`maker_fee`,`taker_fee`,`transfer_fee`,`withdraw_fee`]);function zz(e){return q.has(e)?.5:1};var y=2;',
    });
    return getAdapter('lit.app_fee_share').run(sourceCtx({ nowIso: '2026-10-23T12:00:00.000Z', http }), {});
  },
  'lit.staking_pool': async () => {
    const pool = 281474976624800;
    const http = fakeHttp({
      [`${LIGHTER}/systemConfig`]: { staking_pool_index: pool },
      [`${LIGHTER}/account?by=index&value=${pool}`]: { code: 200, accounts: [{ index: pool, assets: [{ symbol: 'LIT', balance: '110921638.78926387' }] }] },
    });
    return getAdapter('lit.staking_pool').run(sourceCtx({ nowIso: '2026-10-23T12:00:00.000Z', http }), { field: 'staked' });
  },
  'lit.unlocks_next_year': async () => {
    const t0 = Date.parse('2026-12-29T00:00:00Z') / 1000;
    const linear = Array.from({ length: 1461 }, (_, i) => ({ timestamp: t0 + (i - 80) * 86_400, unlocked: Math.max(0, ((i - 80) * 1_661_000) / 7) }));
    const http = fakeHttp({ 'https://defillama-datasets.llama.fi/emissions/lighter': { documentedData: { data: [{ label: 'Team', data: linear }] } } });
    return getAdapter('lit.unlocks_next_year').run(sourceCtx({ nowIso: '2026-10-16T12:00:00.000Z', http }), { allocations: ['Team'] });
  },
  'solana.token_supply': async () => getAdapter('solana.token_supply').run(solCtx(), { mint: 'token' }),
  'solana.owner_balance': async () => getAdapter('solana.owner_balance').run(solCtx(), { mint: 'token', owner: 'burn_wallet_a' }),
  'solana.supply_burn_daily': async () =>
    getAdapter('solana.supply_burn_daily').run(solCtx({ observations: async (m) => (m === 'total_supply' ? [supplyRow('2026-10-14T06:00:00.000Z', 898e9), supplyRow('2026-10-15T06:00:00.000Z', 897e9)] : []) }), {
      mint: 'token', unit: 'usd', supply_metric: 'total_supply', days: 7, history: { slug: 'pump', data_type: 'dailyHoldersRevenue' },
    }),
  'vvv.staker_emission_share': async () => {
    const rpc = fakeRpc({
      genesisTs: 1_700_000_001, latest: 500n,
      calls: {
        [callKey(STAKING, 'veniceEmissionsPercentage')]: 0n, [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
        [callKey(STAKING, 'totalSupply')]: 100n * E18, [callKey(STAKING, 'totalLockedStakedVVV')]: 25n * E18,
      },
    });
    return getAdapter('vvv.staker_emission_share').run(sourceCtx({ rpc, block: await rpc.latestBlock() }), {});
  },
  'vvv.diem_target_supply': async () => {
    const calls: Record<string, bigint> = {};
    for (let i = 0; i < 256; i++) {
      const supply = 500 * (i + 1);
      calls[callKey(STAKING, 'diemSupply', [BigInt(i)])] = BigInt(supply) * E18;
      calls[callKey(STAKING, 'diemMintRates', [BigInt(i)])] = BigInt(Math.round(Math.min(90 * Math.exp(2 * (supply / 40_000) ** 3), 1e30) * 1e6)) * 10n ** 12n;
    }
    const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 500n, calls });
    return getAdapter('vvv.diem_target_supply').run(sourceCtx({ rpc, block: await rpc.latestBlock() }), {});
  },
  'vvv.staker_share_from_api': async () => {
    const url = `${VENICE}/vvv_staking_yield`;
    return getAdapter('vvv.staker_share_from_api').run(sourceCtx({ http: fakeHttp({ [url]: fixture('venice_vvv_staking_yield.json') }) }), { url });
  },
  'vvv.burn_history_tokens': async () => {
    const url = `${VENICE}/vvv_burn_history`;
    return getAdapter('vvv.burn_history_tokens').run(sourceCtx({ http: fakeHttp({ [url]: fixture('venice_vvv_burn_history.json') }) }), { url });
  },
};

describe('the adapter origin registry (review I-1)', () => {
  const stamps = new Map<string, Stamp | null>();
  beforeAll(async () => {
    for (const [name, sample] of Object.entries(SAMPLES)) stamps.set(name, stampOf(await sample()));
  });

  it('has one sample read for every registered adapter', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(adapterNames());
  });

  it("every adapter's writer stamps the origin its provenance reads back as", () => {
    expect(stamps.size).toBe(adapterNames().length);
    expect(mismatches(stamps)).toEqual([]);
    // The one contract-state adapter whose rows are `api`: its daily series goes through writeApiFlow.
    expect(stamps.get('solana.supply_burn_daily')).toBe('api');
  });

  it('fails when an entry is flipped', () => {
    const table = ADAPTER_ORIGINS as Record<string, Stamp>;
    for (const [name, flipped] of [['solana.supply_burn_daily', 'onchain'], ['chain.view_sum', 'api']] as const) {
      const was = table[name];
      table[name] = flipped;
      try {
        expect(mismatches(stamps)).toEqual([`${name}: stamps ${was}, reads back ${flipped}`]);
      } finally {
        table[name] = was;
      }
    }
    expect(mismatches(stamps)).toEqual([]);
  });

  it('fails when a contract-state adapter is missing from ADAPTER_ORIGINS', () => {
    const table = ADAPTER_ORIGINS as Record<string, Stamp>;
    const was = table['solana.supply_burn_daily'];
    delete table['solana.supply_burn_daily'];
    try {
      expect(mismatches(stamps)).toEqual([
        'solana.supply_burn_daily: a contract-state adapter missing from ADAPTER_ORIGINS',
        'solana.supply_burn_daily: stamps api, reads back onchain',
      ]);
    } finally {
      table['solana.supply_burn_daily'] = was;
    }
  });
});
