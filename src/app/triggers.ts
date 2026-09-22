import { calendarEvents, driverDeviationPct } from '../config/agentPolicy.js';
import type { LoadedAsset } from '../config/load.js';
import { listOpenAnomalies } from '../db/anomalies.js';
import { getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { listActiveObservations } from '../db/observations.js';
import { deleteFiring, insertFiring, listFirings, type Firing, type TriggerKind } from '../db/triggerFirings.js';
import { computeDrivers } from '../drivers/compute.js';
import { requiredExtraMetrics } from '../engine/requirements.js';
import { MS_PER_DAY, STD_METRICS } from '../types.js';
import { revenueAnchor, revenueDeviation } from './deviation.js';
import { eligibleObservations } from './eligibility.js';

/** A calendar event fires from its date for this long, so a tick missed for a week does not fire an event months late. */
export const CALENDAR_WINDOW_DAYS = 7;

/** Kinds whose condition can clear and return: their rows go when the condition is false, so the next breach fires again. */
const REARMING: ReadonlySet<TriggerKind> = new Set<TriggerKind>(['staleness', 'driver_deviation']);

/** Research rows the agent wrote carry this prefix in `source_detail`; every other provisional row is the user's. */
const RESEARCH_PREFIX = 'research:';

export interface TriggerInstance {
  kind: TriggerKind;
  key: string;
  /** Orion's own numbers and ids. Never text written by a model or read from a page. */
  detail: Record<string, unknown>;
}

export interface TriggerEvaluation {
  /** Instances true now and not recorded before: new this tick. Under `record: false` their `id` is 0 and nothing was written. */
  fired: Firing[];
  /** Instances true now that fired on an earlier tick. */
  standing: Firing[];
  /** Re-arming instances no longer true; their rows were deleted (or would have been). */
  cleared: Firing[];
}

/** Every trigger condition that holds for the asset now, as instances keyed the way `trigger_firings` keys them. */
export function currentTriggerInstances(db: Db, loaded: LoadedAsset, now: Date): TriggerInstance[] {
  const asset = loaded.config;
  const nowIso = now.toISOString();
  const out: TriggerInstance[] = [];

  for (const a of listOpenAnomalies(db, asset.id)) {
    out.push({ kind: 'open_anomaly', key: String(a.id), detail: { kind: a.kind, metric: a.metricKey, severity: a.severity, first_seen_at: a.firstSeenAt } });
  }

  const eligible = eligibleObservations(db, asset, nowIso);
  const report = computeDrivers(asset, eligible, nowIso, requiredExtraMetrics(asset));
  for (const metric of report.staleCritical) {
    const newest = eligible.filter((o) => o.metricKey === metric).sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id - b.id)).at(-1);
    out.push({ kind: 'staleness', key: metric, detail: { staleness_days: asset.metrics[metric]?.staleness_days ?? null, newest_observed_at: newest?.observedAt ?? null } });
  }

  const revenue = report.drivers?.revenueRunRate;
  const set = getLatestAssumptionSet(db, asset.id);
  if (revenue && set && !report.staleCritical.includes(STD_METRICS.revenue)) {
    const anchor = revenueAnchor(db, asset);
    const deviation = anchor ? revenueDeviation(anchor, revenue.value, set.values.base, now) : null;
    const threshold = driverDeviationPct(asset);
    if (deviation && Math.abs(deviation.deviation_pct) > threshold) {
      out.push({ kind: 'driver_deviation', key: STD_METRICS.revenue, detail: { ...deviation, threshold_pct: threshold, anchor_from: anchor!.from } });
    }
  }

  for (const o of listActiveObservations(db, asset.id)) {
    if (o.status !== 'provisional' || o.sourceDetail?.startsWith(RESEARCH_PREFIX)) continue;
    out.push({ kind: 'provisional', key: String(o.id), detail: { metric: o.metricKey, observed_at: o.observedAt, value: o.value } });
  }

  for (const e of calendarEvents(asset)) {
    const at = Date.parse(e.date);
    if (now.getTime() >= at && now.getTime() < at + CALENDAR_WINDOW_DAYS * MS_PER_DAY) {
      out.push({ kind: 'calendar', key: e.date, detail: { note: e.note } });
    }
  }
  return out;
}

/**
 * Compares the conditions that hold now with the rows in `trigger_firings`. A condition with no row fires (one row is
 * inserted, `agent_run_id` null); one with a row is standing; a re-arming kind whose condition no longer holds is
 * cleared and its row deleted. With `record: false` the same answer is computed and nothing is written.
 */
export function evaluateTriggers(db: Db, loaded: LoadedAsset, now: Date, opts: { record: boolean }): TriggerEvaluation {
  const nowIso = now.toISOString();
  const evaluate = (): TriggerEvaluation => {
    const current = currentTriggerInstances(db, loaded, now);
    const recorded = listFirings(db, loaded.config.id);
    const key = (x: { kind: string; key: string }) => `${x.kind}\u0000${x.key}`;
    const recordedBy = new Map(recorded.map((f) => [key(f), f]));
    const currentKeys = new Set(current.map(key));

    const fired: Firing[] = [];
    const standing: Firing[] = [];
    for (const instance of current) {
      const existing = recordedBy.get(key(instance));
      if (existing) {
        standing.push(existing);
      } else if (opts.record) {
        fired.push(insertFiring(db, { assetId: loaded.config.id, kind: instance.kind, key: instance.key, firedAt: nowIso, detail: instance.detail }));
      } else {
        fired.push({ id: 0, assetId: loaded.config.id, kind: instance.kind, key: instance.key, firedAt: nowIso, agentRunId: null, detail: instance.detail });
      }
    }
    const cleared = recorded.filter((f) => REARMING.has(f.kind) && !currentKeys.has(key(f)));
    if (opts.record) for (const f of cleared) deleteFiring(db, f.id);
    return { fired, standing, cleared };
  };
  // IMMEDIATE: the comparison reads the rows before it writes them; see runValuation.
  return opts.record ? db.transaction(evaluate).immediate() : evaluate();
}
