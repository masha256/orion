import { fileURLToPath } from 'node:url';
import { loadPrices, quoteRefOf, type PriceEntry, type PriceMethod } from '../../src/prices/config.js';
import { checkMethod, quoteTokenFor } from '../../src/prices/evmMethods.js';
import { callKey } from './fakeRpc.js';

/**
 * Fake chain reads for the live `price.token` / `price.token_check` adapters (Phase 3 R2 Task 6b): the multicall results
 * each prices.yaml method decodes to a wanted USD price at the run block, and (cumulative TWAPs) the values at the block
 * an hour earlier. Pool sides follow the token addresses (v2/Aerodrome/v3 pools sort their tokens by address).
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const PRICES = loadPrices(ROOT);
export const priceEntry = (symbol: string): PriceEntry => {
  const e = [...PRICES.values()].find((x) => x.symbol === symbol);
  if (!e) throw new Error(`no ${symbol} in prices.yaml`);
  return e;
};
export const priceRef = (symbol: string): string => priceEntry(symbol).ref;

export type Calls = Record<string, bigint | Error>;
export const k = (address: string, fn: string, args: readonly unknown[] = [], pick?: number): string => callKey(address, fn, args) + (pick === undefined ? '' : `[${pick}]`);

/** A Chainlink feed's latestRoundData: answer (8 decimals) at pick 1, updatedAt at pick 3. */
export const feedCalls = (address: string, usd: number, updatedAt: number): Calls => ({
  [k(address, 'latestRoundData', [], 1)]: BigInt(Math.round(usd * 1e8)),
  [k(address, 'latestRoundData', [], 3)]: BigInt(updatedAt),
});
const word = (x: bigint): bigint => (x < 0n ? (1n << 256n) + x : x);
const pow10 = (n: number): bigint => 10n ** BigInt(n);
/** x (a float) times 10^d as an integer, to 12 significant digits. */
const scaled = (x: number, d: number): bigint => {
  const e = Math.floor(Math.log10(x));
  const digits = 11 - e;
  const m = BigInt(Math.round(x * 10 ** digits));
  return d >= digits ? m * pow10(d - digits) : m / pow10(digits - d);
};

/** Default USD of the Chainlink feeds a quote reads: ETH 3,000; every stable 1. */
const ETH_FEEDS = new Set(['0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70']);
export const defaultFeedUsd = (feed: string): number => (ETH_FEEDS.has(feed.toLowerCase()) ? 3000 : 1);

export interface LiveWant {
  /** The primary's USD. */
  usd: number;
  /** The check's USD (default: the primary's, a zero gap). A `bound` check reads nothing of its own. */
  checkUsd?: number;
}

interface Built {
  /** Results at the run block. */
  end: Calls;
  /** Results at the block an hour before (the cumulative TWAPs' start; every other read falls through to `end`). */
  start: Calls;
}

