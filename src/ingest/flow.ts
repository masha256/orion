import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import type { DayBlockCache } from '../db/dayBlocks.js';
import { advanceCursor, getCursor } from '../db/fetchCursors.js';
import { emptySourceOutcome, type FlowConflict, type SourceOutcome, type UnlistedTransfer } from '../db/fetchRuns.js';
import { insertObservation, listActiveObservations, rejectObservation } from '../db/observations.js';
import { coingeckoTokenRef, evmTokenRef, HOURS_PER_DAY, MS_PER_HOUR, upsertPrices, upsertToken, type TokenInfo } from '../db/prices.js';
import { COINGECKO_PRICE_SOURCE, hourlyPriceRows } from '../prices/coingeckoHourly.js';
import { fetchedProvenance } from '../provenance/locator.js';
import { txRefsProvenance } from '../provenance/types.js';
import { MS_PER_DAY, OrionError } from '../types.js';
import type { FlowGroup, FlowMember } from './plan.js';
import { ERC20_ABI } from './sources/chainLevels.js';
import { coingeckoBase, coingeckoHeaders } from './sources/coingecko.js';
import { addDays, dayStartMs, utcDay } from './time.js';
import type { HttpTransport } from './transport/http.js';
import { firstBlockAtOrAfter, getLogsChunked, type BlockRef, type ReceiptLog, type RpcTransport } from './transport/rpc.js';
import type { DailyPoint, WrittenObservation } from './types.js';
import { unitsToNumber } from './units.js';

const SECONDS_PER_DAY = 86_400;
/** A day boundary is cached only when it is at least this much older than the scan's upper bound (reorg margin). */
const DAY_BLOCK_MIN_AGE_SEC = 3600;
const MAX_LISTED_UNLISTED = 50;

/** `ts` is in milliseconds. */
export interface PricePoint {
  ts: number;
  price: number;
}

export interface PriceSeries {
  hourly: PricePoint[];
  daily: PricePoint[];
}

export function parseMarketChart(body: unknown, what: string): PricePoint[] {
  const prices = (body as { prices?: unknown } | null)?.prices;
  if (!Array.isArray(prices) || prices.length === 0) throw new Error(`${what}: no prices in the market_chart response`);
  const points = prices.map((entry) => {
    const [ts, price] = Array.isArray(entry) ? (entry as unknown[]) : [];
    if (typeof ts !== 'number' || typeof price !== 'number' || !Number.isFinite(ts) || !(price > 0) || !Number.isFinite(price)) {
      throw new Error(`${what}: malformed market_chart point ${JSON.stringify(entry)}`);
    }
    return { ts, price };
  });
  return points.sort((a, b) => a.ts - b.ts);
}

/** A market_chart reply `parseMarketChart` accepts (the shared cache keeps only these, M-8). */
export function isMarketChartBody(body: unknown): boolean {
  try {
    parseMarketChart(body, 'market_chart');
    return true;
  } catch {
    return false;
  }
}

