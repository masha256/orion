import { describe, expect, it } from 'vitest';
import { emptyInbox } from '../../src/app/inbox.js';
import { TickReportSchema, type TickReport } from '../../src/app/tickReport.js';

const report = (ingest: TickReport['ingest']): unknown => ({
  schema_version: 2, tick_id: 'tick_mini_20260919T120005Z', asset: 'mini', started_at: '2026-09-19T12:00:05.000Z', ended_at: '2026-09-19T12:00:06.000Z',
  outcome: 'completed', lock: null, ingest, holder_yield: null, report_error: null, inbox: emptyInbox(), error: null,
});
const ingest = { fetch_run_id: 7, outcome: 'ok', sources_failed: [], anomalies_raised: [] };

describe('TickReportSchema: ingest.watch', () => {
  it('accepts a report without ingest.watch', () => {
    expect(TickReportSchema.parse(report(ingest))).toEqual(report(ingest));
  });

  it('accepts a report with ingest.watch', () => {
    const withWatch = {
      ...ingest,
      watch: [
        { metric: 'flow_usd.rh_buyback', rule: 'above' as const, value: 1500, previous: null, day: '2026-09-17' },
        { metric: 'rh_fee_account_usd', rule: 'change_pct' as const, value: 106, previous: 100, day: '2026-09-19' },
      ],
    };
    expect(TickReportSchema.parse(report(withWatch))).toEqual(report(withWatch));
  });

  it('refuses an unknown rule or an extra key in a firing', () => {
    const bad = (firing: object) => TickReportSchema.safeParse(report({ ...ingest, watch: [firing] } as TickReport['ingest'])).success;
    expect(bad({ metric: 'm', rule: 'below', value: 1, previous: null, day: '2026-09-17' })).toBe(false);
    expect(bad({ metric: 'm', rule: 'above', value: 1, previous: null, day: '2026-09-17', note: 'text' })).toBe(false);
  });
});

describe('TickReportSchema v2', () => {
  it('tick report v2 refuses a signal key', () => {
    const valid = report(ingest) as Record<string, unknown>;
    expect(TickReportSchema.parse(valid)).toEqual(valid);
    expect(() => TickReportSchema.parse({ ...valid, signal: null })).toThrow();
  });

  it('refuses every other key of the valuation era, and schema_version 1', () => {
    const valid = report(ingest) as Record<string, unknown>;
    for (const [key, value] of Object.entries({ triggers_fired: [], triggers_recorded: true, triggers_standing: [], agent: null, agent_would_run: null })) {
      expect(TickReportSchema.safeParse({ ...valid, [key]: value }).success).toBe(false);
    }
    expect(TickReportSchema.safeParse({ ...valid, schema_version: 1 }).success).toBe(false);
  });
});
