import { describe, expect, it } from 'vitest';
import { isStale, obsProvenance, trailingFlowAnnualized, worstProvenance } from '../../src/drivers/select.js';
import { AS_OF, obs } from '../helpers/obs.js';

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
