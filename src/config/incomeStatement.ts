import { z } from 'zod';
import { CheckSchema, checkIssues, type CheckAsset } from '../checks/schema.js';
import type { IncomeStatementDef } from './schema.js';

/**
 * Income statement v2 (spec 2026-10-28 §6, plan correction 6): revenue is everything users pay; each use section says
 * where it goes (cost of revenue to the supply side, holders by bucket, protocol, operating costs), and below_line holds
 * income users did not pay (third-party bribes, treasury programs). Every node is strict and nothing has a default, so the
 * parsed block is what the YAML says and an asset without it keeps its config hash. `window_days`, `volume`, `dilution`
 * and `burned_tokens` reuse `reporting`'s shapes: they are added to this base in `schema.ts`.
 */

const LineId = z.string().regex(/^[a-z0-9_]+$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A fraction of a gross series (0 < share <= 1). */
const Share = z.number().positive().max(1);
const Haircut = z.number().min(0).max(0.5);
const BucketSchema = z.enum(['burn', 'hold', 'cash']);
const RecipientBaseSchema = z.enum(['all', 'staked', 'locked']);
const ValuedPerSchema = z.enum(['supply', 'recipients']);
const CaptureRuleSchema = z.enum(['contractual', 'programmatic', 'discretionary']);
const CategorySchema = z.enum(['dex', 'perp_dex', 'launchpad', 'cdp_stablecoin', 'lending', 'oracle', 'ai_platform', 'liquid_locker', 'lst']);
const CostToSchema = z.enum(['lps', 'lenders', 'savers', 'builders', 'referrers', 'partners', 'creators', 'deployers', 'node_operators', 'other']);
/** A fixed contractual ratio of a measured revenue line (Convex's caller fee: 5 percent of the 10 percent lock line). */
const EstimateSchema = z.strictObject({ of: LineId, ratio: z.number().positive().max(10) });
/**
 * Apportion by mix (Task 7b, ruling R14): the line carries its `metric` x (window sum of `by` / window sum of `total`).
 * Lines reading one flow with complementary `by` series (a set) split it whole: yCRV's payouts between users' fees and
 * auctioned vote incentives by the splitter's sender mix.
 */
const ApportionSchema = z.strictObject({ by: z.string(), total: z.string() });

/**
 * A revenue line, with exactly one value source: `metric` (a flow; `settlement` daily or periodic, `started` dating a young
 * stream), `derived` (a gross from a flow the protocol keeps a known share of), `disclosed` (a level: the company's own
 * run rate, the only revenue line, optionally with a `cross_check` flow), `estimate`, or `not_measured` (shown as n/m).
 */
export const IsRevenueLineSchema = z.strictObject({
  id: LineId,
  label: z.string().optional(),
  metric: z.string().optional(),
  settlement: z.enum(['daily', 'periodic']).optional(),
  started: Day.optional(),
  disclosed: z.string().optional(),
  cross_check: z.string().optional(),
  estimate: EstimateSchema.optional(),
  derived: z.strictObject({ from: z.string(), share: Share, share_metric: z.string().optional() }).optional(),
  not_measured: z.string().min(1).optional(),
});

/**
 * A use line, with exactly one value source: its own `metric` (a flow), `of` a revenue line (that line's series,
 * settlement, start and run-rate weight, times `share`, default 1, optionally read daily from `share_metric`), an
 * `estimate`, or `not_measured`.
 */
const useShape = {
  id: LineId,
  label: z.string().optional(),
  note: z.string().optional(),
  metric: z.string().optional(),
  of: LineId.optional(),
  share: Share.optional(),
  share_metric: z.string().optional(),
  estimate: EstimateSchema.optional(),
  not_measured: z.string().min(1).optional(),
  apportion: ApportionSchema.optional(),
};
export const IsUseLineSchema = z.strictObject(useShape);

/** Paid to holders out of revenue, by bucket. `paid_metric` is the series measured at the recipients (holder flow, yields). */
export const IsHolderLineSchema = z.strictObject({
  ...useShape,
  bucket: BucketSchema,
  haircut: Haircut,
  recipient_base: RecipientBaseSchema,
  valued_per: ValuedPerSchema.optional(),
  capture_rule: CaptureRuleSchema,
  paid_metric: z.string().optional(),
});

/** What users paid that goes to the supply side and partners. */
export const IsCostLineSchema = z.strictObject({ ...useShape, to: CostToSchema });

/**
 * Income not paid by users: exactly one of `metric` (a flow, optionally apportioned), `run_rate` (a level in USD/yr) or
 * `not_measured`.
 */
export const IsBelowLineSchema = z.strictObject({
  id: LineId,
  label: z.string().optional(),
  note: z.string().optional(),
  metric: z.string().optional(),
  run_rate: z.string().optional(),
  not_measured: z.string().min(1).optional(),
  apportion: ApportionSchema.optional(),
  to: z.enum(['holders', 'protocol']),
  bucket: BucketSchema.optional(),
  haircut: Haircut.optional(),
  recipient_base: RecipientBaseSchema.optional(),
  valued_per: ValuedPerSchema.optional(),
  capture_rule: CaptureRuleSchema.optional(),
});

/**
 * The statement's reconciliation checks (spec §5; shapes in src/checks/schema.ts): `sum` (measured totals vs the lines
 * they split into), `parameter`, `balance`, `supply`, `two_path`, `price`, `revision`, `coverage`. A gap is reported and
 * stored (check_results), never booked.
 */
export const IsCheckSchema = CheckSchema;

/** The block without the four keys shared with `reporting` (window_days, volume, dilution, burned_tokens; see schema.ts). */
export const IncomeStatementBaseSchema = z.strictObject({
  category: CategorySchema,
  /** What revenue covers, shown with every figure. */
  scope: z.enum(['complete', 'protocol_share_only', 'partial']),
  revenue: z.array(IsRevenueLineSchema).min(1),
  cost_of_revenue: z.array(IsCostLineSchema).min(1).optional(),
  holders: z.array(IsHolderLineSchema).min(1).optional(),
  protocol: z.array(IsUseLineSchema).min(1).optional(),
  operating_costs: z.array(IsUseLineSchema).min(1).optional(),
  /** The one section closed as revenue less the rest (it lists no line of its own). */
  remainder: z.enum(['protocol', 'operating_costs']).optional(),
  below_line: z.array(IsBelowLineSchema).min(1).optional(),
  checks: z.array(IsCheckSchema).min(1).optional(),
});

export type IsCategory = z.infer<typeof CategorySchema>;
export type IsBucket = z.infer<typeof BucketSchema>;
export type CostTo = z.infer<typeof CostToSchema>;
export type IsRevenueLine = z.infer<typeof IsRevenueLineSchema>;
export type IsUseLine = z.infer<typeof IsUseLineSchema>;
export type IsHolderLine = z.infer<typeof IsHolderLineSchema>;
export type IsCostLine = z.infer<typeof IsCostLineSchema>;
export type IsBelowLine = z.infer<typeof IsBelowLineSchema>;
export type IsCheck = z.infer<typeof IsCheckSchema>;
export type IsApportion = z.infer<typeof ApportionSchema>;

type AnyUseLine = IsUseLine | IsHolderLine | IsCostLine;
type UseSection = 'cost_of_revenue' | 'holders' | 'protocol' | 'operating_costs';
const USE_SECTIONS: UseSection[] = ['cost_of_revenue', 'holders', 'protocol', 'operating_costs'];

/** The lines' own fields that are defined, counted by name (a parser that kept an absent key as undefined must not count). */
const present = (line: object, keys: string[]): string[] => keys.filter((k) => (line as Record<string, unknown>)[k] !== undefined);

/**
 * The validation rules the schema cannot express (spec §6 + correction 6): one value source per line, ids unique across
 * sections (strictly: a use line never reuses its revenue line's id), metric types and references, a
 * disclosed revenue line alone, remainder only on an empty section, burns at haircut 0, a capture rule on every measured
 * below-line line to holders, and no series read twice (a use of a revenue series goes through `of`; a `paid_metric` is
 * read by no other line; a flow split by `apportion` is read only by its set, whose by series a sum check proves partition
 * its total). The shared reporting keys are checked in schema.ts. Messages are prefixed.
 */
export function incomeStatementIssues(asset: CheckAsset): string[] {
  const is = asset.income_statement;
  if (!is) return [];
  const out: string[] = [];
  const issue = (message: string) => out.push(`income_statement: ${message}`);
  const typed = (type: string, label: string) => (m: string, where: string) => {
    if (asset.metrics[m]?.type !== type) issue(`${where} "${m}" is not a ${label} metric`);
  };
  const flow = typed('flow', 'flow');
  const level = typed('level', 'level');

  const revById = new Map(is.revenue.map((r) => [r.id, r] as const));
  const measuredRevenue = (id: string) => {
    const r = revById.get(id);
    return r !== undefined && (r.metric !== undefined || r.derived !== undefined);
  };
  const estimateRef = (of: string, where: string) => {
    if (!measuredRevenue(of)) issue(`${where} estimate of "${of}" is not a measured revenue line (one with a metric or derived)`);
  };

  // Line ids, unique across all sections with no exception (spec §6, ruling R8), so a check part names exactly one line.
  // A use line passing on a revenue line takes its own id (Task 2: the revenue line is `<name>_rev`).
  const ids = new Set<string>();
  const addId = (id: string) => {
    if (ids.has(id)) issue(`line id "${id}" is used twice`);
    else ids.add(id);
  };

  // Which line reads each series: revenue first, so a use or below_line reading a revenue series gets its own message.
  const revenueMetric = new Map<string, string>();
  const readBy = new Map<string, { where: string; apportion?: IsApportion }>();
  // A series read by more than one line only as an apportion set (Task 7b): every reader apportions it.
  const apportionSets = new Map<string, { where: string; id: string; apportion: IsApportion }[]>();
  const read = (m: string, where: string, apportion?: IsApportion) => {
    const first = readBy.get(m);
    if (first !== undefined && (first.apportion === undefined || apportion === undefined)) issue(`metric "${m}" is read by two lines (${first.where} and ${where})`);
    else if (first === undefined) readBy.set(m, { where, ...(apportion ? { apportion } : {}) });
  };
  /** An apportioned line: its by and total are flows (not the same one), its value source a metric, no paid_metric. */
  const apportioned = (l: { id: string; metric?: string; apportion?: IsApportion }, w: string) => {
    if (l.apportion === undefined) return;
    if (l.metric === undefined) {
      issue(`${w} takes apportion only with a metric (the flow it splits)`);
      return;
    }
    flow(l.apportion.by, `${w} apportion by`);
    flow(l.apportion.total, `${w} apportion total`);
    if (l.apportion.by === l.apportion.total) issue(`${w} apportion by "${l.apportion.by}" is its total: the line would carry the whole flow`);
    apportionSets.set(l.metric, [...(apportionSets.get(l.metric) ?? []), { where: w, id: l.id, apportion: l.apportion }]);
  };

  for (const r of is.revenue) {
    const w = `revenue.${r.id}`;
    addId(r.id);
    if (present(r, ['metric', 'derived', 'disclosed', 'estimate', 'not_measured']).length !== 1) {
      issue(`${w} takes exactly one of metric, derived, disclosed, estimate or not_measured`);
    }
    if (r.metric !== undefined) {
      flow(r.metric, `${w} metric`);
      read(r.metric, w);
      revenueMetric.set(r.metric, r.id);
    }
    if (r.derived !== undefined) {
      flow(r.derived.from, `${w} derived from`);
      read(r.derived.from, w);
      revenueMetric.set(r.derived.from, r.id);
      if (r.derived.share_metric !== undefined) level(r.derived.share_metric, `${w} derived share_metric`);
    }
    if (r.disclosed !== undefined) level(r.disclosed, `${w} disclosed`);
    if (r.cross_check !== undefined) {
      if (r.disclosed === undefined) issue(`only a disclosed revenue line takes a cross_check ("${r.id}")`);
      flow(r.cross_check, `${w} cross_check`);
    }
    if ((r.settlement !== undefined || r.started !== undefined) && r.metric === undefined && r.derived === undefined) {
      issue(`${w} takes settlement and started only with a metric or derived`);
    }
    if (r.settlement === 'periodic' && r.started === undefined) issue(`${w} is periodic and needs started (its first covered day)`);
    if (r.estimate !== undefined) estimateRef(r.estimate.of, w);
  }
  if (is.revenue.some((r) => r.disclosed !== undefined) && is.revenue.length > 1) {
    issue('a disclosed revenue line is the whole revenue; list no other revenue line');
  }

  for (const section of USE_SECTIONS) {
    for (const l of (is[section] ?? []) as AnyUseLine[]) {
      const w = `${section}.${l.id}`;
      addId(l.id);
      if (present(l, ['metric', 'of', 'estimate', 'not_measured']).length !== 1) issue(`${w} takes exactly one of metric, of, estimate or not_measured`);
      if (l.metric !== undefined) {
        flow(l.metric, `${w} metric`);
        const rev = revenueMetric.get(l.metric);
        if (rev !== undefined) issue(`${w} metric "${l.metric}" is revenue line ${rev}'s metric: use of: ${rev}`);
        else read(l.metric, w, l.apportion);
      }
      apportioned(l, w);
      if (l.of !== undefined) {
        const rev = revById.get(l.of);
        if (rev === undefined) issue(`${w} of "${l.of}" is not a revenue line`);
        else if (rev.not_measured !== undefined) issue(`${w} of "${l.of}" is a not_measured revenue line`);
      }
      if ((l.share !== undefined || l.share_metric !== undefined) && l.of === undefined) issue(`${w} takes share or share_metric only with of`);
      if (l.share_metric !== undefined) level(l.share_metric, `${w} share_metric`);
      if (l.estimate !== undefined) estimateRef(l.estimate.of, w);
      if (section === 'holders') {
        const h = l as IsHolderLine;
        if (h.bucket === 'burn' && h.haircut !== 0) issue(`${w} is a burn, whose haircut is 0`);
        if (h.valued_per === 'recipients' && h.recipient_base !== 'staked') issue(`${w} can be valued per recipients only with recipient_base staked`);
        if (h.paid_metric !== undefined) {
          flow(h.paid_metric, `${w} paid_metric`);
          if (h.apportion !== undefined) issue(`${w} takes no paid_metric with apportion (holder flow reads the apportioned series)`);
          if (h.not_measured !== undefined) issue(`${w} takes no paid_metric when not_measured`);
        }
      }
    }
  }

  for (const b of is.below_line ?? []) {
    const w = `below_line.${b.id}`;
    addId(b.id);
    if (present(b, ['metric', 'run_rate', 'not_measured']).length !== 1) issue(`${w} takes exactly one of metric, run_rate or not_measured`);
    if (b.metric !== undefined) {
      flow(b.metric, `${w} metric`);
      if (revenueMetric.has(b.metric)) issue(`${w} metric "${b.metric}" is a revenue metric: below-line income is what users did not pay`);
      else read(b.metric, w, b.apportion);
    }
    apportioned(b, w);
    if (b.run_rate !== undefined) level(b.run_rate, `${w} run_rate`);
    if (b.to === 'holders') {
      const measured = b.metric !== undefined || b.run_rate !== undefined;
      // capture_rule too (correction 6, ruling M3): `asset describe` reads it for the holder-flow text. A not_measured line
      // (AERO bribes) needs none of these.
      if (measured && (b.bucket === undefined || b.haircut === undefined || b.recipient_base === undefined || b.capture_rule === undefined)) {
        issue(`${w} to holders needs bucket, haircut, recipient_base and capture_rule`);
      }
    } else if (present(b, ['bucket', 'haircut', 'recipient_base', 'valued_per', 'capture_rule']).length > 0) {
      issue(`${w} to protocol takes no bucket, haircut, recipient_base, valued_per or capture_rule`);
    }
    if (b.bucket === 'burn' && (b.haircut ?? 0) !== 0) issue(`${w} is a burn, whose haircut is 0`);
    if (b.valued_per === 'recipients' && b.recipient_base !== 'staked') issue(`${w} can be valued per recipients only with recipient_base staked`);
  }

  // paid_metric (ruling M4): holder flow reads it in place of the line's statement source, so a series any other line reads
  // would count twice in holder flow and yields. The one exception is the revenue series this line passes on (`of`).
  const readers = new Map<string, string[]>();
  const reader = (m: string | undefined, where: string) => {
    if (m !== undefined) readers.set(m, [...(readers.get(m) ?? []), where]);
  };
  for (const r of is.revenue) {
    reader(r.metric, `revenue.${r.id}`);
    reader(r.derived?.from, `revenue.${r.id}`);
    reader(r.derived?.share_metric, `revenue.${r.id}`);
  }
  for (const section of USE_SECTIONS) {
    for (const l of (is[section] ?? []) as AnyUseLine[]) {
      reader(l.metric, `${section}.${l.id}`);
      reader(l.share_metric, `${section}.${l.id}`);
      if (section === 'holders') reader((l as IsHolderLine).paid_metric, `${section}.${l.id}`);
    }
  }
  for (const b of is.below_line ?? []) {
    reader(b.metric, `below_line.${b.id}`);
    reader(b.run_rate, `below_line.${b.id}`);
  }
  for (const h of is.holders ?? []) {
    if (h.paid_metric === undefined) continue;
    const w = `holders.${h.id}`;
    const passedOn = h.of !== undefined ? `revenue.${h.of}` : undefined;
    const others = [...new Set(readers.get(h.paid_metric) ?? [])].filter((x) => x !== w && x !== passedOn);
    if (others.length > 0) issue(`${w} paid_metric "${h.paid_metric}" is also read by ${others.join(', ')}`);
  }

  // Apportion sets (Task 7b): the lines reading one flow split it whole only when their by series partition one total, so
  // holder flow, yields and buckets cannot move. Same total, distinct by, and a sum check total = [total], parts = the by
  // series (as metrics or the lines reading them) proves the partition every day.
  const sumChecks = (is.checks ?? []).filter((c) => c.type === 'sum');
  const partMetric = (p: string): string | undefined => {
    const r = revById.get(p);
    if (r !== undefined) return r.metric;
    return asset.metrics[p] !== undefined ? p : undefined;
  };
  for (const [m, set] of apportionSets) {
    const total = set[0]!.apportion.total;
    const other = set.find((x) => x.apportion.total !== total);
    if (other !== undefined) {
      issue(`apportion of "${m}": ${set[0]!.where} and ${other.where} name different totals`);
      continue;
    }
    const byWhere = new Map<string, string>();
    let twice = false;
    for (const x of set) {
      const first = byWhere.get(x.apportion.by);
      if (first !== undefined) {
        issue(`apportion of "${m}": by "${x.apportion.by}" is named twice (${first} and ${x.where})`);
        twice = true;
      } else byWhere.set(x.apportion.by, x.where);
    }
    if (twice) continue;
    const bys = [...byWhere.keys()];
    const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
    const proven = sumChecks.some((c) => same(c.total, [total]) && same(c.parts.map((p) => partMetric(p) ?? `?${p}`), bys));
    if (!proven) {
      issue(`apportion of "${m}" by [${bys.join(', ')}] needs a sum check with total [${total}] and parts [${bys.join(', ')}] (the by series must partition the total)`);
    }
  }

  if (is.remainder !== undefined && (is[is.remainder] ?? []).length > 0) {
    issue(`remainder ${is.remainder} closes that section as revenue less the rest; list no ${is.remainder} line`);
  }

  // Every check, explicit or automatic (src/checks/schema.ts): references, types, ids, and the circular-check rule.
  for (const message of checkIssues(asset)) issue(message);
  return out;
}

/** A use line with its `of` resolved: what the report reads for it. */
export interface ResolvedUse {
  id: string;
  /** The revenue line it passes on (`of`): its run-rate weight (a young stream's) applies to this line too. */
  revenue?: IsRevenueLine;
  metric?: string;
  /** 1 unless the line sets one. */
  share: number;
  share_metric?: string;
  settlement?: 'daily' | 'periodic';
  started?: string;
  estimate?: { of: string; ratio: number };
  derived?: { from: string; share: number; share_metric?: string };
  disclosed?: string;
  not_measured?: string;
  apportion?: IsApportion;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * Resolve a use line (cost of revenue, holders, protocol, operating costs): `share` defaults to 1 here, never in the
 * schema, and an `of` line inherits its revenue line's value source, settlement and start (and so its run-rate weight).
 * Throws on an `of` naming no revenue line, which validation refuses.
 */
export function resolveUse(def: IncomeStatementDef, line: AnyUseLine): ResolvedUse {
  const share = line.share ?? 1;
  if (line.of === undefined) {
    return defined({ id: line.id, metric: line.metric, share, estimate: line.estimate, not_measured: line.not_measured, apportion: line.apportion });
  }
  const rev = def.revenue.find((r) => r.id === line.of);
  if (rev === undefined) throw new Error(`income_statement: ${line.id} of "${line.of}" is not a revenue line`);
  return defined({
    id: line.id, revenue: rev, metric: rev.metric, share, share_metric: line.share_metric, settlement: rev.settlement, started: rev.started,
    estimate: rev.estimate, derived: rev.derived, disclosed: rev.disclosed, not_measured: rev.not_measured,
  });
}
