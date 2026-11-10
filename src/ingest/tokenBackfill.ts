import type { LoadedAsset } from '../config/load.js';
import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { fillObservationTokens, getTokensByIds, isActiveObservation, listActiveObservations, type Observation } from '../db/observations.js';
import { MS_PER_HOUR, storedPriceHours, upsertPrices, upsertToken, USD_TOKEN, type ObservationTokens, type TokenInfo } from '../db/prices.js';
import { COINGECKO_PRICE_SOURCE, fetchHourlyRange, hourlyPriceRows } from '../prices/coingeckoHourly.js';
import { defillamaUrlOf } from '../provenance/locator.js';
import { MS_PER_DAY, OrionError } from '../types.js';
import { findAdapter } from './adapters/registry.js';
import { memberToken, openDayScanner, readDecimals, scanUpperBound, uniqueTokens } from './flow.js';
import { buildPlan, type FlowGroup, type FlowMember } from './plan.js';
import { DEFAULT_RPC_URLS, type FetchDeps } from './run.js';
import { addDays, dayStartMs, utcDay } from './time.js';

/**
 * The token backfill (Task 7, spec §4): fills `amount`, `hourly_amounts` and `token_ref` on the flow rows written before
 * 0005. It never inserts a row and never changes `value`: one `UPDATE ... WHERE id = <active row> AND amount IS NULL` per
 * row, one transaction per day under the asset's lock, so a crash leaves whole days and a re-run resumes.
 *
 * - Transfer scans are re-scanned by day with the flow writer's own day scanner. A day whose re-scanned token total
 *   differs from a stored `flow_tokens.*` twin by more than TWIN_REL_TOLERANCE is refused whole (the chain no longer
 *   says what the row says: a config change, a reorg, or a bug), and a day with no active row is skipped; both are
 *   listed. The hourly prices those days need are fetched from CoinGecko's market_chart/range once per CoinGecko id
 *   (through the run's transport, so its spacing applies), only for hours not already stored, and upserted under every
 *   token ref that shares the id.
 * - First-party dollar series (an adapter whose `usdNative(params)` is true: Lighter fees and buys in USDC, Hyperliquid
 *   fills and USDC payments) get token 'usd', amount = value and no hourly buckets, with no request at all (ruling
 *   R18). Only rows that series wrote are filled: a manual row, or a history row read from DefiLlama, is skipped.
 */

export const TWIN_REL_TOLERANCE = 1e-9;

export interface BackfillTokensOptions {
  /** Only these metrics (default: every transfer_flow metric and first-party dollar series of the asset). */
  metrics?: string[];
  /** Days back from now (default: from the oldest active row of the metrics). */
  days?: number;
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export interface BackfillPrices {
  coingeckoId: string;
  /** Every token ref priced at this id: the fetched rows are stored under each. */
  tokenRefs: string[];
  /** Hourly rows upserted per token ref (0 on a dry run, which fetches nothing, and when every hour needed was stored). */
  rows: number;
  /** The first day the hourly series reaches; null when no window answered (or nothing was fetched). */
  reachedDay: string | null;
  failures: string[];
  requests: number;
}

export interface BackfillTokensResult {
  assetId: string;
  dryRun: boolean;
  range: { from: string; to: string } | null;
  /** Rows filled (on a dry run: rows that would be). */
  filled: number;
  /** Rows that already had tokens. */
  alreadyFilled: number;
  skipped: { day: string; metricKey: string; reason: string }[];
  refused: { day: string; reason: string }[];
  prices: BackfillPrices[];
  notes: string[];
}

const rel = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));
const sameSet = (a: string[] | null, b: string[] | null) => (a === null || b === null ? a === b : a.length === b.length && a.every((x) => b.includes(x)));

/** The stored token twins of a member: `flow_tokens.*` members of the group counting the same senders, unpriced shares excluded. */
function twinsOf(group: FlowGroup, m: FlowMember): FlowMember[] {
  if (m.sharePrice) return [];
  return group.members.filter((t) => t.unit === 'tokens' && !t.sharePrice && sameSet(t.countFrom, m.countFrom));
}

