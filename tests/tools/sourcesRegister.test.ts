import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { adapterNames } from '../../src/ingest/adapters/registry.js';
import { ADAPTER_ENDPOINTS, collectUses, loadAssets, registerIsCurrent, renderRegister, sourceKey, TERMS } from '../../tools/sources-register/generate.js';

const root = resolve(import.meta.dirname, '..', '..');

describe('sources register (docs/ops/sources-register.md)', () => {
  it('the committed register is what the 13 asset YAMLs generate (run npx tsx tools/sources-register/generate.ts)', () => {
    expect(loadAssets(root)).toHaveLength(13);
    expect(registerIsCurrent(root)).toBe(true);
  });

  it('every registered adapter has its endpoints listed, so a new adapter cannot skip the register', () => {
    expect(Object.keys(ADAPTER_ENDPOINTS).sort()).toEqual(adapterNames());
  });

  it('schedule.unlocks_next_year reads no endpoint: the register lists its citation url, and a missing one fails', () => {
    const asset = loadAssets(root)[0]!;
    const url = 'https://blockworks.com/token-transparency/filing/pump';
    expect(ADAPTER_ENDPOINTS['schedule.unlocks_next_year']!({ citation: { url, quote: 'q' }, schedules: [] }, asset)).toEqual([{ kind: 'http', url }]);
    expect(sourceKey(ADAPTER_ENDPOINTS['schedule.unlocks_next_year']!({ citation: { url, quote: 'q' } }, asset)[0]!)).toBe('blockworks.com');
    expect(() => sourceKey(ADAPTER_ENDPOINTS['schedule.unlocks_next_year']!({}, asset)[0]!)).toThrow(/has no URL/);
  });

  it('a new asset reading an unregistered host fails generation, naming the host and the asset', () => {
    const assets = loadAssets(root);
    const uni = structuredClone(assets.find((a) => a.id === 'uni')!);
    uni.id = 'newcoin';
    uni.metrics.price_usd!.cross_checks = [{ source: { type: 'http_json', url: 'https://api.newcoin.example/price', path: 'usd', scale: 1, decimals: 0 } }];
    expect(() => renderRegister([...assets, uni])).toThrow(/api\.newcoin\.example \(read by newcoin\)/);
  });

  it('a register entry no asset reads fails generation (an asset removed, or a source dropped)', () => {
    const assets = loadAssets(root).filter((a) => a.id !== 'pump');
    expect(() => renderRegister(assets)).toThrow(/no asset reads: .*lite-api\.jup\.ag/);
  });

  it('RPC rows name the env var, never a URL; commercial use is known only where the repo quotes the terms', () => {
    const uses = collectUses(loadAssets(root));
    const rpc = [...uses.keys()].filter((k) => k.startsWith('rpc:'));
    expect(rpc.sort()).toEqual(['rpc:eip155:1:ORION_ETH_RPC_URL', 'rpc:eip155:56:ORION_BNB_RPC_URL', 'rpc:eip155:8453:ORION_BASE_RPC_URL', 'rpc:solana:ORION_SOL_RPC_URL']);
    for (const [key, t] of Object.entries(TERMS)) {
      expect(JSON.stringify(t), key).not.toMatch(/https?:\/\//);
      // A date checked only on rows whose terms text is quoted (CoinGecko: roadmap rule 5; DefiLlama: roadmap rule 1).
      if (t.commercial === 'unknown') expect(t.checked, key).toBeUndefined();
      else expect(t.terms, key).toBeDefined();
    }
  });
});
