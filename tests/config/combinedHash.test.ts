import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveProposal } from '../../src/app/proposals.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { getProvenanceByIds, listActiveObservations } from '../../src/db/observations.js';
import { insertProposal } from '../../src/db/proposals.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { PRICED_INGEST_ASSET_YAML as INGEST_ASSET_YAML, TOKEN } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

// Ruling R10: every stored asset hash is the combined one (config + entriesFor). A config home whose prices.yaml prices
// the mini asset's token (matched by its contract address, not its symbol).
const PRICES_YAML = `"eip155:8453/${TOKEN}":
  symbol: MINI
  decimals: 18
  chain: "eip155:8453"
  valid_from: "2025-10-13"
  primary: { kind: chainlink, feed: "0x5555555555555555555555555555555555555555" }
  check: { kind: chainlink, feed: "0x6666666666666666666666666666666666666666", tolerance_pct: 2 }
`;

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orion-combined-hash-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'mini.yaml'), INGEST_ASSET_YAML.trimStart());
  writeFileSync(join(dir, 'prices.yaml'), PRICES_YAML);
  return dir;
}

describe('the combined config hash on every stored path (Ruling R10)', () => {
  it('a fetch and an approved observation proposal store the same combined hash for an asset with price entries', async () => {
    const root = home();
    const loaded = loadAsset(root, 'mini');
    // The asset has a price entry, so its hash is not the config-only one.
    expect(loaded.hash).not.toBe(parseAssetYaml(INGEST_ASSET_YAML).hash);

    // The fetch path: provenance carries loaded.hash.
    const h = harness(testDb(), { loaded });
    await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const fetched = await listActiveObservations(h.db, 'mini', 'circulating_supply');
    expect(fetched.length).toBeGreaterThan(0);
    const [fetchedProv] = await getProvenanceByIds(h.db, [fetched.at(-1)!.id]);

    // The approve path: an observation proposal approved against the same config root.
    const p = await insertProposal(h.db, {
      assetId: 'mini', persona: 'analyst', agentRunId: null,
      change: {
        kind: 'observation', metricKey: 'revenue_run_rate_usd', value: 2000, observedAt: '2026-09-15T00:00:00.000Z', periodDays: null,
        citationUrl: 'https://news.example.com/big', quotedText: 'reports annualized revenue of $2,000',
      },
      filedAgainst: { inForce: null }, rationale: 'r', evidence: [], effect: null, createdAt: '2026-09-15T00:00:00.000Z',
    });
    const { result } = await approveProposal(h.db, root, p.id, { now: NOW });
    const [approvedProv] = await getProvenanceByIds(h.db, [(result as { observationId: number }).observationId]);

    expect(fetchedProv!.configHash).toBe(loaded.hash);
    expect(approvedProv!.configHash).toBe(loaded.hash);
  });

  it('approving a config proposal validates with the home\'s prices: the reloaded hash is the combined one', async () => {
    const root = home();
    const before = loadAsset(root, 'mini').hash;
    const db = testDb();
    const p = await insertProposal(db, {
      assetId: 'mini', persona: 'analyst', agentRunId: null,
      change: { kind: 'config', edits: [{ path: ['name'], value: 'Mini Renamed' }] },
      filedAgainst: ['Mini Ingest Asset'], rationale: 'r', evidence: [], effect: null, createdAt: '2026-09-15T00:00:00.000Z',
    });
    await approveProposal(db, root, p.id, { now: NOW });
    const after = loadAsset(root, 'mini');
    expect(after.config.name).toBe('Mini Renamed');
    expect(after.hash).not.toBe(before);
    expect(after.hash).not.toBe(parseAssetYaml(INGEST_ASSET_YAML.replace('Mini Ingest Asset', 'Mini Renamed')).hash);
  });
});
