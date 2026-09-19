import type { AssetConfig, CaptureRule, FlowKind, RecipientBase } from '../config/schema.js';
import type { Observation } from '../db/observations.js';
import { STD_METRICS, type Provenance } from '../types.js';
import {
  buildSchedule, isStale, latestLevel, obsProvenance, trailingFlowAnnualized, worstProvenance, type ScheduleStep,
} from './select.js';

export interface DriverValue {
  value: number;
  provenance: Provenance;
  derived: boolean;
  observedAt: string;
}
export interface HolderFlowDriver {
  id: string;
  kind: FlowKind;
  captureRule: CaptureRule;
  recipientBase: RecipientBase;
  annualizedUsd: DriverValue;
  captureRate: number;
}
export interface UnlockEvent {
  at: string;
  tokens: number;
}
export interface Drivers {
  asOf: string;
  price: DriverValue;
  revenueRunRate: DriverValue;
  usageIndex: DriverValue | null;
  effectiveSupply: DriverValue;
  circulatingSupply: DriverValue | null;
  stakedSupply: DriverValue;
  stakedRatio: DriverValue;
  lockedRatio: DriverValue | null;
  stakerEmissionShare: DriverValue;
  emissionSchedule: ScheduleStep[];
  emissionRateNow: DriverValue;
  realStakingYield: DriverValue;
  scheduledUnlocks: UnlockEvent[];
  marketCap: DriverValue | null;
  fdv: DriverValue;
  holderFlows: HolderFlowDriver[];
  captureRate: number;
  extra: Record<string, DriverValue>;
}
export interface DriverReport {
  drivers: Drivers | null;
  missing: string[];
  staleMetrics: string[];
  staleCritical: string[];
  provisionalMetrics: string[];
  manualMetrics: string[];
}

function derive(value: number, inputs: DriverValue[]): DriverValue {
  return {
    value,
    provenance: worstProvenance(inputs.map((i) => i.provenance)),
    derived: true,
    observedAt: inputs.map((i) => i.observedAt).sort()[0],
  };
}

function newestFetchedAt(list: Observation[]): string {
  return list.map((o) => o.fetchedAt).sort().at(-1)!;
}

