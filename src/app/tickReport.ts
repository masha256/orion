import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import type { HolderYieldReport } from '../report/holderYield.js';
import { WATCH_RULES } from '../types.js';
import { InboxSchema } from './inbox.js';

const ErrorSchema = z.strictObject({ code: z.string(), message: z.string() });
const num = z.number().nullable();

/** The holder-yield block of a tick report: a copy of what `report yield` computes, never a number of its own. */
export const TickHolderYieldSchema = z.strictObject({
  day: z.string(),
  window_days: z.number().int(),
  price: num,
  market_cap: num,
  fdv: num,
  revenue_annualized: num,
  revenue_growth_annualized: num,
  payout_ratio: num,
  flows: z.array(z.strictObject({ id: z.string(), bucket: z.enum(['burn', 'hold', 'cash']), net: num, yield: num })),
  yields: z.strictObject({ cash: num, buyback: num, shareholder: num, dilution: num, net_shareholder: num }),
  multiple: num,
  holder_flow_growth_annualized: num,
});

export type TickHolderYield = z.infer<typeof TickHolderYieldSchema>;

/** The tick's holder-yield block from the report's own numbers: copied, never rounded or recomputed. */
export function summarizeHolderYield(r: HolderYieldReport): TickHolderYield {
  return {
    day: r.day,
    window_days: r.windowDays,
    price: r.price,
    market_cap: r.marketCap,
    fdv: r.fdv,
    revenue_annualized: r.revenue?.annualized ?? r.income?.revenue.annualized ?? null,
    revenue_growth_annualized: r.revenue?.growth.annualized ?? r.income?.revenue.growth.annualized ?? null,
    payout_ratio: r.income?.payoutRatio ?? null,
    flows: r.flows.map((f) => ({ id: f.id, bucket: f.bucket, net: f.net, yield: f.yield })),
    yields: { cash: r.yields.cash, buyback: r.yields.buyback, shareholder: r.yields.shareholder, dilution: r.yields.dilution, net_shareholder: r.yields.netShareholder },
    multiple: r.yields.multiple,
    holder_flow_growth_annualized: r.holderFlowGrowth.annualized,
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
   * could not be built (see `report_error`), when the tick never reached it, or when the asset has no `reporting` block.
   */
  holder_yield: TickHolderYieldSchema.nullable(),
  /** Set when the fetch ran but the report could not be built: `report_unavailable`, with the reason (capped). */
  report_error: ErrorSchema.nullable(),
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
