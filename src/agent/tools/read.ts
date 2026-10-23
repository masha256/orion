import { z } from 'zod';
import { eligibleObservations } from '../../app/eligibility.js';
import { listAnomalies } from '../../db/anomalies.js';
import { listJournal } from '../../db/journal.js';
import { listActiveObservations, listObservations, type Observation } from '../../db/observations.js';
import { listSignals } from '../../db/runs.js';
import { computeDrivers } from '../../drivers/compute.js';
import { requiredExtraMetrics } from '../../engine/requirements.js';
import { dayStartMs, isIsoDate, utcDay } from '../../ingest/time.js';
import { MS_PER_DAY, OrionError } from '../../types.js';
import { describeAnomaly, describeAssumptions, describeDrivers, describeObservation, describeSignal } from '../describe.js';
import { defineTool, refuse, type AgentTool } from './types.js';

const getDrivers = defineTool({
  name: 'get_drivers',
  description:
    'The driver report: every driver with its value, provenance, and age, plus missing, stale, and provisional metrics. ' +
    'Pass as_of (ISO timestamp) to see the drivers as they stood at an earlier time.',
  input: z.strictObject({ as_of: z.string().optional() }),
  run(ctx, input) {
    const asOf = input.as_of === undefined ? ctx.now() : new Date(input.as_of);
    if (Number.isNaN(asOf.getTime())) throw new OrionError('invalid_timestamp', `invalid as_of: ${input.as_of}`);
    const asset = ctx.loaded.config;
    const iso = asOf.toISOString();
    const observations = eligibleObservations(ctx.db, asset, iso);
    ctx.ledger.markShown(observations.map((o) => o.id));
    return {
      ...describeDrivers(computeDrivers(asset, observations, iso, requiredExtraMetrics(asset)), iso),
      // The observations behind these drivers: the ids you may cite as evidence.
      observations_in_force: observations.map((o) => ({ id: o.id, metric: o.metricKey, value: o.value, observed_at: o.observedAt, status: o.status })),
    };
  },
});

const getObservations = defineTool({
  name: 'get_observations',
  description:
    'Observations of one metric, newest first, each with its id (cite ids as evidence), value, source, status, and citation. ' +
    'Observations you recorded in this run are listed first, with negative ids. include_inactive adds superseded and rejected rows.',
  input: z.strictObject({
    metric: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
    include_inactive: z.boolean().optional(),
  }),
  run(ctx, input) {
    if (!ctx.loaded.config.metrics[input.metric]) {
      refuse('unknown_metric', `${input.metric} is not a metric of ${ctx.loaded.config.id}`, { metrics: Object.keys(ctx.loaded.config.metrics).sort() });
    }
    const stored = listObservations(ctx.db, ctx.loaded.config.id, input.metric, { includeInactive: input.include_inactive, limit: input.limit ?? 10 });
    ctx.ledger.markShown(stored.map((o) => o.id));
    const staged = ctx.ledger.observationRows(ctx.now().toISOString()).filter((o) => o.metricKey === input.metric);
    return { metric: input.metric, definition: ctx.loaded.config.metrics[input.metric], observations: [...staged, ...stored].map(describeObservation) };
  },
});

const getAnomalies = defineTool({
  name: 'get_anomalies',
  description:
    'Open anomalies for the asset. include_decided adds resolved and acknowledged ones. An acknowledged anomaly is the user\'s standing ' +
    'decision and is read-only to you.',
  input: z.strictObject({ include_decided: z.boolean().optional() }),
  run(ctx, input) {
    const staged = ctx.ledger.resolvedAnomalyIds();
    return {
      anomalies: listAnomalies(ctx.db, { assetId: ctx.loaded.config.id, includeDecided: input.include_decided }).map((a) => describeAnomaly(a, staged.has(a.id))),
    };
  },
});

const getAssumptions = defineTool({
  name: 'get_assumptions',
  description:
    'Every assumption per scenario: the committed value, the value you staged in this run if any, the key-wide bounds, your band, and ' +
    'allowed_this_run, the exact range apply_assumption_change will accept.',
  input: z.strictObject({}),
  run(ctx) {
    if (ctx.ledger.startSet === null) refuse('no_assumption_set', `${ctx.loaded.config.id} has no assumption set yet; calibration comes after the data`);
    return {
      assumption_set_version: ctx.ledger.startSet!.version,
      author: ctx.ledger.startSet!.author,
      rationale: ctx.ledger.startSet!.rationale,
      assumptions: describeAssumptions(ctx.loaded.config, ctx.ledger),
    };
  },
});