export function computeDrivers(
  asset: AssetConfig,
  observations: Observation[],
  asOf: string,
  extraRequired: string[] = [],
): DriverReport {
  const byMetric = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.assetId !== asset.id) continue;
    const list = byMetric.get(o.metricKey) ?? [];
    list.push(o);
    byMetric.set(o.metricKey, list);
  }
  // Contract: driver output must not depend on the order observations are passed in.
  for (const list of byMetric.values()) {
    list.sort((a, b) => (a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1));
  }
  const of = (key: string) => byMetric.get(key) ?? [];

  const missing = new Set<string>();
  const stale = new Set<string>();
  const provisional = new Set<string>();
  const manual = new Set<string>();

  const note = (key: string, used: Observation[], freshnessIso: string) => {
    for (const o of used) {
      const p = obsProvenance(o);
      if (p === 'provisional') provisional.add(key);
      else if (p === 'manual') manual.add(key);
    }
    const def = asset.metrics[key];
    if (def && isStale(freshnessIso, asOf, def.staleness_days)) stale.add(key);
  };

  const level = (key: string, required: boolean): DriverValue | null => {
    const o = latestLevel(of(key), asOf);
    if (!o) {
      if (required) missing.add(key);
      return null;
    }
    note(key, [o], o.observedAt);
    return { value: o.value, provenance: obsProvenance(o), derived: false, observedAt: o.observedAt };
  };

  const price = level(STD_METRICS.price, true);
  const revenue = level(STD_METRICS.revenue, true);
  const usageIndex = level(STD_METRICS.usageIndex, false);
  const effective = level(STD_METRICS.effectiveSupply, true);
  const circulating = level(STD_METRICS.circulatingSupply, asset.supply_basis === 'circulating');
  const staked = level(STD_METRICS.stakedSupply, true);
  const locked = level(STD_METRICS.lockedSupply, false);
  const share = level(STD_METRICS.stakerEmissionShare, true);

  // Emission schedule: needs a step in force at asOf.
  const sched = buildSchedule(of(STD_METRICS.emissionRate), asOf);
  let emissionNow: DriverValue | null = null;
  const inForce = sched.used.find((o) => o.observedAt <= asOf);
  if (!inForce) {
    missing.add(STD_METRICS.emissionRate);
  } else {
    note(STD_METRICS.emissionRate, sched.used, newestFetchedAt(sched.used));
    emissionNow = { value: inForce.value, provenance: obsProvenance(inForce), derived: false, observedAt: inForce.observedAt };
  }

  // Scheduled unlocks: optional, future events only.
  const unlockObs = of(STD_METRICS.scheduledUnlock).filter((o) => o.observedAt > asOf);
  if (unlockObs.length > 0) note(STD_METRICS.scheduledUnlock, unlockObs, newestFetchedAt(unlockObs));
  const scheduledUnlocks = unlockObs
    .map((o) => ({ at: o.observedAt, tokens: o.value }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  // Holder flows.
  const flowMetricKeys = new Set(asset.holder_flows.map((f) => f.metric));
  const flows: { def: AssetConfig['holder_flows'][number]; annualized: DriverValue }[] = [];
  for (const f of asset.holder_flows) {
    const past = of(f.metric).filter((o) => o.observedAt <= asOf);
    if (past.length === 0) {
      missing.add(f.metric);
      continue;
    }
    const newest = past.map((o) => o.observedAt).sort().at(-1)!;
    const { annualized, used } = trailingFlowAnnualized(past, asOf, f.window_days);
    const basis = used.length > 0 ? used : past;
    const oldest = basis.map((o) => o.observedAt).sort()[0];
    note(f.metric, basis, newest);
    flows.push({
      def: f,
      annualized: {
        value: annualized,
        provenance: worstProvenance(basis.map(obsProvenance)),
        derived: true,
        observedAt: oldest,
      },
    });
  }

  // Extra: every non-standard level metric.
  const standard = new Set<string>(Object.values(STD_METRICS));
  const extra: Record<string, DriverValue> = {};
  for (const [key, def] of Object.entries(asset.metrics)) {
    if (def.type !== 'level' || standard.has(key) || flowMetricKeys.has(key)) continue;
    const v = level(key, extraRequired.includes(key));
    if (v) extra[key] = v;
  }
  for (const key of extraRequired) if (!extra[key]) missing.add(key);

  const report = (drivers: Drivers | null): DriverReport => ({
    drivers,
    missing: [...missing].sort(),
    staleMetrics: [...stale].sort(),
    staleCritical: [...stale].filter((k) => asset.metrics[k]?.critical).sort(),
    provisionalMetrics: [...provisional].sort(),
    manualMetrics: [...manual].sort(),
  });

  if (missing.size > 0 || !price || !revenue || !effective || !staked || !share || !emissionNow) return report(null);

  const holderFlows: HolderFlowDriver[] = flows.map(({ def, annualized }) => ({
    id: def.id,
    kind: def.kind,
    captureRule: def.capture_rule,
    recipientBase: def.recipient_base,
    annualizedUsd: annualized,
    captureRate: revenue.value > 0 ? annualized.value / revenue.value : 0,
  }));

  const stakerApr = staked.value > 0 ? (emissionNow.value * share.value) / staked.value : 0;
  const inflation = effective.value > 0 ? emissionNow.value / effective.value : 0;

  return report({
    asOf,
    price,
    revenueRunRate: revenue,
    usageIndex,
    effectiveSupply: effective,
    circulatingSupply: circulating,
    stakedSupply: staked,
    stakedRatio: derive(effective.value > 0 ? staked.value / effective.value : 0, [staked, effective]),
    lockedRatio: locked ? derive(effective.value > 0 ? locked.value / effective.value : 0, [locked, effective]) : null,
    stakerEmissionShare: share,
    emissionSchedule: sched.steps,
    emissionRateNow: emissionNow,
    realStakingYield: derive(stakerApr - inflation, [emissionNow, share, staked, effective]),
    scheduledUnlocks,
    marketCap: circulating ? derive(price.value * circulating.value, [price, circulating]) : null,
    fdv: derive(price.value * effective.value, [price, effective]),
    holderFlows,
    captureRate: holderFlows.reduce((s, f) => s + f.captureRate, 0),
    extra,
  });
}
