import { z } from 'zod';
import { STD_METRICS, WATCH_RULES } from '../types.js';
import { holderFlowMetrics, IncomeStatementBaseSchema, incomeStatementIssues } from './incomeStatement.js';
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
   * Display data, fetched and stored daily (e.g. each liquid locker's share of veCRV; a protocol's revenue flow, read only
   * by the report). An unlisted sender or a failing source on it raises no anomaly, so it never wakes the agent, and a
   * source that feeds only such metrics is exempt from the failure streak. Optional with no default (hashes).
   */
  monitor_only: z.boolean().optional(),
  /**
   * On a monitor-only metric, one rule that reports a move at fetch time without an anomaly (no trigger, no grade, no
   * streak): `above` (flows) a day written above it; `change_pct` (levels, > 0) a reading that far from the previous one;
   * `outside` (levels, [lo, hi] with lo <= hi) a reading out of the band. Exactly one rule. Optional with no default (hashes).
   */
  watch: z
    .strictObject({
      above: z.number().optional(),
      change_pct: z.number().positive().optional(),
      outside: z.tuple([z.number(), z.number()]).optional(),
    })
    .optional(),
});

/** The trailing window for every series, and the length of each half of a growth comparison. */
const WindowDaysSchema = z.number().int().min(7).max(365);
/** Flow metrics whose sum is the gross the protocol handles (e.g. the CRV a locker collects before its cut). */
const VolumeSchema = z.array(z.string()).min(1);
/**
 * Supply released to the market outside the emission schedule (UNI's Labs vest from the Timelock): a level in tokens per
 * year, optionally capped by a level in tokens (what governance has approved so far). Added to the report's dilution
 * only, never to the valuation: under effective_total supply those tokens are already counted.
 */
const DilutionSchema = z
  .array(z.strictObject({ id: z.string().regex(/^[a-z0-9_]+$/), metric: z.string(), cap_metric: z.string().optional(), note: z.string().optional() }))
  .min(1);
/**
 * Flow metrics in tokens whose sum is the supply the holder flows remove (UNI's burn in UNI). With it the report sets the
 * tokens removed against the tokens added (emissions + dilution) in one unit, so a price move between the days burned
 * and today cannot flip the sign of the net. Optional with no default (hashes).
 */
const BurnedTokensSchema = z.array(z.string()).min(1);

/**
 * Income statement v2 (src/config/incomeStatement.ts): the report's only block since Task 11 retired `holder_flows` and
 * `reporting` (spec D9). Optional, no default (hashes): an asset without it has no report.
 */
const IncomeStatementSchema = IncomeStatementBaseSchema.extend({
  window_days: WindowDaysSchema,
  volume: VolumeSchema.optional(),
  dilution: DilutionSchema.optional(),
  burned_tokens: BurnedTokensSchema.optional(),
});

const BudgetOverrideSchema = z.strictObject({
  requests: z.number().int().positive().optional(),
  input_tokens: z.number().int().positive().optional(),
  output_tokens: z.number().int().positive().optional(),
  web_searches: z.number().int().nonnegative().optional(),
  web_fetches: z.number().int().nonnegative().optional(),
  proposals: z.number().int().nonnegative().optional(),
});

/** The agent's own limits. No tool can reach this block and no proposal may touch it. */
const AgentConfigSchema = z.strictObject({
  budgets: z.strictObject({ disclosure: BudgetOverrideSchema.optional() }).optional(),
});

