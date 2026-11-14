import type { LoadedAsset } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import type { FetchDeps } from '../../src/ingest/run.js';
import type { ReceiptLog, TransferLog } from '../../src/ingest/transport/rpc.js';
import { fakePriceWriter, type FakePriceWriter } from './chainPrices.js';
import { fakeHttp, type FakeHttp, type Route } from './fakeHttp.js';
import { callKey, fakeRpc, type FakeRpc } from './fakeRpc.js';
import { ingestAsset, SINK, STAKING, TOKEN } from './ingestAsset.js';

export const NOW = new Date('2026-09-19T12:00:00.000Z');
/** Block 0 is ten days before NOW, on an odd second like Base. Two-second blocks. */
export const GENESIS_TS = NOW.getTime() / 1000 - 10 * 86_400 + 1;
/** The newest block at NOW. */
export const LATEST = BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / 2));

export const CG_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
export const STATS = 'https://api.example.test/stats';
export const LLAMA = 'https://api.llama.fi/summary/fees/mini';

const E18 = 10n ** 18n;

/** The mini token's ref (Base): the chain price every usd transfer_flow member of the mini asset is valued at. */
export const MINI_REF = 'eip155:8453/0x1111111111111111111111111111111111111111';

/** A healthy world: price 10 everywhere, 100 tokens of total supply, 50 staked, no emissions. */
export function defaultRoutes(): Record<string, Route> {
  return {
    [CG_MARKETS]: [{ id: 'mini-token', current_price: 10, market_cap: 600, circulating_supply: 60 }],
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
  /** The chain price writer the fetch uses (a fake: price 10 every hour unless `price` says otherwise). */
  prices: FakePriceWriter;
}

/** The fetch world on `db` (the test's database: see tests/helpers/db.ts). */
export function harness(
  db: Db,
  over: {
    loaded?: LoadedAsset;
    routes?: Record<string, Route>;
    calls?: Record<string, bigint | Error>;
    logs?: Omit<TransferLog, 'timestamp'>[];
    /** Runtime code by lowercased address, for clone detection. */
    code?: Record<string, string>;
    receipts?: Record<string, ReceiptLog[]>;
    env?: Record<string, string | undefined>;
    now?: Date;
    /** Compute the RPC's latest block from this time instead of `now`, so a test can put the chain head ahead of (or behind) the fetch's `now` independently of `deps.now()`. */
    rpcNow?: Date;
    /** The chain price of a ref at an hour (null: no price). Default: 10 for every ref and hour. */
    price?: (ref: string, hourMs: number) => number | null;
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
    code: over.code,
    receipts: over.receipts,
  });
  const prices = fakePriceWriter(over.price ?? (() => 10));
  const deps: FetchDeps = {
    http,
    priceWriter: prices,
    rpcFactory: () => rpc,
    env: over.env ?? { TEST_RPC_URL: 'http://rpc.test' },
    sleep: async () => undefined,
    now: () => new Date(now.getTime() + 5000),
  };
  return { db, loaded: over.loaded ?? ingestAsset(), deps, http, rpc, prices };
}
