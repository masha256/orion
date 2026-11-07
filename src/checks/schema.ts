import { z } from 'zod';
import type { IncomeStatementDef } from '../config/schema.js';
import type { SourceConfig } from '../config/sources.js';
import { findAdapter } from '../ingest/adapters/registry.js';
import { sourceId } from '../ingest/sourceId.js';

/**
 * Internal reconciliation checks (spec 2026-10-28 §5): each compares two numbers from different source types or
 * different contracts. The shapes below are what `income_statement.checks` may list; `resolveChecks` adds the automatic
 * ones (a `parameter` check per `share_metric`, a `two_path` check per `paid_metric`). Every node is strict and nothing
 * has a default, so a parsed check is what the YAML says and adding a type moves no asset's config hash.
 */

const CheckId = z.string().regex(/^[a-z0-9_]+$/);
const Tolerance = z.number().nonnegative();
/** Days summed per side, ending on the evaluated day (1: the day alone). */
const WindowDays = z.number().int().min(1).max(366);
const Metrics = z.array(z.string()).min(1);

const base = { id: CheckId, tolerance_pct: Tolerance };

/**
 * A measured total vs the sum of the statement lines (or flow metrics) it splits into (a missed recipient, a new split).
 * A part is a line id or a metric key; an apportioned line is named with every line of its set (Task 7b), which together
 * read its flow once.
 */
export const SumCheckSchema = z.strictObject({
  ...base, type: z.literal('sum'), total: Metrics, parts: z.array(z.string().regex(/^[a-z0-9_.]+$/)).min(1), window_days: WindowDays.optional(),
  // Pre-G2 decision 1 (Mike, 2026-11-07): an absolute floor in the series' unit (dust is not a breach), as balance/supply.
  tolerance_abs: Tolerance.optional(),
});
/** A share read from the protocol daily vs the share a line assumes (a fee-split change). */
export const ParameterCheckSchema = z.strictObject({ ...base, type: z.literal('parameter'), metric: z.string(), expected: z.number().finite() });
/** The day's change in an account's balance vs measured inflows less outflows (missed senders, dropped logs). */
export const BalanceCheckSchema = z.strictObject({
  ...base, type: z.literal('balance'), level: z.string(), inflows: Metrics, outflows: z.array(z.string()), tolerance_abs: Tolerance.optional(),
});
/** The day's fall in a supply vs measured burns less mints (burns outside the scanned sinks). */
export const SupplyCheckSchema = z.strictObject({
  ...base, type: z.literal('supply'), level: z.string(), burns: Metrics, mints: z.array(z.string()).min(1).optional(), tolerance_abs: Tolerance.optional(),
});
/** The same quantity measured two ways (an API error, a contract change). */
export const TwoPathCheckSchema = z.strictObject({ ...base, type: z.literal('two_path'), a: z.string(), b: z.string(), window_days: WindowDays.optional() });
/**
 * A price vs an on-chain oracle or pool: `against` is a level metric, or a contract that a `contract_read` cross-check
 * of `level` reads (UNI/LINK/CAKE's Chainlink feeds: the reading each fetch stores in its run detail).
 */
export const PriceCheckSchema = z.strictObject({ ...base, type: z.literal('price'), level: z.string(), against: z.string() });
/** Stored days vs the source's later reads of the last `days` days (an API restating history). */
export const RevisionCheckSchema = z.strictObject({ ...base, type: z.literal('revision'), metric: z.string(), days: z.number().int().min(1).max(366) });
/** A pool list's flows vs the protocol total they can be checked against (a pool outside the list). */
export const CoverageCheckSchema = z.strictObject({ ...base, type: z.literal('coverage'), listed: Metrics, total: z.string(), window_days: WindowDays.optional() });

export const CheckSchema = z.discriminatedUnion('type', [
  SumCheckSchema, ParameterCheckSchema, BalanceCheckSchema, SupplyCheckSchema, TwoPathCheckSchema, PriceCheckSchema, RevisionCheckSchema, CoverageCheckSchema,
]);

export type CheckDef = z.infer<typeof CheckSchema>;
export type CheckType = CheckDef['type'];
export const CHECK_TYPES: readonly CheckType[] = ['sum', 'parameter', 'balance', 'supply', 'two_path', 'price', 'revision', 'coverage'];