export const AssetConfigSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/),
    symbol: z.string(),
    name: z.string(),
    chain: z.string().optional(),
    contracts: z.record(z.string(), z.string()).default({}),
    external_ids: z.record(z.string(), z.string()).default({}),
    ingest: IngestSchema.optional(),
    metrics: z.record(z.string(), MetricDefSchema),
    agent: AgentConfigSchema.optional(),
    income_statement: IncomeStatementSchema.optional(),
  })
  .superRefine((a, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });

    // The standard metrics the holder-yield report cannot be built without.
    const required: string[] = [STD_METRICS.price, STD_METRICS.totalSupply, STD_METRICS.stakedSupply, STD_METRICS.emissionRate];
    for (const key of required) if (!a.metrics[key]) issue(`metrics: required standard metric "${key}" is not defined`);

    const typed: [string, string][] = [
      [STD_METRICS.emissionRate, 'schedule'],
      [STD_METRICS.scheduledUnlock, 'event'],
    ];
    for (const [key, type] of typed) {
      if (a.metrics[key] && a.metrics[key].type !== type) issue(`metrics: "${key}" must have type ${type}`);
    }
    // A monitor-only metric is display data, exempt from anomalies and the failure streak, so no standard metric and no
    // holder flow's metric (income_statement's holder-flow lines) may be one.
    const standardKeys = new Set<string>(Object.values(STD_METRICS));
    const holderFlows = new Set<string>(holderFlowMetrics(a.income_statement));
    for (const [key, def] of Object.entries(a.metrics)) {
      if (def.watch !== undefined) {
        const w = def.watch;
        if (def.monitor_only !== true) issue(`metrics: "${key}" has a watch, which is for monitor_only metrics`);
        // Counted by rule, not by key: a parser that kept an absent rule as an undefined key must not make it two.
        if (WATCH_RULES.filter((r) => w[r] !== undefined).length !== 1) issue(`metrics: "${key}" watch takes exactly one rule (above, change_pct or outside)`);
        if (w.above !== undefined && def.type !== 'flow') issue(`metrics: "${key}" watch above is for flow metrics`);
        if (w.change_pct !== undefined && def.type !== 'level') issue(`metrics: "${key}" watch change_pct is for level metrics`);
        if (w.outside !== undefined && def.type !== 'level') issue(`metrics: "${key}" watch outside is for level metrics`);
        if (w.outside !== undefined && w.outside[0] > w.outside[1]) issue(`metrics: "${key}" watch outside [lo, hi] needs lo <= hi`);
      }
      if (def.monitor_only !== true) continue;
      if (def.type !== 'level' && def.type !== 'flow') issue(`metrics: "${key}" is monitor_only, which is for level and flow metrics`);
      if (def.critical) issue(`metrics: "${key}" is monitor_only and cannot be critical`);
      if (standardKeys.has(key) || holderFlows.has(key)) issue(`metrics: "${key}" is a standard or holder-flow metric and cannot be monitor_only`);
    }

    if (a.income_statement) {
      for (const message of sharedReportingIssues(a.metrics, a.income_statement, 'income_statement')) issue(message);
      for (const message of incomeStatementIssues(a)) issue(message);
    }

    for (const message of sourceIssues(a, required)) issue(message);
  });

/** The checks on income_statement's volume, burned_tokens and dilution, prefixed by block. */
function sharedReportingIssues(
  metrics: Record<string, { type: string; unit: string }>,
  block: { volume?: string[]; burned_tokens?: string[]; dilution?: { id: string; metric: string; cap_metric?: string }[] },
  where: string,
): string[] {
  const out: string[] = [];
  const list = block.volume ?? [];
  if (new Set(list).size !== list.length) out.push(`${where}: volume lists a metric twice`);
  for (const m of list) if (metrics[m]?.type !== 'flow') out.push(`${where}: volume "${m}" is not a flow metric`);
  for (const m of block.burned_tokens ?? []) {
    if (metrics[m]?.type !== 'flow' || metrics[m]?.unit !== 'tokens') out.push(`${where}: burned_tokens "${m}" is not a flow metric in tokens`);
  }
  for (const d of block.dilution ?? []) {
    for (const m of [d.metric, ...(d.cap_metric ? [d.cap_metric] : [])]) {
      if (metrics[m]?.type !== 'level') out.push(`${where}: dilution "${d.id}" metric "${m}" is not a level metric`);
    }
  }
  return out;
}

export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type MetricDef = AssetConfig['metrics'][string];
export type IncomeStatementDef = NonNullable<AssetConfig['income_statement']>;
export type {
  CostTo, IsBelowLine, IsBucket, IsCategory, IsCheck, IsCostLine, IsHolderLine, IsRevenueLine, IsUseLine,
} from './incomeStatement.js';
export type RecipientBase = NonNullable<IncomeStatementDef['holders']>[number]['recipient_base'];
export type CaptureRule = NonNullable<IncomeStatementDef['holders']>[number]['capture_rule'];

