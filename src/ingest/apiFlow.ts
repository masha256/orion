import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { advanceCursor, getCursor } from '../db/fetchCursors.js';
import type { FlowConflict, SourceOutcome } from '../db/fetchRuns.js';
import { insertObservation, listActiveObservations, rejectObservation } from '../db/observations.js';
import { MS_PER_DAY } from '../types.js';
import { findFlowConflicts } from './flow.js';
import { addDays, dayStartMs, utcDay } from './time.js';
import type { DailyPoint, WrittenObservation } from './types.js';

/**
 * A flow metric whose primary is an API's daily series (DefiLlama): one row per completed UTC day, under a cursor, the
 * shape the transfer scan writes. The API may omit a day it has not aggregated yet, and may revise a recent one, so a
 * missing day is skipped (never written as zero) and the last few written days are read again on every run.
 */

export const DEFAULT_API_FLOW_BACKFILL_DAYS = 90;
/** Days already written that every run reads again: a revised value supersedes the day's row. */
export const REVISION_DAYS = 3;

export interface ApiFlowArgs {
  db: Db;
  asset: AssetConfig;
  metricKey: string;
  /** The fetch_cursors key: one per source and metric. */
  scanKey: string;
  points: DailyPoint[];
  /** Stored as the row's source detail: the URL the series came from. */
  detail: string;
  now: Date;
  backfillDays: number;
  /** Ignore the cursor and read `backfillDays` back again. Unchanged days are left alone; changed ones are superseded. */
  rescan: boolean;
  adopt: boolean;
  dryRun: boolean;
  outcome: SourceOutcome;
  /** Rejects a value the metric cannot store; null when it may be stored. */
  validate: (value: number) => string | null;
}

export interface ApiFlowResult {
  written: WrittenObservation[];
  /** Day values this run saw for the metric, written or already stored, for the cross-checks and derived metrics. */
  daily: DailyPoint[];
}

/** The metric's stored daily API rows, keyed by the UTC day each one covers. */
function storedApiDays(db: Db, assetId: string, metricKey: string): Map<string, number> {
  const days = new Map<string, number>();
  for (const o of listActiveObservations(db, assetId, metricKey)) {
    if (o.source === 'api' && o.periodDays === 1) days.set(utcDay(new Date(o.observedAt).getTime() - MS_PER_DAY), o.value);
  }
  return days;
}

