import type { SolanaAccount, SolanaPriceTransport, SolanaSignature, SolanaTransaction } from '../../prices/types.js';
import { OrionError } from '../../types.js';
import type { HttpTransport } from './http.js';

/**
 * Solana JSON-RPC over the plain HTTP transport (Solana has no EVM `eth_*` surface, so viem does not apply). The RPC URL
 * comes from the environment (`ORION_SOL_RPC_URL`: Alchemy's Solana endpoint carries the key in its path), so every
 * error is re-thrown with the URL cut to its origin: a keyed URL must never reach fetch_runs, a log or chat.
 */

export const DEFAULT_SOL_RPC_ENV = 'ORION_SOL_RPC_URL';
/** Keyless public endpoint: serves getTokenSupply and getTokenAccountsByOwner (rate-limited, fine for a daily read). */
export const PUBLIC_SOL_RPC_URL = 'https://api.mainnet-beta.solana.com';

export function solanaRpcUrl(env: Record<string, string | undefined>, envName = DEFAULT_SOL_RPC_ENV): string {
  const v = env[envName];
  return v !== undefined && v.trim() !== '' ? v.trim() : PUBLIC_SOL_RPC_URL;
}

/** The URL's origin, for messages: `https://solana-mainnet.g.alchemy.com/v2/<key>` becomes `https://solana-mainnet.g.alchemy.com`. */
export function scrubUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<rpc url>';
  }
}

/** A JSON-RPC error reply, with its code (a skipped slot is -32007 or -32009, a slot past the node's ledger -32004). */
export class SolanaRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = 'SolanaRpcError';
  }
}

export async function solanaCall(http: HttpTransport, url: string, method: string, params: unknown[]): Promise<unknown> {
  const origin = scrubUrl(url);
  let reply: unknown;
  try {
    reply = await http.postJson(url, { jsonrpc: '2.0', id: 1, method, params });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split(url).join(origin);
    throw new Error(`solana ${method} at ${origin}: ${msg}`);
  }
  const r = reply as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (r && typeof r === 'object' && r.error) {
    throw new SolanaRpcError(`solana ${method} at ${origin}: RPC error ${String(r.error.code)} ${String(r.error.message)}`, typeof r.error.code === 'number' ? r.error.code : null);
  }
  if (!r || typeof r !== 'object' || !('result' in r)) throw new Error(`solana ${method} at ${origin}: the reply has no result`);
  return r.result;
}

export interface TokenAmount {
  /** Whole tokens (raw amount / 10^decimals). */
  amount: number;
  /** The slot the node answered at. */
  slot: number;
}

function uiAmount(value: { amount?: unknown; decimals?: unknown }, what: string): number {
  const raw = typeof value.amount === 'string' ? value.amount : null;
  const decimals = typeof value.decimals === 'number' ? value.decimals : null;
  if (raw === null || !/^\d+$/.test(raw) || decimals === null) throw new Error(`${what}: no integer amount and decimals in the reply`);
  // BigInt keeps the integer exact; the division to a float happens once, at the end.
  const big = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  return Number(big / scale) + Number(big % scale) / Number(scale);
}

/** getTokenSupply: the mint's supply now (burns reduce it; a mint with no authority can never raise it). */
export async function tokenSupply(http: HttpTransport, url: string, mint: string): Promise<TokenAmount> {
  const res = (await solanaCall(http, url, 'getTokenSupply', [mint, { commitment: 'finalized' }])) as { context?: { slot?: unknown }; value?: { amount?: unknown; decimals?: unknown } };
  if (!res?.value) throw new Error(`getTokenSupply ${mint}: no value`);
  return { amount: uiAmount(res.value, `getTokenSupply ${mint}`), slot: typeof res.context?.slot === 'number' ? res.context.slot : 0 };
}

