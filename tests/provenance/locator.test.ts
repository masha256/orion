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
    expect(scrubLocator({ endpoint: 'https://h.test/p?apikey=s3cret', request: { type: 'meta' } })).toEqual({ endpoint: 'https://h.test/p', request: { type: 'meta' } });
    // Not a URL: left alone.
    expect(scrubUrl('totalSupply()')).toBe('totalSupply()');
  });
});

describe('scrubLocator: secrets dropped by context, not by key suffix', () => {
  it('URL query parameters named key, apikey, api_key, token, access_token, secret go (any case); a look-alike name stays', () => {
    for (const k of ['key', 'KEY', 'apikey', 'ApiKey', 'api_key', 'token', 'Token', 'access_token', 'ACCESS_TOKEN', 'secret']) {
      expect(scrubUrl(`https://api.example.test/x?${k}=s3cret&dataType=dailyFees`), k).toBe('https://api.example.test/x?dataType=dailyFees');
    }
    // Not a credential by name: kept.
    expect(scrubUrl('https://api.example.test/x?market_key=2049&token_id=7&kind=maker_fee')).toBe('https://api.example.test/x?market_key=2049&token_id=7&kind=maker_fee');
  });

  it('a contract address in a URL path is kept; a keyed RPC path segment is not', () => {
    const address = '0x0d0105d2b5d0cd2f1f3e3e2b5bd6e1c5f6a3c9d1';
    expect(scrubUrl(`https://api.example.test/v1/token/${address}`)).toBe(`https://api.example.test/v1/token/${address}`);
    expect(scrubUrl(`https://coins.llama.fi/prices/current/ethereum:${address}`)).toBe(`https://coins.llama.fi/prices/current/ethereum:${address}`);
    expect(scrubUrl(ALCHEMY)).toBe('https://eth-mainnet.g.alchemy.com/v2');
  });

  it('object keys authorization, password, secret, api_key, apikey go, and every key inside headers/auth; a plain token field (a symbol) stays', () => {
    const scrubbed = scrubLocator({
      adapter: 'hype.reserve_yield_payments',
      params: { token: 'USDC', senders: { token: '0x0d0105d2b5d0cd2f1f3e3e2b5bd6e1c5f6a3c9d1' }, api_key: 's3cret' },
      Authorization: 'Bearer s3cret', password: 's3cret', secret: 's3cret', apikey: 's3cret',
      headers: { 'x-cg-pro-api-key': 's3cret', accept: 'application/json' },
      auth: { user: 'u', pass: 's3cret' },
      request: { access_key: 'kept-by-name' },
    });
    expect(scrubbed).toEqual({
      adapter: 'hype.reserve_yield_payments',
      params: { token: 'USDC', senders: { token: '0x0d0105d2b5d0cd2f1f3e3e2b5bd6e1c5f6a3c9d1' } },
      headers: {}, auth: {},
      request: { access_key: 'kept-by-name' },
    });
    expect(JSON.stringify(scrubbed)).not.toContain('s3cret');
  });

  it('HYPE flow_usd.reserve_yield keeps params.token: "USDC" in its locator', () => {
    const hype = loadAsset(ROOT, 'hype');
    const p = fetchedProvenance(hype, 'flow_usd.reserve_yield');
    expect((p.locator.params as Record<string, unknown>).token).toBe('USDC');
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
