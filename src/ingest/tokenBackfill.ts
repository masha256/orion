import type { LoadedAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { fillObservationTokens, getTokensByIds, listActiveObservations, type Observation } from '../db/observations.js';
import { upsertPrices, upsertToken, type TokenInfo } from '../db/prices.js';
import { COINGECKO_PRICE_SOURCE, fetchHourlyRange, hourlyPriceRows } from '../prices/coingeckoHourly.js';
import { MS_PER_DAY, OrionError } from '../types.js';
import { memberToken, openDayScanner, readDecimals, scanUpperBound, uniqueTokens } from './flow.js';
import { buildPlan, type FlowGroup, type FlowMember } from './plan.js';
import { DEFAULT_RPC_URLS, type FetchDeps } from './run.js';
import { addDays, dayStartMs, utcDay } from './time.js';

/**
 * The token backfill (Task 7, spec §4): fills `amount`, `hourly_amounts` and `token_ref` on the transfer-scan rows written
 * before 0005, by re-scanning each day with the flow writer's own day scanner. It never inserts a row and never changes
 * `value`: one `UPDATE ... WHERE id = <active row> AND amount IS NULL` per row, one transaction per day under the asset's
 * lock. A day whose re-scanned token total differs from a stored `flow_tokens.*` twin by more than TWIN_REL_TOLERANCE is
 * refused whole (the chain no longer says what the row says: a config change, a reorg, or a bug), and a day with no
 * active row is skipped; both are listed. The range's hourly prices are fetched from CoinGecko's market_chart/range, one
 * token at a time through the run's transport (its CoinGecko spacing), and upserted into `prices`.
 */

export const TWIN_REL_TOLERANCE = 1e-9;

export interface BackfillTokensOptions {
  /** Only these transfer_flow metrics (default: every transfer_flow metric of the asset). */
  metrics?: string[];
  /** Days back from now (default: from the oldest active row of the metrics). */
  days?: number;
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export interface BackfillPrices {
  coingeckoId: string;
  tokenRef: string;
  /** Hourly rows upserted (0 on a dry run, which fetches nothing). */
  rows: number;
  /** The first day the hourly series reaches; null when no window answered. */
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

export async function backfillTokens(db: Db, loaded: LoadedAsset, deps: FetchDeps, opts: BackfillTokensOptions = {}): Promise<BackfillTokensResult> {
  const asset = loaded.config;
  const dryRun = opts.dryRun ?? false;
  const result: BackfillTokensResult = { assetId: asset.id, dryRun, range: null, filled: 0, alreadyFilled: 0, skipped: [], refused: [], prices: [], notes: [] };
  const plan = buildPlan(asset);
  const flowMetrics = new Set(plan.flowGroups.flatMap((g) => g.members.map((m) => m.metricKey)));
  for (const k of opts.metrics ?? []) {
    if (!asset.metrics[k]) throw new OrionError('unknown_metric', `metric "${k}" is not defined in assets/${asset.id}.yaml`);
    if (!flowMetrics.has(k)) throw new OrionError('not_a_transfer_flow', `metric "${k}" is not a transfer_flow: only transfer scans are re-scanned to tokens`);
  }
  const wanted = (m: FlowMember) => opts.metrics === undefined || opts.metrics.length === 0 || opts.metrics.includes(m.metricKey);
  const groups = plan.flowGroups.filter((g) => g.members.some(wanted));
  if (groups.length === 0) throw new OrionError('not_a_transfer_flow', `assets/${asset.id}.yaml has no transfer_flow metric to re-scan`);
  if (opts.days !== undefined && !(Number.isInteger(opts.days) && opts.days >= 1)) throw new OrionError('invalid_number', '--days must be a positive whole number');

  const ingest = asset.ingest!; // a transfer_flow needs it
  const url = deps.env[ingest.rpc_url_env] ?? DEFAULT_RPC_URLS[ingest.chain_id];
  if (!url) throw new OrionError('missing_rpc_url', `set ${ingest.rpc_url_env}: there is no default RPC URL for chain ${ingest.chain_id}`);
  const rpc = deps.rpcFactory(url, ingest.chain_id);
  const now = deps.now();
  const nowIso = now.toISOString();
  const upper = await scanUpperBound(rpc, await rpc.latestBlock(), result.notes);
  const lastCompleteDay = utcDay(Math.floor(upper.timestamp / 86_400) * 86_400 * 1000 - MS_PER_DAY);

  // The stored rows of every member (selected ones are filled, the others may be a selected one's twin).
  const stored = new Map<string, Map<string, Observation>>();
  for (const g of groups) for (const m of g.members) stored.set(m.metricKey, await rowsByDay(db, asset.id, m.metricKey));
  const selected = groups.flatMap((g) => g.members.filter(wanted));
  let startDay: string;
  if (opts.days !== undefined) startDay = utcDay(now.getTime() - opts.days * MS_PER_DAY);
  else {
    const days = selected.flatMap((m) => [...stored.get(m.metricKey)!.keys()]).sort();
    if (days.length === 0) {
      result.notes.push('no stored row to fill');
      return result;
    }
    startDay = days[0]!;
  }
  if (startDay > lastCompleteDay) {
    result.notes.push(`no completed day to re-scan: the last complete day is ${lastCompleteDay}`);
    return result;
  }
  result.range = { from: startDay, to: lastCompleteDay };

  const tokenFill = new Map<number, number | null>(); // row id -> its stored amount
  for (const m of selected) {
    const rows = [...stored.get(m.metricKey)!.values()];
    for (const t of await getTokensByIds(db, rows.map((r) => r.id))) tokenFill.set(t.id, t.amount);
  }

  for (const group of groups) {
    const decimals = await readDecimals(rpc, group, upper);
    const tokenOf = new Map(group.members.map((m) => [m.metricKey, memberToken(asset, group, m, decimals)]));
    const tokens = uniqueTokens(group.members.filter(wanted).map((m) => tokenOf.get(m.metricKey)!));

    // The range's hourly prices, one CoinGecko id at a time (a dry run fetches nothing).
    for (const t of tokens) {
      if (t.coingeckoId === null || result.prices.some((p) => p.tokenRef === t.tokenRef)) continue;
      result.prices.push(await backfillPrices(db, deps, t, dayStartMs(startDay), now.getTime(), nowIso, dryRun));
    }
    if (!dryRun) for (const t of tokens) await upsertToken(db, t);

    const scanner = await openDayScanner({
      group, rpc, latest: upper, ...(deps.dayBlocks ? { dayBlocks: deps.dayBlocks(ingest.chain_id) } : {}), cacheDayBlocks: !dryRun, sleep: deps.sleep, series: null, decimals,
    });
    let unlisted = 0;
    let from = await scanner.dayStart(startDay, upper);
    for (let day = startDay; day <= lastCompleteDay; day = addDays(day, 1)) {
      const next = await scanner.dayStart(addDays(day, 1), from);
      const pending: { m: FlowMember; row: Observation; token: TokenInfo }[] = [];
      for (const m of group.members.filter(wanted)) {
        const row = stored.get(m.metricKey)!.get(day);
        const token = tokenOf.get(m.metricKey)!;
        if (!row) result.skipped.push({ day, metricKey: m.metricKey, reason: 'no active row for the day' });
        else if (row.source !== 'onchain') result.skipped.push({ day, metricKey: m.metricKey, reason: `the active row #${row.id} is ${row.source}, not a transfer scan` });
        else if (tokenFill.get(row.id) !== null && tokenFill.get(row.id) !== undefined) result.alreadyFilled++;
        else if (token === null) result.skipped.push({ day, metricKey: m.metricKey, reason: 'the member has no token (a vault share with no price id)' });
        else pending.push({ m, row, token });
      }
      if (pending.length > 0) {
        const scan = await scanner.scanDay(day, from, next);
        unlisted += scan.unlisted.length;
        const mismatches = new Map<string, string>();
        for (const { m } of pending) {
          const amount = scan.tokens.get(m.metricKey)!.amount;
          for (const t of twinsOf(group, m)) {
            const twin = stored.get(t.metricKey)?.get(day);
            if (twin && rel(twin.value, amount) > TWIN_REL_TOLERANCE) mismatches.set(t.metricKey, `${t.metricKey}: stored ${twin.value}, re-scanned ${amount}`);
          }
        }
        if (mismatches.size > 0) {
          result.refused.push({ day, reason: `the re-scanned tokens differ from the stored token twin by more than ${TWIN_REL_TOLERANCE} relative (${[...mismatches.values()].join('; ')})` });
        } else if (dryRun) {
          result.filled += pending.length;
        } else {
          // Bounded: one day's rows per transaction, under the asset's lock (no new row, no value change).
          const filled = await db.tx(async (t) => {
            let n = 0;
            for (const { m, row, token } of pending) {
              const tk = scan.tokens.get(m.metricKey)!;
              if (await fillObservationTokens(t, row.id, { tokenRef: token.tokenRef, amount: tk.amount, hourlyAmounts: tk.hourly })) n++;
            }
            return n;
          }, { lockAsset: asset.id });
          result.filled += filled;
          result.alreadyFilled += pending.length - filled;
        }
      }
      opts.onProgress?.(`${group.sourceId} ${day}: ${pending.length === 0 ? 'nothing to fill' : `${pending.length} row(s)`}`);
      from = next;
    }
    if (unlisted > 0) result.notes.push(`${group.sourceId}: ${unlisted} unlisted transfer(s) seen (not counted, as in the flow writer)`);
    if (scanner.edgeHours > 0) result.notes.push(`${group.sourceId}: ${scanner.edgeHours} transfer(s) stamped outside their day's hours, counted in its first or last hour`);
  }
  return result;
}

async function backfillPrices(db: Db, deps: FetchDeps, t: TokenInfo, fromMs: number, toMs: number, nowIso: string, dryRun: boolean): Promise<BackfillPrices> {
  const out: BackfillPrices = { coingeckoId: t.coingeckoId!, tokenRef: t.tokenRef, rows: 0, reachedDay: null, failures: [], requests: 0 };
  if (dryRun) return out;
  const r = await fetchHourlyRange(deps.http, deps.env, t.coingeckoId!, fromMs, toMs);
  out.requests = r.requests;
  out.failures = r.failures;
  out.reachedDay = r.reachedMs === null ? null : utcDay(r.reachedMs);
  const rows = hourlyPriceRows(r.points);
  if (rows.length > 0) {
    await upsertToken(db, t);
    out.rows = await upsertPrices(db, t.tokenRef, COINGECKO_PRICE_SOURCE, rows, nowIso);
  }
  return out;
}
