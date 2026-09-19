import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { advanceCursor, getCursor } from '../db/fetchCursors.js';
import { emptySourceOutcome, type FlowConflict, type SourceOutcome, type UnlistedTransfer } from '../db/fetchRuns.js';
import { insertObservation, listActiveObservations, rejectObservation } from '../db/observations.js';
import { MS_PER_DAY, OrionError } from '../types.js';
import type { FlowGroup } from './plan.js';
import { ERC20_ABI } from './sources/chainLevels.js';
import { COINGECKO_API, coingeckoHeaders } from './sources/coingecko.js';
import { addDays, dayStartMs, utcDay } from './time.js';
import type { HttpTransport } from './transport/http.js';
import { firstBlockAtOrAfter, getLogsChunked, type BlockRef, type RpcTransport } from './transport/rpc.js';
import type { DailyPoint, WrittenObservation } from './types.js';
import { unitsToNumber } from './units.js';

const SECONDS_PER_DAY = 86_400;
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
  const chart = (days: number) => `${COINGECKO_API}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`;
  const hourly = parseMarketChart(await http.getJson(chart(90), coingeckoHeaders(env)), `coingecko ${id} hourly`);
  let daily: PricePoint[] = [];
  if (startMs < hourly[0].ts) {
    // CoinGecko returns daily points beyond 90 days. Made only when the scan reaches back past the hourly series.
    const days = Math.max(91, Math.ceil((nowMs - startMs) / MS_PER_DAY) + 1);
    daily = parseMarketChart(await http.getJson(chart(days), coingeckoHeaders(env)), `coingecko ${id} daily`);
  }
  return { hourly, daily };
}

/** Active rows from another source whose period overlaps (startMs, endMs). Periods that only touch do not overlap. */
export function findFlowConflicts(db: Db, assetId: string, metricKey: string, startMs: number, endMs: number): FlowConflict[] {
  return listActiveObservations(db, assetId, metricKey)
    .filter((o) => {
      if (o.source === 'onchain') return false;
      const end = new Date(o.observedAt).getTime();
      const start = end - (o.periodDays ?? 1) * MS_PER_DAY;
      return Math.min(end, endMs) - Math.max(start, startMs) > 0;
    })
    .map((o) => ({
      metricKey, observationId: o.id, source: o.source, observedAt: o.observedAt, periodDays: o.periodDays, adoptable: o.source === 'manual',
    }));
}

