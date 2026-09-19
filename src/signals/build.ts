import type { AssetConfig } from '../config/schema.js';
import type { DriverReport } from '../drivers/compute.js';
import type { EngineOutput, HorizonOutput } from '../engine/run.js';
import { gradeDataQuality } from './quality.js';
import { SignalSchema, type Signal } from './schema.js';

export interface BuildSignalInput {
  signalId: string;
  asset: AssetConfig;
  generatedAt: string;
  report: DriverReport;
  engine: EngineOutput | null;
  blockedReasons: string[];
  change: Signal['change'];
  provenance: Signal['provenance'];
  /** Price observation to report when drivers are null (blocked) but a price exists. */
  spotFallback?: { price: number; ts: string } | null;
}

type SignalHorizon = NonNullable<Signal['horizons']>['6m'];

function toHorizon(h: HorizonOutput): SignalHorizon {
  const modules: SignalHorizon['modules'] = {};
  for (const [id, m] of Object.entries(h.modules)) {
    modules[id] = {
      type: m.type,
      kind: m.kind,
      weight: m.weight,
      value: m.value,
      // `value` is probability weighted across scenarios; the breakdown itself is the base scenario's.
      breakdown: { ...m.breakdown, by_scenario: m.byScenario, breakdown_scenario: 'base' },
    };
  }
  const scenario = (s: 'bear' | 'base' | 'bull') => ({ target: h.scenarios[s].target, probability: h.scenarios[s].probability });
  return {
    expected_target: h.expectedTarget,
    upside_pct: h.upsidePct,
    scenarios: { bear: scenario('bear'), base: scenario('base'), bull: scenario('bull') },
    modules,
    dispersion: h.dispersion,
    staked_total_return_pct: h.stakedTotalReturnPct,
    extras: h.extras,
  };
}

export function buildSignal(input: BuildSignalInput): Signal {
  const { report, engine } = input;
  const grade = gradeDataQuality(report);

  let status: Signal['status'];
  let reasons: string[];
  if (!engine) {
    status = 'blocked';
    reasons = input.blockedReasons;
  } else {
    reasons = report.staleCritical.map((m) => `stale_critical:${m}`);
    if (!engine.converged) reasons.push('supply_forecast_not_converged');
    status = reasons.length > 0 ? 'degraded' : 'ok';
  }

  const spot = report.drivers
    ? { price: report.drivers.price.value, ts: report.drivers.price.observedAt }
    : (input.spotFallback ?? null);

  return SignalSchema.parse({
    schema_version: 1,
    signal_id: input.signalId,
    asset: input.asset.id,
    generated_at: input.generatedAt,
    status,
    status_reasons: reasons,
    spot,
    ...(engine ? { horizons: { '6m': toHorizon(engine.horizons['6m']), '12m': toHorizon(engine.horizons['12m']) } } : {}),
    data_quality: {
      grade,
      stale_metrics: report.staleMetrics,
      provisional_metrics: report.provisionalMetrics,
      open_anomalies: 0,
    },
    change: input.change,
    provenance: input.provenance,
  });
}
