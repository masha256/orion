import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetObject, rawConfig } from '../../src/config/load.js';
import { adapterNeedsRpc, getAdapter, type AdapterSource } from '../../src/ingest/adapters/registry.js';
import { compareLevel } from '../../src/ingest/crosscheck.js';
import type { RpcTransport } from '../../src/ingest/transport/rpc.js';
import type { SourceContext, SourceValue } from '../../src/ingest/types.js';
import type { PriceDeps } from '../../src/prices/types.js';
import { chainOfSource } from '../../src/provenance/locator.js';
import { sourceLabelOf, sourceTypeOf } from '../../src/report/sourceTypes.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { fakeRpc, type FakeRpc } from '../helpers/fakeRpc.js';
import { ETH_USDC_FEED, feedCalls, hyperliquidMids, lighterBook, liveEvmCalls, PRICES, priceRef, pumpLiveSolana, type Calls, type LiveWant } from '../helpers/livePrices.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

/**
 * Phase 3 R2 Task 6b: `price.token { ref }` is the live USD price of a prices.yaml ref by its primary (EVM at the run
 * block, TWAPs over the hour before it, quote refs priced the same way; off-chain venues read now), `price.token_check`
 * the same read by its check. Prices from the scoping rows the method tests use (LINK 12.5, cvxCRV 0.41377 CRV x CRV
 * 0.2335, SKY 0.0584, VVV 19.4017, HYPE 73.8355, LIT 3.3562 mid, PUMP 0.0034929).
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = '2026-11-13T12:30:00.000Z';
const NOW_TS = Date.parse(NOW) / 1000;

/** A chain whose latest block is at NOW, `blockTime` apart; `want` priced at the run block and an hour before. */
function chainAt(blockTime: number, want: Record<string, LiveWant>, over: { feedUsd?: Record<string, number>; extra?: Calls } = {}) {
  const latest = 5_000_000n;
  const genesisTs = NOW_TS - Number(latest) * blockTime;
  const startBlock = latest - BigInt(3600 / blockTime);
  const built = liveEvmCalls(want, { endTs: NOW_TS, startTs: NOW_TS - 3600, ...(over.feedUsd ? { feedUsd: over.feedUsd } : {}) });
  const rpc = fakeRpc({ genesisTs, latest, blockTimeSec: blockTime, calls: { ...built.end, ...over.extra }, callsAt: (n) => (n === startBlock ? built.start : undefined) });
  return { rpc, startBlock };
}

async function ctxFor(assetId: string, rpc: FakeRpc | null, deps: Partial<PriceDeps> & { chains?: Record<string, RpcTransport> } = {}): Promise<SourceContext> {
  const asset = loadAsset(ROOT, assetId).config;
  const priceDeps: PriceDeps = {
    rpcFor: (chain) => {
      const r = deps.chains?.[chain];
      if (!r) throw new Error(`no fake rpc for ${chain}`);
      return r;
    },
    solana: deps.solana ?? ({} as PriceDeps['solana']),
    http: deps.http ?? fakeHttp({}),
    now: new Date(NOW),
    prices: PRICES,
  };
  return sourceCtx({ asset, nowIso: NOW, rpc, block: rpc ? await rpc.latestBlock() : null, prices: PRICES, priceDeps });
}

const run = async (name: 'price.token' | 'price.token_check', ctx: SourceContext, ref: string): Promise<Extract<SourceValue, { kind: 'level' }>> => {
  const v = await getAdapter(name).run(ctx, { ref });
  if (v.kind !== 'level') throw new Error(`not a level: ${v.kind}`);
  return v;
};

