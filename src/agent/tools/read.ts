import { z } from 'zod';
import { listAnomalies } from '../../db/anomalies.js';
import { listJournal } from '../../db/journal.js';
import { listActiveObservations, listObservations, type Observation } from '../../db/observations.js';
import { dayStartMs, isIsoDate, observationDays, utcDay } from '../../ingest/time.js';
import { MS_PER_DAY } from '../../types.js';
import { describeAnomaly, describeObservation } from '../describe.js';
import { defineTool, refuse, type AgentTool } from './types.js';

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

const getFlowTotal = defineTool({
  name: 'get_flow_total',
  description:
    'Orion\'s own confirmed measurement of a flow metric, summed over whole UTC days, from and to inclusive (YYYY-MM-DD, at most a year): ' +
    'total, unit, days_covered, days_missing (days no summed row covers), rows, and first_id/last_id. It sums only confirmed rows already ' +
    'in the database: provisional rows and the figures staged in this run are not in it. A row that reaches outside the range is left out ' +
    'and its days in range count as missing. If two summed rows cover the same day it gives no total and refuses flow_conflict with their ' +
    'ids and the days. Every summed row counts as shown, so you may cite any of them as evidence. The total is the gross ' +
    'series: a series listed in revenue_streams with a share counts only that share as the asset\'s revenue.',
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

    // Confirmed, active, committed rows only: a provisional or staged figure is a claim, not Orion's measurement.
    const coveredBy = new Map<string, number[]>();
    const summed: Observation[] = [];
    for (const o of listActiveObservations(ctx.db, asset.id, input.metric)) {
      if (o.status !== 'confirmed') continue;
      const days = observationDays(o.observedAt, o.periodDays);
      if (!days.every((d) => d >= input.from && d <= input.to)) continue;
      summed.push(o);
      for (const d of days) coveredBy.set(d, [...(coveredBy.get(d) ?? []), o.id]);
    }
    const overlaps = [...coveredBy].filter(([, ids]) => ids.length > 1).sort(([a], [b]) => a.localeCompare(b));
    if (overlaps.length > 0) {
      const ids = [...new Set(overlaps.flatMap(([, rowIds]) => rowIds))].sort((a, b) => a - b);
      const days = overlaps.map(([d]) => d);
      refuse('flow_conflict', `observations ${ids.join(', ')} cover the same day (${days.join(', ')}); no total is given until the overlap is resolved`, { ids, days });
    }
    const missing: string[] = [];
    for (let ms = dayStartMs(input.from); ms <= dayStartMs(input.to); ms += MS_PER_DAY) if (!coveredBy.has(utcDay(ms))) missing.push(utcDay(ms));
    const ids = summed.map((o) => o.id);
    ctx.ledger.markShown(ids);
    return {
      metric: input.metric, from: input.from, to: input.to, total: summed.reduce((sum, o) => sum + o.value, 0), unit: def.unit,
      days_covered: span - missing.length, days_missing: missing, rows: summed.length,
      first_id: ids.length > 0 ? Math.min(...ids) : null, last_id: ids.length > 0 ? Math.max(...ids) : null,
    };
  },
});

export const READ_TOOLS: AgentTool[] = [getObservations, getAnomalies, getJournal, getFlowTotal];
