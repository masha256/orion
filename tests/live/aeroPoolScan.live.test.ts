import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AssetConfig } from '../../src/config/schema.js';
import { loadAsset } from '../../src/config/load.js';
import { getAdapter } from '../../src/ingest/adapters/registry.js';
import { chainRpcFor } from '../../src/ingest/transport/chainRpcEnv.js';
import { createViemRpc } from '../../src/ingest/transport/viemRpc.js';
import type { SourceContext, SourceValue } from '../../src/ingest/types.js';

/**
 * Live golden (Phase 3 R4 Task 9, spec §8), OPT-IN: skipped unless ORION_LIVE_RPC=1. Re-reads UTC day 2026-11-26 from
 * archive on all 8 Aero chains through the two pool adapters (AERO's own scan block from assets/aero.yaml, one run so
 * the five metrics share each chain-day's scan) and checks each chain's gross, allocator and incentives by class
 * against the R4 scoping figures in tests/fixtures/poolscan/live-2026-11-26.json (copied from the scoping's
 * summary-table.json and incentives-data/daily.json), within the fixture's tolerance (0.5% or $1 per chain and figure).
 *
 * RPC URLs come from the process environment only (CHAIN_RPC_ENV: ORION_BASE_RPC_URL, ORION_ETH_RPC_URL,
 * ORION_OP_RPC_URL, ORION_ARB_RPC_URL, ORION_INK_RPC_URL, ORION_ROBINHOOD_RPC_URL, ORION_ARC_RPC_URL,
 * ORION_ELYSIUM_RPC_URL); this test reads no file for them. Archive reads at 2026-11-26's boundary blocks; ~1-3 min.
 *
 *   ORION_LIVE_RPC=1 npx vitest run tests/live/aeroPoolScan.live.test.ts
 *
 * Without ORION_LIVE_RPC=1 (the suite's normal run) it is skipped and makes no request. Run it outside 05:00-06:30 PT.
 */

const LIVE = process.env.ORION_LIVE_RPC === '1';
const DAY = '2026-11-26';
const NOW = '2026-11-27T12:00:00.000Z'; // yesterday = DAY
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/poolscan/live-2026-11-26.json', import.meta.url));

type Figure = 'gross' | 'allocator' | 'vote_incentives' | 'protocol_subsidy';
interface Golden {
  day: string;
  tolerance: { rel: number; absUsd: number };
  chains: Record<string, { chain: string } & Record<Figure, number>>;
}

const METRICS = {
  gross: 'flow_usd.pool_fees_gross',
  allocator: 'flow_usd.voter_fees',
  lp: 'flow_usd.lp_fees',
  vote_incentives: 'flow_usd.vote_incentives',
  protocol_subsidy: 'flow_usd.protocol_subsidy',
} as const;

type Series = Extract<SourceValue, { kind: 'daily_series' }>;
type ChainSlice = Record<string, number | string>;

/**
 * AERO's config with every pool metric's `since` moved to DAY: the adapters then plan exactly one day (no missing day
 * before it, the revision days before it filtered), so the run reads 2026-11-26 and nothing else.
 */
function oneDayAsset(): AssetConfig {
  const asset = structuredClone(loadAsset(ROOT, 'aero').config);
  for (const key of Object.values(METRICS)) {
    const params = (asset.metrics as Record<string, { source?: { params?: Record<string, unknown> } }>)[key]?.source?.params;
    if (!params) throw new Error(`assets/aero.yaml has no ${key} adapter params`);
    params.since = DAY;
  }
  return asset;
}

function ctxFor(asset: AssetConfig): SourceContext {
  const unused = (what: string) => () => {
    throw new Error(`the pool scan does not use ${what}`);
  };
  return {
    asset,
    nowIso: NOW,
    http: { getJson: unused('http'), postJson: unused('http') },
    rpc: null,
    block: null,
    env: process.env,
    contract: unused('contract()'),
    rpcFor: chainRpcFor(process.env, createViemRpc),
    storedFlowDays: async () => new Set<string>(),
  };
}

async function run(ctx: SourceContext, metric: string, adapter: string): Promise<Series> {
  const params = (ctx.asset.metrics as Record<string, { source?: { params?: Record<string, unknown> } }>)[metric]!.source!.params!;
  const v = await getAdapter(adapter).run(ctx, params);
  if (v.kind !== 'daily_series') throw new Error(`${metric}: not a daily series (${v.kind})`);
  expect(v.points.map((p) => p.day)).toEqual([DAY]);
  return v;
}

const chainsOf = (s: Series): Record<string, ChainSlice> => (s.points[0].slice as { chains: Record<string, ChainSlice> }).chains;

describe.skipIf(!LIVE)('AERO pool scan, live golden 2026-11-26 (ORION_LIVE_RPC=1)', () => {
  it('per-chain gross, allocator and incentives match the R4 scoping within tolerance', { timeout: 15 * 60_000 }, async () => {
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden;
    expect(golden.day).toBe(DAY);
    const ctx = ctxFor(oneDayAsset());
    const gross = await run(ctx, METRICS.gross, 'pool.tape_fees_daily');
    const allocator = await run(ctx, METRICS.allocator, 'pool.tape_fees_daily');
    const vote = await run(ctx, METRICS.vote_incentives, 'pool.vrm_incentives_daily');
    const subsidy = await run(ctx, METRICS.protocol_subsidy, 'pool.vrm_incentives_daily');

    const tape = chainsOf(gross);
    const vrm = chainsOf(vote);
    expect(Object.keys(tape).sort()).toEqual(Object.keys(golden.chains).sort());
    const got = (id: string, f: Figure): number =>
      Number(f === 'gross' ? tape[id].grossUsd : f === 'allocator' ? tape[id].allocatorUsd : vrm[id][f]);

    const rows: string[] = [];
    const bad: string[] = [];
    for (const [id, want] of Object.entries(golden.chains)) {
      for (const f of ['gross', 'allocator', 'vote_incentives', 'protocol_subsidy'] as const) {
        const g = got(id, f);
        const tol = Math.max(golden.tolerance.rel * Math.abs(want[f]), golden.tolerance.absUsd);
        const line = `${want.chain} ${f}: ${g.toFixed(2)} vs ${want[f]} (${want[f] === 0 ? '-' : `${(((g - want[f]) / want[f]) * 100).toFixed(3)}%`}, tol ${tol.toFixed(2)})`;
        rows.push(line);
        if (!Number.isFinite(g) || Math.abs(g - want[f]) > tol) bad.push(line);
      }
      expect(Number(tape[id].pricedPct)).toBeGreaterThanOrEqual(99);
    }
    console.log(rows.join('\n'));
    expect(bad).toEqual([]);

    // The series values are the chains' sums (the stored figures), and the run's five metrics agree with each other.
    const sum = (f: Figure) => Object.keys(golden.chains).reduce((a, id) => a + got(id, f), 0);
    expect(gross.points[0].value).toBeCloseTo(sum('gross'), 6);
    expect(allocator.points[0].value).toBeCloseTo(sum('allocator'), 6);
    expect(vote.points[0].value).toBeCloseTo(sum('vote_incentives'), 6);
    expect(subsidy.points[0].value).toBeCloseTo(sum('protocol_subsidy'), 6);
    // LP = gross − allocator per chain, floored at 0 (pool.ts), summed.
    const lp = await run(ctx, METRICS.lp, 'pool.tape_fees_daily');
    const lpWant = Object.keys(golden.chains).reduce((a, id) => a + Math.max(0, got(id, 'gross') - got(id, 'allocator')), 0);
    expect(lp.points[0].value).toBeCloseTo(lpWant, 6);
  });
});
