import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSchedule, newestSlot, nextSlot, parseSchedule, reportDay, type Cadence } from '../../src/daemon/schedule.js';

const SHIPPED = readFileSync(new URL('../../schedule.yaml', import.meta.url), 'utf8');
const iso = (d: Date): string => d.toISOString();
const at = (s: string): Date => new Date(s);

const NIGHTLY: Cadence = { daily: { hh: 0, mm: 45 } };
const LEVELS: Cadence = { every: { hours: 1, minute: 15 } };

function refusal(text: string): string {
  try {
    parseSchedule(text, 'prod');
  } catch (err) {
    expect(err).toMatchObject({ code: 'invalid_schedule' });
    return (err as Error).message;
  }
  throw new Error('expected parseSchedule to refuse');
}

const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe('schedule.yaml', () => {
  it('schedule: the shipped schedule.yaml parses for dev, stage and prod', () => {
    const prod = parseSchedule(SHIPPED, 'prod');
    expect(prod).toEqual([
      { key: 'nightly', cadence: { daily: { hh: 0, mm: 45 } } },
      { key: 'levels', cadence: { every: { hours: 1, minute: 15 } } },
      { key: 'disclosure_watch', cadence: { daily: { hh: 16, mm: 40 } } },
      { key: 'retention', cadence: { daily: { hh: 3, mm: 30 } } },
    ]);
    expect(parseSchedule(SHIPPED, 'dev')).toEqual(prod); // staging_refresh is stage-only; overrides are stage-only
    const stage = parseSchedule(SHIPPED, 'stage');
    expect(stage).toEqual([
      { key: 'nightly', cadence: { daily: { hh: 2, mm: 45 } } },
      { key: 'levels', cadence: { every: { hours: 6, minute: 15 } } }, // the override's fields over the base entry
      { key: 'disclosure_watch', cadence: { daily: { hh: 16, mm: 40 } } },
      { key: 'staging_refresh', cadence: { weekly: { dow: 0, hh: 10, mm: 30 } } },
      { key: 'retention', cadence: { daily: { hh: 3, mm: 30 } } },
    ]);
  });

  it('schedule: 07:00 and 07:59 are refused, 06:59 and 08:00 are accepted', () => {
    for (const t of ['07:00', '07:59', '07:30']) {
      expect(refusal(`nightly: { at: "${t}", tz: UTC }`)).toBe(`nightly at ${t} UTC falls in 07:00-08:00 UTC, whose Pacific date differs between PDT and PST`);
      expect(refusal(`staging_refresh: { weekly: sun, at: "${t}", tz: UTC, env: stage }`)).toBe(
        `staging_refresh at ${t} UTC falls in 07:00-08:00 UTC, whose Pacific date differs between PDT and PST`,
      );
      expect(refusal(`staging_overrides: { nightly: { at: "${t}", tz: UTC } }`)).toMatch(/^staging_overrides\.nightly at .+ falls in 07:00-08:00 UTC/); // refused in every env
    }
    for (const t of ['06:59', '08:00']) {
      expect(parseSchedule(`nightly: { at: "${t}", tz: UTC }`, 'prod')).toEqual([{ key: 'nightly', cadence: { daily: { hh: Number(t.slice(0, 2)), mm: Number(t.slice(3)) } } }]);
      expect(parseSchedule(`staging_refresh: { weekly: sat, at: "${t}", tz: UTC, env: stage }`, 'stage')[0]!.cadence).toEqual({ weekly: { dow: 6, hh: Number(t.slice(0, 2)), mm: Number(t.slice(3)) } });
    }
    // An hourly job may run at 07:15: only daily and weekly slots carry a report day.
    expect(newestSlot(LEVELS, at('2026-11-03T07:20:00Z')).toISOString()).toBe('2026-11-03T07:15:00.000Z');
    expect(parseSchedule('levels: { every: 1h, minute: 15 }', 'prod')).toHaveLength(1);
  });

  it('schedule: tz America/Los_Angeles is refused naming the key', () => {
    expect(refusal('disclosure_watch: { at: "16:40", tz: America/Los_Angeles }')).toBe('disclosure_watch: tz America/Los_Angeles is not allowed; every slot is tz UTC');
    expect(refusal('levels: { every: 1h, minute: 15, tz: America/Los_Angeles }')).toMatch(/^levels: tz America\/Los_Angeles is not allowed/);
    expect(refusal('retention: { at: "03:30" }')).toBe('retention: a daily or weekly slot needs tz: UTC');
  });

  it('schedule: malformed entries and unknown keys are refused', () => {
    expect(refusal('nightly: { at: "00:45", tz: UTC }\nweekly_backup: { at: "01:00", tz: UTC }')).toMatch(/weekly_backup/);
    expect(refusal('nightly: { at: "00:45", tz: UTC, when: now }')).toMatch(/when/);
    expect(refusal('staging_overrides: { backup: { at: "01:00", tz: UTC } }')).toMatch(/backup/);
    expect(refusal('levels: { every: 5h }')).toBe('levels: every 5h must divide 24 hours');
    expect(refusal('levels: { every: 1h, minute: 60 }')).toMatch(/^levels\.minute: /);
    expect(refusal('nightly: { at: "24:00", tz: UTC }')).toMatch(/^nightly\.at: at must be "HH:MM"/);
    expect(refusal('nightly: { at: "0:45", tz: UTC }')).toMatch(/^nightly\.at: /);
    expect(refusal('nightly: { every: 1h, at: "00:45", tz: UTC }')).toMatch(/^nightly: /);
    expect(refusal('staging_refresh: { weekly: sunday, at: "10:30", tz: UTC }')).toMatch(/^staging_refresh\.weekly: /);
    expect(refusal('nightly: [')).toMatch(/schedule\.yaml/);
    expect(parseSchedule('levels: { every: 6h }', 'prod')).toEqual([{ key: 'levels', cadence: { every: { hours: 6, minute: 0 } } }]);
  });

  describe('loadSchedule', () => {
    let root: string;
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    it('schedule: loadSchedule reads <configRoot>/schedule.yaml and refuses a root without one', () => {
      root = mkdtempSync(join(tmpdir(), 'orion-schedule-'));
      expect(() => loadSchedule(root, 'prod')).toThrow(expect.objectContaining({ code: 'schedule_missing' }));
      writeFileSync(join(root, 'schedule.yaml'), SHIPPED);
      expect(loadSchedule(root, 'stage')).toEqual(parseSchedule(SHIPPED, 'stage'));
    });
  });
});