export function writeApiFlow(args: ApiFlowArgs): ApiFlowResult {
  const { db, asset, metricKey, outcome, dryRun } = args;
  const result: ApiFlowResult = { written: [], daily: [] };
  const nowIso = args.now.toISOString();

  // 1. Range: completed UTC days only, from the cursor (less the revision window) or the backfill start.
  const lastCompleteDay = addDays(utcDay(args.now.getTime()), -1);
  const windowStart = utcDay(args.now.getTime() - args.backfillDays * MS_PER_DAY);
  const cursor = getCursor(db, asset.id, args.scanKey);
  const byDay = new Map(args.points.map((p) => [p.day, p.value]));
  const stored = storedApiDays(db, asset.id, metricKey);
  let startDay = windowStart;
  if (cursor && !args.rescan) {
    // Revisions: the last REVISION_DAYS written days are read again. Gaps: a day inside the backfill window that the
    // series had not aggregated when the cursor passed it is retried on every run until it appears (from the series'
    // first day on, so a series that starts late is not treated as a gap).
    startDay = addDays(cursor.lastDay, 1 - REVISION_DAYS);
    const seriesFirst = [...byDay.keys()].sort()[0];
    if (seriesFirst !== undefined) {
      for (let day = seriesFirst > windowStart ? seriesFirst : windowStart; day < startDay; day = addDays(day, 1)) {
        if (!stored.has(day)) {
          startDay = day;
          break;
        }
      }
    }
  }
  if (startDay > lastCompleteDay) {
    outcome.notes.push(`${metricKey}: no completed day to write: the last complete day is ${lastCompleteDay} and the series is already there`);
    return result;
  }
  const rangeStartMs = dayStartMs(startDay);
  const rangeEndMs = dayStartMs(lastCompleteDay) + MS_PER_DAY;

  // 2. Conflicts with rows from other sources decide whether anything is written at all.
  const conflicts = findFlowConflicts(db, asset.id, metricKey, rangeStartMs, rangeEndMs, 'api');
  outcome.conflicts.push(...conflicts);
  const stuck = conflicts.filter((c) => !c.adoptable);
  if (conflicts.length > 0 && (!args.adopt || stuck.length > 0)) {
    outcome.status = 'skipped';
    const ids = (list: FlowConflict[]) => list.map((c) => `#${c.observationId}`).join(', ');
    outcome.notes.push(
      stuck.length > 0
        ? `${metricKey}: nothing was written: ${ids(stuck)} overlap the days ${startDay} to ${lastCompleteDay} and are not manual rows, so --adopt cannot reject them. ` +
            'Reject them by hand with "orion data reject <id>", then fetch again.'
        : `${metricKey}: nothing was written: ${conflicts.length} active manual row(s) (${ids(conflicts)}) overlap the days ${startDay} to ${lastCompleteDay}. ` +
            'Re-run with --adopt to reject them and write the fetched rows in the same transaction.',
    );
    return result;
  }

  // 3. The days, oldest first. A day the API has not aggregated yet is skipped, not written as zero; a day already stored
  //    at the same value is left alone; a changed value supersedes the day's row. One transaction: the series is in memory.
  const skipped: string[] = [];
  const revised: string[] = [];
  let newest: string | null = cursor && !args.rescan ? cursor.lastDay : null;
  const retired: number[] = [];

  const writeDays = () => {
    // --adopt retires every overlapping manual row up front, whether or not the day it covers is rewritten: a row left
    // beside API rows for the same day would be counted twice, and the next plain fetch would be refused again.
    if (!dryRun) {
      for (const c of conflicts) {
        rejectObservation(db, c.observationId);
        retired.push(c.observationId);
      }
    }
    for (let day = startDay; day <= lastCompleteDay; day = addDays(day, 1)) {
      const value = byDay.get(day);
      if (value === undefined) {
        skipped.push(day);
        continue;
      }
      const refusal = args.validate(value);
      if (refusal !== null) throw new Error(`${day}: ${refusal}`);
      result.daily.push({ day, value });
      const have = stored.get(day);
      if (have === value) continue;
      if (have !== undefined) revised.push(day);
      const dayEndMs = dayStartMs(day) + MS_PER_DAY;
      const observedAt = new Date(dayEndMs).toISOString();
      let observationId: number | null = null;
      if (!dryRun) {
        observationId = insertObservation(db, {
          assetId: asset.id, metricKey, observedAt, periodDays: 1, value, source: 'api', sourceDetail: args.detail, fetchedAt: nowIso,
        }).id;
      }
      result.written.push({ metricKey, value, observedAt, periodDays: 1, source: 'api', observationId });
      if (newest === null || day > newest) newest = day;
    }
    // The cursor never moves backwards; lastBlock is meaningless for an API series.
    if (!dryRun && newest !== null) advanceCursor(db, asset.id, args.scanKey, { lastBlock: 0, lastDay: newest }, nowIso);
  };
  // IMMEDIATE: each insert reads for rows to supersede before it writes; see runValuation for why deferred fails.
  if (dryRun) writeDays();
  else db.transaction(writeDays).immediate();
  outcome.retiredObservationIds.push(...retired); // after the commit: a rolled-back transaction retired nothing

  if (result.written.length > 0) outcome.metricsWritten.push(metricKey);
  else outcome.notes.push(`${metricKey}: no new or revised day in ${startDay} to ${lastCompleteDay}`);
  if (revised.length > 0) outcome.notes.push(`${metricKey}: revised by the source, superseded: ${revised.join(', ')}`);
  if (skipped.length > 0) {
    const which = skipped.length <= 5 ? skipped.join(', ') : `${skipped.length} days from ${skipped[0]} to ${skipped[skipped.length - 1]}`;
    outcome.notes.push(`${metricKey}: not in the series, skipped: ${which}`);
  }
  if (dryRun && conflicts.length > 0) outcome.notes.push(`--adopt would reject ${conflicts.map((c) => `#${c.observationId}`).join(', ')}`);
  return result;
}
