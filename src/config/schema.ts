import { z } from 'zod';
import { SCENARIOS, STD_METRICS } from '../types.js';
import { CrossCheckSchema, IngestSchema, SourceSchema, sourceIssues } from './sources.js';

const MetricDefSchema = z.strictObject({
  type: z.enum(['level', 'flow', 'schedule', 'event']),
  unit: z.string(),
  fetcher: z.string().default('manual'),
  cadence: z.enum(['daily', 'weekly', 'monthly', 'event']).default('daily'),
  staleness_days: z.number().positive(),
  tolerance_pct: z.number().nonnegative().default(1),
  allow_provisional: z.boolean().default(false),
  critical: z.boolean().default(false),
  /** Primary source. A metric without one stays manual. Optional with no default, so existing config hashes do not move. */
  source: SourceSchema.optional(),
  cross_checks: z.array(CrossCheckSchema).optional(),
  /**
   * Fetched and stored daily but kept out of the valuation: not a driver, so its staleness or a failed read never
   * touches the grade or the signal (e.g. each liquid locker's share of veCRV; a protocol's revenue flow, read only by
   * the report). An unlisted sender or a failing source on it raises no anomaly, so it never wakes the agent.
   * Optional with no default (hashes).
   */
  monitor_only: z.boolean().optional(),
});

/**
 * Report-only holder-yield and growth series (no driver, no grade, no signal): the holder flows in three buckets with a
 * haircut each, yields on price, period-over-period growth, and the protocol's own revenue. Optional with no default,
 * so an asset without it keeps its config hash.
 */
const ReportingSchema = z.strictObject({
  /** The trailing window for every series, and the length of each half of a growth comparison. */
  window_days: z.number().int().min(7).max(365),
  /**
   * Per holder flow id: the fraction lost turning the flow into a holder's cash. A cash payout's slippage, sized from
   * pool depth; a buy-and-hold's overhang. A burn has none (0).
   */
  haircuts: z.record(z.string(), z.number().min(0).max(0.5)),
  /** Flow metrics whose sum is the protocol's own revenue (the cut it keeps, not what it passes through). */
  revenue: z.array(z.string()).min(1).optional(),
  /** Flow metrics whose sum is the gross the protocol handles (e.g. the CRV a locker collects before its cut). */
  volume: z.array(z.string()).min(1).optional(),
  /** A level metric entered from disclosures (VVV's revenue run rate): its growth between disclosures. */
  revenue_disclosed: z.string().optional(),
  /**
   * Cash to holders that the valuation keeps outside holder_flows (CRV's vote incentives, a component): an annual run-rate
   * level metric, its haircut, and whose tokens receive it.
   */
  extra_cash: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9_]+$/),
        metric: z.string(),
        haircut: z.number().min(0).max(0.5),
        recipient_base: z.enum(['all', 'staked', 'locked']),
      }),
    )
    .optional(),
});

const HolderFlowSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  kind: z.enum(['burn', 'buy_and_hold', 'fee_share']),
  capture_rule: z.enum(['contractual', 'programmatic', 'discretionary']),
  recipient_base: z.enum(['all', 'staked', 'locked']),
  metric: z.string(),
  window_days: z.number().positive().default(90),
  /**
   * `recipients`: value the flow per token of its recipients (staked supply now) instead of per token of supply. For a
   * flow paid only to stakers whose unstaked share goes elsewhere (yCRV: to Yearn's treasury), so the cash per staked
   * token is the claim a holder who stakes buys. Optional with no default, so existing config hashes do not move.
   */
  valued_per: z.enum(['supply', 'recipients']).optional(),
});

const ModuleInstanceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  type: z.string(),
  kind: z.enum(['estimate', 'component']),
  weight: z.number().min(0).max(1).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

const RangeSchema = z.strictObject({ min: z.number(), max: z.number() });