function newestAtOrBefore(points: PricePoint[], tsMs: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts <= tsMs) {
      found = points[mid].price;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The newest hourly point at or before `tsMs`; failing that, the newest daily point. Never interpolated. */
export function priceAt(series: PriceSeries, tsMs: number): number | null {
  return newestAtOrBefore(series.hourly, tsMs) ?? newestAtOrBefore(series.daily, tsMs);
}

async function loadPrices(http: HttpTransport, env: Record<string, string | undefined>, id: string, startMs: number, nowMs: number): Promise<PriceSeries> {
  const chart = (days: number) => `${coingeckoBase(env)}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`;
  const hourly = parseMarketChart(await http.getJson(chart(90), coingeckoHeaders(env)), `coingecko ${id} hourly`);
  let daily: PricePoint[] = [];
  if (startMs < hourly[0].ts) {
    // CoinGecko returns daily points beyond 90 days. Made only when the scan reaches back past the hourly series.
    const days = Math.max(91, Math.ceil((nowMs - startMs) / MS_PER_DAY) + 1);
    daily = parseMarketChart(await http.getJson(chart(days), coingeckoHeaders(env)), `coingecko ${id} daily`);
  }
  return { hourly, daily };
}

/** Milliseconds for which an observation's period [observedAt - periodDays, observedAt] overlaps [startMs, endMs). Periods that only touch overlap by 0. */
export function overlapMs(o: { observedAt: string; periodDays: number | null }, startMs: number, endMs: number): number {
  const end = new Date(o.observedAt).getTime();
  const start = end - (o.periodDays ?? 1) * MS_PER_DAY;
  return Math.min(end, endMs) - Math.max(start, startMs);
}

/** Active rows from a source other than the writer's own (`own`) whose period overlaps (startMs, endMs). Periods that only touch do not overlap. */
export async function findFlowConflicts(db: Db, assetId: string, metricKey: string, startMs: number, endMs: number, own: 'onchain' | 'api' = 'onchain'): Promise<FlowConflict[]> {
  return (await listActiveObservations(db, assetId, metricKey))
    .filter((o) => {
      if (o.source === own) return false;
      return overlapMs(o, startMs, endMs) > 0;
    })
    .map((o) => ({
      metricKey, observationId: o.id, source: o.source, observedAt: o.observedAt, periodDays: o.periodDays, adoptable: o.source === 'manual',
    }));
}

export interface FlowScanArgs {
  db: Db;
  asset: AssetConfig;
  /** The loaded asset's config hash, for the rows' provenance. */
  configHash: string;
  group: FlowGroup;
  rpc: RpcTransport;
  /** The latest block at plan start. The scan's upper bound is the finalized block when the transport has one. */
  latest: BlockRef;
  /** The chain's day-boundary cache (N9). Read on every run; written only by a real run, and only for final boundaries. */
  dayBlocks?: DayBlockCache;
  http: HttpTransport;
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  now: Date;
  backfillDays: number;
  /** Ignore the cursor and scan `backfillDays` back again. Rows for the same day supersede the old ones. */
  rescan: boolean;
  /**
   * The metrics a `--metric` run listed (ruling R20). Unset: every member is written. Set: the scan and its pricing still
   * run once for the whole group, but only listed members' rows are inserted (and only their manual rows adopted); the
   * other members' rows are neither inserted nor superseded, and the shared cursor stays where it was, so the next full
   * fetch scans those days for every member and none is left with a gap.
   */
  only?: ReadonlySet<string>;
  adopt: boolean;
  dryRun: boolean;
  onProgress?: (line: string) => void;
}

export interface FlowScanResult {
  outcome: SourceOutcome;
  written: WrittenObservation[];
  /** Every unlisted transfer. `outcome.unlistedTransfers` lists at most the first 50. */
  unlisted: UnlistedTransfer[];
  /** Day values of this scan per member metric, also on a dry run. */
  daily: Map<string, DailyPoint[]>;
}

/** EIP-1167 minimal proxy: prefix, 20-byte implementation, suffix. Clones with immutable args append bytes after it. */
const CLONE_PREFIX = '363d3d373d3d3d363d73';
const CLONE_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

/** The implementation an EIP-1167 clone delegates to, lowercased, or null when the code is not such a clone. */
export function cloneImplementation(code: string): string | null {
  const c = code.toLowerCase().replace(/^0x/, '');
  if (!c.startsWith(CLONE_PREFIX) || c.slice(CLONE_PREFIX.length + 40, CLONE_PREFIX.length + 40 + CLONE_SUFFIX.length) !== CLONE_SUFFIX) return null;
  return `0x${c.slice(CLONE_PREFIX.length, CLONE_PREFIX.length + 40)}`;
}

/** topic0 of ERC-4626 `Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)`. */
export const ERC4626_DEPOSIT_TOPIC = '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7';
const ZERO = '0x0000000000000000000000000000000000000000';
const topicAddress = (t: string | undefined) => (t === undefined ? null : `0x${t.slice(-40)}`.toLowerCase());

/**
 * The depositor behind a vault mint: the Deposit log of `vault` in the receipt whose owner is `sink` and whose shares equal
 * the minted `value`, the first such log after the mint (a vault emits Transfer, then Deposit). Null when there is none.
 */
export function mintDepositor(logs: ReceiptLog[], vault: string, sink: string, value: bigint, mintLogIndex: number): string | null {
  const hits = logs
    .filter((l) => l.address.toLowerCase() === vault && l.topics[0]?.toLowerCase() === ERC4626_DEPOSIT_TOPIC && topicAddress(l.topics[2]) === sink)
    .filter((l) => {
      const d = l.data.replace(/^0x/, '');
      return d.length >= 128 && BigInt(`0x${d.slice(64, 128)}`) === value;
    })
    .sort((a, b) => Math.abs(a.logIndex - mintLogIndex) - Math.abs(b.logIndex - mintLogIndex) || a.logIndex - b.logIndex);
  return hits.length > 0 ? topicAddress(hits[0].topics[1]) : null;
}

/**
 * The block a transfer scan reads up to: the finalized block when the transport has the tag; when the RPC rejects it
 * (M-7: not every provider serves `finalized`), `latest` minus the chain's confirmations, with a note saying so.
 */
export async function scanUpperBound(rpc: RpcTransport, latest: BlockRef, notes: string[]): Promise<BlockRef> {
  if (!rpc.finalizedBlock) return latest;
  try {
    return await rpc.finalizedBlock();
  } catch (err) {
    if (rpc.confirmations === undefined) throw err;
    const n = latest.number > rpc.confirmations ? latest.number - rpc.confirmations : 0n;
    const why = (err instanceof Error ? err.message : String(err)).split('\n', 1)[0]!.slice(0, 200);
    notes.push(`no finalized block (${why}): scanned up to latest - ${rpc.confirmations} (block ${n})`);
    return await rpc.getBlock(n);
  }
}

/** The token's decimals, read at `latest` (one multicall). */
export async function readDecimals(rpc: RpcTransport, group: FlowGroup, latest: BlockRef): Promise<number> {
  const [decimalsCall] = await rpc.multicall([{ address: group.token, signature: ERC20_ABI.decimals, functionName: 'decimals' }], latest.number);
  if (!decimalsCall.ok) throw new Error(`decimals() on the token: ${decimalsCall.error}`);
  return Number(decimalsCall.value);
}

/**
 * The token a member's amounts are in (spec §4): the scanned token itself, or, for a vault share valued at its
 * pricePerShare, the underlying the price id names (`coingecko:<id>`, since the config names no underlying address).
 * Null when neither applies (a share counted in tokens: no such member today).
 */
export function memberToken(asset: AssetConfig, group: FlowGroup, m: FlowMember, decimals: number): TokenInfo | null {
  if (m.sharePrice) {
    if (m.priceCoingeckoId === null) return null;
    return { tokenRef: coingeckoTokenRef(m.priceCoingeckoId), symbol: m.priceCoingeckoId, decimals: null, coingeckoId: m.priceCoingeckoId };
  }
  const name = Object.entries(asset.contracts ?? {}).find(([, address]) => String(address).toLowerCase() === group.token)?.[0];
  const priced = m.priceCoingeckoId ?? group.members.find((o) => o.unit === 'usd' && !o.sharePrice && o.priceCoingeckoId !== null)?.priceCoingeckoId ?? null;
  return {
    tokenRef: evmTokenRef(asset.ingest!.chain_id, group.token),
    symbol: name === undefined || name === 'token' ? asset.symbol : name,
    decimals,
    coingeckoId: priced,
  };
}

/** One entry per token ref (the first one seen), skipping nulls. */
export function uniqueTokens(list: (TokenInfo | null)[]): TokenInfo[] {
  const out = new Map<string, TokenInfo>();
  for (const t of list) if (t && !out.has(t.tokenRef)) out.set(t.tokenRef, t);
  return [...out.values()];
}

/** A member's token total for the day and its 24 UTC-hour sub-totals (spec §4). */
export interface MemberTokens {
  amount: number;
  hourly: number[];
}

/** What one day's scan counted, before anything is written. */
export interface DayScan {
  /** Per member, the value its row stores (USD for unit usd, tokens otherwise); null when the scanner has no prices. */
  values: Map<string, number> | null;
  /** Per member, in the member's token (tokens x share price for a vault share; never priced). */
  tokens: Map<string, MemberTokens>;
  /** Per member: the `txhash:logIndex` of every transfer counted into it (provenance tx refs and digest). */
  refs: Map<string, string[]>;
  senders: Map<string, { count: number; tokens: number }>;
  sharePrices: Map<string, number>;
  counted: number;
  unlisted: UnlistedTransfer[];
}

export interface DayScanner {
  /** The first block of day `d`: from the chain's cache, else searched (and cached once it is safely final). */
  dayStart(d: string, anchor: BlockRef): Promise<BlockRef>;
  /** Counts the transfers of `day` in blocks [from, next - 1]. Reads the chain; writes nothing. */
  scanDay(day: string, from: BlockRef, next: BlockRef): Promise<DayScan>;
  /** Transfers not counted, as configured, over every day scanned so far. */
  readonly ignored: { zero: number; listed: number; clones: number; dust: number };
  readonly mintsAttributed: number;
  /** Transfers whose time fell outside their day's 24 hours (bucketed at the nearer edge). */
  readonly edgeHours: number;
}

export interface DayScannerArgs {
  group: FlowGroup;
  rpc: RpcTransport;
  /** The scan's upper bound (the finalized block when the chain has one). */
  latest: BlockRef;
  dayBlocks?: DayBlockCache;
  /** Write final day boundaries to `dayBlocks` (a real run only). */
  cacheDayBlocks: boolean;
  sleep(ms: number): Promise<void>;
  /** Price series by CoinGecko id for the usd members; null: count tokens only (`values` is null). */
  series: Map<string, PriceSeries> | null;
  decimals: number;
  /** Hears every unlisted transfer as it is found, so a day that fails part-way still reports the ones it saw. */
  onUnlisted?: (t: UnlistedTransfer) => void;
}

/**
 * The transfer scanner's per-day count, shared by the flow writer and the token backfill so both count exactly the same
 * transfers. USD is priced per transfer at its own time (the reference method, spec §4); token amounts are summed per
 * member and per UTC hour beside it.
 */
export async function openDayScanner(o: DayScannerArgs): Promise<DayScanner> {
  const { group, rpc, latest, decimals } = o;
  const allow = new Map(group.allowlist.map((a) => [a.address, a.name]));
  const ignore = new Set(group.ignore ?? []);
  const cloneImpls = new Set(group.ignoreClonesOf ?? []);
  if (cloneImpls.size > 0 && !rpc.getCode) throw new Error('from_ignore_clones_of needs an RPC transport that reads contract code');
  // Code does not change for a clone, so one read per sender per scan.
  const cloneOf = new Map<string, string | null>();
  const isIgnoredClone = async (sender: string): Promise<boolean> => {
    if (cloneImpls.size === 0) return false;
    if (!cloneOf.has(sender)) cloneOf.set(sender, cloneImplementation(await rpc.getCode!(sender)));
    const impl = cloneOf.get(sender)!;
    return impl !== null && cloneImpls.has(impl);
  };
  const ignored = { zero: 0, listed: 0, clones: 0, dust: 0 };
  if (group.mintSender && !rpc.getReceiptLogs) throw new Error('mint_sender needs an RPC transport that reads receipts');
  let mintsAttributed = 0;
  let edgeHours = 0;

  const dayStart = async (d: string, anchor: BlockRef): Promise<BlockRef> => {
    const hit = await o.dayBlocks?.get(d);
    if (hit) return hit;
    const found = await firstBlockAtOrAfter(rpc, dayStartMs(d) / 1000, anchor, latest);
    if (o.dayBlocks && o.cacheDayBlocks && found.timestamp <= latest.timestamp - DAY_BLOCK_MIN_AGE_SEC) await o.dayBlocks.put(d, found);
    return found;
  };

  const scanDay = async (day: string, from: BlockRef, next: BlockRef): Promise<DayScan> => {
    const startMs = dayStartMs(day);
    const values = o.series ? new Map(group.members.map((m) => [m.metricKey, 0])) : null;
    const tokens = new Map<string, MemberTokens>(group.members.map((m) => [m.metricKey, { amount: 0, hourly: new Array<number>(HOURS_PER_DAY).fill(0) }]));
    const refs = new Map<string, string[]>(group.members.map((m) => [m.metricKey, []]));
    const senders = new Map<string, { count: number; tokens: number }>();
    const unlisted: UnlistedTransfer[] = [];
    let counted = 0;
    // Share prices for the day, read once at its last block and only when a counted transfer needs one.
    const sharePrices = new Map<string, number>();
    const sharePriceOf = async (sp: NonNullable<FlowMember['sharePrice']>): Promise<number> => {
      const key = `${sp.address}.${sp.functionName}`;
      const hit = sharePrices.get(key);
      if (hit !== undefined) return hit;
      const [r] = await rpc.multicall(
        [{ address: sp.address, signature: `function ${sp.functionName}() view returns (uint256)`, functionName: sp.functionName }],
        next.number - 1n,
      );
      if (!r.ok) throw new Error(`${sp.functionName}() on ${sp.address} at block ${next.number - 1n}: ${r.error}`);
      const v = unitsToNumber(r.value, sp.decimals);
      if (!(v > 0) || !Number.isFinite(v)) throw new Error(`${sp.functionName}() on ${sp.address} returned ${v}; day ${day} was not written`);
      sharePrices.set(key, v);
      return v;
    };

    for await (const chunk of getLogsChunked(rpc, { token: group.token, to: group.sink, fromBlock: from.number, toBlock: next.number - 1n }, { sleep: o.sleep })) {
      for (const log of chunk.logs) {
        let sender = log.from.toLowerCase();
        if (sender === ZERO && group.mintSender === 'erc4626_deposit') {
          const depositor = mintDepositor(await rpc.getReceiptLogs!(log.txHash), group.token, group.sink, log.value, log.logIndex);
          if (depositor !== null) {
            sender = depositor;
            mintsAttributed++;
          }
        }
        const amountTokens = unitsToNumber(log.value, decimals);
        let name = allow.get(sender);
        if (name === undefined) {
          // Not this flow, and known to be so: a zero-amount transfer (it moves nothing), a listed sender, or a clone of a
          // listed implementation. None is counted (an unlisted sender never is); they are only kept out of the report.
          if (log.value === 0n) {
            ignored.zero++;
            continue;
          }
          if (ignore.has(sender)) {
            ignored.listed++;
            continue;
          }
          if (group.ignoreBelowTokens !== undefined && amountTokens < group.ignoreBelowTokens) {
            ignored.dust++;
            continue;
          }
          if (await isIgnoredClone(sender)) {
            ignored.clones++;
            continue;
          }
        }
        if (name === undefined && group.anySender) name = sender; // from_any: every sender not ignored is the flow, by address
        if (name === undefined) {
          const u: UnlistedTransfer = { txHash: log.txHash, logIndex: log.logIndex, blockNumber: Number(log.blockNumber), from: sender, tokens: amountTokens, day };
          unlisted.push(u);
          o.onUnlisted?.(u);
          continue;
        }
        counted++;
        const tally = senders.get(name) ?? { count: 0, tokens: 0 };
        tally.count++;
        tally.tokens += amountTokens;
        senders.set(name, tally);
        // The UTC hour of the transfer within its day (blocks [from, next) lie inside the day by construction).
        let hour = Math.floor((log.timestamp * 1000 - startMs) / MS_PER_HOUR);
        if (hour < 0 || hour >= HOURS_PER_DAY) {
          edgeHours++;
          hour = hour < 0 ? 0 : HOURS_PER_DAY - 1;
        }
        for (const m of group.members) {
          if (m.countFrom !== null && !m.countFrom.includes(sender)) continue;
          let amount = m.sharePrice ? amountTokens * (await sharePriceOf(m.sharePrice)) : amountTokens;
          const tk = tokens.get(m.metricKey)!;
          tk.amount += amount;
          tk.hourly[hour] += amount;
          if (values) {
            if (m.unit === 'usd') {
              const price = priceAt(o.series!.get(m.priceCoingeckoId!)!, log.timestamp * 1000);
              if (price === null) {
                throw new Error(
                  `no ${m.priceCoingeckoId} price point at or before ${new Date(log.timestamp * 1000).toISOString()}; day ${day} was not written`,
                );
              }
              amount *= price;
            }
            values.set(m.metricKey, values.get(m.metricKey)! + amount);
          }
          refs.get(m.metricKey)!.push(`${log.txHash}:${log.logIndex}`);
        }
      }
    }
    return { values, tokens, refs, senders, sharePrices, counted, unlisted };
  };

  return {
    dayStart,
    scanDay,
    get ignored() {
      return ignored;
    },
    get mintsAttributed() {
      return mintsAttributed;
    },
    get edgeHours() {
      return edgeHours;
    },
  };
}

export async function scanFlowGroup(args: FlowScanArgs): Promise<FlowScanResult> {
  const { db, asset, group, rpc, dryRun } = args;
  const outcome = emptySourceOutcome(group.sourceId);
  // R20: the members this run writes. The scan counts every member (one pass), but a member left out is not written.
  const writes = args.only ? group.members.filter((m) => args.only!.has(m.metricKey)) : group.members;
  const withheld = group.members.filter((m) => !writes.includes(m)).map((m) => m.metricKey);
  const result: FlowScanResult = { outcome, written: [], unlisted: [], daily: new Map(writes.map((m) => [m.metricKey, []])) };
  const nowIso = args.now.toISOString();

  try {
    // 1. Range: completed UTC days only, up to the finalized block when the chain reports one.
    const latest = await scanUpperBound(rpc, args.latest, outcome.notes);
    const lastMidnightSec = Math.floor(latest.timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const lastCompleteDay = utcDay(lastMidnightSec * 1000 - MS_PER_DAY);
    const cursor = await getCursor(db, asset.id, group.scanKey);
    const startDay = cursor && !args.rescan ? addDays(cursor.lastDay, 1) : utcDay(args.now.getTime() - args.backfillDays * MS_PER_DAY);
    if (startDay > lastCompleteDay) {
      outcome.notes.push(`no completed day to scan: the last complete day is ${lastCompleteDay} and the scan is already there`);
      return result;
    }
    const rangeStartMs = dayStartMs(startDay);
    const rangeEndMs = dayStartMs(lastCompleteDay) + MS_PER_DAY;

    // 2. Conflicts with rows from other sources decide whether the group runs at all.
    const conflicts: FlowConflict[] = [];
    for (const m of writes) conflicts.push(...(await findFlowConflicts(db, asset.id, m.metricKey, rangeStartMs, rangeEndMs)));
    outcome.conflicts = conflicts;
    const stuck = conflicts.filter((c) => !c.adoptable);
    if (conflicts.length > 0 && (!args.adopt || stuck.length > 0)) {
      outcome.status = 'skipped';
      const ids = (list: FlowConflict[]) => list.map((c) => `#${c.observationId}`).join(', ');
      if (stuck.length > 0) {
        outcome.notes.push(
          `nothing was written: ${ids(stuck)} overlap the days ${startDay} to ${lastCompleteDay} and are not manual rows, so --adopt cannot reject them. ` +
            'Reject them by hand with "orion data reject <id>", then fetch again.',
        );
      } else {
        outcome.notes.push(
          `nothing was written: ${conflicts.length} active manual row(s) (${ids(conflicts)}) overlap the days ${startDay} to ${lastCompleteDay}. ` +
            'Re-run with --adopt to reject them and write the fetched rows in the same transaction.',
        );
      }
      return result;
    }

    // 3. Token decimals, price series, and the tokens and prices the rows refer to.
    const decimals = await readDecimals(rpc, group, latest);
    const series = new Map<string, PriceSeries>();
    for (const m of group.members) {
      if (m.unit !== 'usd') continue;
      if (m.priceCoingeckoId === null) throw new OrionError('invalid_source_config', `${m.metricKey}: a transfer_flow with unit usd needs price_coingecko_id`);
      if (!series.has(m.priceCoingeckoId)) {
        series.set(m.priceCoingeckoId, await loadPrices(args.http, args.env, m.priceCoingeckoId, rangeStartMs, args.now.getTime()));
      }
    }
    const tokenOf = new Map(group.members.map((m) => [m.metricKey, memberToken(asset, group, m, decimals)]));
    if (!dryRun) {
      // Every hourly point the scan loaded goes into `prices` (spec §4): no request beyond the ones made above.
      for (const t of uniqueTokens([...tokenOf.values()])) await upsertToken(db, t);
      for (const [id, s] of series) {
        const rows = hourlyPriceRows(s.hourly);
        for (const t of uniqueTokens([...tokenOf.values()])) if (t.coingeckoId === id) await upsertPrices(db, t.tokenRef, COINGECKO_PRICE_SOURCE, rows, nowIso);
      }
    }

    // 4. One day at a time, oldest first. Each day commits on its own, so an interrupted backfill resumes.
    const scanner = await openDayScanner({
      group, rpc, latest, dayBlocks: args.dayBlocks, cacheDayBlocks: !dryRun, sleep: args.sleep, series, decimals, onUnlisted: (u) => result.unlisted.push(u),
    });
    const retired = new Set<number>();
    const wroteAny = new Set<string>();
    let from = await scanner.dayStart(startDay, latest);

    for (let day = startDay; day <= lastCompleteDay; day = addDays(day, 1)) {
      const dayEndMs = dayStartMs(day) + MS_PER_DAY;
      const next = await scanner.dayStart(addDays(day, 1), from);
      const scan = await scanner.scanDay(day, from, next);
      const sums = scan.values!;

      const observedAt = new Date(dayEndMs).toISOString();
      const detail = JSON.stringify({
        day,
        blocks: [Number(from.number), Number(next.number) - 1],
        senders: Object.fromEntries([...scan.senders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
        ...(scan.sharePrices.size > 0 ? { share_price: Object.fromEntries([...scan.sharePrices.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) } : {}),
      });
      const ids = new Map<string, number | null>(writes.map((m) => [m.metricKey, null]));
      if (!dryRun) {
        // Under the asset's transaction lock: each insert reads for rows to supersede before it writes, so another
        // connection's write to the asset waits for this commit instead of landing in between.
        await db.tx(async (t) => {
          for (const m of writes) {
            for (const c of conflicts) {
              if (c.metricKey !== m.metricKey || retired.has(c.observationId)) continue;
              if (overlapMs(c, dayEndMs - MS_PER_DAY, dayEndMs) <= 0) continue;
              await rejectObservation(t, c.observationId);
              retired.add(c.observationId);
              outcome.retiredObservationIds.push(c.observationId);
            }
            const token = tokenOf.get(m.metricKey)!;
            const tk = scan.tokens.get(m.metricKey)!;
            const o = await insertObservation(t, {
              assetId: asset.id, metricKey: m.metricKey, observedAt, periodDays: 1, value: sums.get(m.metricKey)!,
              sourceDetail: detail, fetchedAt: nowIso,
              provenance: fetchedProvenance({ config: asset, hash: args.configHash }, m.metricKey, {
                blockFrom: Number(from.number), blockTo: Number(next.number) - 1, ...txRefsProvenance(scan.refs.get(m.metricKey)!),
              }),
              ...(token ? { tokens: { tokenRef: token.tokenRef, amount: tk.amount, hourlyAmounts: tk.hourly } } : {}),
            });
            ids.set(m.metricKey, o.id);
          }
          if (withheld.length === 0) await advanceCursor(t, asset.id, group.scanKey, { lastBlock: Number(next.number) - 1, lastDay: day }, nowIso);
        }, { lockAsset: asset.id });
      }
      for (const m of writes) {
        const value = sums.get(m.metricKey)!;
        result.written.push({ metricKey: m.metricKey, value, observedAt, periodDays: 1, source: 'onchain', observationId: ids.get(m.metricKey)! });
        result.daily.get(m.metricKey)!.push({ day, value });
        wroteAny.add(m.metricKey);
      }
      args.onProgress?.(`${group.sourceId} ${day}: ${scan.counted} transfers${scan.unlisted.length > 0 ? `, ${scan.unlisted.length} unlisted` : ''}`);
      from = next;
    }

    outcome.metricsWritten = writes.map((m) => m.metricKey).filter((k) => wroteAny.has(k));
    if (withheld.length > 0) {
      outcome.notes.push(
        `--metric: wrote only ${writes.map((m) => m.metricKey).join(', ') || 'none'}; ${withheld.join(', ')} share this scan and were left untouched, ` +
          'and the scan cursor did not move, so the next full fetch scans these days for every member',
      );
    }
    const { ignored, mintsAttributed } = scanner;
    const parts = [
      ignored.zero > 0 ? `${ignored.zero} zero-amount` : '',
      ignored.listed > 0 ? `${ignored.listed} from from_ignore senders` : '',
      ignored.clones > 0 ? `${ignored.clones} from ignored clones` : '',
      ignored.dust > 0 ? `${ignored.dust} dust (below ${group.ignoreBelowTokens} tokens)` : '',
    ].filter((p) => p !== '');
    if (parts.length > 0) outcome.notes.push(`not counted, as configured: ${parts.join(', ')}`);
    if (mintsAttributed > 0) outcome.notes.push(`${mintsAttributed} mint(s) attributed to their ERC-4626 depositor`);
    if (scanner.edgeHours > 0) outcome.notes.push(`${scanner.edgeHours} transfer(s) stamped outside their day's hours, counted in its first or last hour`);
    if (dryRun && conflicts.length > 0) outcome.notes.push(`--adopt would reject ${conflicts.map((c) => `#${c.observationId}`).join(', ')}`);
  } catch (err) {
    if (err instanceof OrionError) throw err;
    outcome.status = 'failed';
    outcome.error = err instanceof Error ? err.message : String(err);
    outcome.metricsWritten = [...new Set(result.written.map((w) => w.metricKey))];
  } finally {
    outcome.unlistedTransfers = result.unlisted.slice(0, MAX_LISTED_UNLISTED);
    if (result.unlisted.length > MAX_LISTED_UNLISTED) {
      outcome.notes.push(`${result.unlisted.length} unlisted transfers in total; the first ${MAX_LISTED_UNLISTED} are listed`);
    }
  }
  return result;
}
