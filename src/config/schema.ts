import { z } from 'zod';
import { STD_METRICS } from '../types.js';

const MetricDefSchema = z.strictObject({
  type: z.enum(['level', 'flow', 'schedule', 'event']),
  unit: z.string(),
  fetcher: z.string().default('manual'),
  cadence: z.enum(['daily', 'weekly', 'monthly', 'event']).default('daily'),
  staleness_days: z.number().positive(),
  tolerance_pct: z.number().nonnegative().default(1),
  allow_provisional: z.boolean().default(false),
  critical: z.boolean().default(false),
});

const HolderFlowSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  kind: z.enum(['burn', 'buy_and_hold', 'fee_share']),
  capture_rule: z.enum(['contractual', 'programmatic', 'discretionary']),
  recipient_base: z.enum(['all', 'staked', 'locked']),
  metric: z.string(),
  window_days: z.number().positive().default(90),
});

const ModuleInstanceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  type: z.string(),
  kind: z.enum(['estimate', 'component']),
  weight: z.number().min(0).max(1).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

const BoundSchema = z.strictObject({ min: z.number(), max: z.number() });

const ProbabilitiesSchema = z.strictObject({ bear: z.number(), base: z.number(), bull: z.number() });

export const AssetConfigSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/),
    symbol: z.string(),
    name: z.string(),
    chain: z.string().optional(),
    supply_basis: z.enum(['effective_total', 'circulating']).default('effective_total'),
    contracts: z.record(z.string(), z.string()).default({}),
    external_ids: z.record(z.string(), z.string()).default({}),
    metrics: z.record(z.string(), MetricDefSchema),
    holder_flows: z.array(HolderFlowSchema).min(1),
    modules: z.array(ModuleInstanceSchema).min(1),
    scenario_probabilities: ProbabilitiesSchema.default({ bear: 0.25, base: 0.5, bull: 0.25 }),
    assumptions: z.record(z.string(), BoundSchema),
    total_return_variants: z
      .array(z.strictObject({ id: z.string(), yield_multiplier_metric: z.string() }))
      .default([]),
    review_triggers: z.record(z.string(), z.unknown()).default({}),
    peer_set: z.array(z.string()).default([]),
  })
  .superRefine((a, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;

    const required: string[] = [
      STD_METRICS.price,
      STD_METRICS.revenue,
      STD_METRICS.effectiveSupply,
      STD_METRICS.stakedSupply,
      STD_METRICS.stakerEmissionShare,
      STD_METRICS.emissionRate,
    ];
    if (a.supply_basis === 'circulating') required.push(STD_METRICS.circulatingSupply);
    for (const key of required) if (!a.metrics[key]) issue(`metrics: required standard metric "${key}" is not defined`);

    const typed: [string, string][] = [
      [STD_METRICS.emissionRate, 'schedule'],
      [STD_METRICS.scheduledUnlock, 'event'],
    ];
    for (const [key, type] of typed) {
      if (a.metrics[key] && a.metrics[key].type !== type) issue(`metrics: "${key}" must have type ${type}`);
    }

    const flowIds = new Set<string>();
    for (const f of a.holder_flows) {
      if (flowIds.has(f.id)) issue(`holder_flows: duplicate id "${f.id}"`);
      flowIds.add(f.id);
      if (a.metrics[f.metric]?.type !== 'flow') issue(`holder_flows: "${f.id}" must reference a metric of type flow`);
    }

    const moduleIds = new Set<string>();
    let weightSum = 0;
    let estimates = 0;
    for (const m of a.modules) {
      if (moduleIds.has(m.id)) issue(`modules: duplicate id "${m.id}"`);
      moduleIds.add(m.id);
      if (m.kind === 'estimate') {
        estimates++;
        if (m.weight === undefined) issue(`modules: estimate "${m.id}" needs a weight`);
        weightSum += m.weight ?? 0;
      } else if (m.weight !== undefined) {
        issue(`modules: component "${m.id}" must not have a weight`);
      }
    }
    if (estimates === 0) issue('modules: at least one estimate module is required');
    if (estimates > 0 && !near(weightSum, 1)) issue(`modules: estimate weights must sum to 1 (got ${weightSum})`);

    const p = a.scenario_probabilities;
    if (!near(p.bear + p.base + p.bull, 1)) issue('scenario_probabilities must sum to 1');

    for (const [key, b] of Object.entries(a.assumptions)) {
      if (b.min > b.max) issue(`assumptions: "${key}" has min greater than max`);
    }
    for (const v of a.total_return_variants) {
      if (a.metrics[v.yield_multiplier_metric]?.type !== 'level') {
        issue(`total_return_variants: "${v.id}" must reference a level metric`);
      }
    }
  });

export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type MetricDef = AssetConfig['metrics'][string];
export type HolderFlowDef = AssetConfig['holder_flows'][number];
export type ModuleInstanceDef = AssetConfig['modules'][number];
export type FlowKind = HolderFlowDef['kind'];
export type CaptureRule = HolderFlowDef['capture_rule'];
export type RecipientBase = HolderFlowDef['recipient_base'];
export type ModuleKind = ModuleInstanceDef['kind'];