/** An automatic parameter check: a share the protocol states must equal the share the line assumes, exactly. */
export const AUTO_PARAMETER_TOLERANCE_PCT = 0;
/**
 * An automatic two_path check compares the statement line's series with its `paid_metric` over the statement window:
 * a payout measured at the recipients lags its source (cvxCRV's BaseRewardPool streams CRV over 7 days and the wrapper
 * holds ~99 percent of the staked supply), so one day never matches; the window total does, within this tolerance.
 */
export const AUTO_TWO_PATH_TOLERANCE_PCT = 5;

/** One flow series of a side, scaled (a line passing on a share of its revenue line's series). */
export interface Term {
  metric: string;
  factor: number;
  /** The statement line the term stands for (sum parts and automatic two_path). */
  line?: string;
}

/** A check as evaluated: explicit or automatic, its line references resolved to series. */
export type ResolvedCheck = { id: string; tolerancePct: number; auto: boolean } & (
  | { type: 'sum'; total: Term[]; parts: Term[]; windowDays: number; toleranceAbs: number | null }
  | { type: 'parameter'; metric: string; expected: number; line?: string }
  | { type: 'balance'; level: string; inflows: Term[]; outflows: Term[]; toleranceAbs: number | null }
  | { type: 'supply'; level: string; burns: Term[]; mints: Term[]; toleranceAbs: number | null }
  | { type: 'two_path'; a: Term[]; b: Term[]; windowDays: number }
  | { type: 'price'; level: string; against: { kind: 'metric'; metric: string } | { kind: 'cross_check'; contract: string; sourceId: string } }
  | { type: 'revision'; metric: string; days: number }
  | { type: 'coverage'; listed: Term[]; total: Term[]; windowDays: number }
);

interface MetricLike {
  type: string;
  unit: string;
  source?: SourceConfig;
  cross_checks?: { source: SourceConfig }[];
}
export interface CheckAsset {
  metrics: Record<string, MetricLike>;
  income_statement?: IncomeStatementDef;
}

const terms = (ms: string[]): Term[] => ms.map((metric) => ({ metric, factor: 1 }));

/** A statement line as one flow series times a factor, or why it cannot be one (estimate, not measured, disclosed, run rate). */
function lineTerm(is: IncomeStatementDef, id: string): Term | string {
  const rev = is.revenue.find((r) => r.id === id);
  const revTerm = (r: typeof rev & object, share: number): Term | string => {
    if (r.metric !== undefined) return { metric: r.metric, factor: share, line: id };
    if (r.derived !== undefined) return { metric: r.derived.from, factor: share / r.derived.share, line: id };
    return `line "${id}" has no measured series (a metric or derived)`;
  };
  if (rev) return revTerm(rev, 1);
  const uses = [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])];
  const use = uses.find((l) => l.id === id);
  if (use) {
    if (use.metric !== undefined) return { metric: use.metric, factor: 1, line: id };
    if (use.of !== undefined) {
      const of = is.revenue.find((r) => r.id === use.of);
      if (!of) return `line "${id}" passes on no revenue line`;
      return revTerm(of, use.share ?? 1);
    }
    return `line "${id}" has no measured series (a metric or of)`;
  }
  const below = (is.below_line ?? []).find((b) => b.id === id);
  if (below) return below.metric !== undefined ? { metric: below.metric, factor: 1, line: id } : `line "${id}" has no measured flow`;
  return `"${id}" is not a line id`;
}

/** The checks the statement lists plus the automatic ones. Throws on a reference validation refuses (callers load validated configs). */
export function resolveChecks(asset: CheckAsset): ResolvedCheck[] {
  const { checks, problems } = resolveAll(asset);
  if (problems.length > 0) throw new Error(`income_statement checks: ${problems.join('; ')}`);
  return checks;
}

