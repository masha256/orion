import { z } from 'zod';
import { STD_METRICS, WATCH_RULES } from '../types.js';
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
  /**
   * The income statement (Mike, 2026-10-11): revenue is everything the protocol takes in from the market; each line says
   * where its part goes: to holders (payout), kept by the protocol (protocol income), or a cost (keepers, third parties).
   */
  income: z
    .strictObject({
      lines: z
        .array(
          z
            .strictObject({
              id: z.string().regex(/^[a-z0-9_]+$/),
              to: z.enum(['holders', 'protocol', 'cost']),
              /** A measured daily flow metric... */
              metric: z.string().optional(),
              /** ...or a fixed contractual ratio of another line's metric (Convex's 0.5 percent caller fee is 5 percent of the 10). */
              estimate: z.strictObject({ of: z.string(), ratio: z.number().positive().max(10) }).optional(),
              note: z.string().optional(),
            })
            .refine((l) => (l.metric === undefined) !== (l.estimate === undefined), { message: 'an income line has a metric or an estimate, not both' }),
        )
        .min(1),
      /**
       * Revenue measured as a total (VVV and HYPE: DefiLlama's dailyRevenue proxy): protocol income is the total less the
       * holder and cost lines, and no protocol line may be listed.
       */
      remainder_of: z.array(z.string()).min(1).optional(),
      /** Reconciliations: a measured total that the listed lines should add up to (the gap is reported, never booked). */
      checks: z.array(z.strictObject({ total: z.array(z.string()).min(1), parts: z.array(z.string()).min(1) })).optional(),
      /** Holder payouts not funded from revenue (a treasury reserve, e.g. cvxCRV's CVX): shown apart from the payout ratio. */
      outside_revenue: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9_]+$/), metric: z.string(), note: z.string().optional() })).optional(),
    })
    .optional(),
  /** Flow metrics whose sum is the gross the protocol handles (e.g. the CRV a locker collects before its cut). */
  volume: z.array(z.string()).min(1).optional(),
  /**
   * Supply released to the market outside the emission schedule (UNI's Labs vest from the Timelock): a level in tokens per
   * year, optionally capped by a level in tokens (what governance has approved so far). Added to the report's dilution
   * only, never to the valuation: under effective_total supply those tokens are already counted.
   */
  dilution: z
    .array(z.strictObject({ id: z.string().regex(/^[a-z0-9_]+$/), metric: z.string(), cap_metric: z.string().optional(), note: z.string().optional() }))
    .min(1)
    .optional(),
  /**
   * Flow metrics in tokens whose sum is the supply the holder flows remove (UNI's burn in UNI). With it the report sets the
   * tokens removed against the tokens added (emissions + dilution) in one unit, so a price move between the days burned
   * and today cannot flip the sign of the net. Optional with no default (hashes).
   */
  burned_tokens: z.array(z.string()).min(1).optional(),
  /** A level metric entered from disclosures (VVV's revenue run rate): its growth between disclosures. */
  revenue_disclosed: z.string().optional(),
  /**
   * Revenue as a list of streams (Mike, 2026-10-12): revenue = the sum of the streams, and a new revenue type is config
   * only. Without the list, revenue is the income statement's total as before (the sum of its lines, or remainder_of).
   * Each stream has one source:
   * - `metric` (a flow) with `settlement`: `daily`, a daily series; or `periodic`, lump payments stored one row per
   *   coverage period, spread evenly over the days covered. The unpaid days since the last covered period run at that
   *   period's daily rate, provisional, and are replaced when the payment lands.
   * - `disclosed` (a level, the asset's revenue_disclosed): the company's own figure. When an asset has disclosures, they
   *   are its revenue, and `cross_check` names the daily series kept beside them (VVV: DefiLlama's dailyRevenue).
   * `started` dates a stream; one younger than the two growth windows is left out of the second revenue growth figure.
   * `holder_flow` also counts the stream in the report's holder flow, in that bucket (never in the valuation).
   */
  revenue: z
    .array(
      z
        .strictObject({
          id: z.string().regex(/^[a-z0-9_]+$/),
          label: z.string().optional(),
          metric: z.string().optional(),
          settlement: z.enum(['daily', 'periodic']).optional(),
          disclosed: z.string().optional(),
          cross_check: z.string().optional(),
          started: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          holder_flow: z.enum(['burn', 'hold', 'cash']).optional(),
          /** The fraction of a metric stream the protocol keeps (0 < share <= 1); absent, the stream counts in full. */
          share: z.number().positive().max(1).optional(),
        })
        .refine((s) => (s.metric === undefined) !== (s.disclosed === undefined), { message: 'a revenue stream has a metric or a disclosed level, not both' }),
    )
    .min(1)
    .optional(),
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
    holder_flows: z.array(HolderFlowSchema).min(1),
    agent: AgentConfigSchema.optional(),
    reporting: ReportingSchema.optional(),
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
    // holder flow's metric may be one.
    const standardKeys = new Set<string>(Object.values(STD_METRICS));
    const holderFlowMetrics = new Set<string>(a.holder_flows.map((f) => f.metric));
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
      if (standardKeys.has(key) || holderFlowMetrics.has(key)) issue(`metrics: "${key}" is a standard or holder-flow metric and cannot be monitor_only`);
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

    if (a.reporting) {
      const r = a.reporting;
      for (const f of a.holder_flows) if (r.haircuts[f.id] === undefined) issue(`reporting: haircuts has no entry for holder flow "${f.id}"`);
      const reportFlows = (r.revenue ?? []).filter((s) => s.holder_flow !== undefined);
      for (const id of Object.keys(r.haircuts)) {
        const f = a.holder_flows.find((x) => x.id === id);
        const s = reportFlows.find((x) => x.id === id);
        if (!f && !s) issue(`reporting: haircuts names "${id}", which is not a holder flow`);
        else if ((f?.kind ?? s?.holder_flow) === 'burn' && r.haircuts[id] !== 0) issue(`reporting: "${id}" is a burn, whose haircut is 0`);
      }
      const inc = r.income;
      if (inc) {
        const ids = new Set<string>();
        const flow = (m: string, where: string) => {
          if (a.metrics[m]?.type !== 'flow') issue(`reporting.income: ${where} "${m}" is not a flow metric`);
        };
        for (const l of inc.lines) {
          if (ids.has(l.id)) issue(`reporting.income: line id "${l.id}" is used twice`);
          ids.add(l.id);
          if (l.metric) flow(l.metric, `line ${l.id}`);
          if (l.estimate) flow(l.estimate.of, `line ${l.id} estimate`);
        }
        if (inc.remainder_of) {
          for (const m of inc.remainder_of) flow(m, 'remainder_of');
          if (inc.lines.some((l) => l.to === 'protocol')) issue('reporting.income: with remainder_of, protocol income is the remainder; list no protocol line');
        }
        for (const c of inc.checks ?? []) {
          for (const m of c.total) flow(m, 'check total');
          for (const p of c.parts) if (!ids.has(p)) issue(`reporting.income: check part "${p}" is not a line id`);
        }
        for (const o of inc.outside_revenue ?? []) flow(o.metric, `outside_revenue ${o.id}`);
      }
      for (const field of ['volume'] as const) {
        const list = r[field] ?? [];
        if (new Set(list).size !== list.length) issue(`reporting: ${field} lists a metric twice`);
        for (const m of list) if (a.metrics[m]?.type !== 'flow') issue(`reporting: ${field} "${m}" is not a flow metric`);
      }
      for (const x of r.extra_cash ?? []) {
        if (a.metrics[x.metric]?.type !== 'level') issue(`reporting: extra_cash "${x.id}" must reference a level metric`);
        if (a.holder_flows.some((f) => f.id === x.id)) issue(`reporting: extra_cash id "${x.id}" is also a holder flow id`);
      }
      for (const m of r.burned_tokens ?? []) {
        if (a.metrics[m]?.type !== 'flow' || a.metrics[m]?.unit !== 'tokens') issue(`reporting: burned_tokens "${m}" is not a flow metric in tokens`);
      }
      for (const d of r.dilution ?? []) {
        for (const m of [d.metric, ...(d.cap_metric ? [d.cap_metric] : [])]) {
          if (a.metrics[m]?.type !== 'level') issue(`reporting: dilution "${d.id}" metric "${m}" is not a level metric`);
        }
      }
      if (r.revenue_disclosed !== undefined && a.metrics[r.revenue_disclosed]?.type !== 'level') {
        issue(`reporting: revenue_disclosed "${r.revenue_disclosed}" is not a level metric`);
      }
      if (r.revenue) {
        const ids = new Set<string>();
        for (const s of r.revenue) {
          if (ids.has(s.id)) issue(`reporting.revenue: stream id "${s.id}" is used twice`);
          ids.add(s.id);
          if (s.metric !== undefined && a.metrics[s.metric]?.type !== 'flow') issue(`reporting.revenue: stream "${s.id}" metric "${s.metric}" is not a flow metric`);
          if (s.disclosed !== undefined) {
            if (s.disclosed !== r.revenue_disclosed) issue(`reporting.revenue: stream "${s.id}" disclosed "${s.disclosed}" must be the asset's revenue_disclosed`);
            if (s.settlement !== undefined || s.holder_flow !== undefined) issue(`reporting.revenue: disclosed stream "${s.id}" takes no settlement or holder_flow`);
            if (s.share !== undefined) issue(`reporting.revenue: disclosed stream "${s.id}" takes no share`);
          }
          // A share keeps part of a gross series; a holder flow or an income line on the same series would stay gross.
          if (s.share !== undefined && s.holder_flow !== undefined) issue(`reporting.revenue: stream "${s.id}" takes no share with a holder_flow`);
          if (s.share !== undefined && s.metric !== undefined && (r.income?.lines ?? []).some((l) => l.metric === s.metric)) {
            issue(`reporting.revenue: stream "${s.id}" takes no share: its metric "${s.metric}" is also an income line's metric`);
          }
          if (s.cross_check !== undefined) {
            if (s.disclosed === undefined) issue(`reporting.revenue: only a disclosed stream takes a cross_check ("${s.id}")`);
            if (a.metrics[s.cross_check]?.type !== 'flow') issue(`reporting.revenue: stream "${s.id}" cross_check "${s.cross_check}" is not a flow metric`);
          }
          if (s.holder_flow !== undefined && (a.holder_flows.some((f) => f.id === s.id) || (r.extra_cash ?? []).some((x) => x.id === s.id))) {
            issue(`reporting.revenue: stream id "${s.id}" is also a holder flow id`);
          }
          if (s.settlement === 'periodic' && s.started === undefined) issue(`reporting.revenue: periodic stream "${s.id}" needs started (its first covered day)`);
        }
        if (r.revenue.filter((s) => s.disclosed !== undefined).length > 1) issue('reporting.revenue: at most one disclosed stream');
        if (r.revenue.some((s) => s.disclosed !== undefined) && r.revenue.length > 1) issue('reporting.revenue: a disclosed stream is the whole revenue; list no other stream');
        if (r.income?.remainder_of) issue('reporting: with revenue streams, protocol income is revenue less holders and costs; drop income.remainder_of');
        if (r.income?.lines.some((l) => l.to === 'protocol')) issue('reporting.income: with revenue streams, protocol income is the remainder; list no protocol line');
      }
      // Mike, 2026-10-12: an asset that discloses its revenue reports that as revenue, not a third-party proxy.
      if (r.revenue_disclosed !== undefined && !(r.revenue ?? []).some((s) => s.disclosed === r.revenue_disclosed)) {
        issue(`reporting: revenue_disclosed "${r.revenue_disclosed}" is the asset's revenue: list it as a disclosed revenue stream`);
      }
    }

    for (const message of sourceIssues(a, required)) issue(message);
  });

export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type MetricDef = AssetConfig['metrics'][string];
export type ReportingDef = NonNullable<AssetConfig['reporting']>;
export type HolderFlowDef = AssetConfig['holder_flows'][number];
export type FlowKind = HolderFlowDef['kind'];
export type CaptureRule = HolderFlowDef['capture_rule'];
export type RecipientBase = HolderFlowDef['recipient_base'];

