import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-09-23T21:30:00.000Z');
const GENESIS_TS = NOW.getTime() / 1000 - 100 * 86_400 + 1;
const LLAMA = 'https://coins.llama.fi/prices/current/base:0x940181a94a35a4569e4529a3cdfb74e38fd98631';

const { config } = loadAsset(ROOT, 'aero');
const C = config.contracts;

/** 100 days of holders revenue ending on the last complete day, about 470k USD a day (the 30-day total was 14.2M on 2026-09-23). */
function chart(): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 100; i >= 1; i--) {
    const day = addDays('2026-09-22', 1 - i);
    points.push([Date.parse(`${day}T00:00:00Z`) / 1000, 450_000 + (i % 5) * 10_000]);
  }
  return { totalDataChart: points };
}

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'aerodrome-finance', symbol: 'aero', current_price: 0.671936, market_cap: 668227328, circulating_supply: 992591965.5968602, total_supply: 1983240735.576791 }],
    [LLAMA]: { coins: { 'base:0x940181a94a35a4569e4529a3cdfb74e38fd98631': { decimals: 18, symbol: 'AERO', price: 0.673898492508311, timestamp: 1790197250, confidence: 0.99 } } },
    'https://api.llama.fi/summary/fees/aerodrome': chart(),
  });
  // Read live on 2026-09-23 at block 51,704,207.
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / 2)),
    calls: {
      [callKey(C.token, 'totalSupply')]: 1983240735576791446735550579n,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.ve, 'supply')]: 1051061695973990144830875038n,
      [callKey(C.minter, 'weekly')]: 8969149540107574558747588n,
      [callKey(C.minter, 'tailEmissionRate')]: 21n,
      [callKey(C.minter, 'teamRate')]: 228n,
      [callKey(C.minter, 'activePeriod')]: 1789603200n, // 2026-09-17T00:00Z
      [callKey(C.ve, 'totalSupplyAt', [1789603199n])]: 1027321406167859438293364475n, // voting power at the epoch's start
    },
  });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: {}, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http, rpc };
}

/** A flat, plausible set for the wiring test; the real one comes from the user's calibration. */
function assumptions(): AssumptionValues {
  const one = {
    rev_growth_y1: 0.1, growth_fade_years: 4, terminal_growth: 0.02, 'capture_rate_terminal.fees': 1, 'capture_ramp_years.fees': 0,
    discount_rate_base: 0.2, 'multiple.fm_holder_flow': 8, regime_multiplier: 1, staked_ratio_horizon: 0.5,
  };
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}

describe('assets/aero.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'aero', symbol: 'AERO', supply_basis: 'effective_total' });
    expect(config.holder_flows).toEqual([{ id: 'fees', kind: 'fee_share', capture_rule: 'contractual', recipient_base: 'locked', metric: 'flow_usd.fees', window_days: 90 }]);
    expect(config.modules.map((m) => [m.id, m.weight])).toEqual([['hc', 0.6], ['fm_holder_flow', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.fees', 'capture_rate_terminal.fees', 'discount_rate_base', 'growth_fade_years', 'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    // Every metric has a source: a bootstrap run has nothing to research on this asset.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // Pinned on 2026-09-23. A deliberate edit of assets/aero.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/aero.yaml`, 'utf8')).hash).toBe('eb39a2307aeff731889630f74152055941db8e49aa2cc88bc5a159e1d2c37f78');
  });

  it('plans the source map of the spec: no transfer scan, one API-series flow, one derived level, two adapters', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'primary:circulating_supply']],
      [`http_json:${LLAMA}`, ['cross_check:price_usd']],
      ['chain_levels', ['primary:effective_supply', 'primary:staked_supply', 'primary:locked_supply']],
      ['adapter:aero.staker_emission_share', ['primary:staker_emission_share']],
      ['adapter:aero.emission_rate_annual', ['primary:emission_rate_annual']],
      ['defillama:aerodrome:dailyHoldersRevenue', ['primary:flow_usd.fees']],
    ]);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
    expect(plan.needsRpc).toBe(true);
  });

  it('fetches every metric from canned sources with the price cross-check in tolerance, then values the asset', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const value = (metric: string) => listActiveObservations(w.db, 'aero', metric).at(-1)!.value;
    expect(value('price_usd')).toBe(0.671936);
    expect(value('circulating_supply')).toBeCloseTo(992591965.5968602, 3);
    expect(value('effective_supply')).toBeCloseTo(1983240735.576791, 3);
    expect(value('staked_supply')).toBeCloseTo(1051061695.97399, 3);
    expect(value('locked_supply')).toBeCloseTo(1051061695.97399, 3);
    expect(value('staker_emission_share')).toBeGreaterThan(0.09);
    expect(value('staker_emission_share')).toBeLessThan(0.11);
    expect(value('emission_rate_annual')).toBeGreaterThan(245e6);
    expect(value('emission_rate_annual')).toBeLessThan(262e6);
    // The writer keeps only the backfill window (backfill_days 90 on a first run, no cursor): 2026-06-25 to 2026-09-22, 90 of the 100 days.
    expect(listActiveObservations(w.db, 'aero', 'flow_usd.fees')).toHaveLength(90);
    // The run rate: the last 90 complete days summed and scaled to a year, written for every day with a full window: only 2026-09-22.
    const revenue = listActiveObservations(w.db, 'aero', 'revenue_run_rate_usd');
    expect(revenue).toHaveLength(1);
    expect(revenue.at(-1)!.value).toBeGreaterThan(160e6);
    expect(revenue.at(-1)!.value).toBeLessThan(180e6);
    expect(revenue.at(-1)).toMatchObject({ source: 'api', sourceDetail: 'derived flow_annualized(flow_usd.fees, 90d)' });
    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ metricKey: 'price_usd', ok: true });
    expect(w.rpc.stats.multicall).toBeLessThanOrEqual(5); // levels, and two per adapter (the epoch, then the voting power at its start)

    createAssumptionSet(w.db, { assetId: 'aero', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'aero'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
    expect(signal.spot!.price).toBe(0.671936);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
  });
});

describe('the AERO persona', () => {
  it('ships beside the VVV one, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst']);
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['dex', 'onchain-fee-share'] });
    expect(persona.body).toContain('Locking is the thesis');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
  });
});
