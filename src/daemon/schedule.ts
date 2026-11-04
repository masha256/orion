import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { OrionEnv } from '../cli/paths.js';
import { MS_PER_DAY, OrionError } from '../types.js';

/**
 * `schedule.yaml` (ships in the release, at the config root) and slot arithmetic. Slots are UTC only: every date and
 * hour here comes from `Date.UTC` and `getUTC*`, so the host's zone and DST never move a slot (Review Focus 2). A daily
 * or weekly slot in 07:00-08:00 UTC is refused: midnight Pacific is 07:00 UTC in PDT and 08:00 UTC in PST, so that
 * hour's Pacific date flips with DST and a report labelled by it would be ambiguous.
 */

export const SCHEDULE_KEYS = ['nightly', 'levels', 'disclosure_watch', 'staging_refresh', 'retention'] as const;
export type ScheduleKey = (typeof SCHEDULE_KEYS)[number];

export type Cadence =
  | { daily: { hh: number; mm: number } }
  | { weekly: { dow: 0 | 1 | 2 | 3 | 4 | 5 | 6; hh: number; mm: number } }
  | { every: { hours: number; minute: number } };

export interface ScheduleEntry {
  key: ScheduleKey;
  cadence: Cadence;
}

const DOWS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const MS_PER_HOUR = 3_600_000;

const EntrySchema = z.strictObject({
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'at must be "HH:MM" (00:00-23:59, quoted)').optional(),
  tz: z.string().optional(),
  weekly: z.enum(DOWS).optional(),
  every: z.string().regex(/^\d{1,2}h$/, 'every must be <hours>h, e.g. 1h').optional(),
  minute: z.number().int().min(0).max(59).optional(),
  env: z.enum(['dev', 'stage', 'prod']).optional(),
});
type Entry = z.infer<typeof EntrySchema>;

const FileSchema = z.strictObject({
  ...Object.fromEntries(SCHEDULE_KEYS.map((k) => [k, EntrySchema.optional()])),
  staging_overrides: z.strictObject(Object.fromEntries(SCHEDULE_KEYS.map((k) => [k, EntrySchema.partial().optional()]))).optional(),
}) as unknown as z.ZodType<Partial<Record<ScheduleKey, Entry>> & { staging_overrides?: Partial<Record<ScheduleKey, Entry>> }>;

function refuse(message: string): never {
  throw new OrionError('invalid_schedule', message);
}

/** One entry to its cadence; `name` is how a refusal names it (`nightly`, `staging_overrides.nightly`). */
function cadenceOf(name: string, e: Entry): Cadence {
  if (e.tz !== undefined && e.tz !== 'UTC') refuse(`${name}: tz ${e.tz} is not allowed; every slot is tz UTC`);
  if (e.every !== undefined) {
    if (e.at !== undefined || e.weekly !== undefined) refuse(`${name}: every cannot be combined with at or weekly`);
    const hours = Number(e.every.slice(0, -1));
    if (hours < 1 || 24 % hours !== 0) refuse(`${name}: every ${e.every} must divide 24 hours`);
    return { every: { hours, minute: e.minute ?? 0 } };
  }
  if (e.minute !== undefined) refuse(`${name}: minute goes with every`);
  if (e.at === undefined) refuse(`${name}: needs at (daily or weekly) or every`);
  if (e.tz === undefined) refuse(`${name}: a daily or weekly slot needs tz: UTC`);
  const hh = Number(e.at.slice(0, 2));
  const mm = Number(e.at.slice(3));
  if (hh === 7) refuse(`${name} at ${e.at} UTC falls in 07:00-08:00 UTC, whose Pacific date differs between PDT and PST`);
  if (e.weekly !== undefined) return { weekly: { dow: DOWS.indexOf(e.weekly) as 0 | 1 | 2 | 3 | 4 | 5 | 6, hh, mm } };
  return { daily: { hh, mm } };
}

/**
 * The entries that run in `env`, in `SCHEDULE_KEYS` order. On `stage`, each `staging_overrides` entry's fields replace
 * the base entry's; an entry with `env` runs only in that env. Every entry and every override is checked whatever the
 * env, so a file valid in one env is valid in all. Throws `invalid_schedule`.
 */
export function parseSchedule(text: string, env: OrionEnv): ScheduleEntry[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    refuse(`schedule.yaml is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  const parsed = FileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'schedule.yaml'}: ${i.message}`).join('\n'));
  }
  const file = parsed.data;
  const overrides = file.staging_overrides ?? {};
  const out: ScheduleEntry[] = [];
  for (const key of SCHEDULE_KEYS) {
    const base = file[key];
    const over = overrides[key];
    if (base) cadenceOf(key, base);
    if (over) cadenceOf(`staging_overrides.${key}`, { ...base, ...over });
    const entry = env === 'stage' && over ? { ...base, ...over } : base;
    if (!entry || (entry.env !== undefined && entry.env !== env)) continue;
    out.push({ key, cadence: cadenceOf(key, entry) });
  }
  return out;
}

/** `<configRoot>/schedule.yaml` for `env`. Throws `schedule_missing` when there is none, `invalid_schedule` when it is wrong. */
export function loadSchedule(configRoot: string, env: OrionEnv): ScheduleEntry[] {
  const file = join(configRoot, 'schedule.yaml');
  if (!existsSync(file)) throw new OrionError('schedule_missing', `no schedule.yaml in ${configRoot}`);
  return parseSchedule(readFileSync(file, 'utf8'), env);
}

/** The cadence's period in ms. */
function periodMs(c: Cadence): number {
  if ('daily' in c) return MS_PER_DAY;
  if ('weekly' in c) return 7 * MS_PER_DAY;
  return c.every.hours * MS_PER_HOUR;
}

/** The latest slot at or before `now` (UTC arithmetic only). */
export function newestSlot(c: Cadence, now: Date): Date {
  const t = now.getTime();
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  let slot: number;
  if ('daily' in c) {
    slot = Date.UTC(y, mo, d, c.daily.hh, c.daily.mm);
  } else if ('weekly' in c) {
    const back = (now.getUTCDay() - c.weekly.dow + 7) % 7;
    slot = Date.UTC(y, mo, d - back, c.weekly.hh, c.weekly.mm);
  } else {
    const h = Math.floor(now.getUTCHours() / c.every.hours) * c.every.hours;
    slot = Date.UTC(y, mo, d, h, c.every.minute);
  }
  if (slot > t) slot -= periodMs(c);
  return new Date(slot);
}

/** The earliest slot strictly after `now`. */
export function nextSlot(c: Cadence, now: Date): Date {
  return new Date(newestSlot(c, now).getTime() + periodMs(c));
}

/**
 * The UTC day a nightly slot reports on: a slot before 12:00 UTC covers the day before its own date (00:45 on 11-02
 * reports 11-01), a slot at or after noon its own date.
 */
export function reportDay(nightlySlot: Date): string {
  const t = nightlySlot.getUTCHours() < 12 ? nightlySlot.getTime() - MS_PER_DAY : nightlySlot.getTime();
  return new Date(t).toISOString().slice(0, 10);
}
