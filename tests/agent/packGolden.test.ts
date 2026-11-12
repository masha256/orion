import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildContextPack } from '../../src/agent/context.js';
import { Ledger } from '../../src/agent/ledger.js';
import { DEFAULT_BUDGETS } from '../../src/config/agentPolicy.js';
import { holderFlowMetrics } from '../../src/config/incomeStatement.js';
import { loadAsset } from '../../src/config/load.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { useTestDb } from '../helpers/db.js';
import { testProvenance } from '../helpers/provenance.js';
import { ALL_ASSETS } from '../helpers/syntheticReport.js';

/**
 * Task 11 (G4): the analyst's context pack for each repo asset, on seeded rows (100 daily rows of every flow metric,
 * one row of every level), against the packs written at cc59fa7, before `holder_flows`/`reporting` were retired. Every
 * asset's whole pack is identical (fix round 1, I1: `revenue_streams` too, present on exactly the six assets cc59fa7
 * listed it for). `asset_config_yaml` is left out: it is the YAML text, which lost the retired blocks.
 * UPDATE_GOLDEN=1 rewrites the file (only ever at the base commit); a missing file fails.
 *
 * Phase 3 R1 rewrote the packs of cake, lit, pump, uni and vvv. What moved: LIT's and PUMP's adapter_params entry for
 * unlocks_next_year (lit.unlocks_next_year -> schedule.unlocks_next_year), and the seeded level rows' ids on cake, lit,
 * uni and vvv (fewer flow metrics are seeded before them: the removed DefiLlama series). No value or metric moved.
 */
const GOLDEN = fileURLToPath(new URL('./golden/packs-13.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = '2026-11-03T12:00:00.000Z';
const testDb = useTestDb();

async function packOf(id: string): Promise<Record<string, unknown>> {
  await testDb.reset();
  const db = testDb();
  const loaded = loadAsset(ROOT, id);
  for (const [key, def] of Object.entries(loaded.config.metrics).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (def.type === 'flow') {
      for (let i = 0; i < 100; i++) {
        const at = `${addDays('2026-11-03', -i)}T00:00:00.000Z`;
        await insertObservation(db, { provenance: testProvenance('onchain'), assetId: id, metricKey: key, observedAt: at, periodDays: 1, value: 100 + i, fetchedAt: NOW });
      }
    } else if (def.type === 'level' || def.type === 'schedule') {
      await insertObservation(db, { provenance: testProvenance('api'), assetId: id, metricKey: key, observedAt: '2026-11-02T00:00:00.000Z', value: 7, fetchedAt: NOW });
    }
  }
  const pack = await buildContextPack(db, loaded, new Ledger(id, 'analyst', 'test'), {
    runType: 'disclosure', budgets: DEFAULT_BUDGETS.disclosure, now: new Date(NOW), trigger: {}, assetYaml: 'yaml',
  });
  const { asset_config_yaml: _yaml, ...rest } = JSON.parse(JSON.stringify(pack)) as Record<string, unknown>;
  return rest;
}

describe('context packs, golden at cc59fa7 (Task 11)', () => {
  it('every asset: the whole pack (flow rows in force, revenue_streams, everything else)', { timeout: 120_000 }, async () => {
    const now: Record<string, Record<string, unknown>> = {};
    for (const id of ALL_ASSETS) now[id] = await packOf(id);
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(Object.keys(golden)).toEqual([...ALL_ASSETS]);
    // Every asset that differs, named at once.
    expect(ALL_ASSETS.filter((id) => JSON.stringify(now[id]) !== JSON.stringify(golden[id]))).toEqual([]);
    for (const id of ALL_ASSETS) {
      const flows = (now[id]!.observations_in_force as { metric: string }[]).filter((o) => o.metric.startsWith('flow_'));
      expect(flows.length, id).toBeGreaterThan(0);
      expect(now[id], id).toEqual(golden[id]);
      // toEqual ignores key order; the rendered pack is JSON text, so pin the bytes too.
      expect(JSON.stringify(now[id]), id).toBe(JSON.stringify(golden[id]));
    }
    // The golden itself: revenue_streams on exactly the assets cc59fa7 listed it for.
    expect(ALL_ASSETS.filter((id) => 'revenue_streams' in golden[id]!)).toEqual(['hype', 'link', 'lit', 'pump', 'sky', 'uni']);
  });
});

/**
 * Ruling R11.1: the pack's flow set (eligibility's flow windows) is income_statement's holders and
 * below_line-to-holders
 * metrics, and must equal the retired `holder_flows` metrics. Hard-coded from cc59fa7's assets/*.yaml (every
 * `holder_flows` entry had window_days 91, the statement's window).
 */
const V1_HOLDER_FLOWS: Record<string, string[]> = {
    aero: ['flow_usd.fees'],
    cake: ['flow_usd.burn'],
    crv: ['flow_usd.fees'],
    cvxcrv: ['flow_usd.fees', 'flow_usd.crv', 'flow_usd.cvx'],
    hype: ['flow_usd.af_buyback'],
    link: ['flow_usd.reserve'],
    lit: ['flow_usd.buyback'],
    pump: ['flow_usd.buyback'],
    sdcrv: ['flow_usd.fees', 'flow_usd.crv', 'flow_usd.bribes'],
    sky: ['flow_usd.stakers', 'flow_usd.buyback'],
    uni: ['flow_usd.burn'],
    vvv: ['flow_usd.burn'],
    ycrv: ['flow_usd.fees'],
};

describe('holder-flow metrics = the retired holder_flows (Task 11, R11.1)', () => {
  it.each(ALL_ASSETS)('%s', (id) => {
    const is = loadAsset(ROOT, id).config.income_statement;
    expect(holderFlowMetrics(is)).toEqual(V1_HOLDER_FLOWS[id]);
    expect(is!.window_days).toBe(91);
  });

  it('covers the 13 assets', () => {
    expect(Object.keys(V1_HOLDER_FLOWS).sort()).toEqual([...ALL_ASSETS].sort());
  });
});