const getSignalHistory = defineTool({
  name: 'get_signal_history',
  description: 'Recent signals, newest first: status, grade, spot, expected targets, and what caused each change.',
  input: z.strictObject({ limit: z.number().int().min(1).max(50).optional() }),
  run(ctx, input) {
    return { signals: listSignals(ctx.db, ctx.loaded.config.id, input.limit ?? 8).map(describeSignal) };
  },
});

const getJournal = defineTool({
  name: 'get_journal',
  description: 'Earlier journal entries for this asset, newest first. Pass before_id to page back past the entries in your context pack.',
  input: z.strictObject({ limit: z.number().int().min(1).max(20).optional(), before_id: z.number().int().optional() }),
  run(ctx, input) {
    return { entries: listJournal(ctx.db, ctx.loaded.config.id, { limit: input.limit ?? 5, beforeId: input.before_id }) };
  },
});

/** The longest range get_flow_total sums: a year, so `days_missing` stays a list a reader can take in. */
const MAX_FLOW_TOTAL_DAYS = 366;

/**
 * The UTC days a row covers: from the start of the day its period begins in, up to its `observed_at`. A daily row
 * observed at the end of day D (D+1 00:00Z, period 1) covers D alone; a row not at midnight covers the day it ends in
 * as well. The same convention as the API-flow gap check (`coveredDays` in ingest/apiFlow.ts).
 */
function daysCovered(o: Observation): string[] {
  const endMs = new Date(o.observedAt).getTime();
  const days: string[] = [];
  for (let ms = dayStartMs(utcDay(endMs - (o.periodDays ?? 1) * MS_PER_DAY)); ms < endMs; ms += MS_PER_DAY) days.push(utcDay(ms));
  return days;
}

const getFlowTotal = defineTool({
  name: 'get_flow_total',
  description:
    'Orion\'s own sum of a flow metric over whole UTC days, from and to inclusive (YYYY-MM-DD, at most a year): total, unit, days_covered, ' +
    'days_missing (days no summed row covers), rows, and first_id/last_id. Sums every active row (staged ones included) whose days all fall ' +
    'in the range; a row that reaches outside it is left out and its days in range count as missing. Every summed row counts as shown, so ' +
    'you may cite any of them as evidence.',
  input: z.strictObject({ metric: z.string(), from: z.string(), to: z.string() }),
  run(ctx, input) {
    const asset = ctx.loaded.config;
    const def = asset.metrics[input.metric];
    if (!def) refuse('unknown_metric', `${input.metric} is not a metric of ${asset.id}`, { metrics: Object.keys(asset.metrics).sort() });
    if (def.type !== 'flow') refuse('not_a_flow', `${input.metric} is a ${def.type} metric; get_flow_total sums flow metrics only`);
    for (const d of [input.from, input.to]) if (!isIsoDate(d)) refuse('invalid_date', `${d} is not a date in the form YYYY-MM-DD`);
    if (input.from > input.to) refuse('invalid_range', `from ${input.from} is after to ${input.to}`);
    const span = (dayStartMs(input.to) - dayStartMs(input.from)) / MS_PER_DAY + 1;
    if (span > MAX_FLOW_TOTAL_DAYS) refuse('invalid_range', `${span} days is more than ${MAX_FLOW_TOTAL_DAYS}; ask for a shorter range`);

    const staged = ctx.ledger.observationRows(ctx.now().toISOString()).filter((o) => o.metricKey === input.metric);
    const covered = new Set<string>();
    const summed: Observation[] = [];
    for (const o of [...listActiveObservations(ctx.db, asset.id, input.metric), ...staged]) {
      const days = daysCovered(o);
      if (!days.every((d) => d >= input.from && d <= input.to)) continue;
      summed.push(o);
      for (const d of days) covered.add(d);
    }
    const missing: string[] = [];
    for (let ms = dayStartMs(input.from); ms <= dayStartMs(input.to); ms += MS_PER_DAY) if (!covered.has(utcDay(ms))) missing.push(utcDay(ms));
    const ids = summed.map((o) => o.id);
    ctx.ledger.markShown(ids);
    return {
      metric: input.metric, from: input.from, to: input.to, total: summed.reduce((sum, o) => sum + o.value, 0), unit: def.unit,
      days_covered: span - missing.length, days_missing: missing, rows: summed.length,
      first_id: ids.length > 0 ? Math.min(...ids) : null, last_id: ids.length > 0 ? Math.max(...ids) : null,
    };
  },
});

export const READ_TOOLS: AgentTool[] = [getDrivers, getObservations, getAnomalies, getAssumptions, getSignalHistory, getJournal, getFlowTotal];