/** The owner's balance of one mint, summed over all its token accounts (classic SPL and Token-2022 alike). */
export async function ownerBalance(http: HttpTransport, url: string, owner: string, mint: string): Promise<TokenAmount> {
  const res = (await solanaCall(http, url, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'finalized' }])) as {
    context?: { slot?: unknown };
    value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown; decimals?: unknown } } } } } }[];
  };
  if (!res || !Array.isArray(res.value)) throw new Error(`getTokenAccountsByOwner ${owner}: no account list`);
  let total = 0;
  for (const a of res.value) {
    const ta = a.account?.data?.parsed?.info?.tokenAmount;
    if (!ta) throw new Error(`getTokenAccountsByOwner ${owner}: an account has no parsed tokenAmount`);
    total += uiAmount(ta, `getTokenAccountsByOwner ${owner}`);
  }
  return { amount: total, slot: typeof res.context?.slot === 'number' ? res.context.slot : 0 };
}

// ---- the price writer's reads (Phase 3 R2 Task 4) --------------------------------------------------------------------

/**
 * Measured mean slot time (hype-lit-pump.md §3, over 1M slots): the slot search's first estimate. 0.4 s, the nominal
 * figure, lands hours off; the search then re-estimates from the slots it has read, so local drift costs a probe or two.
 */
export const SOLANA_SLOT_SEC = 0.215;
/** A slot that produced no block: "Slot N was skipped, or missing due to ledger jump to recent snapshot" / "...in long-term storage". */
const SKIPPED_SLOT_CODES: ReadonlySet<number> = new Set([-32007, -32009]);
/** "Block not available for slot N": past the node's finalized ledger. */
const NOT_AVAILABLE_CODE = -32004;
/** Consecutive skipped slots are rare beyond a handful (a leader offline for its 4 slots); this bounds one probe. */
const MAX_SKIP_RUN = 64;
/** Ruling R8 / M8: pump.fun's own hosts are never read (its Terms §21(h)); PUMP is read only through our own Solana RPC. */
const FORBIDDEN_HOST = /(^|\.)pump\.fun$/i;

interface SlotTime {
  slot: number;
  time: number;
}

/**
 * The SolanaPriceTransport over our own Solana RPC (`ORION_SOL_RPC_URL`), at finalized commitment. `slotAt` searches
 * getBlockTime from the nearest slot already read (the head first, then each probe of earlier searches, so the
 * hours a writer walks one by one cost a few probes each), stepping over skipped slots. `stats.requests` counts every
 * JSON-RPC request.
 */