/** The active daily scan row per UTC day the row covers (observed at the day's end). */
async function rowsByDay(db: Db, assetId: string, metricKey: string): Promise<Map<string, Observation>> {
  const out = new Map<string, Observation>();
  for (const o of await listActiveObservations(db, assetId, metricKey)) {
    if (o.periodDays !== 1) continue;
    out.set(utcDay(new Date(o.observedAt).getTime() - MS_PER_DAY), o);
  }
  return out;
}

/** The flow metrics whose source is a first-party API reporting dollars (the adapter's own declaration). */
function usdNativeMetrics(asset: AssetConfig): string[] {
  return Object.entries(asset.metrics)
    .filter(([, d]) => d.type === 'flow' && d.source?.type === 'adapter' && findAdapter(d.source.name)?.usdNative?.(d.source.params ?? {}) === true)
    .map(([k]) => k)
    .sort();
}

function widen(result: BackfillTokensResult, from: string, to: string): void {
  result.range = result.range === null ? { from, to } : { from: from < result.range.from ? from : result.range.from, to: to > result.range.to ? to : result.range.to };
}

/** One day's rows to fill, written in one transaction under the asset's lock; a row retired since it was read is skipped. */
async function fillDay(
  db: Db, assetId: string, day: string, rows: { metricKey: string; row: Observation; tokens: ObservationTokens }[], result: BackfillTokensResult,
): Promise<void> {
  const out = await db.tx(async (t) => {
    const r = { filled: 0, already: 0, gone: [] as { metricKey: string; id: number }[] };
    for (const { metricKey, row, tokens } of rows) {
      if (await fillObservationTokens(t, row.id, tokens)) r.filled++;
      else if (await isActiveObservation(t, row.id)) r.already++;
      else r.gone.push({ metricKey, id: row.id });
    }
    return r;
  }, { lockAsset: assetId });
  result.filled += out.filled;
  result.alreadyFilled += out.already;
  for (const g of out.gone) result.skipped.push({ day, metricKey: g.metricKey, reason: `the row #${g.id} was superseded or rejected during the run` });
}

export async function backfillTokens(db: Db, loaded: LoadedAsset, deps: FetchDeps, opts: BackfillTokensOptions = {}): Promise<BackfillTokensResult> {
  const asset = loaded.config;
  const dryRun = opts.dryRun ?? false;
  const result: BackfillTokensResult = { assetId: asset.id, dryRun, range: null, filled: 0, alreadyFilled: 0, skipped: [], refused: [], prices: [], notes: [] };
  const plan = buildPlan(asset);
  const flowMetrics = new Set(plan.flowGroups.flatMap((g) => g.members.map((m) => m.metricKey)));
  const usdMetrics = usdNativeMetrics(asset);
  for (const k of opts.metrics ?? []) {
    if (!asset.metrics[k]) throw new OrionError('unknown_metric', `metric "${k}" is not defined in assets/${asset.id}.yaml`);
    if (!flowMetrics.has(k) && !usdMetrics.includes(k)) {
      throw new OrionError('not_a_transfer_flow', `metric "${k}" is neither a transfer_flow nor a first-party dollar series: only those are filled with tokens`);
    }
  }
  const wanted = (k: string) => opts.metrics === undefined || opts.metrics.length === 0 || opts.metrics.includes(k);
  const groups = plan.flowGroups.filter((g) => g.members.some((m) => wanted(m.metricKey)));
  const usdSelected = usdMetrics.filter(wanted);
  if (groups.length === 0 && usdSelected.length === 0) {
    throw new OrionError('not_a_transfer_flow', `assets/${asset.id}.yaml has no transfer_flow metric or first-party dollar series to fill`);
  }
  if (opts.days !== undefined && !(Number.isInteger(opts.days) && opts.days >= 1)) throw new OrionError('invalid_number', '--days must be a positive whole number');
  const now = deps.now();
  const fromDay = opts.days === undefined ? null : utcDay(now.getTime() - opts.days * MS_PER_DAY);

  if (usdSelected.length > 0) await fillUsdNative(db, asset, usdSelected, fromDay, dryRun, result, opts.onProgress);
  if (groups.length > 0) await fillTransferScans(db, asset, deps, groups, (m) => wanted(m.metricKey), fromDay, now, dryRun, result, opts.onProgress);
  return result;
}

