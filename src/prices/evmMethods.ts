import type { BlockRef, CallResult, ContractCall, RpcTransport } from '../ingest/transport/rpc.js';
import { unitsToNumber } from '../ingest/units.js';
import { OrionError } from '../types.js';
import { methodSource, quoteRefOf, type PriceCheck, type PriceEntry, type PriceMethod } from './config.js';
import type { HourPrice } from './types.js';

/**
 * The EVM price methods of prices.yaml (Phase 3 R2, plan P2): every primary, check and feed of one chain's refs for one
 * hour bucket [H, H+1h) is read in one multicall at B(H+1h) (`at.end`); a cumulative TWAP also reads the same calls at
 * B(H) (`at.start`), which the previous (older) hour reads as its end, so with a shared BlockReadCache a writer walking
 * hours in order pays one multicall per chain-hour. Refs are then resolved in quote order (crvUSD -> CRV -> cvxCRV;
 * VVV -> DIEM) from that one result: a ref whose quote has no price for the hour gets none either (Review Focus 2).
 *
 * The pure pool decoders AERO's adapters use (src/ingest/adapters/evm.ts) live here too: sideOf, reserveTwap,
 * sqrtPriceInQuote.
 */

// ---- pure decoders (shared with src/ingest/adapters/evm.ts) ------------------------------------------------------------

/** Which side of a pool `token` is on, from the pool's token0()/token1() read as integers: 0, 1, or a refusal. */
export function sideOf(t0: bigint, t1: bigint, token: string, pool: string): 0 | 1 {
  const want = BigInt(token);
  if (t0 === want) return 0;
  if (t1 === want) return 1;
  throw new Error(`pool ${pool} does not hold ${token}`);
}

/**
 * An Aerodrome/Velodrome basic pool's time-weighted reserves between two `currentCumulativePrices()` readings
 * (reserve0Cumulative, reserve1Cumulative, blockTimestamp): quote per token.
 */
export function reserveTwap(
  end: readonly [bigint, bigint, bigint],
  start: readonly [bigint, bigint, bigint],
  which: 0 | 1,
  tokenDecimals: number,
  quoteDecimals: number,
): { dt: number; inQuote: number } {
  const [c0, c1, t] = end;
  const [s0, s1, st] = start;
  const dt = Number(t - st);
  if (!(dt > 0)) throw new Error(`no time elapsed between the pool's cumulative readings (${st} -> ${t})`);
  const r0 = Number(c0 - s0) / dt;
  const r1 = Number(c1 - s1) / dt;
  const [rToken, rQuote] = which === 0 ? [r0, r1] : [r1, r0];
  if (!(rToken > 0 && rQuote > 0)) throw new Error(`time-weighted reserves are not positive (${r0}, ${r1})`);
  return { dt, inQuote: rQuote / 10 ** quoteDecimals / (rToken / 10 ** tokenDecimals) };
}

/** A concentrated-liquidity pool's sqrtPriceX96 (token1 raw units per token0 raw unit, squared): quote per token. */
export function sqrtPriceInQuote(sqrt: bigint, which: 0 | 1, tokenDecimals: number, quoteDecimals: number): number {
  if (!(sqrt > 0n)) throw new Error('slot0 sqrtPriceX96 is zero');
  const raw = (Number(sqrt) / 2 ** 96) ** 2; // token1 raw units per token0 raw unit
  return (which === 0 ? raw : 1 / raw) * 10 ** (tokenDecimals - quoteDecimals);
}

const U256 = 1n << 256n;
const U32 = 1n << 32n;
const Q112 = 1n << 112n;

/**
 * A Uniswap v2 pair's price cumulatives as of block time `blockTs`: the stored `priceXCumulativeLast` folded forward
 * from `blockTimestampLast` at the reserves `getReserves` reports (what `_update` would add on the next touch; UQ112x112,
 * uint32 time, wrapping modulo 2^256 as the pair does).
 */