export function solanaPriceTransport(http: HttpTransport, url: string): SolanaPriceTransport & { readonly stats: { requests: number } } {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new OrionError('invalid_price_config', 'the Solana RPC URL is not a URL');
  }
  if (FORBIDDEN_HOST.test(host)) throw new OrionError('forbidden_price_host', `${host}: PUMP is read only through our own Solana RPC, never a pump.fun host (R8)`);
  const stats = { requests: 0 };
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    stats.requests += 1;
    return await solanaCall(http, url, method, params);
  };
  const known: SlotTime[] = [];
  const remember = (p: SlotTime) => {
    if (known.some((k) => k.slot === p.slot)) return;
    known.push(p);
    known.sort((a, b) => a.slot - b.slot);
    if (known.length > 512) known.splice(1, known.length - 512);
  };
  let head: SlotTime | null = null;

  /** The first produced slot at or after `slot` and its block time; null past the ledger. */
  const timeOf = async (slot: number): Promise<SlotTime | null> => {
    for (let s = slot; s < slot + MAX_SKIP_RUN; s++) {
      try {
        const t = await call('getBlockTime', [s]);
        if (typeof t !== 'number') continue;
        const p = { slot: s, time: t };
        remember(p);
        return p;
      } catch (err) {
        if (err instanceof SolanaRpcError && err.code !== null && SKIPPED_SLOT_CODES.has(err.code)) continue;
        if (err instanceof SolanaRpcError && err.code === NOT_AVAILABLE_CODE) return null;
        throw err;
      }
    }
    throw new Error(`solana: ${MAX_SKIP_RUN} slots in a row from ${slot} produced no block`);
  };
  const refreshHead = async (): Promise<SlotTime> => {
    const s = await call('getSlot', [{ commitment: 'finalized' }]);
    if (typeof s !== 'number') throw new Error('solana getSlot: the reply is not a slot number');
    for (let back = 0; back < MAX_SKIP_RUN; back++) {
      const p = await timeOf(s - back);
      if (p && p.slot <= s) return p;
    }
    throw new Error(`solana: no block time near the finalized slot ${s}`);
  };
  const rateBetween = (a: SlotTime, b: SlotTime): number => {
    const dt = Math.abs(a.time - b.time);
    const ds = Math.abs(a.slot - b.slot);
    return dt >= 10 && ds > 0 ? dt / ds : SOLANA_SLOT_SEC;
  };

  return {
    stats,
    async slotAt(ts) {
      if (!head || head.time < ts) head = await refreshHead();
      if (head.time < ts) return null;
      // The bracket: lo a produced slot before ts, hi the earliest known produced slot at or after it; no produced
      // slot lies in [top, hi.slot).
      let lo: SlotTime | null = null;
      let hi: SlotTime = head;
      for (const p of known) {
        if (p.time < ts) lo = p;
        else if (p.slot < hi.slot) hi = p;
      }
      if (lo && lo.slot > hi.slot) lo = null;
      let top = hi.slot;
      const probe = async (g: number): Promise<void> => {
        const p = await timeOf(g);
        if (!p || p.slot >= top) top = Math.min(top, g);
        else if (p.time < ts) lo = p;
        else {
          hi = p;
          top = p.slot;
        }
      };
      // Below the bracket: aim a second under ts from hi, further each time hi moves down.
      for (let margin = 5; !lo; margin *= 4) {
        if (hi.slot <= 0 || margin > 1e7) throw new Error(`solana: no slot before ${new Date(ts * 1000).toISOString()}`);
        const near = known.filter((p) => p.slot > hi.slot).at(0);
        const rate = near ? rateBetween(hi, near) : SOLANA_SLOT_SEC;
        await probe(Math.max(0, hi.slot - Math.ceil((hi.time - ts) / rate) - margin));
      }
      // Interpolate while the bracket is wide, then bisect.
      while (top - lo!.slot > 1) {
        const l: SlotTime = lo!;
        let g: number;
        if (top - l.slot > 32 && hi.time > l.time) {
          const rate = (hi.time - l.time) / (hi.slot - l.slot);
          g = l.slot + Math.floor((ts - l.time) / rate) - 2;
          g = Math.min(Math.max(g, l.slot + 1), top - 1);
        } else {
          g = Math.floor((l.slot + top) / 2);
        }
        await probe(g);
      }
      return hi.slot;
    },
    async blockSignature(slot) {
      const b = (await call('getBlock', [slot, { encoding: 'json', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 1, commitment: 'finalized' }])) as { signatures?: unknown } | null;
      if (!b || !Array.isArray(b.signatures)) throw new Error(`solana getBlock ${slot}: no signature list`);
      const first: unknown = b.signatures[0];
      return typeof first === 'string' ? first : null;
    },
    async signaturesBefore(address, beforeSig, limit) {
      const r = await call('getSignaturesForAddress', [address, { limit, commitment: 'finalized', ...(beforeSig ? { before: beforeSig } : {}) }]);
      if (!Array.isArray(r)) throw new Error(`solana getSignaturesForAddress ${address}: the reply is not a list`);
      return (r as Record<string, unknown>[]).map((x): SolanaSignature => {
        if (typeof x.signature !== 'string' || typeof x.slot !== 'number') throw new Error(`solana getSignaturesForAddress ${address}: a row has no signature and slot`);
        return { signature: x.signature, slot: x.slot, blockTime: typeof x.blockTime === 'number' ? x.blockTime : null, err: x.err ?? null };
      });
    },
    async getTransaction(sig) {
      // Version-1 transactions exist on mainnet: maxSupportedTransactionVersion 0 fails them with -32015 (measured).
      const r = await call('getTransaction', [sig, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
      return (r ?? null) as SolanaTransaction | null;
    },
    async getMultipleAccounts(keys) {
      const r = (await call('getMultipleAccounts', [keys, { encoding: 'jsonParsed', commitment: 'finalized' }])) as { value?: unknown } | null;
      if (!r || !Array.isArray(r.value) || r.value.length !== keys.length) throw new Error('solana getMultipleAccounts: the reply has no account per key');
      return r.value as (SolanaAccount | null)[];
    },
  };
}
