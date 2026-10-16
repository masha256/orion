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
  if (r && typeof r === 'object' && r.error) throw new Error(`solana ${method} at ${origin}: RPC error ${String(r.error.code)} ${String(r.error.message)}`);
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
