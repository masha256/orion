import { agentBand, keyBounds } from '../config/agentPolicy.js';
import type { AssetConfig } from '../config/schema.js';
import type { Anomaly } from '../db/anomalies.js';
import type { Observation } from '../db/observations.js';
import type { Proposal } from '../db/proposals.js';
import type { DriverReport, DriverValue } from '../drivers/compute.js';
import type { EngineOutput } from '../engine/run.js';
import type { Signal } from '../signals/schema.js';
import { requiredAssumptionKeys } from '../engine/requirements.js';
import { HORIZONS, MS_PER_DAY, SCENARIOS } from '../types.js';
import { allowedRange } from './guardrails.js';
import type { Ledger } from './ledger.js';

/**
 * Compact JSON views of Orion's state for the model: the context pack and the read tools share them, so the agent sees
 * one shape for one thing. Keys are snake_case, like the signal.
 */

const driver = (v: DriverValue | null, nowIso: string) =>
  v === null
    ? null
    : {
        value: v.value, provenance: v.provenance, derived: v.derived, observed_at: v.observedAt,
        age_days: Math.round(((Date.parse(nowIso) - Date.parse(v.observedAt)) / MS_PER_DAY) * 10) / 10,
      };

export function describeDrivers(report: DriverReport, nowIso: string): Record<string, unknown> {
  const d = report.drivers;
  return {
    drivers: d && {
      as_of: d.asOf,
      price: driver(d.price, nowIso),
      revenue_run_rate: driver(d.revenueRunRate, nowIso),
      usage_index: driver(d.usageIndex, nowIso),
      effective_supply: driver(d.effectiveSupply, nowIso),
      circulating_supply: driver(d.circulatingSupply, nowIso),
      staked_ratio: driver(d.stakedRatio, nowIso),
      locked_ratio: driver(d.lockedRatio, nowIso),
      staker_emission_share: driver(d.stakerEmissionShare, nowIso),
      emission_rate_now: driver(d.emissionRateNow, nowIso),
      emission_schedule: d.emissionSchedule,
      scheduled_unlocks: d.scheduledUnlocks,
      real_staking_yield: driver(d.realStakingYield, nowIso),
      market_cap: driver(d.marketCap, nowIso),
      fdv: driver(d.fdv, nowIso),
      capture_rate: d.captureRate,
      holder_flows: d.holderFlows.map((f) => ({
        id: f.id, kind: f.kind, capture_rule: f.captureRule, annualized_usd: driver(f.annualizedUsd, nowIso), capture_rate: f.captureRate,
      })),
      extra: Object.fromEntries(Object.entries(d.extra).map(([k, v]) => [k, driver(v, nowIso)])),
    },
    missing: report.missing,
    stale_metrics: report.staleMetrics,
    stale_critical: report.staleCritical,
    provisional_metrics: report.provisionalMetrics,
    overlapping_flow_metrics: report.overlappingFlowMetrics,
  };
}

export function describeObservation(o: Observation): Record<string, unknown> {
  return {
    id: o.id, metric: o.metricKey, value: o.value, observed_at: o.observedAt, period_days: o.periodDays, source: o.source,
    status: o.status, active: o.supersededBy === null && o.status !== 'rejected', citation_url: o.citationUrl, quoted_text: o.quotedText,
    source_detail: o.sourceDetail,
  };
}

export function describeAnomaly(a: Anomaly, stagedResolved = false): Record<string, unknown> {
  return {
    id: a.id, kind: a.kind, metric: a.metricKey, severity: a.severity, status: a.status, occurrences: a.occurrences,
    first_seen_at: a.firstSeenAt, last_seen_at: a.lastSeenAt, detail: a.detail, note: a.note, decided_by: a.decidedBy,
    ...(a.status === 'acknowledged' ? { read_only: true } : {}),
    ...(stagedResolved ? { resolution_staged_in_this_run: true } : {}),
  };
}

export function describeSignal(s: Signal): Record<string, unknown> {
  return {
    signal_id: s.signal_id, generated_at: s.generated_at, status: s.status, status_reasons: s.status_reasons, grade: s.data_quality.grade,
    spot: s.spot?.price ?? null,
    expected_target_6m: s.horizons?.['6m'].expected_target ?? null,
    expected_target_12m: s.horizons?.['12m'].expected_target ?? null,
    cause: s.change.cause, causes: s.change.causes ?? null, author: s.change.author ?? null, rationale: s.change.rationale,
    assumption_set_version: s.provenance.assumption_set_version,
  };
}

export function describeEngine(output: EngineOutput): Record<string, unknown> {
  return Object.fromEntries(
    HORIZONS.map((h) => {
      const o = output.horizons[h];
      return [
        h,
        {
          expected_target: o.expectedTarget, upside_pct: o.upsidePct, dispersion: o.dispersion,
          scenarios: Object.fromEntries(SCENARIOS.map((s) => [s, o.scenarios[s].target])),
          modules: Object.fromEntries(Object.entries(o.modules).map(([id, m]) => [id, { value: m.value, weight: m.weight, by_scenario: m.byScenario }])),
        },
      ];
    }),
  );
}

export function describeProposal(p: Proposal): Record<string, unknown> {
  return {
    id: p.id, kind: p.change.kind, change: p.change, rationale: p.rationale, effect: p.effect, status: p.status, created_at: p.createdAt,
    decided_at: p.decidedAt, decision_note: p.decisionNote,
  };
}

/**
 * Every assumption the asset requires, per scenario: the committed value, the staged value when this run changed it,
 * the key-wide bounds, the agent band, and the exact range the agent may apply this run. Precomputed so the agent never
 * has to work the step rule out for itself. `allowed_this_run` is null when only a proposal can move the value.
 */
export function describeAssumptions(asset: AssetConfig, ledger: Ledger): Record<string, unknown>[] {
  const staged = ledger.mergedValues();
  return requiredAssumptionKeys(asset).map((key) => ({
    key,
    bounds: keyBounds(asset, key),
    scenarios: Object.fromEntries(
      SCENARIOS.map((s) => {
        const committed = ledger.startValue(key, s);
        return [
          s,
          {
            committed: committed ?? null,
            ...(staged[s][key] !== committed ? { staged: staged[s][key] } : {}),
            band: agentBand(asset, key, s),
            allowed_this_run: committed === undefined ? null : allowedRange(asset, key, s, committed),
          },
        ];
      }),
    ),
  }));
}
