import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dueRunType } from '../../src/app/cadence.js';
import { cadenceFor, DEFAULT_CADENCE } from '../../src/config/agentPolicy.js';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import { finishAgentRun, startAgentRun, ZERO_USAGE, type AgentOutcome } from '../../src/db/agentRuns.js';
import { openDb, type Db } from '../../src/db/connection.js';
import type { RunType } from '../../src/types.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

const T0 = new Date('2026-09-21T00:00:00.000Z');
const daysLater = (d: number) => new Date(T0.getTime() + d * 86_400_000);

let db: Db;
let asset: AssetConfig;
beforeEach(() => {
  db = openDb(':memory:');
  asset = parseAssetYaml(MINI_ASSET_YAML).config;
});

function attempt(runType: RunType, opts: { at?: Date; outcome?: Exclude<AgentOutcome, 'running'>; dryRun?: boolean; trigger?: string } = {}): number {
  const at = (opts.at ?? T0).toISOString();
  const id = startAgentRun(db, {
    assetId: 'mini', persona: 'analyst', runType, trigger: opts.trigger ?? 'schedule', triggerDetail: {}, dryRun: opts.dryRun ?? false,
    configHash: 'x', model: 'm', startedAt: at,
  });
  finishAgentRun(db, id, { outcome: opts.outcome ?? 'completed', endedAt: at, usage: ZERO_USAGE, error: null, summary: null, transcript: [] });
  return id;
}

describe('cadence config', () => {
  it('defaults to weekly 7, deep 30, enabled, and reads overrides from agent.cadence', () => {
    expect(cadenceFor(asset)).toEqual(DEFAULT_CADENCE);
    const over = parseAssetYaml(`${MINI_ASSET_YAML}agent:\n  cadence: { weekly_days: 3, deep_days: 14, enabled: false }\n`).config;
    expect(cadenceFor(over)).toEqual({ weeklyDays: 3, deepDays: 14, enabled: false });
    expect(cadenceFor(parseAssetYaml(`${MINI_ASSET_YAML}agent:\n  cadence: { deep_days: 60 }\n`).config)).toEqual({ ...DEFAULT_CADENCE, deepDays: 60 });
  });

  it('rejects a non-positive or fractional interval and an unknown key', () => {
    const messageOf = (yaml: string) => {
      try {
        parseAssetYaml(yaml);
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    };
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  cadence: { weekly_days: 0 }\n`)).toMatch(/agent\.cadence\.weekly_days/);
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  cadence: { deep_days: 1.5 }\n`)).toMatch(/agent\.cadence\.deep_days/);
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  cadence: { monthly_days: 30 }\n`)).toMatch(/agent\.cadence/);
  });

  it('leaves the config hashes where they were: no schema default was added', () => {
    // Pinned on main 3e1d547 before sub-project 4. A schema change that adds a default moves these; a deliberate edit of assets/vvv.yaml moves the second, and then this pin is updated on purpose.
    expect(parseAssetYaml(MINI_ASSET_YAML).hash).toBe('6db2927f57c7349c1bcf199b769c3b5f4fee8dea4fb6ae4492f12b866f7b5395');
    expect(parseAssetYaml(readFileSync(join(process.cwd(), 'assets', 'vvv.yaml'), 'utf8')).hash).toBe('360988f5fd4ba608f00f76ebcade1cf98f8a484c254b0b470d1888a3ae2d44f4');
    expect(asset.agent).toBeUndefined();
    expect(asset.review_triggers).toEqual({});
  });
});

describe('dueRunType', () => {
  it('owes a bootstrap first on a fresh asset, and a deep once one bootstrap or deep attempt exists', () => {
    expect(dueRunType(db, asset, T0)).toBe('bootstrap');
    attempt('weekly'); // a weekly alone does not make an asset bootstrapped
    expect(dueRunType(db, asset, T0)).toBe('bootstrap');
    attempt('bootstrap', { outcome: 'budget_exhausted' }); // every attempt counts
    expect(dueRunType(db, asset, T0)).toBeNull();
    expect(dueRunType(db, asset, daysLater(7))).toBe('weekly'); // the bootstrap was that week's weekly
    expect(dueRunType(db, asset, daysLater(30))).toBe('deep'); // and that month's deep
  });

  it('a deep run satisfies the week; weekly is due at 7 days and not at 6; deep at 30', () => {
    attempt('deep');
    expect(dueRunType(db, asset, T0)).toBeNull();
    expect(dueRunType(db, asset, daysLater(6))).toBeNull();
    expect(dueRunType(db, asset, daysLater(7))).toBe('weekly');
    attempt('weekly', { at: daysLater(7) });
    expect(dueRunType(db, asset, daysLater(13))).toBeNull();
    expect(dueRunType(db, asset, daysLater(14))).toBe('weekly');
    attempt('weekly', { at: daysLater(14) });
    attempt('weekly', { at: daysLater(21) });
    attempt('weekly', { at: daysLater(28) });
    expect(dueRunType(db, asset, daysLater(29))).toBeNull();
    expect(dueRunType(db, asset, daysLater(30))).toBe('deep');
  });

  it('a failed attempt counts, a dry run does not, a manual run counts', () => {
    attempt('deep');
    attempt('weekly', { at: daysLater(7), outcome: 'budget_exhausted' });
    expect(dueRunType(db, asset, daysLater(8))).toBeNull(); // not retried the next day
    expect(dueRunType(db, asset, daysLater(14))).toBe('weekly');
    attempt('weekly', { at: daysLater(14), dryRun: true });
    expect(dueRunType(db, asset, daysLater(14))).toBe('weekly'); // the dry run is not an attempt
    attempt('weekly', { at: daysLater(14), trigger: 'manual' });
    expect(dueRunType(db, asset, daysLater(15))).toBeNull();
  });

  it('deep takes precedence when both are due, and the intervals come from agent.cadence', () => {
    const fast = parseAssetYaml(`${MINI_ASSET_YAML}agent:\n  cadence: { weekly_days: 2, deep_days: 5 }\n`).config;
    attempt('deep');
    attempt('weekly', { at: daysLater(2) });
    expect(dueRunType(db, fast, daysLater(4))).toBe('weekly');
    expect(dueRunType(db, fast, daysLater(5))).toBe('deep');
  });

  it('has half a day of slack: due a minute before the boundary, not yet at 6.4 days', () => {
    attempt('deep');
    expect(dueRunType(db, asset, new Date(daysLater(7).getTime() - 60_000))).toBe('weekly');
    expect(dueRunType(db, asset, daysLater(6.4))).toBeNull();
  });

  it('ignores other assets', () => {
    startAgentRun(db, { assetId: 'other', persona: 'p', runType: 'deep', trigger: 'schedule', triggerDetail: {}, dryRun: false, configHash: 'x', model: 'm', startedAt: T0.toISOString() });
    expect(dueRunType(db, asset, T0)).toBe('bootstrap');
  });
});