/** R18: the first-party dollar rows written before 0005 get token 'usd' and amount = value. No request is made. */
async function fillUsdNative(
  db: Db, asset: AssetConfig, metrics: string[], fromDay: string | null, dryRun: boolean, result: BackfillTokensResult, onProgress?: (line: string) => void,
): Promise<void> {
  const byDay = new Map<string, { metricKey: string; row: Observation; tokens: ObservationTokens }[]>();
  const skipped: BackfillTokensResult['skipped'] = [];
  const candidates: Observation[] = [];
  for (const metricKey of metrics) {
    for (const o of await listActiveObservations(db, asset.id, metricKey)) {
      if (o.periodDays === null) continue;
      // The first day the row covers (a periodic payment covers periodDays days ending at observed_at).
      const day = utcDay(new Date(o.observedAt).getTime() - o.periodDays * MS_PER_DAY);
      if (fromDay !== null && day < fromDay) continue;
      widen(result, day, day);
      if (o.source !== 'api') skipped.push({ day, metricKey, reason: `the active row #${o.id} is ${o.source}, not the first-party series` });
      else if (defillamaUrlOf(o.sourceDetail) !== null) skipped.push({ day, metricKey, reason: `the active row #${o.id} was read from DefiLlama, not the first-party series` });
      else candidates.push(o);
    }
  }
  result.skipped.push(...skipped.sort((a, b) => (a.day === b.day ? a.metricKey.localeCompare(b.metricKey) : a.day < b.day ? -1 : 1)));
  const stored = new Map((await getTokensByIds(db, candidates.map((o) => o.id))).map((t) => [t.id, t.amount]));
  for (const o of candidates) {
    if (stored.get(o.id) !== null && stored.get(o.id) !== undefined) {
      result.alreadyFilled++;
      continue;
    }
    const day = utcDay(new Date(o.observedAt).getTime() - o.periodDays! * MS_PER_DAY);
    const list = byDay.get(day) ?? [];
    list.push({ metricKey: o.metricKey, row: o, tokens: { tokenRef: USD_TOKEN.tokenRef, amount: o.value, hourlyAmounts: null } });
    byDay.set(day, list);
  }
  if (byDay.size === 0) return;
  if (dryRun) {
    for (const rows of byDay.values()) result.filled += rows.length;
    return;
  }
  await upsertToken(db, USD_TOKEN);
  for (const day of [...byDay.keys()].sort()) {
    await fillDay(db, asset.id, day, byDay.get(day)!, result);
    onProgress?.(`usd-native ${day}: ${byDay.get(day)!.length} row(s)`);
  }
}

interface Pending {
  m: FlowMember;
  row: Observation;
  token: TokenInfo;
}