function resolveAll(asset: CheckAsset): { checks: ResolvedCheck[]; problems: string[] } {
  const is = asset.income_statement;
  const out: ResolvedCheck[] = [];
  const problems: string[] = [];
  if (!is) return { checks: out, problems };
  const part = (c: { id: string }, id: string): Term | null => {
    const t = lineTerm(is, id);
    if (typeof t === 'string') {
      problems.push(`check ${c.id} part ${t}`);
      return null;
    }
    return t;
  };
  // Apportion sets (Task 7b): the lines that read one flow, each with a share that moves with the window's mix.
  const lines = [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? []), ...(is.below_line ?? [])];
  const setOf = (id: string): string[] | null => {
    const l = lines.find((x) => x.id === id);
    if (l?.apportion === undefined || l.metric === undefined) return null;
    return lines.filter((x) => x.apportion !== undefined && x.metric === l.metric && x.apportion.total === l.apportion!.total).map((x) => x.id);
  };
  const sumPart = (c: { id: string; parts: string[] }, id: string, done: Set<string>): Term | null => {
    const isLine = [...is.revenue, ...lines].some((x) => x.id === id);
    if (!isLine) {
      if (asset.metrics[id] !== undefined) return { metric: id, factor: 1 };
      problems.push(`check ${c.id} part "${id}" is not a line id or a metric`);
      return null;
    }
    const set = setOf(id);
    if (set === null) return part(c, id);
    // A whole set reads its flow once (factor 1); a part of one would carry a factor that moves with the mix.
    if (!set.every((x) => c.parts.includes(x))) {
      problems.push(`check ${c.id} part "${id}" is apportioned: list every line of its set (${set.join(', ')}) or none`);
      return null;
    }
    if (set.some((x) => done.has(x))) return null;
    set.forEach((x) => done.add(x));
    return { metric: lines.find((x) => x.id === id)!.metric!, factor: 1, line: set.join('+') };
  };
  for (const c of is.checks ?? []) {
    const common = { id: c.id, tolerancePct: c.tolerance_pct, auto: false };
    switch (c.type) {
      case 'sum': {
        const done = new Set<string>();
        const parts = c.parts.map((p) => sumPart(c, p, done)).filter((t): t is Term => t !== null);
        out.push({ ...common, type: 'sum', total: terms(c.total), parts, windowDays: c.window_days ?? 1, toleranceAbs: c.tolerance_abs ?? null });
        break;
      }
      case 'parameter':
        out.push({ ...common, type: 'parameter', metric: c.metric, expected: c.expected });
        break;
      case 'balance':
        out.push({ ...common, type: 'balance', level: c.level, inflows: terms(c.inflows), outflows: terms(c.outflows), toleranceAbs: c.tolerance_abs ?? null });
        break;
      case 'supply':
        out.push({ ...common, type: 'supply', level: c.level, burns: terms(c.burns), mints: terms(c.mints ?? []), toleranceAbs: c.tolerance_abs ?? null });
        break;
      case 'two_path':
        out.push({ ...common, type: 'two_path', a: terms([c.a]), b: terms([c.b]), windowDays: c.window_days ?? 1 });
        break;
      case 'price': {
        if (asset.metrics[c.against] !== undefined) {
          out.push({ ...common, type: 'price', level: c.level, against: { kind: 'metric', metric: c.against } });
          break;
        }
        const reads = (asset.metrics[c.level]?.cross_checks ?? []).filter((x) => x.source.type === 'contract_read' && x.source.contract === c.against);
        if (reads.length !== 1) {
          problems.push(`check ${c.id} against "${c.against}" is neither a metric nor a contract that one contract_read cross-check of ${c.level} reads`);
          break;
        }
        out.push({ ...common, type: 'price', level: c.level, against: { kind: 'cross_check', contract: c.against, sourceId: sourceId(reads[0]!.source) } });
        break;
      }
      case 'revision':
        out.push({ ...common, type: 'revision', metric: c.metric, days: c.days });
        break;
      case 'coverage':
        out.push({ ...common, type: 'coverage', listed: terms(c.listed), total: terms([c.total]), windowDays: c.window_days ?? 1 });
        break;
    }
  }
  // Automatic: a parameter check for every share_metric (the share the line assumes), a two_path for every paid_metric.
  const auto = { tolerancePct: AUTO_PARAMETER_TOLERANCE_PCT, auto: true };
  for (const r of is.revenue) {
    if (r.derived?.share_metric !== undefined) out.push({ ...auto, id: `${r.id}_share`, type: 'parameter', metric: r.derived.share_metric, expected: r.derived.share, line: r.id });
  }
  for (const l of [...(is.cost_of_revenue ?? []), ...(is.holders ?? []), ...(is.protocol ?? []), ...(is.operating_costs ?? [])]) {
    if (l.share_metric !== undefined) out.push({ ...auto, id: `${l.id}_share`, type: 'parameter', metric: l.share_metric, expected: l.share ?? 1, line: l.id });
  }
  for (const h of is.holders ?? []) {
    if (h.paid_metric === undefined) continue;
    const a = lineTerm(is, h.id);
    // An estimate line has nothing measured to set the paid series against; a paid_metric that is the line's own series
    // (allowed: M4) is one reading, not two paths.
    if (typeof a === 'string' || a.metric === h.paid_metric) continue;
    out.push({ id: `${h.id}_paid`, tolerancePct: AUTO_TWO_PATH_TOLERANCE_PCT, auto: true, type: 'two_path', a: [a], b: [{ metric: h.paid_metric, factor: 1, line: h.id }], windowDays: is.window_days });
  }
  return { checks: out, problems };
}