export interface FlowScanArgs {
  db: Db;
  asset: AssetConfig;
  group: FlowGroup;
  rpc: RpcTransport;
  /** The latest block at plan start. */
  latest: BlockRef;
  http: HttpTransport;
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  now: Date;
  backfillDays: number;
  /** Ignore the cursor and scan `backfillDays` back again. Rows for the same day supersede the old ones. */
  rescan: boolean;
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

export async function scanFlowGroup(args: FlowScanArgs): Promise<FlowScanResult> {
  const { db, asset, group, rpc, latest, dryRun } = args;
  const outcome = emptySourceOutcome(group.sourceId);
  const result: FlowScanResult = { outcome, written: [], unlisted: [], daily: new Map(group.members.map((m) => [m.metricKey, []])) };
  const nowIso = args.now.toISOString();

  try {
    // 1. Range: completed UTC days only.
    const lastMidnightSec = Math.floor(latest.timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const lastCompleteDay = utcDay(lastMidnightSec * 1000 - MS_PER_DAY);
    const cursor = getCursor(db, asset.id, group.scanKey);
    const startDay = cursor && !args.rescan ? addDays(cursor.lastDay, 1) : utcDay(args.now.getTime() - args.backfillDays * MS_PER_DAY);
    if (startDay > lastCompleteDay) {
      outcome.notes.push(`no completed day to scan: the last complete day is ${lastCompleteDay} and the scan is already there`);
      return result;
    }
    const rangeStartMs = dayStartMs(startDay);
    const rangeEndMs = dayStartMs(lastCompleteDay) + MS_PER_DAY;

    // 2. Conflicts with rows from other sources decide whether the group runs at all.
    const conflicts = group.members.flatMap((m) => findFlowConflicts(db, asset.id, m.metricKey, rangeStartMs, rangeEndMs));
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

    // 3. Token decimals and price series.
    const [decimalsCall] = await rpc.multicall([{ address: group.token, signature: ERC20_ABI.decimals, functionName: 'decimals' }], latest.number);
    if (!decimalsCall.ok) throw new Error(`decimals() on the token: ${decimalsCall.error}`);
    const decimals = Number(decimalsCall.value);
    const series = new Map<string, PriceSeries>();
    for (const m of group.members) {
      if (m.unit !== 'usd') continue;
      if (m.priceCoingeckoId === null) throw new OrionError('invalid_source_config', `${m.metricKey}: a transfer_flow with unit usd needs price_coingecko_id`);
      if (!series.has(m.priceCoingeckoId)) {
        series.set(m.priceCoingeckoId, await loadPrices(args.http, args.env, m.priceCoingeckoId, rangeStartMs, args.now.getTime()));
      }
    }

    // 4. One day at a time, oldest first. Each day commits on its own, so an interrupted backfill resumes.
    const allow = new Map(group.allowlist.map((a) => [a.address, a.name]));
    const retired = new Set<number>();
    const wroteAny = new Set<string>();
    let from = await firstBlockAtOrAfter(rpc, rangeStartMs / 1000, latest, latest);

    for (let day = startDay; day <= lastCompleteDay; day = addDays(day, 1)) {
      const dayEndMs = dayStartMs(day) + MS_PER_DAY;
      const next = await firstBlockAtOrAfter(rpc, dayEndMs / 1000, from, latest);
      const sums = new Map(group.members.map((m) => [m.metricKey, 0]));
      const senders = new Map<string, { count: number; tokens: number }>();
      let counted = 0;
      let unlistedToday = 0;

      for await (const chunk of getLogsChunked(rpc, { token: group.token, to: group.sink, fromBlock: from.number, toBlock: next.number - 1n }, { sleep: args.sleep })) {
        for (const log of chunk.logs) {
          const sender = log.from.toLowerCase();
          const tokens = unitsToNumber(log.value, decimals);
          const name = allow.get(sender);
          if (name === undefined) {
            result.unlisted.push({ txHash: log.txHash, logIndex: log.logIndex, blockNumber: Number(log.blockNumber), from: sender, tokens, day });
            unlistedToday++;
            continue;
          }
          counted++;
          const tally = senders.get(name) ?? { count: 0, tokens: 0 };
          tally.count++;
          tally.tokens += tokens;
          senders.set(name, tally);
          for (const m of group.members) {
            if (!m.countFrom.includes(sender)) continue;
            let amount = tokens;
            if (m.unit === 'usd') {
              const price = priceAt(series.get(m.priceCoingeckoId!)!, log.timestamp * 1000);
              if (price === null) {
                throw new Error(
                  `no ${m.priceCoingeckoId} price point at or before ${new Date(log.timestamp * 1000).toISOString()}; day ${day} was not written`,
                );
              }
              amount = tokens * price;
            }
            sums.set(m.metricKey, sums.get(m.metricKey)! + amount);
          }
        }
      }

      const observedAt = new Date(dayEndMs).toISOString();
      const detail = JSON.stringify({
        day,
        blocks: [Number(from.number), Number(next.number) - 1],
        senders: Object.fromEntries([...senders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      });
      const ids = new Map<string, number | null>(group.members.map((m) => [m.metricKey, null]));
      if (!dryRun) {
        db.transaction(() => {
          for (const m of group.members) {
            for (const c of conflicts) {
              if (c.metricKey !== m.metricKey || retired.has(c.observationId)) continue;
              const end = new Date(c.observedAt).getTime();
              const start = end - (c.periodDays ?? 1) * MS_PER_DAY;
              if (Math.min(end, dayEndMs) - Math.max(start, dayEndMs - MS_PER_DAY) <= 0) continue;
              rejectObservation(db, c.observationId);
              retired.add(c.observationId);
              outcome.retiredObservationIds.push(c.observationId);
            }
            const o = insertObservation(db, {
              assetId: asset.id, metricKey: m.metricKey, observedAt, periodDays: 1, value: sums.get(m.metricKey)!, source: 'onchain',
              sourceDetail: detail, fetchedAt: nowIso,
            });
            ids.set(m.metricKey, o.id);
          }
          advanceCursor(db, asset.id, group.scanKey, { lastBlock: Number(next.number) - 1, lastDay: day }, nowIso);
        })();
      }
      for (const m of group.members) {
        const value = sums.get(m.metricKey)!;
        result.written.push({ metricKey: m.metricKey, value, observedAt, periodDays: 1, source: 'onchain', observationId: ids.get(m.metricKey)! });
        result.daily.get(m.metricKey)!.push({ day, value });
        wroteAny.add(m.metricKey);
      }
      args.onProgress?.(`${group.sourceId} ${day}: ${counted} transfers${unlistedToday > 0 ? `, ${unlistedToday} unlisted` : ''}`);
      from = next;
    }

    outcome.metricsWritten = group.members.map((m) => m.metricKey).filter((k) => wroteAny.has(k));
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