describe('price.token / price.token_check on EVM methods, read at the run block', () => {
  it('a feed primary (LINK/USD 12.5) and its v3 TWAP check (LINK/WETH x ETH/USD at 12.6): one multicall serves both', async () => {
    const LINK = priceRef('LINK');
    const { rpc } = chainAt(12, { [LINK]: { usd: 12.5, checkUsd: 12.6 } });
    const ctx = await ctxFor('link', rpc);
    const p = await run('price.token', ctx, LINK);
    expect(p).toMatchObject({ value: 12.5, source: 'onchain', observedAt: NOW });
    expect(p.detail).toContain('by chain:chainlink at block 5000000');
    const c = await run('price.token_check', ctx, LINK);
    expect(c.value).toBeCloseTo(12.6, 6);
    expect(c.detail).toContain('check chain:v3_twap');
    expect(compareLevel(p.value, c.value, 2).ok).toBe(true);
    expect(rpc.stats.multicall).toBe(1);
  });

  it('a Curve EMA quoted in a ref quoted in a ref: cvxCRV 0.41377 CRV x CRV 0.2335 crvUSD x crvUSD 1, checked by get_dy', async () => {
    const [CVXCRV, CRV, CRVUSD] = [priceRef('cvxCRV'), priceRef('CRV'), priceRef('crvUSD')];
    const { rpc } = chainAt(12, { [CRVUSD]: { usd: 1 }, [CRV]: { usd: 0.2335 }, [CVXCRV]: { usd: 0.41377 * 0.2335, checkUsd: 0.42 * 0.2335 } });
    const ctx = await ctxFor('cvxcrv', rpc);
    expect((await run('price.token', ctx, CVXCRV)).value).toBeCloseTo(0.41377 * 0.2335, 9);
    expect((await run('price.token_check', ctx, CVXCRV)).value).toBeCloseTo(0.42 * 0.2335, 6);
    expect((await run('price.token', ctx, CRV)).value).toBeCloseTo(0.2335, 12);
  });

  it('a quote ref with no price at the block prices nothing: the read fails naming the reason, never a stale quote', async () => {
    const [CVXCRV, CRV, CRVUSD] = [priceRef('cvxCRV'), priceRef('CRV'), priceRef('crvUSD')];
    const { rpc } = chainAt(12, { [CRVUSD]: { usd: 1 }, [CRV]: { usd: 0.2335 }, [CVXCRV]: { usd: 0.0966 } }, { extra: { [`${'0xeef0c605546958c1f899b6fb336c20671f9cd49f'}.latestRoundData()[1]`]: new Error('execution reverted') } });
    await expect(run('price.token', await ctxFor('cvxcrv', rpc), CVXCRV)).rejects.toThrow(/cvxCRV .*no price at block 5000000.*quote_missing/);
  });

  it('a Uniswap v2 cumulative TWAP over [the block an hour before the run block, the run block]: SKY 0.0584 x USDS', async () => {
    const [SKY, USDS] = [priceRef('SKY'), priceRef('USDS')];
    const { rpc, startBlock } = chainAt(12, { [USDS]: { usd: 1 }, [SKY]: { usd: 0.0584, checkUsd: 0.0589 } });
    const ctx = await ctxFor('sky', rpc);
    const p = await run('price.token', ctx, SKY);
    expect(p.value).toBeCloseTo(0.0584, 9);
    expect(p.detail).toContain(`TWAP from block ${startBlock} (2026-11-13T11:30:00.000Z)`);
    expect((await run('price.token_check', ctx, SKY)).value).toBeCloseTo(0.0589, 8);
  });

  it('an Aerodrome reserve TWAP x ETH/USD (VVV 19.4017 at ETH 3,000) on Base, checked by the v3 VVV/USDC TWAP', async () => {
    const VVV = priceRef('VVV');
    const { rpc } = chainAt(2, { [VVV]: { usd: 19.4017, checkUsd: 19.5 } });
    const ctx = await ctxFor('vvv', rpc);
    expect((await run('price.token', ctx, VVV)).value).toBeCloseTo(19.4017, 6);
    expect((await run('price.token_check', ctx, VVV)).value).toBeCloseTo(19.5, 5);
  });

  it('DIEM chained through VVV: the Aerodrome DIEM/VVV TWAP x VVV\'s own price at the same blocks', async () => {
    const [VVV, DIEM] = [priceRef('VVV'), priceRef('DIEM')];
    const { rpc } = chainAt(2, { [VVV]: { usd: 19.4017 }, [DIEM]: { usd: 19.4017 * 21.5, checkUsd: 420 } });
    const ctx = await ctxFor('vvv', rpc);
    expect((await run('price.token', ctx, DIEM)).value).toBeCloseTo(19.4017 * 21.5, 4);
    expect((await run('price.token_check', ctx, DIEM)).value).toBeCloseTo(420, 3);
    expect((await run('price.token', ctx, VVV)).value).toBeCloseTo(19.4017, 6);
    // VVV's price is read once for both refs (the second read is the run's cache).
    expect(rpc.stats.multicall).toBe(2);
  });

  it('a ref off the asset\'s chain is read at that price chain\'s head (CAKE on BNB from an Ethereum run)', async () => {
    const CAKE = priceRef('CAKE');
    const bnb = chainAt(3, { [CAKE]: { usd: 1.74948, checkUsd: 1.75 } }).rpc;
    const eth = chainAt(12, {}).rpc;
    const ctx = await ctxFor('link', eth, { chains: { 'eip155:56': bnb } });
    expect((await run('price.token', ctx, CAKE)).value).toBeCloseTo(1.74948, 12);
    expect(eth.stats.multicall).toBe(0);
    expect(bnb.stats.multicall).toBe(1);
  });
});

