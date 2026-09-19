import { describe, expect, it } from 'vitest';
import {
  buildSchedule, isStale, latestLevel, obsProvenance, trailingFlowAnnualized, worstProvenance,
} from '../../src/drivers/select.js';
import { AS_OF, obs } from '../helpers/obs.js';

describe('latestLevel', () => {
  it('picks the newest observation at or before asOf and ignores future ones', () => {
    const list = [obs('p', 1, '2026-06-01'), obs('p', 2, '2026-06-29'), obs('p', 3, '2026-07-05')];
    expect(latestLevel(list, AS_OF)?.value).toBe(2);
  });
  it('returns undefined when nothing qualifies', () => {
    expect(latestLevel([obs('p', 3, '2026-07-05')], AS_OF)).toBeUndefined();
  });
});

describe('trailingFlowAnnualized', () => {
  it('annualizes three full months inside a 90 day window', () => {
    const list = [
      obs('f', 300, '2026-05-01', { periodDays: 30 }),
      obs('f', 300, '2026-05-31', { periodDays: 30 }),
      obs('f', 300, '2026-06-30', { periodDays: 30 }),
    ];
    const r = trailingFlowAnnualized(list, AS_OF, 90);
    expect(r.annualized).toBeCloseTo((900 * 365) / 90, 9);
    expect(r.used).toHaveLength(3);
  });
  it('prorates an observation that straddles the window start', () => {
    // The window ends at the newest reported period end, which the second row pins to AS_OF, so the
    // first covers [asOf-110d, asOf-80d]: 10 of its 30 days fall inside the 90 day window.
    const list = [obs('f', 300, '2026-04-11', { periodDays: 30 }), obs('f', 0, AS_OF, { periodDays: 1 })];
    expect(trailingFlowAnnualized(list, AS_OF, 90).annualized).toBeCloseTo((100 * 365) / 90, 9);
  });
  it('anchors the window at the newest reported period end, so the value does not decay as data ages', () => {
    const list = [
      obs('f', 300, '2026-05-01', { periodDays: 30 }),
      obs('f', 300, '2026-05-31', { periodDays: 30 }),
      obs('f', 300, '2026-06-30', { periodDays: 30 }),
    ];
    const atPeriodEnd = trailingFlowAnnualized(list, AS_OF, 90).annualized;
    const twentyDaysLater = trailingFlowAnnualized(list, '2026-07-20T00:00:00.000Z', 90).annualized;
    expect(atPeriodEnd).toBeCloseTo((900 * 365) / 90, 9);
    expect(twentyDaysLater).toBeCloseTo(atPeriodEnd, 9);
  });
  it('ignores observations after asOf', () => {
    expect(trailingFlowAnnualized([obs('f', 300, '2026-07-15', { periodDays: 30 })], AS_OF, 90).annualized).toBe(0);
  });
});

describe('buildSchedule', () => {
  it('returns the step in force followed by future steps', () => {
    const list = [obs('e', 900, '2025-01-01'), obs('e', 700, '2026-01-01'), obs('e', 500, '2026-10-01')];
    const { steps } = buildSchedule(list, AS_OF);
    expect(steps).toEqual([
      { from: '2026-01-01T00:00:00.000Z', value: 700 },
      { from: '2026-10-01T00:00:00.000Z', value: 500 },
    ]);
  });
  it('returns only future steps when none is in force', () => {
    expect(buildSchedule([obs('e', 500, '2026-10-01')], AS_OF).steps).toHaveLength(1);
  });
});

describe('provenance and staleness', () => {
  it('treats provisional status as the provenance', () => {
    expect(obsProvenance(obs('p', 1, '2026-06-01', { status: 'provisional', source: 'manual' }))).toBe('provisional');
    expect(obsProvenance(obs('p', 1, '2026-06-01', { source: 'api' }))).toBe('api');
  });
  it('picks the worst provenance', () => {
    expect(worstProvenance(['onchain', 'manual', 'api'])).toBe('manual');
    expect(worstProvenance([])).toBe('onchain');
  });
  it('flags stale values', () => {
    expect(isStale('2026-06-20T00:00:00.000Z', AS_OF, 3)).toBe(true);
    expect(isStale('2026-06-28T00:00:00.000Z', AS_OF, 3)).toBe(false);
  });
});
