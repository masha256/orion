import { describe, expect, it } from 'vitest';
import { buildSchedule, latestLevel } from '../../src/observations/select.js';
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
