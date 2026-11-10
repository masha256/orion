import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPublishTarget as daemonCheckPublishTarget } from '../../src/daemon/daemon.js';
import { insertSnapshot, latestPushed, markPushed, pendingSnapshots, type OutboxRow } from '../../src/db/snapshotsOut.js';
import { buildEnvelope, buildFileSet, SNAPSHOT_SCHEMA, type SnapshotEnvelope } from '../../src/push/envelope.js';
import { checkPublishTarget, parsePublishTarget, publisherFromEnv } from '../../src/push/publisher.js';
import { signManifest, verifyManifest } from '../../src/push/sign.js';
import { canonicalJson, sha256 } from '../../src/util/canonical.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();

const keys = generateKeyPairSync('ed25519');
const PRIVATE_PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PUBLIC_B64 = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const NOW = new Date('2026-11-03T01:15:00.000Z');
const opts = { seq: 0, env: 'stage' as const, releaseTag: 'orion-2026.11.03.1', now: NOW };
const hex = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

describe('envelope', () => {
  it('envelope: sha256 is of the canonical body; seq increases per kind', async () => {
    const body = { b: 2, a: { z: [3, { y: 1, x: 2 }], k: null } };
    const e = buildEnvelope('levels', body, { ...opts, uuid: () => '00000000-0000-4000-8000-000000000001' });
    expect(e).toEqual({
      schema: SNAPSHOT_SCHEMA, kind: 'levels', snapshot_id: '00000000-0000-4000-8000-000000000001', seq: 0,
      generated_at: NOW.toISOString(), env: 'stage', release_tag: 'orion-2026.11.03.1', sha256: sha256(canonicalJson(body)), body,
    });
    expect(SNAPSHOT_SCHEMA).toBe('orion.snapshot/2'); // Task 11b: the full body's report lost the v1 keys
    // The same body with its keys in another order hashes the same.
    expect(buildEnvelope('levels', { a: { k: null, z: [3, { x: 2, y: 1 }] }, b: 2 }, opts).sha256).toBe(e.sha256);
    expect(buildEnvelope('levels', body, opts).snapshot_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const rows: OutboxRow[] = [];
    rows.push(await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { n: 1 }, opts) }));
    rows.push(await insertSnapshot(db(), { kind: 'full', day: '2026-11-02', envelope: buildEnvelope('full', { n: 2 }, opts) }));
    rows.push(await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { n: 3 }, opts) }));
    rows.push(await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { n: 4 }, opts) }));
    expect(rows.map((r) => [r.kind, r.seq])).toEqual([['levels', 1], ['full', 1], ['levels', 2], ['levels', 3]]);
    // The stored body is the canonical envelope with the outbox's seq in it.
    const stored = JSON.parse(rows[3].body) as SnapshotEnvelope;
    expect(rows[3].body).toBe(canonicalJson(stored));
    expect(stored).toMatchObject({ seq: 3, kind: 'levels', body: { n: 4 }, sha256: sha256(canonicalJson({ n: 4 })) });
    expect(rows[3]).toMatchObject({ snapshotId: stored.snapshot_id, sha256: stored.sha256, day: null, createdAt: NOW.toISOString(), pushedAt: null, attempts: 0, lastError: null, alertedAt: null });
    expect(rows[1].day).toBe('2026-11-02');

    expect((await pendingSnapshots(db())).map((r) => r.id)).toEqual([1, 2, 3, 4]);
    await markPushed(db(), [1, 3], NOW.toISOString());
    expect((await pendingSnapshots(db())).map((r) => r.id)).toEqual([2, 4]);
    expect((await latestPushed(db(), 'levels'))?.seq).toBe(2);
    expect(await latestPushed(db(), 'full')).toBeNull();
  });

  it('envelope: concurrent inserts get distinct seqs', async () => {
    const all = await Promise.all([1, 2, 3, 4].map(async (n) => await insertSnapshot(db(), { kind: 'full', day: '2026-11-02', envelope: buildEnvelope('full', { n }, opts) })));
    expect(all.map((r) => r.seq).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('files', () => {
  async function rows(): Promise<{ full: OutboxRow; levels: OutboxRow }> {
    const full = await insertSnapshot(db(), { kind: 'full', day: '2026-11-02', envelope: buildEnvelope('full', { day: '2026-11-02', assets: {} }, opts) });
    const levels = await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { assets: {} }, opts) });
    return { full, levels };
  }

  it('files: exactly the six paths; manifest hashes match file bytes; the signature verifies with the public key and fails on one changed byte', async () => {
    const { full, levels } = await rows();
    const assets = { mini: { state: 'active', since: '2026-09-01T00:00:00.000Z', reason: null } };
    const files = buildFileSet({ full, levels, assets, env: 'stage', releaseTag: 'orion-2026.11.03.1', now: NOW }, PRIVATE_PEM);
    expect(Object.keys(files).sort()).toEqual([
      'assets.json', 'full/2026/2026-11-02.json', 'full/latest.json', 'levels/latest.json', 'manifest.json', 'manifest.json.sig',
    ]);
    for (const [path, text] of Object.entries(files)) {
      if (path === 'manifest.json.sig') continue;
      expect(text.endsWith('\n')).toBe(true);
      expect(text).toBe(`${canonicalJson(JSON.parse(text))}\n`);
    }
    expect(files['full/latest.json']).toBe(files['full/2026/2026-11-02.json']);
    expect(JSON.parse(files['full/latest.json'])).toEqual(JSON.parse(full.body));
    expect(JSON.parse(files['levels/latest.json'])).toEqual(JSON.parse(levels.body));
    expect(JSON.parse(files['assets.json'])).toEqual(assets);

    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest).toEqual({
      schema: 'orion.snapshot/2', env: 'stage', release_tag: 'orion-2026.11.03.1', generated_at: NOW.toISOString(),
      full: { seq: 1, day: '2026-11-02', path: 'full/2026/2026-11-02.json', sha256: hex(files['full/2026/2026-11-02.json']) },
      levels: { seq: 1, generated_at: NOW.toISOString(), path: 'levels/latest.json', sha256: hex(files['levels/latest.json']) },
      assets: { path: 'assets.json', sha256: hex(files['assets.json']) },
    });

    const sig = files['manifest.json.sig'];
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const bytes = Buffer.from(files['manifest.json']);
    expect(verifyManifest(bytes, sig, PUBLIC_PEM)).toBe(true);
    expect(verifyManifest(bytes, sig, PUBLIC_B64)).toBe(true); // the site may hold the bare SPKI base64
    const changed = Buffer.from(bytes);
    changed[10] ^= 1;
    expect(verifyManifest(changed, sig, PUBLIC_PEM)).toBe(false);
    expect(verifyManifest(bytes, `${sig.slice(0, -4)}AAA=`, PUBLIC_PEM)).toBe(false);
    expect(verifyManifest(bytes, 'not base64 at all', PUBLIC_PEM)).toBe(false);
    expect(signManifest(bytes, PRIVATE_PEM)).toBe(sig); // Ed25519 is deterministic
  });

  it('files: a row the previous release queued (orion.snapshot/1) publishes as written; an unknown schema is refused', async () => {
    // Task 11b bumped the schema: an outbox row written before the upgrade must not wedge the publisher.
    const old = { ...buildEnvelope('full', { day: '2026-11-02', assets: {} }, opts), schema: 'orion.snapshot/1' };
    const full = await insertSnapshot(db(), { kind: 'full', day: '2026-11-02', envelope: old as SnapshotEnvelope });
    const levels = await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { assets: {} }, opts) });
    const files = buildFileSet({ full, levels, assets: {}, env: 'stage', releaseTag: 'orion-2026.11.03.1', now: NOW }, PRIVATE_PEM);
    expect(JSON.parse(files['full/latest.json']).schema).toBe('orion.snapshot/1');
    expect(JSON.parse(files['levels/latest.json']).schema).toBe('orion.snapshot/2');
    const bad = await insertSnapshot(db(), { kind: 'full', day: '2026-11-03', envelope: { ...old, schema: 'orion.snapshot/9' } as SnapshotEnvelope });
    expect(() => buildFileSet({ full: bad, levels, assets: {}, env: 'stage', releaseTag: null, now: NOW }, PRIVATE_PEM)).toThrow(expect.objectContaining({ code: 'snapshot_corrupt' }));
  });

  it('files: with no full snapshot yet the manifest says full null and no full files are written', async () => {
    const levels = await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', { assets: {} }, opts) });
    const files = buildFileSet({ full: null, levels, assets: {}, env: 'dev', releaseTag: null, now: NOW }, PRIVATE_PEM);
    expect(Object.keys(files).sort()).toEqual(['assets.json', 'levels/latest.json', 'manifest.json', 'manifest.json.sig']);
    expect(JSON.parse(files['manifest.json'])).toMatchObject({ full: null, release_tag: null, env: 'dev' });
  });
});

