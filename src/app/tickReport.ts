import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { CHECK_TYPES } from '../checks/schema.js';
import type { IsV2 } from '../report/incomeStatement.js';
import type { YieldReport } from '../report/load.js';
import { WATCH_RULES } from '../types.js';
import { InboxSchema } from './inbox.js';

const ErrorSchema = z.strictObject({ code: z.string(), message: z.string() });
const num = z.number().nullable();

/**
 * The holder-yield block of a tick report: a copy of what `report yield` computes, never a number of its own. Since
 * Task 11b every figure is the income statement's (T4 M2: no v1 source left): `flows`, `yields`, `multiple` and
 * `holder_flow_growth_annualized` are its holder flow and yields, empty/null when it threw (C4).
 */
export const TickHolderYieldSchema = z.strictObject({
  day: z.string(),
  window_days: z.number().int(),
  price: num,
  market_cap: num,
  fdv: num,
  /**
   * v1's revenue and payout ratio: only on a `refresh` job row a release before Task 11b wrote (kept optional so the
   * nightly still reads it). The statement's are `statement_revenue`, `statement_revenue_growth`, `statement_payout_ratio`.
   */
  revenue_annualized: num.optional(),
  revenue_growth_annualized: num.optional(),
  payout_ratio: num.optional(),
  /** The statement's measured holder-flow lines with a bucket. */
  flows: z.array(z.strictObject({ id: z.string(), bucket: z.enum(['burn', 'hold', 'cash']), net: num, yield: num })),
  yields: z.strictObject({ cash: num, buyback: num, shareholder: num, dilution: num, net_shareholder: num }),
  multiple: num,
  holder_flow_growth_annualized: num,
  // Income statement v2 (spec 7, Task 4): copied from the report's `incomeStatement`. Optional, so a `refresh` job row a
  // release before Task 4 wrote (none of these) still parses; absent when the statement threw (`statement_error`).
  /** Revenue under v2 (gross user-paid fees, LIT's Robinhood gross included; sdCRV's bribes below the line). */
  statement_revenue: num.optional(),
  statement_revenue_growth: num.optional(),
  /** Revenue less cost of revenue; null when any cost line is not measured (never zero-filled). */
  gross_profit: num.optional(),
  statement_payout_ratio: num.optional(),
  /** What the v2 payout ratio divides by: gross profit, or revenue when gross profit is not measured (correction 14). */
  payout_ratio_basis: z.enum(['grossProfit', 'revenue']).optional(),
  /** Net holder flow (USD a year) per bucket; null for a bucket the asset does not have. */
  holder_flow_by_bucket: z.strictObject({ burn: num, hold: num, cash: num }).optional(),
  /** Holder yield net of dilution (the statement's `yields.netShareholder`). */
  net_holder_yield: num.optional(),
  mcap_to_revenue: num.optional(),
  /** Market cap over total net holder flow. */
  mcap_to_holder_flow: num.optional(),
  scope: z.enum(['complete', 'protocol_share_only', 'partial']).optional(),
  /** The statement's display flags: not-measured lines, third-party lines, the payout ratio basis. */
  flags: z.array(z.string()).optional(),
  /** Computing the income statement threw (ruling C4): its message. The header fields above are unaffected. */
  statement_error: z.string().optional(),
});

export type TickHolderYield = z.infer<typeof TickHolderYieldSchema>;

/** The tick's holder-yield block from the report's own numbers (the statement's): copied, never rounded or recomputed. */
export function summarizeHolderYield(r: YieldReport): TickHolderYield {
  const is = r.incomeStatement;
  const y = is?.yields;
  return {
    day: r.day,
    window_days: r.windowDays,
    price: r.price,
    market_cap: r.marketCap,
    fdv: r.fdv,
    flows: (is?.holderFlow.lines ?? []).flatMap((l) => (l.notMeasured !== undefined || l.bucket === null ? [] : [{ id: l.id, bucket: l.bucket, net: l.net, yield: l.yield }])),
    yields: { cash: y?.cash ?? null, buyback: y?.buyback ?? null, shareholder: y?.shareholder ?? null, dilution: y?.dilution ?? null, net_shareholder: y?.netShareholder ?? null },
    multiple: y?.multiple ?? null,
    holder_flow_growth_annualized: is?.holderFlow.growth.annualized ?? null,
    ...(is ? statementFields(is) : {}),
    ...(r.incomeStatementError !== undefined ? { statement_error: r.incomeStatementError } : {}),
  };
}