export function uniV2Cumulatives(last0: bigint, last1: bigint, r0: bigint, r1: bigint, tsLast: bigint, blockTs: number): [bigint, bigint] {
  const elapsed = (((BigInt(blockTs) % U32) - tsLast) % U32 + U32) % U32;
  if (elapsed === 0n || r0 === 0n || r1 === 0n) return [last0, last1];
  return [(last0 + ((r1 * Q112) / r0) * elapsed) % U256, (last1 + ((r0 * Q112) / r1) * elapsed) % U256];
}

/** (cumulativeEnd - cumulativeStart) / dt of the token's side, in quote per token. */
export function uniV2Twap(end: readonly [bigint, bigint], start: readonly [bigint, bigint], dt: number, which: 0 | 1, tokenDecimals: number, quoteDecimals: number): number {
  if (!(dt > 0)) throw new Error(`no time elapsed between the TWAP blocks (${dt} s)`);
  const diff = (((end[which] - start[which]) % U256) + U256) % U256;
  return (Number(diff) / dt / 2 ** 112) * 10 ** (tokenDecimals - quoteDecimals);
}

/** A uint256 word as the signed integer it encodes (two's complement): an int56 tick cumulative read as a word. */
export const toSigned = (w: bigint): bigint => (w >= 1n << 255n ? w - U256 : w);

// ---- quote tokens ------------------------------------------------------------------------------------------------------

/**
 * The token a pool method's `usd_feed` prices, by chain and feed (lowercased): the pool's other side and its decimals.
 * A pool quoted in a ref finds both in that ref instead. Canonical deployments; the pool's own token0()/token1() are
 * read every hour and must agree, so a wrong row prices nothing rather than something wrong.
 */