const OFFCHAIN: ReadonlySet<string> = new Set(['hyperliquid_candle', 'lighter_candle', 'solana_vaults', 'meteora_dlmm']);
const tokenOf = (ref: string): string => ref.split('/')[1]!;
const chainIdOf = (ref: string): number => Number(/^eip155:(\d+)\//.exec(ref)![1]);

/**
 * The run-block (and hour-earlier) results that price each wanted EVM ref at `usd` by its primary and `checkUsd` by its
 * check, with the feeds at `feedUsd` (default ETH 3,000, stables 1) and quote refs at their own wanted USD (a quote ref
 * the method needs must be among `want`). `endTs`/`startTs` are the two blocks' timestamps.
 */
export function liveEvmCalls(want: Record<string, LiveWant>, o: { endTs: number; startTs: number; feedUsd?: Record<string, number> }): Built {
  const end: Calls = {};
  const start: Calls = {};
  const feeds = new Map<string, number>();
  const feedUsd = (f: string): number => o.feedUsd?.[f.toLowerCase()] ?? defaultFeedUsd(f);
  const addFeed = (f: string, usd: number) => {
    feeds.set(f.toLowerCase(), usd);
    Object.assign(end, feedCalls(f.toLowerCase(), usd, Math.floor(o.endTs) - 60));
  };
  const usdOf = (ref: string): number => {
    const w = want[ref];
    if (!w) throw new Error(`liveEvmCalls: quote ref ${ref} is not among the wanted refs`);
    return w.usd;
  };
  for (const [ref, w] of Object.entries(want)) {
    const e = PRICES.get(ref);
    if (!e) throw new Error(`liveEvmCalls: ${ref} is not in prices.yaml`);
    // An off-chain primary (LIT's Lighter candle) is not read here; its EVM check is (`usd` is then the check's).
    if (!OFFCHAIN.has(e.primary.kind)) method(e, e.primary, w.usd);
    const c = checkMethod(e.check);
    if (c.kind !== 'bound' && !OFFCHAIN.has(c.kind)) method(e, c, w.checkUsd ?? w.usd);
  }
  return { end, start };

  function method(e: PriceEntry, m: PriceMethod, usd: number): void {
    const token = tokenOf(e.ref);
    const chainId = chainIdOf(e.ref);
    if (m.kind === 'chainlink') return addFeed(m.feed, usd);
    const qref = quoteRefOf(m);
    const feed = (m as { usd_feed?: string }).usd_feed;
    const quoteUsd = qref !== undefined ? usdOf(qref) : feedUsd(feed!);
    if (feed !== undefined) addFeed(feed, quoteUsd);
    const quote = qref !== undefined ? { address: tokenOf(qref), decimals: PRICES.get(qref)!.decimals } : quoteTokenFor(chainId, feed!);
    if (!quote) throw new Error(`liveEvmCalls: no quote token for ${e.ref} ${m.kind}`);
    const inQuote = usd / quoteUsd;
    const td = e.decimals;
    const qd = quote.decimals;
    const tokenIs0 = BigInt(token) < BigInt(quote.address);
    const pool = (m as { pool?: string }).pool?.toLowerCase();
    const sides = () => {
      end[k(pool!, 'token0')] = BigInt(tokenIs0 ? token : quote.address);
      end[k(pool!, 'token1')] = BigInt(tokenIs0 ? quote.address : token);
    };
    // token1 raw units per token0 raw unit
    const raw1per0 = (tokenIs0 ? inQuote : 1 / inQuote) * 10 ** ((tokenIs0 ? qd : td) - (tokenIs0 ? td : qd));
    switch (m.kind) {
      case 'curve_oracle':
        end[m.index === undefined ? k(pool!, 'price_oracle') : k(pool!, 'price_oracle', [BigInt(m.index)])] = scaled(inQuote, 18);
        return;
      case 'curve_get_dy': {
        const fee = 4_000_000n; // 0.04% in 1e10
        const dx = m.dx ?? 1;
        end[k(pool!, 'get_dy', [BigInt(m.i), BigInt(m.j), BigInt(Math.round(dx * 1e6)) * pow10(td) / 1_000_000n])] = (scaled(inQuote * dx, qd) * (10n ** 10n - fee)) / 10n ** 10n;
        end[k(pool!, 'fee')] = fee;
        return;
      }
      case 'v2_twap': {
        sides();
        const dt = BigInt(Math.floor(o.endTs) - Math.floor(o.startTs));
        if (m.flavor === 'aerodrome') {
          const rToken = 1000n * pow10(td);
          const rQuote = scaled(inQuote * 1000, qd);
          const [r0, r1] = tokenIs0 ? [rToken, rQuote] : [rQuote, rToken];
          for (const [i, v] of [r0 * dt, r1 * dt, BigInt(Math.floor(o.endTs))].entries()) end[k(pool!, 'currentCumulativePrices', [], i)] = v;
          for (const [i, v] of [0n, 0n, BigInt(Math.floor(o.startTs))].entries()) start[k(pool!, 'currentCumulativePrices', [], i)] = v;
          return;
        }
        // Uniswap v2: priceXCumulativeLast stamped at each block (no fold-forward), reserves at the same ratio.
        const q112 = 2 ** 112;
        const c0 = scaled(raw1per0 * q112 * Number(dt), 0);
        const c1 = scaled((1 / raw1per0) * q112 * Number(dt), 0);
        end[k(pool!, 'price0CumulativeLast')] = c0;
        end[k(pool!, 'price1CumulativeLast')] = c1;
        start[k(pool!, 'price0CumulativeLast')] = 0n;
        start[k(pool!, 'price1CumulativeLast')] = 0n;
        for (const [calls, ts] of [[end, o.endTs], [start, o.startTs]] as const) {
          calls[k(pool!, 'getReserves', [], 0)] = 10n ** 24n;
          calls[k(pool!, 'getReserves', [], 1)] = scaled(raw1per0 * 1e24, 0);
          calls[k(pool!, 'getReserves', [], 2)] = BigInt(Math.floor(ts) % 2 ** 32);
        }
        return;
      }
      case 'v3_twap': {
        sides();
        const tick = Math.log(raw1per0) / Math.log(1.0001);
        const tc0 = -1_000_000n;
        end[k(pool!, 'observe', [[3600, 0]], 3)] = word(tc0);
        end[k(pool!, 'observe', [[3600, 0]], 4)] = word(tc0 + BigInt(Math.round(tick * 3600)));
        return;
      }
      case 'v3_spot':
        sides();
        end[k(pool!, 'slot0', [], 0)] = BigInt(Math.round(Math.sqrt(raw1per0) * 2 ** 96));
        return;
      case 'v4_spot': {
        const sv = m.state_view.toLowerCase();
        const id = m.pool_id.toLowerCase();
        end[k(sv, 'getSlot0', [id], 0)] = BigInt(Math.round(Math.sqrt(raw1per0) * 2 ** 96));
        end[k(sv, 'getLiquidity', [id])] = 10n ** 20n;
        return;
      }
      default:
        throw new Error(`liveEvmCalls: ${m.kind} is not an EVM method`);
    }
  }
}

// ---- off-chain venues ------------------------------------------------------------------------------------------------

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** The Ethereum USDC/USD feed the off-chain refs are multiplied by (Ruling R5). */
export const ETH_USDC_FEED = '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6';

/** Hyperliquid's info API answering allMids (HYPE spot @107 and the perp's mid). */
export const hyperliquidMids = (mids: Record<string, string>) => ({
  'https://api.hyperliquid.xyz/info': (_u: string, body?: unknown) => {
    if ((body as { type?: string } | undefined)?.type !== 'allMids') throw new Error(`hyperliquidMids: no fake for ${JSON.stringify(body)}`);
    return mids;
  },
});

/** Lighter's order book for a market: the best bid and ask. */
export const lighterBook = (marketId: number, bid: string, ask: string) => ({
  [`https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=${marketId}`]: { code: 200, total_asks: 1, asks: [{ price: ask, remaining_base_amount: '100' }], total_bids: 1, bids: [{ price: bid, remaining_base_amount: '100' }] },
});

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const out: number[] = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 0xffn));
  for (let i = 0; i < s.length && s[i] === '1'; i++) out.unshift(0);
  return Uint8Array.from(out);
}

