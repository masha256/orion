import { quoteRefOf, type PriceEntry } from '../../prices/config.js';
import { checkMethod, priceHourEvm, type BlockReadCache, type HourBlocks } from '../../prices/evmMethods.js';
import { livePriceOffchain } from '../../prices/offchainMethods.js';
import type { HourPrice } from '../../prices/types.js';
import { priceSourceVenue, priceVenue, type PriceAdapterName } from '../../prices/venue.js';
import { OrionError } from '../../types.js';
import { firstBlockAtOrAfter, type BlockRef, type RpcTransport } from '../transport/rpc.js';
import { NoReading, type SourceContext, type SourceValue } from '../types.js';
import type { AdapterDef, AdapterSource, AdapterValidateContext } from './registry.js';

/**
 * The live USD price of a token ref by its prices.yaml methods (Phase 3 R2 Task 6b): every asset's `price_usd` (and
 * VVV's `diem_price_usd`) reads `price.token { ref }`, its cross-check `price.token_check { ref }`. The methods are the
 * hourly writer's own (src/prices/evmMethods.ts, offchainMethods.ts), read once now:
 *
 * - an EVM primary at the run block (the asset's own RPC and block when the ref is on its ingest chain, else the price
 *   chain's head), a cumulative TWAP over [the first block at or after run block - 1 h, run block], a v3 TWAP over the
 *   hour `observe` ends at the run block, a quote ref priced the same way at the same blocks (CRV in crvUSD, DIEM in VVV);
 * - an off-chain primary by livePriceOffchain: Hyperliquid's allMids, Lighter's order-book mid, PumpSwap's vault reserves
 *   now, each x the Ethereum USDC/USD feed at the head.
 *
 * price.token_check is the check of the same read (one read per run serves both): its USD value, or for a `bound` check
 * (sdCRV: 0.3-1.0 CRV) the primary itself inside the band and the nearer bound in USD outside it, so the cross-check's gap
 * is the distance outside the band (0 inside; the detail names the band and the primary in the quote's units). A check
 * pool with zero in-range liquidity gives no reading (NoReading): the cross-check is skipped. Ruling R22: only CAKE, LINK,
 * LIT, PUMP, UNI and VVV use it as a cross-check (the assets that had a price_usd cross-check before R2); the others'
 * checks run hourly in the writer (ORION WATCH, never an anomaly).
 */

type Params = Record<string, unknown>;

/** One run's live read per ref, shared by price.token and price.token_check (and by refs quoted in each other). */
const READS = new WeakMap<SourceContext, Map<string, Promise<LiveRead>>>();
const CACHES = new WeakMap<SourceContext, BlockReadCache>();

interface LiveRead {
  entry: PriceEntry;
  price: HourPrice;
  observedAt: string;
  /** Where it was read: `block <n> (<iso>) on <chain>`, or the off-chain venue's time. */
  at: string;
}

function validate(p: Params, ctx?: AdapterValidateContext): string[] {
  const out = Object.keys(p).filter((k) => k !== 'ref').map((k) => `unknown param "${k}" (ref)`);
  if (typeof p.ref !== 'string' || p.ref === '') out.push('ref must be a token ref named in prices.yaml');
  else if (ctx?.prices && ctx.prices.size > 0 && !ctx.prices.has(p.ref)) out.push(`ref ${p.ref} is not in prices.yaml`);
  return out;
}

function entryOf(ctx: SourceContext, ref: unknown): PriceEntry {
  if (typeof ref !== 'string') throw new OrionError('invalid_source_config', 'price adapter: params.ref must be a token ref');
  const entry = ctx.prices?.get(ref);
  if (!entry) throw new OrionError('unknown_price_ref', `price adapter: ${ref} is not in prices.yaml (or the run has no prices.yaml)`);
  return entry;
}

const iso = (tsSec: number): string => new Date(tsSec * 1000).toISOString();