describe('slot arithmetic', () => {
  it('schedule: slots do not move with TZ or DST', () => {
    const instants = [
      '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-02T00:50:00Z', // PDT ends 2026-11-01 09:00 UTC
      '2027-03-14T09:30:00Z', '2027-03-14T10:30:00Z', '2027-03-15T00:44:00Z', // PST ends 2027-03-14 10:00 UTC
    ];
    const run = (): string[] =>
      instants.flatMap((s) => [NIGHTLY, LEVELS, { weekly: { dow: 0, hh: 10, mm: 30 } } as Cadence].flatMap((c) => {
        const newest = newestSlot(c, at(s));
        return [iso(newest), iso(nextSlot(c, at(s))), reportDay(newest)];
      }));
    process.env.TZ = 'America/Los_Angeles';
    // The zone really is in force, and really changes offset across both transitions.
    expect([at('2026-11-01T08:30:00Z'), at('2026-11-01T09:30:00Z'), at('2027-03-14T09:30:00Z'), at('2027-03-14T10:30:00Z')].map((d) => d.getTimezoneOffset())).toEqual([420, 480, 480, 420]);
    const pacific = run();
    process.env.TZ = 'UTC';
    expect(at('2026-11-01T08:30:00Z').getTimezoneOffset()).toBe(0);
    expect(run()).toEqual(pacific);

    process.env.TZ = 'America/Los_Angeles';
    const nightly = newestSlot(NIGHTLY, at('2026-11-02T00:50:00Z'));
    expect(nightly.toISOString()).toBe('2026-11-02T00:45:00.000Z');
    expect(reportDay(nightly)).toBe('2026-11-01');
    expect(newestSlot(NIGHTLY, at('2026-11-01T08:30:00Z')).toISOString()).toBe('2026-11-01T00:45:00.000Z');
    expect(newestSlot(LEVELS, at('2026-11-01T08:30:00Z')).toISOString()).toBe('2026-11-01T08:15:00.000Z');
    expect(newestSlot(LEVELS, at('2026-11-01T09:30:00Z')).toISOString()).toBe('2026-11-01T09:15:00.000Z');
    expect(nextSlot(NIGHTLY, at('2027-03-14T09:30:00Z')).toISOString()).toBe('2027-03-15T00:45:00.000Z');
    expect(reportDay(newestSlot(NIGHTLY, at('2027-03-15T00:44:00Z')))).toBe('2027-03-13'); // the 03-14 00:45 slot covers 03-13
    expect(reportDay(at('2026-11-02T12:00:00Z'))).toBe('2026-11-02'); // a slot at or after noon labels its own day
  });

  it('schedule: levels every 6h at minute 15 gives 00:15, 06:15, 12:15, 18:15', () => {
    const c: Cadence = { every: { hours: 6, minute: 15 } };
    const slots: string[] = [];
    let t = at('2026-11-02T23:59:00Z');
    for (let i = 0; i < 5; i++) {
      t = nextSlot(c, t);
      slots.push(iso(t));
    }
    expect(slots).toEqual(['2026-11-03T00:15:00.000Z', '2026-11-03T06:15:00.000Z', '2026-11-03T12:15:00.000Z', '2026-11-03T18:15:00.000Z', '2026-11-04T00:15:00.000Z']);
    expect(iso(newestSlot(c, at('2026-11-03T06:14:59Z')))).toBe('2026-11-03T00:15:00.000Z');
    expect(iso(newestSlot(c, at('2026-11-03T06:15:00Z')))).toBe('2026-11-03T06:15:00.000Z'); // a slot is <= now
    expect(iso(newestSlot(c, at('2026-11-03T00:10:00Z')))).toBe('2026-11-02T18:15:00.000Z');
    expect(iso(nextSlot(c, at('2026-11-03T06:15:00Z')))).toBe('2026-11-03T12:15:00.000Z'); // next is > now
  });

  it('schedule: weekly sun 10:30 newest slot on a Wednesday is the previous Sunday', () => {
    const c: Cadence = { weekly: { dow: 0, hh: 10, mm: 30 } };
    expect(iso(newestSlot(c, at('2026-11-04T12:00:00Z')))).toBe('2026-11-01T10:30:00.000Z'); // Wed -> Sun 2026-11-01
    expect(iso(nextSlot(c, at('2026-11-04T12:00:00Z')))).toBe('2026-11-08T10:30:00.000Z');
    expect(iso(newestSlot(c, at('2026-11-08T10:29:00Z')))).toBe('2026-11-01T10:30:00.000Z'); // Sunday before the slot
    expect(iso(newestSlot(c, at('2026-11-08T10:30:00Z')))).toBe('2026-11-08T10:30:00.000Z');
    expect(iso(newestSlot({ daily: { hh: 16, mm: 40 } }, at('2026-11-03T16:39:00Z')))).toBe('2026-11-02T16:40:00.000Z');
  });
});