/**
 * `min`/`max` are the key-wide bounds and bind every author. The optional per-scenario sub-ranges are agent bands:
 * they bind the agent only. Optional with no default, so existing config hashes do not move.
 */
const BoundSchema = z.strictObject({
  min: z.number(),
  max: z.number(),
  bear: RangeSchema.optional(),
  base: RangeSchema.optional(),
  bull: RangeSchema.optional(),
});

const BudgetOverrideSchema = z.strictObject({
  requests: z.number().int().positive().optional(),
  input_tokens: z.number().int().positive().optional(),
  output_tokens: z.number().int().positive().optional(),
  web_searches: z.number().int().nonnegative().optional(),
  web_fetches: z.number().int().nonnegative().optional(),
  proposals: z.number().int().nonnegative().optional(),
});

/** When `orion tick` runs the scheduled agent. All optional with no defaults, so existing config hashes do not move. */
const CadenceSchema = z.strictObject({
  weekly_days: z.number().int().positive().optional(),
  deep_days: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

/** The agent's own limits and schedule. No tool can reach this block and no proposal may touch it. */
const AgentConfigSchema = z.strictObject({
  max_step_fraction: z.number().gt(0).max(1).optional(),
  budgets: z
    .strictObject({ weekly: BudgetOverrideSchema.optional(), triage: BudgetOverrideSchema.optional(), deep: BudgetOverrideSchema.optional(), bootstrap: BudgetOverrideSchema.optional() })
    .optional(),
  cadence: CadenceSchema.optional(),
});

const CalendarEventSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date, YYYY-MM-DD').refine(
    (d) => {
      if (Number.isNaN(Date.parse(d))) return false;
      try {
        return new Date(d).toISOString().slice(0, 10) === d;
      } catch {
        return false;
      }
    },
    'must be a real date, YYYY-MM-DD',
  ),
  note: z.string().min(1),
});