/** The ref and every quote ref its primary and check are priced in, transitively (they must be on its chain). */
function quoteClosure(ctx: SourceContext, entry: PriceEntry): PriceEntry[] {
  const out = new Map<string, PriceEntry>();
  const visit = (e: PriceEntry) => {
    if (out.has(e.ref)) return;
    if (e.chain !== entry.chain) throw new OrionError('invalid_price_config', `${entry.ref}: quote ref ${e.ref} is priced on ${e.chain}, not ${entry.chain}`);
    out.set(e.ref, e);
    for (const q of [quoteRefOf(e.primary), quoteRefOf(checkMethod(e.check))]) if (q !== undefined) visit(entryOf(ctx, q));
  };
  visit(entry);
  return [...out.values()];
}

/** The chain's RPC and the block to read at: the run's own on the asset's ingest chain, else the price chain's head. */
async function evmAt(ctx: SourceContext, chain: string): Promise<{ rpc: RpcTransport; block: BlockRef }> {
  if (ctx.rpc && ctx.block && ctx.asset.ingest && `eip155:${ctx.asset.ingest.chain_id}` === chain) return { rpc: ctx.rpc, block: ctx.block };
  if (!ctx.priceDeps) throw new OrionError('no_price_transport', `price adapter: ${chain} is not the asset's chain and the run has no price transports`);
  const rpc = ctx.priceDeps.rpcFor(chain);
  return { rpc, block: await rpc.latestBlock() };
}

async function readEvm(ctx: SourceContext, entry: PriceEntry): Promise<LiveRead> {
  const entries = quoteClosure(ctx, entry);
  const { rpc, block } = await evmAt(ctx, entry.chain);
  const cumulative = entries.some((e) => e.primary.kind === 'v2_twap' || e.check.kind === 'v2_twap');
  const start = cumulative ? await firstBlockAtOrAfter(rpc, block.timestamp - 3600, block, block) : block;
  const at: HourBlocks = { start, end: block };
  let cache = CACHES.get(ctx);
  if (!cache) CACHES.set(ctx, (cache = new Map()));
  const r = await priceHourEvm(rpc, entries, at, { cache });
  const price = r.prices.get(entry.ref);
  const where = `block ${block.number} (${iso(block.timestamp)}) on ${entry.chain}${cumulative ? `, TWAP from block ${start.number} (${iso(start.timestamp)})` : ''}`;
  if (!price) {
    const miss = r.missing.find((m) => m.ref === entry.ref);
    throw new Error(`${entry.symbol} (${entry.ref}): no price at ${where}: ${miss ? `${miss.reason} ${JSON.stringify(miss.detail)}` : 'not priced'}`);
  }
  return { entry, price, observedAt: iso(block.timestamp), at: where };
}

async function readOffchain(ctx: SourceContext, entry: PriceEntry): Promise<LiveRead> {
  if (!ctx.priceDeps) throw new OrionError('no_price_transport', `price adapter: ${entry.ref} is priced on ${entry.chain} and the run has no price transports`);
  const price = await livePriceOffchain(ctx.priceDeps, entry);
  return { entry, price, observedAt: ctx.nowIso, at: `${entry.chain} at ${ctx.nowIso}` };
}

/** The run's live read of `ref` (made once per run). A failed read is not kept, so a later adapter of the run retries. */
function liveRead(ctx: SourceContext, ref: unknown): Promise<LiveRead> {
  const entry = entryOf(ctx, ref);
  let reads = READS.get(ctx);
  if (!reads) READS.set(ctx, (reads = new Map()));
  const hit = reads.get(entry.ref);
  if (hit) return hit;
  const p = entry.chain.startsWith('eip155:') ? readEvm(ctx, entry) : readOffchain(ctx, entry);
  reads.set(entry.ref, p);
  void p.catch(() => reads.delete(entry.ref));
  return p;
}

const stampOf = (name: PriceAdapterName, entry: PriceEntry): 'onchain' | 'api' => (priceVenue(name, entry).rung === 'first_party_api' ? 'api' : 'onchain');
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

