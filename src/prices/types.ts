import type { HttpTransport } from '../ingest/transport/http.js';
import type { RpcTransport } from '../ingest/transport/rpc.js';
import type { PriceEntry } from './config.js';

/**
 * Shared shapes of the Phase 3 R2 price writer (Ruling R3): the EVM readers (evmMethods.ts), the off-chain readers
 * (Task 4) and the writer (Task 3) import from here, never from each other, so there is no import cycle.
 */

/** One ref's price for one hour bucket [H, H+1h), read at B(H+1h) (plan P2), with its check's outcome. */
export interface HourPrice {
  usd: number;
  /** The primary's source: `chain:<kind>` or `first_party:<venue>` (methodSource). */
  source: string;
  /** (check - primary) / primary x 100; for a `bound` check the distance outside the band in % of the bound (0 inside).
   * null when the check could not be read this hour (zero in-range liquidity, a failed call, a missing quote). */
  checkGapPct: number | null;
  /** The check's label: its source, plus its config label (`same_venue`, `no_independent_check`) when it has one. */
  check: string;
  /** JSON-safe: what was read (blocks, raw answers as strings, feed ages, the quote used) for the primary and the check. */
  detail: Record<string, unknown>;
}

/** An account as getMultipleAccounts (jsonParsed) answers it: `data` is parsed for token accounts, [base64, 'base64'] else. */
export interface SolanaAccount {
  owner: string;
  data: unknown;
}

/** A getSignaturesForAddress row (newest first). `err` is null for a transaction that succeeded. */
export interface SolanaSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

/** A token balance in a transaction's meta (accountIndex into the static keys, then the loaded writable, then readonly). */
export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** The parts of getTransaction (encoding json, maxSupportedTransactionVersion 1) the price methods read. */
export interface SolanaTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: SolanaTokenBalance[];
    postTokenBalances?: SolanaTokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}

/** Solana reads for PUMP's price methods (Task 4: src/ingest/transport/solana.ts solanaPriceTransport). */
export interface SolanaPriceTransport {
  getMultipleAccounts(keys: string[]): Promise<(SolanaAccount | null)[]>;
  /** The first produced (finalized) slot whose block time is at or after `tsSec`; null when the chain has none yet. */
  slotAt(tsSec: number): Promise<number | null>;
  /** The first transaction signature of the block at `slot`: a time cursor for signaturesBefore (null: an empty block). */
  blockSignature(slot: number): Promise<string | null>;
  signaturesBefore(address: string, beforeSig: string | null, limit: number): Promise<SolanaSignature[]>;
  getTransaction(sig: string): Promise<SolanaTransaction | null>;
  /** JSON-RPC requests made so far (a search such as slotAt makes several); absent: each method call counts one. */
  readonly stats?: { requests: number };
}

/** Everything the price writer reads through. `rpcFor` takes a price chain (`eip155:<id>`). */
export interface PriceDeps {
  rpcFor(chain: string): RpcTransport;
  solana: SolanaPriceTransport;
  http: HttpTransport;
  now: Date;
  /** prices.yaml (loadPrices): the writer's refs and their quote refs are looked up here. */
  prices: ReadonlyMap<string, PriceEntry>;
}

/** What one writer run did (plan Task 3). */
export interface WriteResult {
  written: Record<string, number>;
  skippedExisting: number;
  missing: { ref: string; hourMs: number; reason: string }[];
  breaches: { ref: string; hourMs: number; gapPct: number; check: string }[];
  /** RPC requests per chain (multicall, getBlock, latestBlock; an off-chain method reports its own). */
  calls: { [chain: string]: number };
  /** The oldest hour of the oldest UTC day every chain of the run finished (null: none). */
  reachedMs: number | null;
  stoppedByBudget: boolean;
  /** A chain whose read threw (a transport failure): it is skipped for the rest of the run, which a re-run resumes. */
  errors: { chain: string; hourMs: number; error: string }[];
}