/** The series each side of a check reads, for the circular-check rule (a revision check reads one series by design). */
function sides(c: ResolvedCheck): [string[], string[]] | null {
  const ms = (t: Term[]) => t.map((x) => x.metric);
  switch (c.type) {
    case 'sum':
      return [ms(c.total), ms(c.parts)];
    case 'parameter':
      return null;
    case 'balance':
      return [[c.level], [...ms(c.inflows), ...ms(c.outflows)]];
    case 'supply':
      return [[c.level], [...ms(c.burns), ...ms(c.mints)]];
    case 'two_path':
      return [ms(c.a), ms(c.b)];
    case 'price':
      return [[c.level], c.against.kind === 'metric' ? [c.against.metric] : []];
    case 'revision':
      return null;
    case 'coverage':
      return [ms(c.listed), ms(c.total)];
  }
}

/**
 * Every adapter `name`'s series is computed from, followed transitively (A computedFrom B computedFrom C), each with the
 * adapters it was reached through (empty for a direct entry). Cycles stop at the first repeat.
 */
function adapterUpstream(name: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (n: string, via: string[]) => {
    for (const up of findAdapter(n)?.computedFrom ?? []) {
      if (out.has(up) || up === name) continue;
      out.set(up, via);
      walk(up, [...via, up]);
    }
  };
  walk(name, []);
  return out;
}

