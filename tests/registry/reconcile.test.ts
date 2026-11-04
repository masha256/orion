import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRegistryRow, listRegistry, listStateEvents, recordRun } from '../../src/db/registry.js';
import { applyReconcile, planReconcile, reconcileFromDisk } from '../../src/registry/reconcile.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = new Date('2026-11-03T00:00:00.000Z');
const T1 = new Date('2026-11-04T00:00:00.000Z');

/** A config root holding `ids`, each the mini asset under its own id (`variant` changes its config, so its hash). */
function configRoot(ids: string[], variant: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'orion-registry-'));
  dirs.push(root);
  mkdirSync(join(root, 'assets'));
  for (const id of ids) writeAsset(root, id, variant[id]);
  return root;
}

function writeAsset(root: string, id: string, name = 'Mini Test Asset'): void {
  writeFileSync(join(root, 'assets', `${id}.yaml`), MINI_ASSET_YAML.replace('id: mini', `id: ${id}`).replace('name: Mini Test Asset', `name: ${name}`));
}

async function eventCount(): Promise<number> {
  return (await db().one<{ n: number }>('SELECT count(*)::int AS n FROM asset_state_events'))!.n;
}

describe('registry reconcile', () => {
  it('reconcile: a YAML with no row arrives inactive', async () => {
    const root = configRoot(['aero', 'cake']);
    const diff = await reconcileFromDisk(db(), root, 'orion-2026.11.03.1', T0);
    expect(diff).toEqual({ added: ['aero', 'cake'], missing: [], returned: [], configChanged: [] });
    const rows = await listRegistry(db());
    expect(rows.map((r) => [r.assetId, r.state, r.stateBy, r.stateReason, r.firstSeenRelease, r.stateSince])).toEqual([
      ['aero', 'inactive', 'release', 'new in release orion-2026.11.03.1', 'orion-2026.11.03.1', T0.toISOString()],
      ['cake', 'inactive', 'release', 'new in release orion-2026.11.03.1', 'orion-2026.11.03.1', T0.toISOString()],
    ]);
    expect(rows[0]!.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await listStateEvents(db(), 'aero', 10)).toEqual([
      { id: 1, assetId: 'aero', fromState: null, toState: 'inactive', at: T0.toISOString(), by: 'release', reason: 'new in release orion-2026.11.03.1', releaseTag: 'orion-2026.11.03.1' },
    ]);
    // Never active: nothing arrives running.
    expect(rows.some((r) => r.state === 'active')).toBe(false);
  });

  it('reconcile: a row whose YAML is gone becomes missing, history kept', async () => {
    const root = configRoot(['aero', 'cake']);
    await reconcileFromDisk(db(), root, 'r1', T0);
    await db().run("UPDATE asset_registry SET state = 'active' WHERE asset_id = 'cake'");
    await recordRun(db(), 'cake', 7, '2026-11-03T00:50:00.000Z', 'done');
    rmSync(join(root, 'assets', 'cake.yaml'));
    const diff = await reconcileFromDisk(db(), root, 'r2', T1);
    expect(diff).toEqual({ added: [], missing: ['cake'], returned: [], configChanged: [] });
    const cake = await getRegistryRow(db(), 'cake');
    expect(cake).toMatchObject({
      state: 'missing', stateBy: 'release', stateReason: 'YAML not in release r2', stateSince: T1.toISOString(),
      lastJobId: 7, lastRunAt: '2026-11-03T00:50:00.000Z', lastOutcome: 'done', firstSeenRelease: 'r1',
    });
    expect((await listStateEvents(db(), 'cake', 10)).map((e) => [e.fromState, e.toState, e.releaseTag])).toEqual([['active', 'missing', 'r2'], [null, 'inactive', 'r1']]);
    // A missing row stays missing on the next reconcile; it is not listed again.
    expect(await reconcileFromDisk(db(), root, 'r3', T1)).toEqual({ added: [], missing: [], returned: [], configChanged: [] });
  });

  it('reconcile: a returning YAML comes back inactive', async () => {
    const root = configRoot(['aero']);
    await reconcileFromDisk(db(), root, 'r1', T0);
    await db().run("UPDATE asset_registry SET state = 'active'");
    rmSync(join(root, 'assets', 'aero.yaml'));
    await reconcileFromDisk(db(), root, 'r2', T0, { allowRetire: true }); // the only asset: retiring it needs the override
    writeAsset(root, 'aero');
    const diff = await reconcileFromDisk(db(), root, null, T1);
    expect(diff).toEqual({ added: [], missing: [], returned: ['aero'], configChanged: [] });
    expect(await getRegistryRow(db(), 'aero')).toMatchObject({ state: 'inactive', stateBy: 'release', stateReason: 'back in release (dev checkout)', firstSeenRelease: 'r1' });
    expect((await listStateEvents(db(), 'aero', 1))[0]).toMatchObject({ fromState: 'missing', toState: 'inactive', releaseTag: null });
  });

  it('reconcile: a hash change is listed as configChanged and stored', async () => {
    const root = configRoot(['aero', 'cake']);
    await reconcileFromDisk(db(), root, 'r1', T0);
    await db().run("UPDATE asset_registry SET state = 'active' WHERE asset_id = 'aero'");
    const before = (await getRegistryRow(db(), 'aero'))!;
    const events = await eventCount();
    writeAsset(root, 'aero', 'Aerodrome renamed');
    const diff = await reconcileFromDisk(db(), root, 'r2', T1);
    expect(diff).toEqual({ added: [], missing: [], returned: [], configChanged: ['aero'] });
    const after = (await getRegistryRow(db(), 'aero'))!;
    expect(after.configHash).not.toBe(before.configHash);
    // Only the hash moves: the state, since, by and reason stay, and no event is written (not a state change).
    expect({ ...after, configHash: before.configHash }).toEqual(before);
    expect(await eventCount()).toBe(events);
  });

  it('reconcile: running it twice changes nothing the second time', async () => {
    const root = configRoot(['aero', 'cake', 'crv']);
    await reconcileFromDisk(db(), root, 'r1', T0);
    rmSync(join(root, 'assets', 'crv.yaml'));
    writeAsset(root, 'cake', 'changed');
    writeAsset(root, 'link');
    expect(await reconcileFromDisk(db(), root, 'r2', T1)).toEqual({ added: ['link'], missing: ['crv'], returned: [], configChanged: ['cake'] });
    const rows = await listRegistry(db());
    const events = await eventCount();
    expect(await reconcileFromDisk(db(), root, 'r2', T1)).toEqual({ added: [], missing: [], returned: [], configChanged: [] });
    expect(await listRegistry(db())).toEqual(rows);
    expect(await eventCount()).toBe(events);
  });

  it('reconcile: refuses to retire every asset, or more than 2 at once, writing nothing, unless allowRetire (I-3)', async () => {
    // An empty assets/ (or none at all) against live rows: every asset would go missing.
    const root = configRoot(['aero', 'cake', 'crv', 'link']);
    await reconcileFromDisk(db(), root, 'r1', T0);
    const rows = await listRegistry(db());
    const events = await eventCount();
    const empty = configRoot([]);
    await expect(reconcileFromDisk(db(), empty, 'r2', T1)).rejects.toMatchObject({
      code: 'reconcile_would_retire', message: 'release r2 would retire every asset (aero, cake, crv, link); refused (orion daemon --allow-retire to accept)',
    });
    rmSync(join(empty, 'assets'), { recursive: true });
    await expect(reconcileFromDisk(db(), empty, 'r2', T1)).rejects.toMatchObject({ code: 'reconcile_would_retire' });
    // Three at once (one YAML left) is refused too, and a new YAML in the same release is not added either.
    for (const id of ['cake', 'crv', 'link']) rmSync(join(root, 'assets', `${id}.yaml`));
    writeAsset(root, 'new');
    await expect(reconcileFromDisk(db(), root, 'r2', T1)).rejects.toMatchObject({
      code: 'reconcile_would_retire', message: 'release r2 would retire 3 assets at once (cake, crv, link); refused (orion daemon --allow-retire to accept)',
    });
    expect(await listRegistry(db())).toEqual(rows);
    expect(await eventCount()).toBe(events);
    // With allowRetire it goes through.
    expect(await reconcileFromDisk(db(), root, 'r2', T1, { allowRetire: true })).toEqual({ added: ['new'], missing: ['cake', 'crv', 'link'], returned: [], configChanged: [] });
  });

  it('reconcile: two assets retired at once, or the last of several already missing, are not refused (I-3)', async () => {
    const root = configRoot(['aero', 'cake', 'crv']);
    await reconcileFromDisk(db(), root, 'r1', T0);
    rmSync(join(root, 'assets', 'cake.yaml'));
    rmSync(join(root, 'assets', 'crv.yaml'));
    expect((await reconcileFromDisk(db(), root, 'r2', T1)).missing).toEqual(['cake', 'crv']);
    // The only non-missing row going is "every asset": refused.
    rmSync(join(root, 'assets', 'aero.yaml'));
    await expect(reconcileFromDisk(db(), root, 'r3', T1)).rejects.toMatchObject({ code: 'reconcile_would_retire' });
    // An empty registry and an empty assets/: nothing to retire, nothing refused.
    await db().run('TRUNCATE asset_registry, asset_state_events');
    expect(await reconcileFromDisk(db(), configRoot([]), 'r4', T1)).toEqual({ added: [], missing: [], returned: [], configChanged: [] });
  });

  it('reconcile: an invalid YAML throws invalid_asset_config before anything is written', async () => {
    const root = configRoot(['aero']);
    writeFileSync(join(root, 'assets', 'bad.yaml'), 'id: bad\nsymbol: BAD\n');
    await expect(reconcileFromDisk(db(), root, 'r1', T0)).rejects.toMatchObject({ code: 'invalid_asset_config', message: expect.stringMatching(/^bad: /) });
    expect(await listRegistry(db())).toEqual([]);
    expect(await eventCount()).toBe(0);
  });

  it('reconcile: planReconcile is pure and sorted; a paused asset whose YAML returns unchanged is not touched', async () => {
    const row = (assetId: string, state: 'inactive' | 'active' | 'paused' | 'missing', configHash: string) => ({
      assetId, state, configHash, stateSince: T0.toISOString(), stateBy: 'x', stateReason: null, pausedFrom: state === 'paused' ? 'active' as const : null, firstSeenRelease: null, lastJobId: null, lastRunAt: null, lastOutcome: null,
    });
    const rows = [row('b', 'paused', 'h1'), row('a', 'missing', 'h0'), row('c', 'active', 'h2'), row('d', 'missing', 'h3')];
    const yamls = [{ id: 'z', hash: 'hz' }, { id: 'b', hash: 'h1' }, { id: 'a', hash: 'h0x' }, { id: 'e', hash: 'he' }];
    const frozen = JSON.stringify({ rows, yamls });
    // a: missing and back with a new hash: returned and changed. c: gone. d: already missing. b: as it was.
    expect(planReconcile(rows, yamls)).toEqual({ added: ['e', 'z'], missing: ['c'], returned: ['a'], configChanged: ['a'] });
    expect(JSON.stringify({ rows, yamls })).toBe(frozen);
    // applyReconcile writes exactly the diff it is given.
    await applyReconcile(db(), { added: ['e'], missing: [], returned: [], configChanged: [] }, [{ id: 'e', hash: 'he' }], 'r9', T0);
    expect((await listRegistry(db())).map((r) => [r.assetId, r.state, r.configHash])).toEqual([['e', 'inactive', 'he']]);
  });
});
