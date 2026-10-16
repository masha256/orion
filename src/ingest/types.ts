import type { AssetConfig } from '../config/schema.js';
import type { SourceConfig, SourceOf } from '../config/sources.js';
import type { AnomalyKind, AnomalySeverity } from '../db/anomalies.js';
import { OrionError } from '../types.js';
import type { HttpTransport } from './transport/http.js';
import type { BlockRef, RpcTransport } from './transport/rpc.js';
import type { Observation } from '../db/observations.js';

/** `day` is the UTC day ('YYYY-MM-DD') the value covers. */
export interface DailyPoint {
  day: string;
  value: number;
}

/** `month` is 'YYYY-MM'. */
export interface MonthlyPoint {
  month: string;
  value: number;
}

/** One step of a schedule: `value` in force from `observedAt`. */
export interface ScheduleStepReading {
  value: number;
  observedAt: string;
}

/**
 * What a source returned, with the source's own timestamp. Series are for cross-checks only; they never become
 * observations. `schedule_steps` is a schedule metric's primary reading when the source knows future steps too (a
 * coded halving): the step in force first, then each later step, every one written as its own observation.
 */
export type SourceValue =
  | { kind: 'level'; value: number; observedAt: string; source: 'onchain' | 'api'; detail: string }
  | { kind: 'schedule_steps'; steps: ScheduleStepReading[]; source: 'onchain' | 'api'; detail: string }
  | { kind: 'daily_series'; points: DailyPoint[]; detail: string }
  | { kind: 'monthly_series'; points: MonthlyPoint[]; detail: string }
  | { kind: 'periodic_payments'; payments: PeriodicPayment[]; due: PeriodDue[]; payers: string[]; expectedPayers: string[]; detail: string };

/**
 * One lump payment for a known coverage period (HYPE's USDC reserve yield: 30 days, paid 8 days after the period ends).
 * Stored as one flow row covering [from, to]; the report spreads it evenly over those days.
 */
export interface PeriodicPayment {
  /** First and last UTC day the payment covers (inclusive). */
  from: string;
  to: string;
  value: number;
  /** When it was paid (ISO), and the day it was due. */
  paidAt: string;
  dueDay: string;
}

/** A completed coverage period with no payment yet, and the day it falls due. */
export interface PeriodDue {
  from: string;
  to: string;
  dueDay: string;
}

export type ReadingResult = { ok: true; value: SourceValue } | { ok: false; error: string };

export function failed(error: string): ReadingResult {
  return { ok: false, error };
}

export function level(value: number, observedAt: string, source: 'onchain' | 'api', detail: string): ReadingResult {
  return { ok: true, value: { kind: 'level', value, observedAt, source, detail } };
}

export interface SourceRequest {
  metricKey: string;
  role: 'primary' | 'cross_check';
  source: SourceConfig;
  /** For a cross-check: its own tolerance, or the metric's. Unused for a primary. */
  tolerancePct: number;
}

export interface SourceContext {
  asset: AssetConfig;
  /** Fetch time. API levels are stamped with it. */
  nowIso: string;
  http: HttpTransport;
  rpc: RpcTransport | null;
  /** The latest block at plan start. Every chain level in one run is read at this block and stamped with its time. */
  block: BlockRef | null;
  env: Record<string, string | undefined>;
  /** Address of a named contract from the asset's `contracts` map. */
  contract(name: string): string;
  /**
   * How far back an adapter that pages an API's history (LIT's trades) reads: the run's `--backfill-days`, or the asset's
   * backfill on the first fetch of an adapter flow (no cursor yet). Absent on a routine run, when it reads its own window.
   */
  backfillDays?: number;
  /** The asset's active stored observations of one metric (oldest first): for adapters that work from earlier readings (Solana's supply drop). */
  observations?: (metricKey: string) => Observation[];
}

/**
 * Serves one batch of requests for one source. Returns one result per request, in order.
 * Throws when the whole batch failed; returns { ok: false } in a slot when only that reading failed.
 */
export interface SourceHandler {
  id: string;
  fetch(requests: SourceRequest[], ctx: SourceContext): Promise<ReadingResult[]>;
}

export function narrow<T extends SourceConfig['type']>(s: SourceConfig, type: T): SourceOf<T> {
  if (s.type !== type) throw new Error(`expected a ${type} source, got ${s.type}`);
  return s as SourceOf<T>;
}

export function contractResolver(asset: AssetConfig): (name: string) => string {
  return (name) => {
    const address = asset.contracts[name];
    if (address === undefined) throw new OrionError('unknown_contract', `contract "${name}" is not defined in assets/${asset.id}.yaml`);
    return address;
  };
}

/** An observation a fetch wrote, or (on a dry run, observationId null) would have written. */
export interface WrittenObservation {
  metricKey: string;
  value: number;
  observedAt: string;
  periodDays: number | null;
  source: 'onchain' | 'api';
  observationId: number | null;
}

/** An anomaly a fetch raised, or (on a dry run, id null) would have raised. */
export interface RaisedAnomaly {
  id: number | null;
  /** 'acknowledged' when the condition was seen again under a standing acknowledgement: nothing reopened. */
  status: 'open' | 'acknowledged';
  kind: AnomalyKind;
  metricKey: string;
  dedupeKey: string;
  severity: AnomalySeverity;
  detail: Record<string, unknown>;
}