/** The metric keys a derived source's params name, arrays flattened (LINK released_rate: `metrics: [a, b]`). */
function paramMetrics(asset: CheckAsset, params: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      if (asset.metrics[v] !== undefined) out.push(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(params ?? {});
  return out;
}

/** Every metric a derived metric `m` is computed from, followed through derived inputs, each with the metrics it was reached through. */
function derivedUpstream(asset: CheckAsset, m: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (n: string, via: string[]) => {
    const s = asset.metrics[n]?.source;
    if (s?.type !== 'derived') return;
    for (const up of paramMetrics(asset, s.params)) {
      if (out.has(up) || up === m) continue;
      out.set(up, via);
      walk(up, [...via, up]);
    }
  };
  walk(m, []);
  return out;
}

const viaText = (via: string[]) => (via.length > 0 ? ` (via ${via.join(' -> ')})` : '');

/**
 * Why series `a` and `b` are not independent readings, or null: the same metric, an adapter computed (transitively) from
 * the other's, a derived metric (transitively) of the other.
 */
function joined(asset: CheckAsset, a: string, b: string): string | null {
  if (a === b) return `"${a}" is on both sides`;
  const src = (m: string) => asset.metrics[m]?.source;
  const sa = src(a);
  const sb = src(b);
  if (sa?.type === 'adapter' && sb?.type === 'adapter') {
    const fromA = adapterUpstream(sa.name).get(sb.name);
    if (fromA !== undefined) return `"${a}" (adapter ${sa.name}) is computedFrom ${sb.name}${viaText(fromA)}, which reads "${b}"`;
    const fromB = adapterUpstream(sb.name).get(sa.name);
    if (fromB !== undefined) return `"${b}" (adapter ${sb.name}) is computedFrom ${sa.name}${viaText(fromB)}, which reads "${a}"`;
  }
  const ofA = derivedUpstream(asset, a).get(b);
  if (ofA !== undefined) return `"${a}" is derived from "${b}"${viaText(ofA)}`;
  const ofB = derivedUpstream(asset, b).get(a);
  if (ofB !== undefined) return `"${b}" is derived from "${a}"${viaText(ofB)}`;
  return null;
}

/**
 * Problems with the statement's checks, explicit and automatic, one message each (prefixed by the caller): references,
 * metric types and units, id collisions, and the circular-check rule (spec §5, Review Focus 2): the two sides of a check
 * must not read the same series, nor one computed from the other.
 */
export function checkIssues(asset: CheckAsset): string[] {
  const is = asset.income_statement;
  if (!is) return [];
  const out: string[] = [];
  const { checks, problems } = resolveAll(asset);
  out.push(...problems);
  const def = (m: string) => asset.metrics[m];
  const want = (c: { id: string }, m: string, type: 'flow' | 'level', what: string): MetricLike | null => {
    const d = def(m);
    if (d?.type !== type) {
      out.push(`check ${c.id} ${what} "${m}" is not a ${type} metric`);
      return null;
    }
    return d;
  };
  const sameUnit = (c: { id: string }, ms: string[]) => {
    const units = new Set(ms.map((m) => def(m)?.unit).filter((u) => u !== undefined));
    if (units.size > 1) out.push(`check ${c.id} mixes units (${[...units].sort().join(', ')})`);
  };
  const ids = new Set<string>();
  for (const c of checks) {
    if (ids.has(c.id)) out.push(`check id "${c.id}" is used twice${c.auto ? ' (an automatic check takes <line>_share or <line>_paid)' : ''}`);
    ids.add(c.id);
    const flows = (t: Term[], what: string) => t.forEach((x) => want(c, x.metric, 'flow', what));
    switch (c.type) {
      case 'sum':
        flows(c.total, 'total');
        flows(c.parts, 'part');
        sameUnit(c, [...c.total, ...c.parts].map((t) => t.metric));
        break;
      case 'parameter': {
        const d = want(c, c.metric, 'level', 'metric');
        if (d?.source?.type === 'constant') out.push(`check ${c.id} metric "${c.metric}" is a constant: it can never disagree with the line`);
        break;
      }
      case 'balance':
      case 'supply': {
        want(c, c.level, 'level', 'level');
        const fl = c.type === 'balance' ? [...c.inflows, ...c.outflows] : [...c.burns, ...c.mints];
        flows(fl, c.type === 'balance' ? 'flow' : 'burn or mint');
        sameUnit(c, [c.level, ...fl.map((t) => t.metric)]);
        break;
      }
      case 'two_path':
        flows([...c.a, ...c.b], 'side');
        sameUnit(c, [...c.a, ...c.b].map((t) => t.metric));
        break;
      case 'price': {
        const d = want(c, c.level, 'level', 'level');
        if (c.against.kind === 'metric') {
          want(c, c.against.metric, 'level', 'against');
          sameUnit(c, [c.level, c.against.metric]);
        } else if (d?.source?.type === 'contract_read' && d.source.contract === c.against.contract) {
          out.push(`check ${c.id} against "${c.against.contract}" is ${c.level}'s own primary contract`);
        }
        break;
      }
      case 'revision':
        want(c, c.metric, 'flow', 'metric');
        break;
      case 'coverage':
        flows([...c.listed, ...c.total], 'series');
        sameUnit(c, [...c.listed, ...c.total].map((t) => t.metric));
        break;
    }
    const s = sides(c);
    if (s === null) continue;
    const seen = new Set<string>();
    for (const a of s[0]) {
      for (const b of s[1]) {
        const why = joined(asset, a, b);
        if (why !== null && !seen.has(why)) {
          seen.add(why);
          out.push(`check ${c.id} is circular: ${why}`);
        }
      }
    }
  }
  return out;
}