async function token(ctx: SourceContext, p: Params): Promise<SourceValue> {
  const r = await liveRead(ctx, p.ref);
  const { entry, price } = r;
  const gap = price.checkGapPct === null ? 'not read' : `${price.checkGapPct.toFixed(4)}%`;
  return {
    kind: 'level', value: price.usd, observedAt: r.observedAt, source: stampOf('price.token', entry),
    detail: `${entry.symbol} ${entry.ref} by ${price.source} at ${r.at}: ${price.usd} USD; check ${price.check} gap ${gap}`,
  };
}

async function tokenCheck(ctx: SourceContext, p: Params): Promise<SourceValue> {
  const r = await liveRead(ctx, p.ref);
  const { entry, price } = r;
  const check = (price.detail.check ?? {}) as Record<string, unknown>;
  const stamp = stampOf('price.token_check', entry);
  const level = (value: number, detail: string): SourceValue => ({ kind: 'level', value, observedAt: r.observedAt, source: stamp, detail: `${entry.symbol} ${entry.ref} check ${price.check} at ${r.at}: ${detail}` });
  // Zero in-range liquidity (LIT's v4 pool) is no reading, not a failure (Ruling R22): the cross-check is skipped.
  if (check.skipped === 'zero_liquidity') throw new NoReading(`${entry.symbol} (${entry.ref}): check ${price.check} not read at ${r.at}: zero_liquidity`);
  if (typeof check.skipped === 'string') throw new Error(`${entry.symbol} (${entry.ref}): check ${price.check} not read at ${r.at}: ${check.skipped}${typeof check.error === 'string' ? ` (${check.error})` : ''}`);
  if (entry.check.kind === 'bound') {
    const inQuote = num(check.in_quote);
    const quoteUsd = num((check.quote as { usd?: unknown } | undefined)?.usd);
    if (inQuote === null || quoteUsd === null) throw new Error(`${entry.symbol} (${entry.ref}): bound check without the primary in its quote (${JSON.stringify(check)})`);
    const { min_in_quote: min, max_in_quote: max } = entry.check;
    const nearest = inQuote < min ? min : inQuote > max ? max : null;
    const band = `primary ${inQuote} in ${entry.check.quote_ref} (band ${min}-${max}), gap ${(price.checkGapPct ?? 0).toFixed(4)}%`;
    return nearest === null ? level(price.usd, `${band}: inside, the primary ${price.usd} USD`) : level(nearest * quoteUsd, `${band}: outside, the nearer bound ${nearest} x ${quoteUsd} USD`);
  }
  const usd = num(check.usd);
  if (usd === null || !(usd > 0)) throw new Error(`${entry.symbol} (${entry.ref}): check ${price.check} gave no USD value (${JSON.stringify(check)})`);
  return level(usd, `${usd} USD (primary ${price.usd}, gap ${(price.checkGapPct ?? 0).toFixed(4)}%)`);
}

/** A price adapter needs the run's RPC only when its method reads an EVM chain (as noted at load, else by the ref). */
const needsRpc = (s: AdapterSource): boolean => priceSourceVenue(s).rpc;

export const priceAdapters: AdapterDef[] = [
  {
    name: 'price.token',
    needsRpc,
    paramsDoc: 'ref: a token ref in prices.yaml (eip155:<chain>/<address>, solana:mainnet/<mint>, hyperliquid:spot/@<index>). The live USD price by its prices.yaml primary: an EVM method at the run block (TWAPs over the last hour), quote refs priced the same way; an off-chain venue read now x the Ethereum USDC/USD feed.',
    validateParams: validate,
    run: token,
  },
  {
    name: 'price.token_check',
    needsRpc,
    paramsDoc: 'ref: a token ref in prices.yaml. The same read as price.token, by its prices.yaml check: the check method\'s USD value; for a bound check, the primary inside the band and the nearer bound (in USD) outside it.',
    validateParams: validate,
    run: tokenCheck,
  },
];
