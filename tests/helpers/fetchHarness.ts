import type { LoadedAsset } from '../../src/config/load.js';
import { openDb, type Db } from '../../src/db/connection.js';
import type { FetchDeps } from '../../src/ingest/run.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { fakeHttp, type FakeHttp, type Route } from './fakeHttp.js';
import { callKey, fakeRpc, type FakeRpc } from './fakeRpc.js';
import { ingestAsset, SINK, STAKING, TOKEN } from './ingestAsset.js';

export const NOW = new Date('2026-09-19T12:00:00.000Z');
/** Block 0 is ten days before NOW, on an odd second like Base. Two-second blocks. */
export const GENESIS_TS = NOW.getTime() / 1000 - 10 * 86_400 + 1;
/** The newest block at NOW. */
export const LATEST = BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / 2));

export const CG_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
export const CG_CHART = 'https://api.coingecko.com/api/v3/coins/mini-token/market_chart';
export const STATS = 'https://api.example.test/stats';
export const LLAMA = 'https://api.llama.fi/summary/fees/mini';

const E18 = 10n ** 18n;

/** One price point per hour from `fromIso` up to and including `toIso`. */
export function hourlyPrices(fromIso: string, toIso: string, priceAt: (ms: number) => number): { prices: [number, number][] } {
  const prices: [number, number][] = [];
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 3_600_000) prices.push([t, priceAt(t)]);
  return { prices };
}

/** A healthy world: price 10 everywhere, 100 tokens of effective supply, 50 staked, no emissions. */
export function defaultRoutes(): Record<string, Route> {
  return {
    [CG_MARKETS]: [{ id: 'mini-token', current_price: 10, market_cap: 600, circulating_supply: 60 }],
    [CG_CHART]: hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', () => 10),
    [STATS]: { price: '10.1', supply: { totalBaseUnit: (100n * E18).toString() } },
    [LLAMA]: { totalDataChart: [] },
  };
}

export function defaultCalls(): Record<string, bigint | Error> {
  return {
    [callKey(TOKEN, 'totalSupply')]: 150n * E18,
    [callKey(TOKEN, 'decimals')]: 18n,
    [callKey(TOKEN, 'balanceOf', [SINK])]: 50n * E18,
    [callKey(STAKING, 'totalSupply')]: 50n * E18,
    [callKey(STAKING, 'emissionRatePerSecond')]: 0n,
  };
}

export interface Harness {
  db: Db;
  loaded: LoadedAsset;
  deps: FetchDeps;
  http: FakeHttp;
  rpc: FakeRpc;
}

export function harness(
  over: {
    db?: Db;
    loaded?: LoadedAsset;
    routes?: Record<string, Route>;
    calls?: Record<string, bigint | Error>;
    logs?: Omit<TransferLog, 'timestamp'>[];
    env?: Record<string, string | undefined>;
    now?: Date;
    /** Compute the RPC's latest block from this time instead of `now`, so a test can put the chain head ahead of (or behind) the fetch's `now` independently of `deps.now()`. */
    rpcNow?: Date;
  } = {},
): Harness {
  const now = over.now ?? NOW;
  const rpcNow = over.rpcNow ?? now;
  const http = fakeHttp({ ...defaultRoutes(), ...over.routes });
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    latest: BigInt(Math.floor((rpcNow.getTime() / 1000 - GENESIS_TS) / 2)),
    calls: { ...defaultCalls(), ...over.calls },
    logs: over.logs ?? [],
  });
  const deps: FetchDeps = {
    http,
    rpcFactory: () => rpc,
    env: over.env ?? { TEST_RPC_URL: 'http://rpc.test' },
    sleep: async () => undefined,
    now: () => new Date(now.getTime() + 5000),
  };
  return { db: over.db ?? openDb(':memory:'), loaded: over.loaded ?? ingestAsset(), deps, http, rpc };
}