describe('price.token_check on a bound check (sdCRV: 0.3-1.0 CRV, no independent venue)', () => {
  const [SDCRV, CRV, CRVUSD] = [priceRef('sdCRV'), priceRef('CRV'), priceRef('crvUSD')];

  it('inside the band the check is the primary itself: the cross-check gap is 0 at tolerance 0', async () => {
    const { rpc } = chainAt(12, { [CRVUSD]: { usd: 1 }, [CRV]: { usd: 0.2335 }, [SDCRV]: { usd: 0.85 * 0.2335 } });
    const ctx = await ctxFor('sdcrv', rpc);
    const p = await run('price.token', ctx, SDCRV);
    const c = await run('price.token_check', ctx, SDCRV);
    expect(c.value).toBe(p.value);
    expect(c.detail).toMatch(/\(band 0\.3-1\), gap 0\.0000%: inside/);
    expect(compareLevel(p.value, c.value, 0)).toEqual({ diffPct: 0, ok: true });
  });

  it('above the band the check is the 1.0 CRV bound in USD: the gap is the distance outside the band (a breach)', async () => {
    const { rpc } = chainAt(12, { [CRVUSD]: { usd: 1 }, [CRV]: { usd: 0.2335 }, [SDCRV]: { usd: 1.1 * 0.2335 } });
    const ctx = await ctxFor('sdcrv', rpc);
    const p = await run('price.token', ctx, SDCRV);
    const c = await run('price.token_check', ctx, SDCRV);
    expect(c.value).toBeCloseTo(0.2335, 10);
    expect(c.detail).toMatch(/outside, the nearer bound 1 x 0\.2335 USD/);
    expect(c.detail).toMatch(/gap 10\.0000%/);
    const cmp = compareLevel(p.value, c.value, 0);
    expect(cmp.ok).toBe(false);
    expect(cmp.diffPct).toBeCloseTo((0.1 / 1.1) * 100, 6);
  });
});

describe('price.token / price.token_check on the off-chain venues (x the Ethereum USDC/USD feed at its head)', () => {
  const usdcHead = () => fakeRpc({ genesisTs: NOW_TS - 12_000_000, latest: 1_000_000n, blockTimeSec: 12, calls: feedCalls(ETH_USDC_FEED, 0.99978, NOW_TS - 60) });

  it('Hyperliquid allMids["@107"] (73.8355), checked against the perp mid; first party (api), stamped at the fetch', async () => {
    const http = fakeHttp(hyperliquidMids({ '@107': '73.8355', HYPE: '73.795' }));
    const ctx = await ctxFor('hype', null, { http, chains: { 'eip155:1': usdcHead() } });
    const HYPE = priceRef('HYPE');
    const p = await run('price.token', ctx, HYPE);
    expect(p).toMatchObject({ source: 'api', observedAt: NOW });
    expect(p.value).toBeCloseTo(73.8355 * 0.99978, 10);
    expect((await run('price.token_check', ctx, HYPE)).value).toBeCloseTo(73.795 * 0.99978, 10);
    expect(http.calls).toHaveLength(1);
  });

  it('Lighter\'s order-book mid (3.3547 / 3.3577), checked against the v4 LIT/USDC pool on Ethereum (contract state)', async () => {
    const LIT = priceRef('LIT');
    // Only the check is read on chain (the primary is Lighter's book), at the same USDC/USD answer.
    const v4 = liveEvmCalls({ [LIT]: { usd: 3.3573 * 0.99978 } }, { endTs: NOW_TS, startTs: NOW_TS - 3600, feedUsd: { [ETH_USDC_FEED]: 0.99978 } });
    const eth = fakeRpc({ genesisTs: NOW_TS - 12_000_000, latest: 1_000_000n, blockTimeSec: 12, calls: v4.end });
    const ctx = await ctxFor('lit', eth, { http: fakeHttp(lighterBook(2049, '3.3547', '3.3577')), chains: { 'eip155:1': eth } });
    const p = await run('price.token', ctx, LIT);
    expect(p.source).toBe('api');
    expect(p.value).toBeCloseTo(3.3562 * 0.99978, 10);
    const c = await run('price.token_check', ctx, LIT);
    expect(c.source).toBe('onchain');
    expect(c.value).toBeCloseTo(3.3573 * 0.99978, 8);
  });

  it('PumpSwap\'s vault reserves (10.53M USDC / 3.0147B PUMP), checked against the Meteora DLMM active bin', async () => {
    const PUMP = priceRef('PUMP');
    const solana = pumpLiveSolana({ pump: 3_014_700_000, usdc: 10_530_000, binUsdc: 0.0034953 });
    const ctx = await ctxFor('pump', null, { solana, chains: { 'eip155:1': usdcHead() } });
    const p = await run('price.token', ctx, PUMP);
    expect(p.source).toBe('onchain');
    expect(p.value).toBeCloseTo((10_530_000 / 3_014_700_000) * 0.99978, 12);
    expect((await run('price.token_check', ctx, PUMP)).value).toBeCloseTo(solana.binUsdc * 0.99978, 12);
    expect(solana.calls).toHaveLength(1);
  });
});