async function fillTransferScans(
  db: Db, asset: AssetConfig, deps: FetchDeps, groups: FlowGroup[], wanted: (m: FlowMember) => boolean, fromDay: string | null, now: Date, dryRun: boolean,
  result: BackfillTokensResult, onProgress?: (line: string) => void,
): Promise<void> {
  const ingest = asset.ingest!; // a transfer_flow needs it
  const url = deps.env[ingest.rpc_url_env] ?? DEFAULT_RPC_URLS[ingest.chain_id];
  if (!url) throw new OrionError('missing_rpc_url', `set ${ingest.rpc_url_env}: there is no default RPC URL for chain ${ingest.chain_id}`);
  const rpc = deps.rpcFactory(url, ingest.chain_id);
  const nowIso = now.toISOString();
  const upper = await scanUpperBound(rpc, await rpc.latestBlock(), result.notes);
  const lastCompleteDay = utcDay(Math.floor(upper.timestamp / 86_400) * 86_400 * 1000 - MS_PER_DAY);

  // The stored rows of every member (selected ones are filled, the others may be a selected one's twin).
  const stored = new Map<string, Map<string, Observation>>();
  for (const g of groups) for (const m of g.members) stored.set(m.metricKey, await rowsByDay(db, asset.id, m.metricKey));
  const selected = groups.flatMap((g) => g.members.filter(wanted));
  let startDay: string;
  if (fromDay !== null) startDay = fromDay;
  else {
    const days = selected.flatMap((m) => [...stored.get(m.metricKey)!.keys()]).sort();
    if (days.length === 0) {
      result.notes.push('no stored transfer-scan row to fill');
      return;
    }
    startDay = days[0]!;
  }
  if (startDay > lastCompleteDay) {
    result.notes.push(`no completed day to re-scan: the last complete day is ${lastCompleteDay}`);
    return;
  }
  widen(result, startDay, lastCompleteDay);

  const tokenFill = new Map<number, number | null>(); // row id -> its stored amount
  for (const m of selected) {
    const rows = [...stored.get(m.metricKey)!.values()];
    for (const t of await getTokensByIds(db, rows.map((r) => r.id))) tokenFill.set(t.id, t.amount);
  }

  // Each group's tokens and, per day, the rows to fill (decided before any scan, so prices are fetched for those days only).
  const prepared: { group: FlowGroup; decimals: number; tokens: TokenInfo[]; pending: Map<string, Pending[]> }[] = [];
  for (const group of groups) {
    const decimals = await readDecimals(rpc, group, upper);
    const tokenOf = new Map(group.members.map((m) => [m.metricKey, memberToken(asset, group, m, decimals)]));
    const pending = new Map<string, Pending[]>();
    for (let day = startDay; day <= lastCompleteDay; day = addDays(day, 1)) {
      const list: Pending[] = [];
      for (const m of group.members.filter(wanted)) {
        const row = stored.get(m.metricKey)!.get(day);
        const token = tokenOf.get(m.metricKey)!;
        if (!row) result.skipped.push({ day, metricKey: m.metricKey, reason: 'no active row for the day' });
        else if (row.source !== 'onchain') result.skipped.push({ day, metricKey: m.metricKey, reason: `the active row #${row.id} is ${row.source}, not a transfer scan` });
        else if (tokenFill.get(row.id) !== null && tokenFill.get(row.id) !== undefined) result.alreadyFilled++;
        else if (token === null) result.skipped.push({ day, metricKey: m.metricKey, reason: 'the member has no token (a vault share with no price id)' });
        else list.push({ m, row, token });
      }
      if (list.length > 0) pending.set(day, list);
    }
    prepared.push({ group, decimals, tokens: uniqueTokens(group.members.filter(wanted).map((m) => tokenOf.get(m.metricKey)!)), pending });
  }

  // Hourly prices: one market_chart range per CoinGecko id for the whole run, only for the hours the pending days need
  // and the store lacks, stored under every token ref priced at that id (a dry run fetches nothing).
  const byId = new Map<string, { tokens: TokenInfo[]; days: Set<string> }>();
  for (const p of prepared) {
    for (const t of p.tokens) {
      if (t.coingeckoId === null) continue;
      const e = byId.get(t.coingeckoId) ?? { tokens: [], days: new Set<string>() };
      if (!e.tokens.some((x) => x.tokenRef === t.tokenRef)) e.tokens.push(t);
      byId.set(t.coingeckoId, e);
    }
    for (const [day, list] of p.pending) for (const { token } of list) if (token.coingeckoId !== null) byId.get(token.coingeckoId)!.days.add(day);
  }
  for (const [id, e] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    result.prices.push(await backfillPrices(db, deps, id, e.tokens, [...e.days].sort(), nowIso, dryRun));
  }

  for (const { group, decimals, tokens, pending } of prepared) {
    if (!dryRun) for (const t of tokens) await upsertToken(db, t);
    const scanner = await openDayScanner({
      group, rpc, latest: upper, ...(deps.dayBlocks ? { dayBlocks: deps.dayBlocks(ingest.chain_id) } : {}), cacheDayBlocks: !dryRun, sleep: deps.sleep, series: null, decimals,
    });
    let unlisted = 0;
    let from = await scanner.dayStart(startDay, upper);
    for (let day = startDay; day <= lastCompleteDay; day = addDays(day, 1)) {
      const next = await scanner.dayStart(addDays(day, 1), from);
      const list = pending.get(day) ?? [];
      if (list.length > 0) {
        const scan = await scanner.scanDay(day, from, next);
        unlisted += scan.unlisted.length;
        const mismatches = new Map<string, string>();
        for (const { m } of list) {
          const amount = scan.tokens.get(m.metricKey)!.amount;
          for (const t of twinsOf(group, m)) {
            const twin = stored.get(t.metricKey)?.get(day);
            if (twin && rel(twin.value, amount) > TWIN_REL_TOLERANCE) mismatches.set(t.metricKey, `${t.metricKey}: stored ${twin.value}, re-scanned ${amount}`);
          }
        }
        if (mismatches.size > 0) {
          result.refused.push({ day, reason: `the re-scanned tokens differ from the stored token twin by more than ${TWIN_REL_TOLERANCE} relative (${[...mismatches.values()].join('; ')})` });
        } else if (dryRun) {
          result.filled += list.length;
        } else {
          // Bounded: one day's rows per transaction, under the asset's lock (no new row, no value change).
          await fillDay(db, asset.id, day, list.map(({ m, row, token }) => {
            const tk = scan.tokens.get(m.metricKey)!;
            return { metricKey: m.metricKey, row, tokens: { tokenRef: token.tokenRef, amount: tk.amount, hourlyAmounts: tk.hourly } };
          }), result);
        }
      }
      onProgress?.(`${group.sourceId} ${day}: ${list.length === 0 ? 'nothing to fill' : `${list.length} row(s)`}`);
      from = next;
    }
    if (unlisted > 0) result.notes.push(`${group.sourceId}: ${unlisted} unlisted transfer(s) seen (not counted, as in the flow writer)`);
    if (scanner.edgeHours > 0) result.notes.push(`${group.sourceId}: ${scanner.edgeHours} transfer(s) stamped outside their day's hours, counted in its first or last hour`);
  }
}

