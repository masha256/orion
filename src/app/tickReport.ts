import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { TRIGGER_KINDS } from '../db/triggerFirings.js';
import { RUN_TYPES } from '../types.js';

const ErrorSchema = z.strictObject({ code: z.string(), message: z.string() });

/**
 * What one `orion tick` did, for the scheduler's reader. Ids, kinds, counts, and Orion's own codes and numbers only:
 * nothing a model wrote or a page said. Validated before it is written, as a signal is.
 */
export const TickReportSchema = z.strictObject({
  schema_version: z.literal(1),
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
    })
    .nullable(),
  signal: z
    .strictObject({
      signal_id: z.string(),
      status: z.enum(['ok', 'degraded', 'blocked']),
      grade: z.enum(['A', 'B', 'C', 'D']),
      expected_target_12m: z.number().nullable(),
      target_delta_pct: z.number().nullable(),
      cause: z.enum(['data', 'assumptions', 'config', 'both', 'none']),
    })
    .nullable(),
  /** Fired this tick; under `triggers_recorded: false`, what would have fired. */
  triggers_fired: z.array(z.strictObject({ kind: z.enum(TRIGGER_KINDS), key: z.string(), detail: z.record(z.string(), z.unknown()) })),
  triggers_recorded: z.boolean(),
  agent: z
    .strictObject({
      run_type: z.enum(RUN_TYPES),
      trigger_kind: z.enum(['schedule', 'trigger']),
      /** Null when the run never got a row: it threw at preflight. */
      run_id: z.number().int().nullable(),
      outcome: z.string().nullable(),
      usage: z
        .strictObject({ requests: z.number().int(), input_tokens: z.number().int(), output_tokens: z.number().int(), web_searches: z.number().int(), web_fetches: z.number().int() })
        .nullable(),
      /** What the run wrote, by count; `assumption_set_version` is the new set's version when it changed assumptions. Null when nothing was committed. */
      committed: z
        .strictObject({ assumption_set_version: z.number().int().nullable(), observations: z.number().int(), anomalies_resolved: z.number().int(), journal: z.number().int() })
        .nullable(),
      proposals: z.array(z.strictObject({ id: z.number().int(), kind: z.string() })),
      signal_id: z.string().nullable(),
      error: ErrorSchema.nullable(),
    })
    .nullable(),
  /** Set under `--no-agent` or `agent.cadence.enabled: false`: the run tick would have started. */
  agent_would_run: z.strictObject({ run_type: z.enum(RUN_TYPES), trigger_kind: z.enum(['schedule', 'trigger']) }).nullable(),
  error: ErrorSchema.nullable(),
});

export type TickReport = z.infer<typeof TickReportSchema>;

export function tickId(asset: string, startedAt: Date): string {
  return `tick_${asset}_${startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

/** One JSON line to `write`, and appended to `outFile` when given. Throws if the report does not fit its own schema. */
export function emitTickReport(report: TickReport, opts: { write: (line: string) => void; outFile?: string }): void {
  const line = JSON.stringify(TickReportSchema.parse(report));
  opts.write(line);
  if (opts.outFile) appendFileSync(opts.outFile, line + '\n', 'utf8');
}
