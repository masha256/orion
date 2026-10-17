import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import type { SourceOf } from '../../src/config/sources.js';
import { sourceId } from '../../src/ingest/sourceId.js';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import type { ReadingResult } from '../../src/ingest/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { NOW_ISO, req, sourceCtx } from '../helpers/sourceCtx.js';

/**
 * Hand-trimmed from https://api.llama.fi/overview/fees (2026-10-17). Totals per category in the fixture:
 * Dexs 30d = 100 + 50 + 30 + 20 + 0 (curve null) + 40 = 240; Dexs 1y = 1000 + 400 + 300 + 150 + 60 + 0 (pancake missing) = 1910;
 * Derivatives 30d = 200 + 10 + 90 = 300.
 */
const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/ingest/defillama-overview-fees.json', import.meta.url)), 'utf8'),
) as unknown;
const Q = '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';
const FEES_URL = `https://api.llama.fi/overview/fees${Q}`;

type Share = SourceOf<'defillama_share'>;
const share = (over: Partial<Share> = {}): Share => ({
  type: 'defillama_share', parent: 'parent#uniswap', category: 'Dexs', overview: 'fees', window: '30d', ...over,
});

async function read(sources: Share[], body: unknown = FIXTURE) {
  const http = fakeHttp({ 'https://api.llama.fi/overview/': body });
  const results = await getSourceHandler('defillama_share').fetch(sources.map((s) => req('dominance_share', s)), sourceCtx({ http }));
  return { results, http };
}

const levelOf = (r: ReadingResult): number => {
  if (!r.ok || r.value.kind !== 'level') throw new Error(`expected a level reading, got ${JSON.stringify(r)}`);
  return r.value.value;
};

describe('defillama_share source', () => {
  it('share of category, grouped by parentProtocol', async () => {
    const { results, http } = await read([share()]);
    expect(levelOf(results[0])).toBeCloseTo(150 / 240, 12);
    expect(http.calls.map((c) => c.url)).toEqual([FEES_URL]);
    expect(sourceId(share())).toBe('defillama_share:fees:Dexs:parent#uniswap:30d');
  });

  it('1y window reads total1y', async () => {
    const { results } = await read([share({ window: '1y' })]);
    expect(levelOf(results[0])).toBeCloseTo(1400 / 1910, 12);
  });

  it('counts only the requested category on both sides', async () => {
    const { results } = await read([
      share({ parent: 'parent#hyperliquid', category: 'Derivatives' }),
      share({ parent: 'parent#hyperliquid', category: 'Dexs' }),
    ]);
    expect(levelOf(results[0])).toBeCloseTo(210 / 300, 12);
    expect(levelOf(results[1])).toBeCloseTo(20 / 240, 12);
  });

  it('bare slug parent for a protocol with no parentProtocol', async () => {
    const { results } = await read([share({ parent: 'lighter', category: 'Derivatives' })]);
    expect(levelOf(results[0])).toBeCloseTo(90 / 300, 12);
  });

  it('null or missing totals count as 0', async () => {
    const { results } = await read([
      share({ parent: 'parent#curve-finance' }), // total30d null
      share({ parent: 'parent#pancakeswap', window: '1y' }), // total1y missing
      share({ parent: 'parent#curve-finance', window: '1y' }),
      share({ parent: 'parent#pancakeswap' }),
    ]);
    expect(levelOf(results[0])).toBe(0);
    expect(levelOf(results[1])).toBe(0);
    expect(levelOf(results[2])).toBeCloseTo(60 / 1910, 12);
    expect(levelOf(results[3])).toBeCloseTo(40 / 240, 12);
    for (const r of results) expect(Number.isFinite(levelOf(r))).toBe(true);
  });

  it('chain goes in the path', async () => {
    const s = share({ parent: 'parent#aerodrome', overview: 'dexs', chain: 'Base' });
    const { results, http } = await read([s]);
    expect(http.calls.map((c) => c.url)).toEqual([`https://api.llama.fi/overview/dexs/Base${Q}`]);
    expect(levelOf(results[0])).toBeCloseTo(30 / 240, 12);
    expect(sourceId(s)).toBe('defillama_share:dexs/Base:Dexs:parent#aerodrome:30d');
  });

  it('fails when the parent is not in the category', async () => {
    const { results } = await read([
      share({ parent: 'parent#aerodrome', category: 'Derivatives' }),
      share({ parent: 'parent#renamed' }),
      share(),
    ]);
    for (const r of results.slice(0, 2)) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/parent .* not found/);
    }
    expect(levelOf(results[2])).toBeCloseTo(150 / 240, 12);
  });

  it('fails when the category total is 0', async () => {
    const { results } = await read([share({ category: 'Nope' })]);
    expect(results[0].ok).toBe(false);
    if (!results[0].ok) expect(results[0].error).toMatch(/category "Nope" .*total is 0/);
    await expect(read([share()], { nothing: [] })).rejects.toThrow(/protocols/);
  });

  it('level reading: source api, observedAt = ctx.nowIso, detail names the URL and the parent sum/total', async () => {
    const { results } = await read([share()]);
    const r = results[0];
    if (!r.ok || r.value.kind !== 'level') throw new Error('expected a level');
    expect(r.value.source).toBe('api');
    expect(r.value.observedAt).toBe(NOW_ISO);
    expect(r.value.detail).toContain(FEES_URL);
    expect(r.value.detail).toContain('150');
    expect(r.value.detail).toContain('240');
  });
});

describe('defillama_share in the asset config', () => {
  const bad = (yaml: string): string => {
    try {
      parseAssetYaml(yaml);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };
  const SRC = '{ type: defillama_share, parent: "parent#mini", category: Dexs, overview: dexs, chain: Base, window: 30d }';
  const SHARE = 'staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }';

  it('schema accepts defillama_share as a level primary and refuses it on a flow metric', () => {
    const ok = INGEST_ASSET_YAML.replace(SHARE, `staker_emission_share: { type: level, unit: ratio, staleness_days: 30, source: ${SRC} }`);
    expect(bad(ok)).toBe('');
    expect(parseAssetYaml(ok).config.metrics.staker_emission_share.source).toEqual({
      type: 'defillama_share', parent: 'parent#mini', category: 'Dexs', overview: 'dexs', chain: 'Base', window: '30d',
    });
    const noChain = parseAssetYaml(INGEST_ASSET_YAML.replace(SHARE, `staker_emission_share: { type: level, unit: ratio, staleness_days: 30, source: { type: defillama_share, parent: lighter, category: Derivatives, overview: fees, window: 1y } }`));
    expect('chain' in noChain.config.metrics.staker_emission_share.source!).toBe(false);
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: tokens }', `source: ${SRC}`)))
      .toMatch(/flow_tokens\.fees.*defillama_share cannot be the source of a flow metric/);
    expect(bad(INGEST_ASSET_YAML.replace(SHARE, `staker_emission_share: { type: level, unit: ratio, staleness_days: 30, source: { type: defillama_share, parent: x, category: Dexs, overview: derivatives, window: 30d } }`))).not.toBe('');
  });

  it('schema refuses defillama_share as a cross-check', () => {
    expect(bad(INGEST_ASSET_YAML.replace('- { tolerance_pct: 2, source: { type: http_json, url: "https://api.example.test/stats", path: price } }', `- { source: ${SRC} }`)))
      .toMatch(/price_usd.*defillama_share cannot be a cross-check/);
  });
});
