import type { AssetConfig } from '../config/schema.js';
import type { SourceConfig, SourceOf } from '../config/sources.js';
import type { AnomalyKind, AnomalySeverity } from '../db/anomalies.js';
import { OrionError } from '../types.js';
import type { HttpTransport } from './transport/http.js';
import type { BlockRef, RpcTransport } from './transport/rpc.js';

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

/** What a source returned, with the source's own timestamp. Series are for cross-checks only; they never become observations. */
export type SourceValue =
  | { kind: 'level'; value: number; observedAt: string; source: 'onchain' | 'api'; detail: string }
  | { kind: 'daily_series'; points: DailyPoint[]; detail: string }
  | { kind: 'monthly_series'; points: MonthlyPoint[]; detail: string };

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
  kind: AnomalyKind;
  metricKey: string;
  dedupeKey: string;
  severity: AnomalySeverity;
  detail: Record<string, unknown>;
}