describe('publisher', () => {
  it('publisher: s3 target is refused with publish_driver_not_built', () => {
    const paths = { home: '/tmp/x', configRoot: '/tmp/x', envFile: '/tmp/x/.env', release: null };
    const run = async () => ({ code: 0, stdout: '', stderr: '' });
    expect(parsePublishTarget('s3:https://nyc3.digitaloceanspaces.com/orion-data')).toEqual({ driver: 's3' });
    expect(() => publisherFromEnv({ ORION_PUBLISH: 's3:https://x/b' }, paths, run)).toThrow(expect.objectContaining({ code: 'publish_driver_not_built' }));
    expect(() => checkPublishTarget('prod', 's3:https://x/b')).toThrow(expect.objectContaining({ code: 'publish_driver_not_built' }));
    expect(publisherFromEnv({}, paths, run)).toBeNull();
    expect(publisherFromEnv({ ORION_PUBLISH: '  ' }, paths, run)).toBeNull();
    expect(publisherFromEnv({ ORION_PUBLISH: 'git:file:///tmp/r.git' }, paths, run)).not.toBeNull();
  });

  it('publisher: git targets parse with main as the default branch; anything else is invalid_publish_target', () => {
    expect(parsePublishTarget(undefined)).toBeNull();
    expect(parsePublishTarget('')).toBeNull();
    expect(parsePublishTarget('git:git@github.com:masha256/orion-data.git#main')).toEqual({ driver: 'git', url: 'git@github.com:masha256/orion-data.git', branch: 'main' });
    expect(parsePublishTarget('git:file:///tmp/a.git')).toEqual({ driver: 'git', url: 'file:///tmp/a.git', branch: 'main' });
    expect(parsePublishTarget('git:file:///tmp/a.git#data/v1')).toEqual({ driver: 'git', url: 'file:///tmp/a.git', branch: 'data/v1' });
    for (const bad of ['http://x', 'git:', 'git:#main', 'git:-oProxyCommand=x', 'git:file:///a#', 'git:file:///a#-f', 'git:file:///a#a..b', 'git:file:///a#a b', 'gitfile:///a']) {
      expect(() => parsePublishTarget(bad), bad).toThrow(expect.objectContaining({ code: 'invalid_publish_target' }));
    }
  });

  it('publisher: staging never publishes to the prod repo and prod never to the staging repo', () => {
    expect(daemonCheckPublishTarget).toBe(checkPublishTarget);
    const prodRepo = 'git:git@github.com:masha256/orion-data.git#main';
    const stageRepo = 'git:git@github.com:masha256/orion-data-staging.git#main';
    expect(() => checkPublishTarget('stage', prodRepo)).toThrow(expect.objectContaining({ code: 'publish_repo_is_prod' }));
    expect(() => checkPublishTarget('stage', 'git:ssh://git@github.com/masha256/orion-data#main')).toThrow(expect.objectContaining({ code: 'publish_repo_is_prod' }));
    expect(() => checkPublishTarget('prod', stageRepo)).toThrow(expect.objectContaining({ code: 'publish_repo_is_stage' }));
    expect(() => checkPublishTarget('prod', 'git:https://github.com/masha256/orion-data-staging')).toThrow(expect.objectContaining({ code: 'publish_repo_is_stage' }));
    // M-5: GitHub repo names ignore case
    expect(() => checkPublishTarget('stage', 'git:git@github.com:masha256/Orion-Data.git#main')).toThrow(expect.objectContaining({ code: 'publish_repo_is_prod' }));
    expect(() => checkPublishTarget('prod', 'git:git@github.com:Masha256/ORION-DATA-STAGING#main')).toThrow(expect.objectContaining({ code: 'publish_repo_is_stage' }));
    // I-2: off is publishing off on purpose
    expect(parsePublishTarget('off')).toBeNull();
    expect(() => checkPublishTarget('prod', 'off')).not.toThrow();
    expect(() => checkPublishTarget('stage', stageRepo)).not.toThrow();
    expect(() => checkPublishTarget('prod', prodRepo)).not.toThrow();
    expect(() => checkPublishTarget('stage', undefined)).not.toThrow();
    expect(() => checkPublishTarget('dev', 'git:file:///tmp/soak-data.git#main')).not.toThrow();
    expect(() => checkPublishTarget('dev', 'nonsense')).toThrow(expect.objectContaining({ code: 'invalid_publish_target' }));
  });
});
