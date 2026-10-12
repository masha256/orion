import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import type { SourceOutcome } from '../db/fetchRuns.js';
import { insertObservation, listActiveObservations } from '../db/observations.js';
import { MS_PER_DAY } from '../types.js';
import { addDays, dayStartMs, utcDay } from './time.js';
import type { PeriodDue, PeriodicPayment, RaisedAnomaly, WrittenObservation } from './types.js';

/**
 * A flow metric settled in lump payments, each for a known coverage period (a `periodic` revenue stream; HYPE's USDC
 * reserve yield). Each payment is stored as ONE flow row covering its period (observedAt = the end of the last covered
 * day, periodDays = the days covered); the report spreads it evenly over those days. A payment already stored at the
 * same value is left alone; a changed amount supersedes the row. The payment is the truth: the report's provisional
 * tail (the unpaid days at the last period's daily rate) is never stored, so nothing needs replacing when it lands.
 *
 * Alerts (Mike, 2026-10-12), raised as `revenue_payment` anomalies, advisory (report data: never a grade):
 * - late: a period's payment more than LATE_DAYS after its due day (still unpaid, or paid that late);
 * - off accrual: a payment more than ACCRUAL_TOLERANCE_PCT off the accrual for its period, which (the protocol no longer
 *   publishes the daily rate) is the previous period's daily rate times the days covered;
 * - new payer: an address funding the payer that is not the configured one (a treasury change).
 */

export const LATE_DAYS = 10;
export const ACCRUAL_TOLERANCE_PCT = 2;

export interface PeriodicArgs {
  db: Db;
  asset: AssetConfig;
  metricKey: string;
  payments: PeriodicPayment[];
  due: PeriodDue[];
  payers: string[];
  expectedPayers: string[];
  detail: string;
  now: Date;
  dryRun: boolean;
  outcome: SourceOutcome;
  validate: (value: number) => string | null;
  raise: (a: Omit<RaisedAnomaly, 'id' | 'status'>) => void;
}

const daysBetween = (from: string, to: string) => Math.round((dayStartMs(to) - dayStartMs(from)) / MS_PER_DAY);

export function writePeriodicPayments(args: PeriodicArgs): WrittenObservation[] {
  const { db, asset, metricKey, outcome, dryRun } = args;
  const nowIso = args.now.toISOString();
  const today = utcDay(args.now.getTime());
  const written: WrittenObservation[] = [];
  const stored = new Map(listActiveObservations(db, asset.id, metricKey).filter((o) => (o.periodDays ?? 1) > 1).map((o) => [o.observedAt, o.value]));

  const rows = args.payments.map((p) => {
    const refusal = args.validate(p.value);
    if (refusal !== null) throw new Error(`${p.from} to ${p.to}: ${refusal}`);
    const periodDays = daysBetween(p.from, p.to) + 1;
    return { p, periodDays, observedAt: new Date(dayStartMs(addDays(p.to, 1))).toISOString() };
  });
  const write = () => {
    for (const { p, periodDays, observedAt } of rows) {
      if (stored.get(observedAt) === p.value) continue;
      const observationId = dryRun
        ? null
        : insertObservation(db, {
            assetId: asset.id, metricKey, observedAt, periodDays, value: p.value, source: 'api',
            sourceDetail: `${args.detail}; covers ${p.from} to ${p.to}, paid ${p.paidAt}`, fetchedAt: nowIso,
          }).id;
      written.push({ metricKey, value: p.value, observedAt, periodDays, source: 'api', observationId });
    }
  };
  if (dryRun) write();
  else db.transaction(write).immediate();
  if (written.length > 0) outcome.metricsWritten.push(metricKey);
  else outcome.notes.push(`${metricKey}: no new payment (${args.payments.length} stored${args.due.length > 0 ? `; ${args.due.map((d) => `${d.from} to ${d.to} due ${d.dueDay}`).join(', ')} unpaid` : ''})`);

  // Late: unpaid past the due day plus LATE_DAYS, or paid that late.
  for (const d of args.due) {
    const late = daysBetween(d.dueDay, today);
    if (late > LATE_DAYS) {
      args.raise({ kind: 'revenue_payment', metricKey, dedupeKey: `late:${d.from}`, severity: 'advisory', detail: { period: [d.from, d.to], due_day: d.dueDay, days_late: late, paid: false, threshold_days: LATE_DAYS } });
    }
  }
  for (const p of args.payments) {
    const late = daysBetween(p.dueDay, p.paidAt.slice(0, 10));
    if (late > LATE_DAYS) {
      args.raise({ kind: 'revenue_payment', metricKey, dedupeKey: `late:${p.from}`, severity: 'advisory', detail: { period: [p.from, p.to], due_day: p.dueDay, paid_at: p.paidAt, days_late: late, paid: true, threshold_days: LATE_DAYS } });
    }
  }
  // Off accrual: each payment against the previous period's daily rate times its days.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const accrued = (prev.p.value / prev.periodDays) * cur.periodDays;
    const diffPct = accrued > 0 ? (cur.p.value / accrued - 1) * 100 : null;
    if (diffPct !== null && Math.abs(diffPct) > ACCRUAL_TOLERANCE_PCT) {
      args.raise({
        kind: 'revenue_payment', metricKey, dedupeKey: `accrual:${cur.p.from}`, severity: 'advisory',
        detail: { period: [cur.p.from, cur.p.to], paid: cur.p.value, accrued, diff_pct: diffPct, tolerance_pct: ACCRUAL_TOLERANCE_PCT, basis: `the ${prev.p.from} to ${prev.p.to} period's daily rate` },
      });
    }
  }
  // A new payer.
  if (args.expectedPayers.length > 0) {
    for (const payer of args.payers) {
      if (!args.expectedPayers.includes(payer)) {
        args.raise({ kind: 'revenue_payment', metricKey, dedupeKey: `payer:${payer}`, severity: 'advisory', detail: { payer, expected: args.expectedPayers, note: 'an address other than the configured treasury funded the payments' } });
      }
    }
  }
  return written;
}
