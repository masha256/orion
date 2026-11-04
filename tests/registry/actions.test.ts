import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRegistryRow, listRegistry, listStateEvents } from '../../src/db/registry.js';
import { activateAsset, pauseAsset, resumeAsset, seedRegistry } from '../../src/registry/actions.js';
import { reconcileFromDisk } from '../../src/registry/reconcile.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const DAY = 86_400_000;
const T0 = new Date('2026-11-03T00:00:00.000Z');
const at = (days: number): Date => new Date(T0.getTime() + days * DAY);

/** Two API series, backfill_days 30 and the writer's default (90): the shorter one bounds the refill. */
const API_ASSET_YAML = MINI_ASSET_YAML.replace('id: mini', 'id: apis').replace(
  '  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, critical: true }',
  [
    '  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, critical: true, source: { type: defillama, slug: x, data_type: dailyFees, backfill_days: 30 } }',
    '  flow_usd.rev: { type: flow, unit: usd, staleness_days: 45, source: { type: defillama, slug: x, data_type: dailyRevenue } }',
  ].join('\n'),
);

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orion-actions-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  writeFileSync(join(root, 'assets', 'apis.yaml'), API_ASSET_YAML);
  await reconcileFromDisk(db(), root, 'r1', T0); // both arrive inactive
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = (now: Date, by = 'mike') => ({ by, now, releaseTag: 'r1' });