const QUOTE_TOKENS: Record<string, { symbol: string; address: string; decimals: number }> = {
  '1/0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419': { symbol: 'WETH', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 },
  '1/0x8fffffd4afb6115b954bd326cbe7b4ba576818f6': { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  '1/0x3e7d1eab13ad0104d2750b8863b489d65364e32d': { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
  '56/0xb97ad0e74fa7d920791e90258a6e2085088b4320': { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
  '8453/0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70': { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  '8453/0x7e860098f58bbfc8648a4311b374b1d669a2bc6b': { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
};

export function quoteTokenFor(chainId: number, usdFeed: string): { symbol: string; address: string; decimals: number } | null {
  return QUOTE_TOKENS[`${chainId}/${usdFeed.toLowerCase()}`] ?? null;
}

const POOL_KINDS: ReadonlySet<string> = new Set(['v2_twap', 'v3_twap', 'v3_spot', 'v4_spot']);
export const EVM_METHOD_KINDS: ReadonlySet<string> = new Set(['chainlink', 'curve_oracle', 'curve_get_dy', 'v2_twap', 'v3_twap', 'v3_spot', 'v4_spot', 'bound']);

// ---- calls and decoding ------------------------------------------------------------------------------------------------

export interface HourBlocks {
  /** B(H): the first block at or after the hour start. */
  start: BlockRef;
  /** B(H+1h): the block every method reads at. */
  end: BlockRef;
}

/** A read at one of the hour's two blocks. */
export interface HourCall extends ContractCall {
  at: 'start' | 'end';
}

/** What a method needs to know about the ref it prices. */
export interface MethodCtx {
  chainId: number;
  /** The priced token's address (lowercased). */
  token: string;
  decimals: number;
  /** The decimals of a quote ref's token, if that ref is known. */
  quoteDecimals(ref: string): number | null;
}

export interface MethodValue {
  usd: number;
  detail: Record<string, unknown>;
}
/** A method that gives no value this hour, and why: `call_failed`, `quote_missing`, `zero_liquidity`, `bad_read`... */
export interface MethodMiss {
  usd: null;
  reason: string;
  detail: Record<string, unknown>;
}
export type MethodRead = MethodValue | MethodMiss;

const FEED_SIG = 'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)';
const FEED_DECIMALS = 8;
const uint = (name: string, input = ''): string => `function ${name}(${input}) view returns (uint256)`;
const CUM = 'function currentCumulativePrices() view returns (uint256, uint256, uint256)';
const RESERVES = 'function getReserves() view returns (uint112, uint112, uint32)';
/** observe's (int56[], uint160[]) return read as its 8 raw words: offsets, then length 2 and tickCumulatives[0..1]. */
const OBSERVE = 'function observe(uint32[] secondsAgos) view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)';
const SLOT0 = 'function slot0() view returns (uint256, uint256, uint256, uint256, uint256, uint256)';
const V4_SLOT0 = 'function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)';
const V4_LIQUIDITY = 'function getLiquidity(bytes32 poolId) view returns (uint128)';
const GET_DY = 'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)';

const lc = (a: string) => a.toLowerCase();
const call = (at: 'start' | 'end', address: string, signature: string, functionName: string, extra: { args?: readonly unknown[]; pick?: number } = {}): HourCall => ({
  at,
  address: lc(address),
  signature,
  functionName,
  ...extra,
});
const tokenCalls = (pool: string): HourCall[] => [call('end', pool, uint('token0'), 'token0'), call('end', pool, uint('token1'), 'token1')];

export function feedCalls(feed: string): HourCall[] {
  return [call('end', feed, FEED_SIG, 'latestRoundData', { pick: 1 }), call('end', feed, FEED_SIG, 'latestRoundData', { pick: 3 })];
}

/** dx in coin i's raw units (dx tokens, default 1). */
function dxRaw(dx: number | undefined, decimals: number): bigint {
  const micro = BigInt(Math.round((dx ?? 1) * 1e6));
  return (micro * 10n ** BigInt(decimals)) / 1_000_000n;
}

/**
 * The calls one method reads for one hour, in the order `decode` takes their results. A `usd_feed` quote is not among
 * them: feeds are read once per chain-hour (feedCalls) and handed to decode as `feedUsd`.
 */
export function callsFor(m: PriceMethod, _at: HourBlocks, ctx: MethodCtx): HourCall[] {
  switch (m.kind) {
    case 'chainlink':
      return feedCalls(m.feed);
    case 'curve_oracle':
      return m.index === undefined
        ? [call('end', m.pool, uint('price_oracle'), 'price_oracle')]
        : [call('end', m.pool, uint('price_oracle', 'uint256'), 'price_oracle', { args: [BigInt(m.index)] })];
    case 'curve_get_dy':
      return [call('end', m.pool, GET_DY, 'get_dy', { args: [BigInt(m.i), BigInt(m.j), dxRaw(m.dx, ctx.decimals)] }), call('end', m.pool, uint('fee'), 'fee')];
    case 'v2_twap': {
      const at = (side: 'start' | 'end'): HourCall[] =>
        m.flavor === 'aerodrome'
          ? [0, 1, 2].map((pick) => call(side, m.pool, CUM, 'currentCumulativePrices', { pick }))
          : [
              call(side, m.pool, uint('price0CumulativeLast'), 'price0CumulativeLast'),
              call(side, m.pool, uint('price1CumulativeLast'), 'price1CumulativeLast'),
              ...[0, 1, 2].map((pick) => call(side, m.pool, RESERVES, 'getReserves', { pick })),
            ];
      return [...tokenCalls(m.pool), ...at('end'), ...at('start')];
    }
    case 'v3_twap':
      return [...tokenCalls(m.pool), ...[3, 4].map((pick) => call('end', m.pool, OBSERVE, 'observe', { args: [[m.seconds, 0]], pick }))];
    case 'v3_spot':
      return [...tokenCalls(m.pool), call('end', m.pool, SLOT0, 'slot0', { pick: 0 })];
    case 'v4_spot':
      return [call('end', m.state_view, V4_SLOT0, 'getSlot0', { args: [lc(m.pool_id)], pick: 0 }), call('end', m.state_view, V4_LIQUIDITY, 'getLiquidity', { args: [lc(m.pool_id)] })];
    case 'bound':
      return [];
    default:
      throw new OrionError('invalid_price_config', `${m.kind} is not an EVM price method`);
  }
}

/** A Chainlink answer (8 decimals) and its age at B(H+1h). A stale answer is priced, with its age (Review Focus 3). */
export function decodeFeed(feed: string, raw: readonly bigint[], at: HourBlocks): MethodRead {
  const [answer, updatedAt] = raw;
  const detail = { feed: lc(feed), answer: String(answer), updated_at: Number(updatedAt), feed_age_s: at.end.timestamp - Number(updatedAt) };
  if (!(answer > 0n)) return { usd: null, reason: 'not_positive', detail };
  return { usd: unitsToNumber(answer, FEED_DECIMALS), detail };
}

interface Quote {
  usd: number;
  address: string | null;
  decimals: number | null;
  detail: Record<string, unknown>;
}

/** The USD price of a method's quote: its quote ref's price this hour, or its feed's answer this hour. */
function quoteOf(m: PriceMethod, ctx: MethodCtx, quoteUsd: (ref: string) => number | null, feedUsd: Map<string, number>): Quote | MethodMiss {
  const q = quoteRefOf(m);
  if (q !== undefined) {
    const usd = quoteUsd(q);
    if (usd === null) return { usd: null, reason: 'quote_missing', detail: { quote: { ref: q } } };
    return { usd, address: q.startsWith('eip155:') ? lc(q.split('/')[1]) : null, decimals: ctx.quoteDecimals(q), detail: { quote: { ref: q, usd } } };
  }
  const feed = (m as { usd_feed?: string }).usd_feed;
  if (feed === undefined) throw new OrionError('invalid_price_config', `${m.kind} has neither quote_ref nor usd_feed`);
  const usd = feedUsd.get(lc(feed));
  if (usd === undefined) return { usd: null, reason: 'quote_missing', detail: { quote: { feed: lc(feed) } } };
  const token = POOL_KINDS.has(m.kind) ? quoteTokenFor(ctx.chainId, feed) : null;
  return { usd, address: token?.address ?? null, decimals: token?.decimals ?? null, detail: { quote: { feed: lc(feed), usd } } };
}

/** The pool's token0/token1 must be the priced token and the quote; which side the priced token is on. */
function poolSide(pool: string, t0: bigint, t1: bigint, ctx: MethodCtx, quote: Quote): 0 | 1 {
  const which = sideOf(t0, t1, ctx.token, lc(pool));
  const other = which === 0 ? t1 : t0;
  if (quote.address === null || other !== BigInt(quote.address)) {
    throw new Error(`pool ${lc(pool)} pairs ${ctx.token} with 0x${other.toString(16).padStart(40, '0')}, not the quote ${quote.address ?? '(unknown)'}`);
  }
  return which;
}

function quoteDecimalsOf(quote: Quote): number {
  if (quote.decimals === null) throw new Error(`the quote's decimals are unknown (${JSON.stringify(quote.detail.quote)})`);
  return quote.decimals;
}

/**
 * One method's USD value for the hour from its calls' results (in callsFor order). A quoted method multiplies by the
 * quote ref's price (`quoteUsd`) or its feed's answer (`feedUsd`, keyed by the lowercased feed address); either missing
 * gives `quote_missing`, never a stale quote. A `bound` gives its quote's price (the band is applied by withCheck).
 */
export function decode(
  m: PriceMethod,
  raw: readonly bigint[],
  at: HourBlocks,
  ctx: MethodCtx,
  quoteUsd: (ref: string) => number | null,
  feedUsd: Map<string, number>,
): MethodRead {
  const base: Record<string, unknown> = { method: m.kind, block: String(at.end.number) };
  if (m.kind === 'chainlink') {
    const f = decodeFeed(m.feed, raw, at);
    return { ...f, detail: { ...base, ...f.detail } } as MethodRead;
  }
  const quote = quoteOf(m, ctx, quoteUsd, feedUsd);
  if (quote.usd === null) return { ...quote, detail: { ...base, ...quote.detail } };
  const q = quote as Quote;
  const value = (inQuote: number, extra: Record<string, unknown>): MethodRead =>
    Number.isFinite(inQuote) && inQuote > 0
      ? { usd: inQuote * q.usd, detail: { ...base, ...extra, in_quote: inQuote, ...q.detail } }
      : { usd: null, reason: 'not_positive', detail: { ...base, ...extra, in_quote: inQuote, ...q.detail } };
  try {
    switch (m.kind) {
      case 'curve_oracle':
        return value(unitsToNumber(raw[0], 18), { pool: lc(m.pool), price_oracle: String(raw[0]), ...(m.index === undefined ? {} : { index: m.index }) });
      case 'curve_get_dy': {
        const [dy, fee] = raw;
        const dx = m.dx ?? 1;
        const qd = quoteDecimalsOf(q);
        const feeFrac = Number(fee) / 1e10;
        return value(unitsToNumber(dy, qd) / dx / (1 - feeFrac), { pool: lc(m.pool), i: m.i, j: m.j, dx, get_dy: String(dy), fee: String(fee) });
      }
      case 'v2_twap': {
        const which = poolSide(m.pool, raw[0], raw[1], ctx, q);
        const qd = quoteDecimalsOf(q);
        if (m.flavor === 'aerodrome') {
          const [c0, c1, t, s0, s1, st] = raw.slice(2);
          const { dt, inQuote } = reserveTwap([c0, c1, t], [s0, s1, st], which, ctx.decimals, qd);
          return value(inQuote, { pool: lc(m.pool), flavor: m.flavor, side: which, twap_s: dt, start_block: String(at.start.number) });
        }
        const [e0, e1, er0, er1, ets, s0, s1, sr0, sr1, sts] = raw.slice(2);
        const end = uniV2Cumulatives(e0, e1, er0, er1, ets, at.end.timestamp);
        const start = uniV2Cumulatives(s0, s1, sr0, sr1, sts, at.start.timestamp);
        const dt = at.end.timestamp - at.start.timestamp;
        return value(uniV2Twap(end, start, dt, which, ctx.decimals, qd), { pool: lc(m.pool), flavor: m.flavor, side: which, twap_s: dt, start_block: String(at.start.number) });
      }
      case 'v3_twap': {
        const which = poolSide(m.pool, raw[0], raw[1], ctx, q);
        const [w0, w1] = raw.slice(2);
        const meanTick = Number(toSigned(w1) - toSigned(w0)) / m.seconds;
        const p = 1.0001 ** meanTick; // token1 raw per token0 raw
        return value((which === 0 ? p : 1 / p) * 10 ** (ctx.decimals - quoteDecimalsOf(q)), { pool: lc(m.pool), side: which, twap_s: m.seconds, mean_tick: meanTick });
      }
      case 'v3_spot': {
        const which = poolSide(m.pool, raw[0], raw[1], ctx, q);
        return value(sqrtPriceInQuote(raw[2], which, ctx.decimals, quoteDecimalsOf(q)), { pool: lc(m.pool), side: which, sqrt_price_x96: String(raw[2]) });
      }
      case 'v4_spot': {
        const [sqrt, liquidity] = raw;
        const detail = { ...base, state_view: lc(m.state_view), pool_id: lc(m.pool_id), sqrt_price_x96: String(sqrt), liquidity: String(liquidity), ...q.detail };
        if (liquidity === 0n) return { usd: null, reason: 'zero_liquidity', detail: { ...detail, skipped: 'zero_liquidity' } };
        if (q.address === null) throw new Error(`the quote's token is unknown (${JSON.stringify(q.detail.quote)})`);
        // v4 sorts a pool's currencies by address: currency0 is the lower one.
        const which: 0 | 1 = BigInt(ctx.token) < BigInt(q.address) ? 0 : 1;
        return value(sqrtPriceInQuote(sqrt, which, ctx.decimals, quoteDecimalsOf(q)), { state_view: lc(m.state_view), pool_id: lc(m.pool_id), side: which, sqrt_price_x96: String(sqrt), liquidity: String(liquidity) });
      }
      case 'bound':
        return { usd: q.usd, detail: { ...base, min_in_quote: m.min_in_quote, max_in_quote: m.max_in_quote, ...q.detail } };
      default:
        throw new OrionError('invalid_price_config', `${m.kind} is not an EVM price method`);
    }
  } catch (err) {
    if (err instanceof OrionError) throw err;
    return { usd: null, reason: 'bad_read', detail: { ...base, error: err instanceof Error ? err.message : String(err) } };
  }
}

// ---- checks ------------------------------------------------------------------------------------------------------------

/** The check's label stored with every row: its source, plus its config label. */
export function checkLabel(check: PriceCheck): string {
  return check.label === undefined ? methodSource(check) : `${methodSource(check)}:${check.label}`;
}

/** The method part of a check (its tolerance and label stripped). */
export function checkMethod(check: PriceCheck): PriceMethod {
  const { tolerancePct: _t, consecutive: _c, label: _l, ...m } = check;
  return m as PriceMethod;
}

/**
 * The ref's HourPrice from its primary's value and its check's read (null: not read). The gap is (check - primary) /
 * primary x 100; for a `bound` check, the primary in the quote's units outside [min, max] as % of the nearer bound, 0
 * inside. An unread check gives checkGapPct null with the reason in detail.check.skipped. Exported for an entry whose
 * primary is off-chain and whose check is read here (LIT): the writer combines the two.
 */
export function withCheck(entry: PriceEntry, primary: { usd: number; source: string; detail: Record<string, unknown> }, check: MethodRead | null): HourPrice {
  const out = (checkGapPct: number | null, checkDetail: Record<string, unknown>): HourPrice => ({
    usd: primary.usd,
    source: primary.source,
    checkGapPct,
    check: checkLabel(entry.check),
    detail: { ...primary.detail, check: checkDetail },
  });
  if (check === null) return out(null, { skipped: 'not_read' });
  if (check.usd === null) return out(null, { ...check.detail, skipped: check.reason });
  if (entry.check.kind === 'bound') {
    const inQuote = primary.usd / check.usd;
    const { min_in_quote: min, max_in_quote: max } = entry.check;
    const gap = inQuote < min ? ((inQuote - min) / min) * 100 : inQuote > max ? ((inQuote - max) / max) * 100 : 0;
    return out(gap, { ...check.detail, in_quote: inQuote });
  }
  return out(((check.usd - primary.usd) / primary.usd) * 100, { ...check.detail, usd: check.usd });
}

// ---- one chain-hour ----------------------------------------------------------------------------------------------------

/** Results of earlier multicalls by block number and call key, so a block read for one hour serves the next one. */
export type BlockReadCache = Map<bigint, Map<string, CallResult>>;

export interface EvmHourOptions {
  /** More Chainlink feeds to read this hour (the writer asks chain 1 for the off-chain refs' USDC/USD, Ruling R5). */
  feeds?: string[];
  cache?: BlockReadCache;
}

export interface EvmHourResult {
  /** Every ref of the chain whose primary priced this hour (with its check's outcome). */
  prices: Map<string, HourPrice>;
  /** The USD answer of every feed read this hour, keyed by the lowercased feed address (Ruling R5). */
  feedUsd: Map<string, number>;
  /** The check reads of entries whose primary is off-chain but whose check is read on this chain (LIT's v4_spot). */
  checks: Map<string, MethodRead>;
  /** Refs that got no price this hour, and why. */
  missing: { ref: string; reason: string; detail: Record<string, unknown> }[];
}

const keyOf = (c: ContractCall): string => `${lc(c.address)}.${c.functionName}(${JSON.stringify(c.args ?? [], (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))})${c.pick === undefined ? '' : `[${c.pick}]`}`;
const EVM_REF = /^eip155:(\d+)\/(0x[0-9a-f]{40})$/;

async function readBlock(rpc: RpcTransport, block: bigint, calls: ContractCall[], cache: BlockReadCache): Promise<Map<string, CallResult>> {
  let got = cache.get(block);
  if (!got) cache.set(block, (got = new Map()));
  const want = new Map<string, ContractCall>();
  for (const c of calls) {
    const key = keyOf(c);
    if (!got.has(key) && !want.has(key)) want.set(key, c);
  }
  if (want.size > 0) {
    const list = [...want.entries()];
    const results = await rpc.multicall(
      list.map(([, c]) => ({ address: c.address, signature: c.signature, functionName: c.functionName, ...(c.args ? { args: c.args } : {}), ...(c.pick !== undefined ? { pick: c.pick } : {}) })),
      block,
    );
    list.forEach(([key], i) => got.set(key, results[i] ?? { ok: false, error: 'no result' }));
  }
  return got;
}

/**
 * Prices one chain's refs for one hour bucket from one multicall at B(H+1h) (and, for a cumulative TWAP, the same
 * calls at B(H)). `entries` are the chain's refs (chain `eip155:<id>`) plus any entry whose primary is off-chain but
 * whose check is an EVM method on this chain (its check read lands in `checks`). Quote refs must be among `entries`.
 */
export async function priceHourEvm(rpc: RpcTransport, entries: PriceEntry[], at: HourBlocks, opts: EvmHourOptions = {}): Promise<EvmHourResult> {
  const byRef = new Map(entries.map((e) => [e.ref, e]));
  const chainIds = new Set<number>();
  const ctxOf = (e: PriceEntry): MethodCtx => {
    const m = EVM_REF.exec(e.ref);
    if (!m) throw new OrionError('invalid_price_config', `${e.ref}: an EVM price method needs an eip155 token ref`);
    return { chainId: Number(m[1]), token: m[2], decimals: e.decimals, quoteDecimals: (r) => byRef.get(r)?.decimals ?? null };
  };
  const full = entries.filter((e) => e.chain.startsWith('eip155:'));
  const checkOnly = entries.filter((e) => !e.chain.startsWith('eip155:') && EVM_METHOD_KINDS.has(e.check.kind) && e.check.kind !== 'bound');

  // The plan: every method's calls, and every feed (the chain's own, the quotes', and the extra ones).
  type Planned = { entry: PriceEntry; role: 'primary' | 'check'; m: PriceMethod; ctx: MethodCtx; calls: HourCall[] };
  const planned: Planned[] = [];
  const feeds = new Set<string>((opts.feeds ?? []).map(lc));
  const plan = (entry: PriceEntry, role: 'primary' | 'check', m: PriceMethod) => {
    const ctx = ctxOf(entry);
    chainIds.add(ctx.chainId);
    const feed = (m as { usd_feed?: string }).usd_feed;
    if (feed !== undefined) {
      feeds.add(lc(feed));
      if (POOL_KINDS.has(m.kind) && quoteTokenFor(ctx.chainId, feed) === null) {
        throw new OrionError('invalid_price_config', `${entry.ref}.${role}: no quote token is known for usd_feed ${feed} on chain ${ctx.chainId}`);
      }
    }
    if (m.kind === 'chainlink') feeds.add(lc(m.feed));
    planned.push({ entry, role, m, ctx, calls: callsFor(m, at, ctx) });
  };
  for (const e of full) {
    plan(e, 'primary', e.primary);
    if (EVM_METHOD_KINDS.has(e.check.kind)) plan(e, 'check', checkMethod(e.check));
  }
  for (const e of checkOnly) plan(e, 'check', checkMethod(e.check));
  if (chainIds.size > 1) throw new OrionError('invalid_price_config', `one chain-hour reads one chain, got ${[...chainIds].join(', ')}`);

  const all: HourCall[] = [...planned.flatMap((p) => p.calls), ...[...feeds].flatMap(feedCalls)];
  const cache = opts.cache ?? new Map();
  // Every call is read at both blocks when any method needs B(H): the older hour then finds its B(H+1h) read cached.
  const endRead = await readBlock(rpc, at.end.number, all, cache);
  const startRead = all.some((c) => c.at === 'start') ? await readBlock(rpc, at.start.number, all, cache) : new Map<string, CallResult>();
  const results = (calls: HourCall[]): { raw: bigint[] } | { error: string } => {
    const raw: bigint[] = [];
    for (const c of calls) {
      const r = (c.at === 'start' ? startRead : endRead).get(keyOf(c));
      if (!r || !r.ok) return { error: `${c.functionName}(${(c.args ?? []).map(String).join(',')}) at block ${c.at === 'start' ? at.start.number : at.end.number}: ${r ? r.error : 'not read'}` };
      raw.push(r.value);
    }
    return { raw };
  };

  const feedUsd = new Map<string, number>();
  for (const f of feeds) {
    const r = results(feedCalls(f));
    if ('raw' in r) {
      const v = decodeFeed(f, r.raw, at);
      if (v.usd !== null) feedUsd.set(f, v.usd);
    }
  }

  const prices = new Map<string, HourPrice>();
  const missing: EvmHourResult['missing'] = [];
  const quoteUsd = (r: string): number | null => prices.get(r)?.usd ?? null;
  const read = (p: Planned): MethodRead => {
    const r = results(p.calls);
    if ('error' in r) return { usd: null, reason: 'call_failed', detail: { method: p.m.kind, error: r.error } };
    return decode(p.m, r.raw, at, p.ctx, quoteUsd, feedUsd);
  };

  // Primaries in quote order: a ref waits while its quote ref is still to be priced this hour.
  const primaries = planned.filter((p) => p.role === 'primary');
  const primaryRead = new Map<string, MethodRead>();
  const pending = new Set(primaries.map((p) => p.entry.ref));
  while (pending.size > 0) {
    const ready = primaries.filter((p) => pending.has(p.entry.ref) && !pending.has(quoteRefOf(p.m) ?? ''));
    if (ready.length === 0) throw new OrionError('invalid_price_config', `quote refs form a cycle among ${[...pending].join(', ')}`);
    for (const p of ready) {
      pending.delete(p.entry.ref);
      const v = read(p);
      primaryRead.set(p.entry.ref, v);
      if (v.usd !== null) prices.set(p.entry.ref, { usd: v.usd, source: methodSource(p.entry.primary), checkGapPct: null, check: checkLabel(p.entry.check), detail: v.detail });
      else missing.push({ ref: p.entry.ref, reason: v.reason, detail: v.detail });
    }
  }

  // Checks, once every primary is known (a check may be quoted in another ref: cvxCRV's get_dy in CRV).
  const checks = new Map<string, MethodRead>();
  for (const p of planned.filter((x) => x.role === 'check')) {
    const v = read(p);
    if (!p.entry.chain.startsWith('eip155:')) {
      checks.set(p.entry.ref, v);
      continue;
    }
    const priced = prices.get(p.entry.ref);
    if (priced) prices.set(p.entry.ref, withCheck(p.entry, { usd: priced.usd, source: priced.source, detail: priced.detail }, v));
  }
  // A priced ref whose check is not an EVM method (none today) keeps checkGapPct null with the reason.
  for (const e of full) {
    if (EVM_METHOD_KINDS.has(e.check.kind)) continue;
    const priced = prices.get(e.ref);
    if (priced) prices.set(e.ref, withCheck(e, priced, null));
  }
  return { prices, feedUsd, checks, missing };
}