/**
 * PUMP's live Solana reads: the PumpSwap vaults holding `pump` PUMP and `usdc` USDC (6 decimals each), and the Meteora
 * DLMM pair whose active bin prices PUMP at about `binUsdc` USDC. Only getMultipleAccounts is wired.
 */
export function pumpLiveAccounts(o: { pump: number; usdc: number; binUsdc: number }): { accounts: Record<string, unknown>; binUsdc: number } {
  const e = priceEntry('PUMP');
  if (e.primary.kind !== 'solana_vaults' || e.check.kind !== 'meteora_dlmm') throw new Error('PUMP methods moved');
  const mint = e.ref.split('/')[1]!;
  const account = (m: string, tokens: number) => ({ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { mint: m, tokenAmount: { amount: String(Math.round(tokens * 1e6)), decimals: 6 } } } } });
  const pair = Buffer.alloc(904);
  const activeId = Math.round(Math.log(o.binUsdc) / Math.log(1.002));
  pair.writeInt32LE(activeId, 76);
  pair.writeUInt16LE(20, 80);
  Buffer.from(b58decode(mint)).copy(pair, 88);
  Buffer.from(b58decode(USDC_MINT)).copy(pair, 120);
  const accounts: Record<string, unknown> = {
    [e.primary.base_vault]: account(mint, o.pump),
    [e.primary.quote_vault]: account(USDC_MINT, o.usdc),
    [e.check.pair]: { owner: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', data: [pair.toString('base64'), 'base64'] },
  };
  return { accounts, binUsdc: 1.002 ** activeId };
}

/** pumpLiveAccounts as a SolanaPriceTransport (getMultipleAccounts only), recording each request's keys. */
export function pumpLiveSolana(o: { pump: number; usdc: number; binUsdc: number }) {
  const { accounts, binUsdc } = pumpLiveAccounts(o);
  const calls: string[][] = [];
  const unwired = async (): Promise<never> => {
    throw new Error('pumpLiveSolana: only getMultipleAccounts is wired');
  };
  return {
    calls,
    binUsdc,
    getMultipleAccounts: async (keys: string[]) => {
      calls.push(keys);
      return keys.map((key) => (accounts[key] ?? null) as never);
    },
    slotAt: unwired, blockSignature: unwired, signaturesBefore: unwired, getTransaction: unwired,
  };
}
