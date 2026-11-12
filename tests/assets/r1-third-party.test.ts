import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * Phase 3 R1 (spec §5): the 12 assets other than AERO read no DefiLlama/CoinGecko figure that feeds no revenue, holder
 * flow or price. What stays is the out-of-scope list of the Global Constraints: HYPE af_buyback / revenue_proxy (R5),
 * PUMP llama_revenue and solana.supply_burn_daily's history (R6), CRV llama.box (R7), and every price / circulating
 * primary (R2/R3). identifiers (external_ids) stay until R8.
 */
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url));
const R1_ASSETS = ['cake', 'crv', 'cvxcrv', 'hype', 'link', 'lit', 'pump', 'sdcrv', 'sky', 'uni', 'vvv', 'ycrv'];

/** `<asset>:<metric>` whose primary source may still be a `defillama` read (out of scope for R1). */
const DEFILLAMA_ALLOWED = new Set(['hype:flow_usd.af_buyback', 'hype:flow_usd.revenue_proxy', 'pump:flow_usd.llama_revenue']);

interface Found { asset: string; metric: string; where: string; source: Record<string, unknown> }

/** Every source object of one asset's metrics: the primary and each cross-check. */
function sources(asset: string): Found[] {
  const doc = parseYaml(readFileSync(join(ASSETS_DIR, `${asset}.yaml`), 'utf8')) as { metrics?: Record<string, unknown> };
  const out: Found[] = [];
  for (const [metric, raw] of Object.entries(doc.metrics ?? {})) {
    const m = raw as { source?: Record<string, unknown>; cross_checks?: { source: Record<string, unknown> }[] };
    if (m?.source) out.push({ asset, metric, where: 'source', source: m.source });
    (m?.cross_checks ?? []).forEach((c, i) => out.push({ asset, metric, where: `cross_checks[${i}]`, source: c.source }));
  }
  return out;
}

const all = R1_ASSETS.flatMap(sources);

describe('Phase 3 R1: no third-party read outside the out-of-scope list (12 assets)', () => {
  it('has the 12 assets plus AERO in assets/', () => {
    const present = readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, ''));
    expect([...R1_ASSETS, 'aero'].every((a) => present.includes(a))).toBe(true);
  });

  it('has no defillama source except the out-of-scope primaries', () => {
    const bad = all.filter((s) => s.source.type === 'defillama' && !(s.where === 'source' && DEFILLAMA_ALLOWED.has(`${s.asset}:${s.metric}`)));
    expect(bad.map((s) => `${s.asset}:${s.metric}:${s.where}`)).toEqual([]);
  });

  it('has no coins.llama.fi or defillama-datasets url anywhere in the 12 YAMLs', () => {
    const hits = R1_ASSETS.filter((a) => /coins\.llama\.fi|defillama-datasets/.test(readFileSync(join(ASSETS_DIR, `${a}.yaml`), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('has no coingecko source with field total_supply', () => {
    const bad = all.filter((s) => s.source.type === 'coingecko' && s.source.field === 'total_supply');
    expect(bad.map((s) => `${s.asset}:${s.metric}:${s.where}`)).toEqual([]);
  });

  it('references lit.unlocks_next_year from no asset (the adapter stays until R8)', () => {
    const users = [...R1_ASSETS, 'aero'].flatMap(sources).filter((s) => s.source.type === 'adapter' && s.source.name === 'lit.unlocks_next_year');
    expect(users.map((s) => `${s.asset}:${s.metric}`)).toEqual([]);
  });

  it('reads LIT and PUMP unlocks from the cited schedule', () => {
    for (const asset of ['lit', 'pump']) {
      const u = sources(asset).find((s) => s.metric === 'unlocks_next_year' && s.where === 'source');
      expect(u?.source.name).toBe('schedule.unlocks_next_year');
    }
  });
});