describe('params, rungs and the run\'s RPC', () => {
  it('validateParams refuses an unknown key, a missing ref and (given prices.yaml) a ref not in it', () => {
    for (const name of ['price.token', 'price.token_check']) {
      const v = (p: Record<string, unknown>, withPrices = true) => getAdapter(name).validateParams!(p, withPrices ? { prices: PRICES } : {});
      expect(v({ ref: priceRef('CRV') })).toEqual([]);
      expect(v({ ref: priceRef('CRV'), quote: 'x' })).toEqual(['unknown param "quote" (ref)']);
      expect(v({})).toEqual(['ref must be a token ref named in prices.yaml']);
      expect(v({ ref: 'eip155:1/0x0000000000000000000000000000000000000001' })).toEqual(['ref eip155:1/0x0000000000000000000000000000000000000001 is not in prices.yaml']);
      expect(v({ ref: 'eip155:1/0x0000000000000000000000000000000000000001' }, false)).toEqual([]);
    }
  });

  it('an asset naming a ref not in prices.yaml is refused at load, naming the metric', () => {
    const raw = structuredClone(rawConfig(loadAsset(ROOT, 'crv'))) as { metrics: { price_usd: { source: { params: { ref: string } } } } };
    raw.metrics.price_usd.source.params.ref = 'eip155:1/0x0000000000000000000000000000000000000001';
    expect(() => parseAssetObject(raw, PRICES)).toThrow(/metrics\.price_usd\.source\.params: ref eip155:1\/0x0+1 is not in prices\.yaml/);
  });

  it('an unknown ref at the run refuses with unknown_price_ref, naming it', async () => {
    const { rpc } = chainAt(12, {});
    await expect(run('price.token', await ctxFor('crv', rpc), 'eip155:1/0x0000000000000000000000000000000000000001')).rejects.toMatchObject({ code: 'unknown_price_ref' });
  });

  it('rung, label, chain and RPC need follow the ref\'s method: EVM and Solana contract state, Hyperliquid and Lighter first party', () => {
    const rows = ['crv', 'cake', 'vvv', 'hype', 'lit', 'pump'].map((id) => {
      const { config } = loadAsset(ROOT, id);
      const def = config.metrics.price_usd!;
      const check = def.cross_checks![0]!.source as AdapterSource;
      return [id, sourceTypeOf(def, config.metrics), sourceLabelOf(def), chainOfSource(config, def.source!), adapterNeedsRpc(def.source as AdapterSource), sourceTypeOf({ ...def, source: check }), chainOfSource(config, check), adapterNeedsRpc(check)];
    });
    expect(rows).toEqual([
      ['crv', 'contract_state', 'contract_state:price.token', 'eip155:1', true, 'contract_state', 'eip155:1', true],
      ['cake', 'contract_state', 'contract_state:price.token', 'eip155:56', true, 'contract_state', 'eip155:56', true],
      ['vvv', 'contract_state', 'contract_state:price.token', 'eip155:8453', true, 'contract_state', 'eip155:8453', true],
      ['hype', 'first_party_api', 'first_party_api:price.token', 'hyperliquid:core', false, 'first_party_api', 'hyperliquid:core', false],
      ['lit', 'first_party_api', 'first_party_api:price.token', null, false, 'contract_state', 'eip155:1', true],
      ['pump', 'contract_state', 'contract_state:price.token', 'solana:mainnet', false, 'contract_state', 'solana:mainnet', false],
    ]);
  });
});
