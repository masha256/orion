import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-09-24T12:00:00.000Z');
const INFO = 'https://api.hyperliquid.xyz/info';
const LLAMA_PRICE = 'https://coins.llama.fi/prices/current/hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec';
const recorded = (name: string): unknown => JSON.parse(readFileSync(`${ROOT}/tests/fixtures/hype/${name}.json`, 'utf8')) as unknown;

const { config } = loadAsset(ROOT, 'hype');

/** 100 days of holders revenue ending on the last complete day, about 1.55M USD a day (the 30-day total was 57.2M on 2026-09-24). */
function chart(): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 100; i >= 1; i--) {
    const day = addDays('2026-09-23', 1 - i);
    points.push([Date.parse(`${day}T00:00:00Z`) / 1000, 1_500_000 + (i % 5) * 25_000]);
  }
  return { totalDataChart: points };
}

function world() {
  const fixtures: Record<string, unknown> = { tokenDetails: recorded('tokenDetails'), validatorSummaries: recorded('validatorSummaries') };
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'hyperliquid', symbol: 'hype', current_price: 92.36, market_cap: 20545976252, circulating_supply: 222445714.07414138, total_supply: 955307079.4341414 }],
    [LLAMA_PRICE]: { coins: { 'hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec': { decimals: 8, symbol: 'HYPE', price: 92.35934496087437, timestamp: 1790215180, confidence: 0.99 } } },
    'https://api.llama.fi/summary/fees/hyperliquid': chart(),
    // The info API answers by request type; the fixtures were recorded on 2026-09-24.
    [INFO]: (_url: string, body?: unknown) => structuredClone(fixtures[(body as { type: string }).type]),
  });
  const deps: FetchDeps = { http, rpcFactory: () => { throw new Error('HYPE reads no chain'); }, env: {}, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http };
}

/** A flat, plausible set for the wiring test; the real one comes from the user's calibration. */
function assumptions(): AssumptionValues {
  const one = {
    rev_growth_y1: 0.2, growth_fade_years: 5, terminal_growth: 0.02, 'capture_rate_terminal.af_buyback': 1, 'capture_ramp_years.af_buyback': 0,
    discount_rate_base: 0.2, discount_premium_programmatic: 0.02, 'multiple.fm_holder_flow': 30, regime_multiplier: 1, staked_ratio_horizon: 0.46,
  };
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}

describe('assets/hype.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'hype', symbol: 'HYPE', supply_basis: 'effective_total' });
    expect(config.chain).toBeUndefined();
    expect(config.ingest).toBeUndefined();
    expect(config.holder_flows).toEqual([{ id: 'af_buyback', kind: 'burn', capture_rule: 'programmatic', recipient_base: 'all', metric: 'flow_usd.af_buyback', window_days: 90 }]);
    expect(config.modules.map((m) => [m.id, m.weight])).toEqual([['hc', 0.6], ['fm_holder_flow', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.af_buyback', 'capture_rate_terminal.af_buyback', 'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years', 'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    // One manual metric: the staker share, 1.0 by construction, which the bootstrap researches and the user confirms.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual(['staker_emission_share']);
    // Pinned on 2026-09-24. A deliberate edit of assets/hype.yaml (the calibration bands) moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/hype.yaml`, 'utf8')).hash).toBe('5683e7a67bcf51284aff86ed27460364122c90259449115c4c29f0d2a38131f3');
  });

  it('plans the source map of the spec: no chain, three adapters, one API-series flow, one derived level', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'primary:circulating_supply']],
      [`http_json:${LLAMA_PRICE}`, ['cross_check:price_usd']],
      ['adapter:hype.effective_supply', ['primary:effective_supply']],
      ['adapter:hype.staked_supply', ['primary:staked_supply']],
      ['adapter:hype.emission_rate_annual', ['primary:emission_rate_annual']],
      ['defillama:hyperliquid:dailyHoldersRevenue', ['primary:flow_usd.af_buyback']],
    ]);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
    expect(plan.needsRpc).toBe(false);
  });

  it('fetches every sourced metric from canned responses with the price cross-check in tolerance, then values the asset once the staker share is entered', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const value = (metric: string) => listActiveObservations(w.db, 'hype', metric).at(-1)!.value;
    expect(value('price_usd')).toBe(92.36);
    expect(value('circulating_supply')).toBeCloseTo(222445714.07414138, 3);
    expect(value('effective_supply')).toBeGreaterThan(950e6);
    expect(value('effective_supply')).toBeLessThan(953e6);
    expect(value('staked_supply')).toBeGreaterThan(430e6);
    expect(value('staked_supply')).toBeLessThan(450e6);
    expect(value('emission_rate_annual')).toBeGreaterThan(9.8e6);
    expect(value('emission_rate_annual')).toBeLessThan(10.1e6);
    expect(listActiveObservations(w.db, 'hype', 'staker_emission_share')).toEqual([]);
    // The writer keeps only the backfill window (backfill_days 90 on a first run, no cursor): 2026-06-26 to 2026-09-23, 90 of the 100 days.
    expect(listActiveObservations(w.db, 'hype', 'flow_usd.af_buyback')).toHaveLength(90);
    // The run rate: the last 90 complete days summed and scaled to a year, written for every day with a full window: only 2026-09-23.
    const revenue = listActiveObservations(w.db, 'hype', 'revenue_run_rate_usd');
    expect(revenue).toHaveLength(1);
    expect(revenue.at(-1)!.value).toBeGreaterThan(560e6);
    expect(revenue.at(-1)!.value).toBeLessThan(580e6);
    expect(revenue.at(-1)).toMatchObject({ source: 'api', sourceDetail: 'derived flow_annualized(flow_usd.af_buyback, 90d)' });
    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ metricKey: 'price_usd', ok: true });
    // Three posts to the info API, one per adapter, each cached for the run; the token details and the validators are read once each.
    expect(w.http.calls.filter((c) => c.url === INFO).map((c) => (c.body as { type: string }).type).sort()).toEqual(['tokenDetails', 'validatorSummaries']);

    createAssumptionSet(w.db, { assetId: 'hype', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const withoutShare = runValuation(w.db, loadAsset(ROOT, 'hype'), NOW);
    expect(withoutShare.signal.status).toBe('blocked');
    expect(withoutShare.signal.status_reasons.join(' ')).toMatch(/staker_emission_share/);
    // The user's confirmation of the bootstrap's row: 1.0 by construction.
    insertObservation(w.db, { assetId: 'hype', metricKey: 'staker_emission_share', observedAt: NOW.toISOString(), value: 1, source: 'manual', fetchedAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'hype'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('B'); // a manual row in force (the staker share) caps the grade, as VVV's revenue does
    expect(signal.spot!.price).toBe(92.36);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    // A burn flow on the effective-total basis: the supply forecast at the horizon is below today's effective supply plus a year of emissions.
    const hc = signal.horizons!['12m'].modules.hc.breakdown as { supply_at_horizon: number };
    expect(hc.supply_at_horizon).toBeLessThan(value('effective_supply') + value('emission_rate_annual'));
  });
});

describe('the HYPE persona', () => {
  it('ships beside the other two, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst', 'perp-exchange-analyst']);
    const persona = loadPersona(ROOT, 'perp-exchange-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['perp-dex', 'exchange-buyback'] });
    expect(persona.body).toContain('The fund is the mechanism and the risk');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
  });
});