describe('registry actions', () => {
  it('actions: pause needs a reason', async () => {
    await activateAsset(db(), 'mini', opts(T0));
    for (const reason of ['', '   ']) {
      await expect(pauseAsset(db(), 'mini', { ...opts(T0), reason })).rejects.toMatchObject({ code: 'reason_required' });
    }
    expect((await getRegistryRow(db(), 'mini'))!.state).toBe('active');
    expect(await listStateEvents(db(), 'mini', 10)).toHaveLength(2); // arrival + activate only
  });

  it('actions: pause then resume writes two events and ends active', async () => {
    await activateAsset(db(), 'mini', opts(T0));
    const before = (await listStateEvents(db(), 'mini', 10)).length;
    const paused = await pauseAsset(db(), 'mini', { ...opts(at(1), 'mike via raymond'), reason: 'AERO+VELO merger rebuild' });
    expect(paused.from).toBe('active');
    expect(paused.row).toMatchObject({ state: 'paused', stateBy: 'mike via raymond', stateReason: 'AERO+VELO merger rebuild', stateSince: at(1).toISOString() });
    const out = await resumeAsset(db(), 'mini', { ...opts(at(3)), configRoot: root });
    expect(out).toEqual({ state: 'active', pausedDays: 2, backfillDays: null, refillShort: false }); // mini has no API series
    const events = await listStateEvents(db(), 'mini', 10);
    expect(events).toHaveLength(before + 2);
    expect(events.slice(0, 2).map((e) => [e.fromState, e.toState, e.by, e.reason, e.at, e.releaseTag])).toEqual([
      ['paused', 'active', 'mike', null, at(3).toISOString(), 'r1'],
      ['active', 'paused', 'mike via raymond', 'AERO+VELO merger rebuild', at(1).toISOString(), 'r1'],
    ]);
    expect(await getRegistryRow(db(), 'mini')).toMatchObject({ state: 'active', stateSince: at(3).toISOString(), stateBy: 'mike', stateReason: null });
  });

  it('actions: resume restores the state before the pause; only activate makes an asset active (R-c5)', async () => {
    // Paused while inactive (a new asset never activated): resume leaves it inactive.
    await pauseAsset(db(), 'mini', { ...opts(at(1)), reason: 'hold before launch' });
    expect(await getRegistryRow(db(), 'mini')).toMatchObject({ state: 'paused', pausedFrom: 'inactive' });
    expect(await resumeAsset(db(), 'mini', { ...opts(at(2)), configRoot: root })).toEqual({ state: 'inactive', pausedDays: 1, backfillDays: null, refillShort: false });
    expect(await getRegistryRow(db(), 'mini')).toMatchObject({ state: 'inactive', pausedFrom: null, stateSince: at(2).toISOString() });
    expect((await listStateEvents(db(), 'mini', 1)).map((e) => [e.fromState, e.toState])).toEqual([['paused', 'inactive']]);
    // Only activate makes it active; a later pause/resume of the active asset returns it to active.
    await activateAsset(db(), 'mini', opts(at(3)));
    await pauseAsset(db(), 'mini', { ...opts(at(4)), reason: 'rebuild' });
    expect((await getRegistryRow(db(), 'mini'))!.pausedFrom).toBe('active');
    expect((await resumeAsset(db(), 'mini', { ...opts(at(5)), configRoot: root })).state).toBe('active');
    expect(await getRegistryRow(db(), 'mini')).toMatchObject({ state: 'active', pausedFrom: null });
  });

  it('actions: resume after 40 days on an asset with backfill_days 30 reports refillShort', async () => {
    await activateAsset(db(), 'apis', opts(T0));
    await pauseAsset(db(), 'apis', { ...opts(T0), reason: 'source outage' });
    expect(await resumeAsset(db(), 'apis', { ...opts(at(40)), configRoot: root })).toEqual({ state: 'active', pausedDays: 40, backfillDays: 30, refillShort: true });
    await pauseAsset(db(), 'apis', { ...opts(at(40)), reason: 'again' });
    expect(await resumeAsset(db(), 'apis', { ...opts(at(70)), configRoot: root })).toEqual({ state: 'active', pausedDays: 30, backfillDays: 30, refillShort: false });
  });

  it('actions: activate refuses a paused asset with invalid_state_transition', async () => {
    await pauseAsset(db(), 'mini', { ...opts(T0), reason: 'not yet' }); // pause works from inactive too
    await expect(activateAsset(db(), 'mini', opts(T0))).rejects.toMatchObject({
      code: 'invalid_state_transition', message: 'mini is paused; activate needs inactive',
    });
    await expect(pauseAsset(db(), 'mini', { ...opts(T0), reason: 'twice' })).rejects.toMatchObject({
      code: 'invalid_state_transition', message: 'mini is paused; pause needs active or inactive',
    });
    await expect(resumeAsset(db(), 'apis', { ...opts(T0), configRoot: root })).rejects.toMatchObject({
      code: 'invalid_state_transition', message: 'apis is inactive; resume needs paused',
    });
    // A missing asset cannot be activated: its YAML is not in the release.
    rmSync(join(root, 'assets', 'apis.yaml'));
    await reconcileFromDisk(db(), root, 'r2', T0);
    await expect(activateAsset(db(), 'apis', opts(T0))).rejects.toMatchObject({ code: 'invalid_state_transition', message: 'apis is missing; activate needs inactive' });
    await expect(activateAsset(db(), 'nope', opts(T0))).rejects.toMatchObject({ code: 'asset_not_in_registry' });
    expect((await getRegistryRow(db(), 'mini'))!.state).toBe('paused');
  });

  it('actions: seed activates only YAMLs without a row', async () => {
    await db().run("DELETE FROM asset_registry WHERE asset_id = 'apis'");
    const out = await seedRegistry(db(), root, { state: 'active', by: 'mike', reason: 'cutover from SQLite', now: at(1) });
    expect(out).toEqual({ seeded: ['apis'], existing: ['mini'] });
    expect((await listRegistry(db())).map((r) => [r.assetId, r.state])).toEqual([['apis', 'active'], ['mini', 'inactive']]);
    expect((await listStateEvents(db(), 'apis', 10))[0]).toMatchObject({ fromState: null, toState: 'active', by: 'mike', reason: 'cutover from SQLite' });
    await expect(seedRegistry(db(), root, { state: 'active', by: 'mike', reason: ' ', now: at(1) })).rejects.toMatchObject({ code: 'reason_required' });
  });
});
