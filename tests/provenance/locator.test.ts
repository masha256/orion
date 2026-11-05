import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, listAssetIds } from '../../src/config/load.js';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { chainOfSource, disclosedProvenance, fetchedProvenance, locatorOfSource, scrubLocator, scrubUrl } from '../../src/provenance/locator.js';
import { codeVersion, MAX_TX_REFS, txRefsProvenance } from '../../src/provenance/types.js';
import { ADAPTER_SOURCE_TYPES } from '../../src/report/sourceTypes.js';
import { sha256 } from '../../src/util/canonical.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The fake keyed Alchemy URL of tests/ingest/rpc.test.ts (Review Focus 4: the fixture), read from that file. */
const ALCHEMY = /https:\/\/eth-mainnet\.g\.alchemy\.com\/v2\/\w+/.exec(readFileSync(fileURLToPath(new URL('../ingest/rpc.test.ts', import.meta.url)), 'utf8'))![0];
const KEY = ALCHEMY.split('/').at(-1)!;

describe('scrubLocator', () => {
  it('locator: a keyed Alchemy URL (the fake-key fixture of tests/ingest/rpc.test.ts) never reaches the row', () => {
    expect(KEY).toMatch(/SECRET/);
    const scrubbed = scrubLocator({ endpoint: ALCHEMY, nested: { rpc: [ALCHEMY], note: `see ${ALCHEMY}` }, api_key: KEY });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.endpoint).toBe('https://eth-mainnet.g.alchemy.com/v2');
    expect(scrubbed.api_key).toBeUndefined();
    // Infura /v3/<key>, a drpc / publicnode keyed path, user info: the key goes, the host stays.
    expect(scrubUrl('https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef')).toBe('https://mainnet.infura.io/v3');
    expect(scrubUrl('https://lb.drpc.org/ethereum/AbCdEf123')).toBe('https://lb.drpc.org/');
    expect(scrubUrl('https://ethereum-rpc.publicnode.com/0xabc123def')).toBe('https://ethereum-rpc.publicnode.com/');
    expect(scrubUrl('https://user:pw@rpc.example.test/a')).toBe('https://rpc.example.test/a');
    expect(scrubUrl('https://rpc.example.test/x/abcdefghij0123456789xyz/y')).toBe('https://rpc.example.test/x/y'); // key-like segment anywhere
  });

  it('locator: ?apikey= and ?token= are stripped', () => {
    expect(scrubUrl('https://api.example.test/v1/stats?apikey=s3cret&market=2049')).toBe('https://api.example.test/v1/stats?market=2049');
    expect(scrubUrl('https://api.example.test/x?token=s3cret')).toBe('https://api.example.test/x');
    for (const k of ['key', 'api_key', 'api-key', 'API_KEY', 'access_token', 'dkey']) {
      expect(scrubUrl(`https://api.example.test/x?${k}=s3cret&dataType=dailyFees`), k).toBe('https://api.example.test/x?dataType=dailyFees');
    }
    expect(scrubLocator({ endpoint: 'https://h.test/p?apikey=s3cret', request: { token: 's3cret', type: 'meta' } })).toEqual({ endpoint: 'https://h.test/p', request: { type: 'meta' } });
    // Not a URL: left alone.
    expect(scrubUrl('totalSupply()')).toBe('totalSupply()');
  });
});

describe('provenance builders', () => {
  it('tx refs: capped at 50, the digest over the full sorted list', () => {
    const refs = Array.from({ length: 60 }, (_, i) => `0xtx${String(59 - i).padStart(2, '0')}:${i}`);
    const p = txRefsProvenance(refs);
    expect(p.txCount).toBe(60);
    expect(p.txRefs).toHaveLength(MAX_TX_REFS);
    expect(p.txRefs).toEqual([...refs].sort().slice(0, 50));
    expect(p.txDigest).toBe(sha256(JSON.stringify([...refs].sort())));
    expect(txRefsProvenance([])).toEqual({ txCount: 0, txRefs: null, txDigest: null });
  });

  it('codeVersion is dev in a checkout (no RELEASE)', () => {
    expect(codeVersion()).toBe('dev');
  });

  it('disclosure: method disclosed, rung disclosure, citation required', () => {
    expect(disclosedProvenance('h', { citationUrl: 'https://venice.ai/post', approvedBy: 'user', approvedAt: '2026-11-01T00:00:00.000Z' })).toEqual({
      method: 'disclosed', sourceType: 'disclosure', chain: null,
      locator: { citation_url: 'https://venice.ai/post', approved_by: 'user', approved_at: '2026-11-01T00:00:00.000Z' }, codeVersion: 'dev', configHash: 'h',
    });
    expect(() => disclosedProvenance('h', { citationUrl: null, approvedBy: null, approvedAt: null })).toThrow(expect.objectContaining({ code: 'citation_required' }));
  });

  it('every live asset metric with a source maps to a rung, a method and a scrubbed locator; every adapter has a rung', () => {
    for (const name of adapterNames()) {
      expect(ADAPTER_SOURCE_TYPES[name], name).toBeDefined();
      // chainOfSource reads the rung, not the registry: an RPC adapter is exactly an EVM contract-state one.
      const chain = chainOfSource(loadAsset(ROOT, 'crv').config, { type: 'adapter', name, params: {} });
      expect(chain === 'eip155:1', name).toBe(getAdapter(name).needsRpc);
    }
    const ids = listAssetIds(ROOT);
    expect(ids.length).toBeGreaterThanOrEqual(13);
    for (const id of ids) {
      const loaded = loadAsset(ROOT, id);
      for (const [key, def] of Object.entries(loaded.config.metrics)) {
        if (def.source === undefined) continue;
        const p = fetchedProvenance(loaded, key);
        expect(p.configHash).toBe(loaded.hash);
        expect(JSON.stringify(p.locator)).toBe(JSON.stringify(scrubLocator(p.locator)));
        if (def.source.type === 'transfer_flow') expect([p.method, p.sourceType, p.chain], `${id}.${key}`).toEqual(['measured', 'log_scan', `eip155:${loaded.config.ingest!.chain_id}`]);
        if (def.source.type === 'constant') expect([p.method, p.sourceType], `${id}.${key}`).toEqual(['disclosed', 'constant']);
        if (def.source.type === 'derived') expect(p.method, `${id}.${key}`).toBe('derived');
      }
    }
  });

  it('locator shapes: contract read, transfer scan senders, market data, chain of the PUMP and HYPE adapters', () => {
    const crv = loadAsset(ROOT, 'crv').config;
    const flowKey = Object.keys(crv.metrics).find((k) => crv.metrics[k].source?.type === 'transfer_flow')!;
    const loc = locatorOfSource(crv, flowKey, crv.metrics[flowKey].source!);
    expect(loc).toMatchObject({ event: 'Transfer(address,address,uint256)', contracts: [expect.stringMatching(/^0x/)], topics: { to: expect.stringMatching(/^0x/) } });
    expect(Object.values(loc.senders as Record<string, string>).every((a) => /^0x/i.test(a))).toBe(true);
    const price = locatorOfSource(crv, 'price_usd', crv.metrics.price_usd.source!);
    expect(price).toMatchObject({ provider: 'coingecko', endpoint: '/coins/markets', field: 'price' });
    const pump = loadAsset(ROOT, 'pump').config;
    expect(chainOfSource(pump, pump.metrics.total_supply.source!)).toBe('solana:mainnet');
    const hype = loadAsset(ROOT, 'hype').config;
    expect(chainOfSource(hype, hype.metrics.total_supply.source!)).toBe('hyperliquid:core');
  });
});