/** All optional with no defaults, so existing config hashes do not move. The percent fields are checked in the refine below. */
const ReviewTriggersSchema = z.strictObject({
  driver_deviation_pct: z.number().optional(),
  provisional_move_pct: z.number().optional(),
  revenue_stale_move_pct: z.number().optional(),
  calendar: z.array(CalendarEventSchema).optional(),
});

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
    ingest: IngestSchema.optional(),
    metrics: z.record(z.string(), MetricDefSchema),
    holder_flows: z.array(HolderFlowSchema).min(1),
    modules: z.array(ModuleInstanceSchema).min(1),
    scenario_probabilities: ProbabilitiesSchema.default({ bear: 0.25, base: 0.5, bull: 0.25 }),
    assumptions: z.record(z.string(), BoundSchema),
    agent: AgentConfigSchema.optional(),
    total_return_variants: z
      .array(z.strictObject({ id: z.string(), yield_multiplier_metric: z.string() }))
      .default([]),
    review_triggers: ReviewTriggersSchema.default({}),
    peer_set: z.array(z.string()).default([]),
    reporting: ReportingSchema.optional(),
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
    // A monitor-only metric is invisible to the valuation, so nothing the valuation needs may be one.
    const standardKeys = new Set<string>(Object.values(STD_METRICS));
    const valuationRefs = new Set<string>([...a.holder_flows.map((f) => f.metric), ...a.total_return_variants.map((v) => v.yield_multiplier_metric)]);
    for (const [key, def] of Object.entries(a.metrics)) {
      if (def.monitor_only !== true) continue;
      if (def.type !== 'level' && def.type !== 'flow') issue(`metrics: "${key}" is monitor_only, which is for level and flow metrics`);
      if (def.critical) issue(`metrics: "${key}" is monitor_only and cannot be critical`);
      if (standardKeys.has(key) || valuationRefs.has(key)) issue(`metrics: "${key}" is used by the valuation and cannot be monitor_only`);
    }

    const flowIds = new Set<string>();
    for (const f of a.holder_flows) {
      if (flowIds.has(f.id)) issue(`holder_flows: duplicate id "${f.id}"`);
      flowIds.add(f.id);
      if (a.metrics[f.metric]?.type !== 'flow') issue(`holder_flows: "${f.id}" must reference a metric of type flow`);
      if (f.valued_per === 'recipients' && f.recipient_base !== 'staked') {
        issue(`holder_flows: "${f.id}" can be valued per recipients only with recipient_base staked`);
      }
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
      for (const s of SCENARIOS) {
        const band = b[s];
        if (!band) continue;
        if (band.min > band.max) issue(`assumptions: "${key}" ${s} band has min greater than max`);
        else if (band.min < b.min || band.max > b.max) issue(`assumptions: "${key}" ${s} band must lie inside [${b.min}, ${b.max}]`);
      }
    }
    for (const v of a.total_return_variants) {
      if (a.metrics[v.yield_multiplier_metric]?.type !== 'level') {
        issue(`total_return_variants: "${v.id}" must reference a level metric`);
      }
    }

    if (a.reporting) {
      const r = a.reporting;
      for (const f of a.holder_flows) if (r.haircuts[f.id] === undefined) issue(`reporting: haircuts has no entry for holder flow "${f.id}"`);
      for (const id of Object.keys(r.haircuts)) {
        const f = a.holder_flows.find((x) => x.id === id);
        if (!f) issue(`reporting: haircuts names "${id}", which is not a holder flow`);
        else if (f.kind === 'burn' && r.haircuts[id] !== 0) issue(`reporting: "${id}" is a burn, whose haircut is 0`);
      }
      for (const field of ['revenue', 'volume'] as const) {
        const list = r[field] ?? [];
        if (new Set(list).size !== list.length) issue(`reporting: ${field} lists a metric twice`);
        for (const m of list) if (a.metrics[m]?.type !== 'flow') issue(`reporting: ${field} "${m}" is not a flow metric`);
      }
      for (const x of r.extra_cash ?? []) {
        if (a.metrics[x.metric]?.type !== 'level') issue(`reporting: extra_cash "${x.id}" must reference a level metric`);
        if (a.holder_flows.some((f) => f.id === x.id)) issue(`reporting: extra_cash id "${x.id}" is also a holder flow id`);
      }
      if (r.revenue_disclosed !== undefined && a.metrics[r.revenue_disclosed]?.type !== 'level') {
        issue(`reporting: revenue_disclosed "${r.revenue_disclosed}" is not a level metric`);
      }
    }

    for (const message of sourceIssues(a, required)) issue(message);
    for (const key of ['driver_deviation_pct', 'provisional_move_pct', 'revenue_stale_move_pct'] as const) {
      const v = a.review_triggers[key];
      if (v !== undefined && !(Number.isFinite(v) && v > 0)) issue(`review_triggers: ${key} must be a positive number`);
    }
    const calendarDates = new Set<string>();
    for (const e of a.review_triggers.calendar ?? []) {
      if (calendarDates.has(e.date)) {
        issue(`review_triggers: calendar dates must be unique (${e.date})`);
      }
      calendarDates.add(e.date);
    }
  });

export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type MetricDef = AssetConfig['metrics'][string];
export type ReportingDef = NonNullable<AssetConfig['reporting']>;
export type HolderFlowDef = AssetConfig['holder_flows'][number];
export type ModuleInstanceDef = AssetConfig['modules'][number];
export type FlowKind = HolderFlowDef['kind'];
export type CaptureRule = HolderFlowDef['capture_rule'];
export type RecipientBase = HolderFlowDef['recipient_base'];
export type ModuleKind = ModuleInstanceDef['kind'];

/** Percent move in usage_index since the revenue disclosure that raises the stale-revenue alert. Default 30. */
export function revenueStaleMovePct(asset: AssetConfig): number {
  return asset.review_triggers.revenue_stale_move_pct ?? 30;
}