/** The v2 fields of the tick's holder-yield block, copied from the statement, never rounded or recomputed. */
function statementFields(is: IsV2): Partial<TickHolderYield> {
  const bucket = (b: 'burn' | 'hold' | 'cash') => is.holderFlow.byBucket[b]?.net ?? null;
  return {
    statement_revenue: is.revenue.annualized,
    statement_revenue_growth: is.revenue.growth.annualized,
    gross_profit: is.grossProfit.annualized,
    statement_payout_ratio: is.ratios.payoutRatio,
    payout_ratio_basis: is.ratios.payoutRatioBasis,
    holder_flow_by_bucket: { burn: bucket('burn'), hold: bucket('hold'), cash: bucket('cash') },
    net_holder_yield: is.yields.netShareholder,
    mcap_to_revenue: is.multiples.mcapToRevenue,
    mcap_to_holder_flow: is.multiples.mcapToHolderFlow.total,
    scope: is.scope,
    flags: [...is.flags],
  };
}

/**
 * What one `orion tick` did, for the scheduler's reader. Ids, kinds, counts, and Orion's own codes and numbers only:
 * nothing a model wrote or a page said. Validated before it is written.
 */
export const TickReportSchema = z.strictObject({
  schema_version: z.literal(2),
  tick_id: z.string(),
  asset: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  outcome: z.enum(['completed', 'run_in_progress', 'error']),
  /** Set on `run_in_progress`: who holds the asset's lock. */
  lock: z.strictObject({ holder: z.string(), acquired_at: z.string() }).nullable(),
  ingest: z
    .strictObject({
      fetch_run_id: z.number().int().nullable(),
      outcome: z.string(),
      sources_failed: z.array(z.string()),
      /** Anomalies the fetch opened, or saw again while still open. Ones standing under an acknowledgement are not news and are left out. */
      anomalies_raised: z.array(z.strictObject({ id: z.number().int().nullable(), kind: z.string(), metric: z.string(), severity: z.enum(['degrading', 'advisory']) })),
      /** Watched monitor-only metrics that moved (never anomalies). Present only when the fetch had any. */
      watch: z
        .array(z.strictObject({ metric: z.string(), rule: z.enum(WATCH_RULES), value: z.number(), previous: z.number().nullable(), day: z.string() }))
        .optional(),
    })
    .nullable(),
  /**
   * The asset's `report yield` summary for its latest complete day, field for field and unrounded. Null when the report
   * could not be built (`report_unavailable`), when the tick never reached it, or when the asset has no
   * `income_statement` block. Kept, with `report_error` `report_stale`, when the report's day is more than
   * REPORT_STALE_DAYS behind the tick.
   */
  holder_yield: TickHolderYieldSchema.nullable(),
  /**
   * Set when the fetch ran but the report could not be built (`report_unavailable`, `holder_yield` null), or was built for
   * a day more than REPORT_STALE_DAYS behind the tick (`report_stale`, `holder_yield` kept). Message capped at 300.
   */
  report_error: ErrorSchema.nullable(),
  /**
   * The reconciliation checks evaluated for the report's day (spec §5, Task 5), in check order: what each found. Absent
   * when the asset has no checks or the tick never reached them (an optional key, so a v2 row without it still parses).
   */
  checks: z
    .array(z.strictObject({ id: z.string(), type: z.enum(CHECK_TYPES), status: z.enum(['ok', 'breach', 'incomplete']), gap_pct: num }))
    .optional(),
  /** Evaluating or storing the checks threw: its message (capped at 300). The rest of the tick is unaffected. */
  checks_error: z.string().optional(),
  /** What awaits the user after this tick, computed last, outside the lock, so a tick that never got the lock still lists it. */
  inbox: InboxSchema,
  error: ErrorSchema.nullable(),
});

export type TickReport = z.infer<typeof TickReportSchema>;

export function tickId(asset: string, startedAt: Date): string {
  return `tick_${asset}_${startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

/** One JSON line to `write`, and appended to `outFile` when given. Throws if the report does not fit its own schema. */
export function emitTickReport(report: TickReport, opts: { write: (line: string) => void; outFile?: string; onAppendError?: (err: unknown) => void }): void {
  const line = JSON.stringify(TickReportSchema.parse(report));
  opts.write(line);
  // The line on stdout is the delivery; the file is a copy. Losing the copy is not fatal.
  if (opts.outFile) {
    try {
      appendFileSync(opts.outFile, line + '\n', 'utf8');
    } catch (err) {
      opts.onAppendError?.(err);
    }
  }
}
