import { z } from 'zod';

const ScenarioSchema = z.strictObject({ target: z.number(), probability: z.number() });

const ModuleSchema = z.strictObject({
  type: z.string(),
  kind: z.enum(['estimate', 'component']),
  weight: z.number().nullable(),
  value: z.number(),
  breakdown: z.record(z.string(), z.unknown()),
});

const HorizonSchema = z.strictObject({
  expected_target: z.number(),
  upside_pct: z.number(),
  scenarios: z.strictObject({ bear: ScenarioSchema, base: ScenarioSchema, bull: ScenarioSchema }),
  modules: z.record(z.string(), ModuleSchema),
  dispersion: z.number(),
  staked_total_return_pct: z.number(),
  extras: z.record(z.string(), z.number()),
});

export const SignalSchema = z.strictObject({
  schema_version: z.literal(1),
  signal_id: z.string(),
  asset: z.string(),
  generated_at: z.string(),
  status: z.enum(['ok', 'degraded', 'blocked']),
  status_reasons: z.array(z.string()),
  spot: z.strictObject({ price: z.number(), ts: z.string() }).nullable(),
  horizons: z.strictObject({ '6m': HorizonSchema, '12m': HorizonSchema }).optional(),
  data_quality: z.strictObject({
    grade: z.enum(['A', 'B', 'C', 'D']),
    stale_metrics: z.array(z.string()),
    provisional_metrics: z.array(z.string()),
    open_anomalies: z.number().int().nonnegative(),
    /** Added in sub-project 2 (additive, schema_version stays 1). Signals stored before it have no such key. */
    anomalies: z
      .array(z.strictObject({ id: z.number().int(), kind: z.string(), metric: z.string(), severity: z.enum(['degrading', 'advisory']) }))
      .default([]),
  }),
  change: z.strictObject({
    prev_signal_id: z.string().nullable(),
    target_delta_pct: z.number().nullable(),
    cause: z.enum(['data', 'assumptions', 'both', 'none']),
    rationale: z.string(),
  }),
  provenance: z.strictObject({
    run_id: z.number().int(),
    snapshot_id: z.number().int(),
    assumption_set_version: z.number().int().nullable(),
    engine_version: z.string(),
    config_hash: z.string(),
  }),
});

export type Signal = z.infer<typeof SignalSchema>;