async function backfillPrices(db: Db, deps: FetchDeps, id: string, tokens: TokenInfo[], days: string[], nowIso: string, dryRun: boolean): Promise<BackfillPrices> {
  const refs = tokens.map((t) => t.tokenRef).sort();
  const out: BackfillPrices = { coingeckoId: id, tokenRefs: refs, rows: 0, reachedDay: null, failures: [], requests: 0 };
  if (dryRun || days.length === 0) return out;
  // The hours the pending days need that some ref has no stored CoinGecko price for.
  const fromMs = dayStartMs(days[0]!);
  const toMs = dayStartMs(addDays(days[days.length - 1]!, 1));
  const have = await storedPriceHours(db, refs, COINGECKO_PRICE_SOURCE, fromMs, toMs);
  const missing: number[] = [];
  for (const day of days) for (let h = dayStartMs(day); h < dayStartMs(addDays(day, 1)); h += MS_PER_HOUR) if (!have.has(h)) missing.push(h);
  if (missing.length === 0) return out;
  const start = Math.min(...missing);
  const end = Math.max(...missing) + MS_PER_HOUR;
  const r = await fetchHourlyRange(deps.http, deps.env, id, start, end);
  out.requests = r.requests;
  out.failures = r.failures;
  out.reachedDay = r.reachedMs === null ? null : utcDay(r.reachedMs);
  const rows = hourlyPriceRows(r.points).filter((p) => {
    const ms = Date.parse(p.ts);
    return ms >= start && ms < end;
  });
  if (rows.length > 0) {
    for (const t of tokens) {
      await upsertToken(db, t);
      out.rows = await upsertPrices(db, t.tokenRef, COINGECKO_PRICE_SOURCE, rows, nowIso);
    }
  }
  return out;
}
