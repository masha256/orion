import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { evaluateChecks, gapPct, recordChecks } from '../../src/checks/evaluate.js';
import { resolveChecks } from '../../src/checks/schema.js';
import { loadAsset, parseAssetObject } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import { listAnomalies } from '../../src/db/anomalies.js';
import { listCheckResults } from '../../src/db/checkResults.js';
import type { Db } from '../../src/db/connection.js';
import { emptySourceOutcome, insertFetchRun } from '../../src/db/fetchRuns.js';
import { insertObservation } from '../../src/db/observations.js';
import { REVISION_DAYS } from '../../src/ingest/apiFlow.js';
import { registerAdapter } from '../../src/ingest/adapters/registry.js';
import { addDays } from '../../src/ingest/time.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE } from '../helpers/provenance.js';

const testDb = useTestDb();
let db: Db;
beforeEach(() => {
  db = testDb();
});

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const D = '2026-11-02';
const NOW = new Date('2026-11-03T01:00:00.000Z');
const asset = (id: string): AssetConfig => loadAsset(ROOT, id).config;
/** The asset's YAML with `edit` applied to the raw object, parsed and validated as `asset validate` would. */
const edited = (id: string, edit: (raw: Record<string, any>) => void): AssetConfig => {
  const raw = parseYaml(readFileSync(`${ROOT}/assets/${id}.yaml`, 'utf8')) as Record<string, any>;
  edit(raw);
  return parseAssetObject(raw).config;
};

/** A daily flow row for `day` (stamped at its end). */
async function flow(assetId: string, metricKey: string, day: string, value: number, source: 'onchain' | 'api' = 'onchain') {
  await insertObservation(db, { provenance: TEST_PROVENANCE, assetId, metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, source, fetchedAt: NOW.toISOString() });
}
async function level(assetId: string, metricKey: string, at: string, value: number) {
  await insertObservation(db, { provenance: TEST_PROVENANCE, assetId, metricKey, observedAt: at, value, source: 'onchain', fetchedAt: at });
}
const byId = async (a: AssetConfig, day = D) => new Map((await evaluateChecks(db, a, day, { now: NOW })).map((r) => [r.checkId, r]));

describe('checks', () => {
  it('gap_pct is |lhs - rhs| / max(|lhs|, |rhs|), 0 when both are 0', () => {
    expect(gapPct(100, 90)).toBeCloseTo(10, 12);
    expect(gapPct(90, 100)).toBeCloseTo(10, 12);
    expect(gapPct(0, 0)).toBe(0);
    expect(gapPct(0, 5)).toBe(100);
  });

  it('sum: CRV 0.00% gap ok; a missing part breaches', async () => {
    await flow('crv', 'flow_usd.protocol_revenue', D, 1000);
    await flow('crv', 'flow_usd.fees', D, 900);
    await flow('crv', 'flow_usd.curve_treasury', D, 100);
    const ok = (await byId(asset('crv'))).get('splitter')!;
    expect(ok).toMatchObject({ type: 'sum', status: 'ok', lhs: 1000, rhs: 1000, gapPct: 0, day: D });
    expect(ok.detail).toMatchObject({ tolerance_pct: 2, window_days: 1, lhs: ['flow_usd.protocol_revenue'], rhs: ['vecrv_fees', 'treasury'] });

    // A recipient the split does not list (here: treasury dropped from the parts) shows as the gap.
    const missingPart = edited('crv', (raw) => { raw.income_statement.checks[0].parts = ['vecrv_fees']; });
    expect((await byId(missingPart)).get('splitter')).toMatchObject({ status: 'breach', lhs: 1000, rhs: 900, gapPct: 10 });
  });

  // Pre-G2 decision 1 (Mike, 2026-11-07): dust is not a breach. The CRV-family sum checks carry tolerance_abs $1, and a
  // day breaches only past both tolerance_pct and $1 (the balance/supply checks' existing meaning).
  it('sum: $1 absolute floor on the CRV-family sum checks (sdCRV 2026-08-31 dust is ok, $2 at 100% breaches)', async () => {
    const day = '2026-08-31';
    // The measured shape: CRV fee in $0.046, every part 0 (gap 100 percent).
    await flow('sdcrv', 'flow_usd.sd_rev_crv', day, 0.046);
    for (const m of ['flow_usd.sd_rev_crv_vesdt', 'flow_usd.sd_rev_crv_treasury', 'flow_usd.crv', 'flow_usd.sd_boost_delegation']) await flow('sdcrv', m, day, 0);
    const dust = (await byId(asset('sdcrv'), day)).get('crv_fee')!;
    expect(dust).toMatchObject({ type: 'sum', status: 'ok', lhs: 0.046, rhs: 0, gapPct: 100 });
    expect(dust.detail).toMatchObject({ tolerance_pct: 2, tolerance_abs: 1 });

    const d2 = '2026-09-01';
    await flow('sdcrv', 'flow_usd.sd_rev_crv', d2, 2);
    for (const m of ['flow_usd.sd_rev_crv_vesdt', 'flow_usd.sd_rev_crv_treasury', 'flow_usd.crv', 'flow_usd.sd_boost_delegation']) await flow('sdcrv', m, d2, 0);
    expect((await byId(asset('sdcrv'), d2)).get('crv_fee')).toMatchObject({ status: 'breach', lhs: 2, rhs: 0, gapPct: 100 });

    // A large day: $1 is nothing against a 10 percent gap, which still breaches.
    await flow('crv', 'flow_usd.protocol_revenue', D, 1000);
    await flow('crv', 'flow_usd.fees', D, 900);
    await flow('crv', 'flow_usd.curve_treasury', D, 0);
    expect((await byId(asset('crv'))).get('splitter')).toMatchObject({ status: 'breach', gapPct: 10 });

    // Exactly the three CRV-family sum checks carry the floor; yCRV's partition guard keeps its 1e-6 percent alone.
    const abs = (id: string) => Object.fromEntries((loadAsset(ROOT, id).config.income_statement?.checks ?? []).filter((c) => c.type === 'sum').map((c) => [c.id, (c as { tolerance_abs?: number }).tolerance_abs ?? null]));
    expect(abs('crv')).toEqual({ splitter: 1 });
    expect(abs('sdcrv')).toEqual({ crv_fee: 1 });
    expect(abs('ycrv')).toEqual({ splitter: 1, gross_by_sender: null });
  });

  it('parameter: LIT rh_revenue_share_app 0.5 vs 0.5 ok; 0.4 breaches', async () => {
    const lit = asset('lit');
    const auto = resolveChecks(lit).find((c) => c.id === 'robinhood_partner_share');
    expect(auto).toMatchObject({ type: 'parameter', metric: 'rh_revenue_share_app', expected: 0.5, auto: true, tolerancePct: 0 });
    await level('lit', 'rh_revenue_share_app', `${addDays(D, 1)}T00:45:00.000Z`, 0.5);
    expect((await byId(lit)).get('robinhood_partner_share')).toMatchObject({ status: 'ok', lhs: 0.5, rhs: 0.5, gapPct: 0 });
    await db.run('TRUNCATE observations RESTART IDENTITY CASCADE');
    await level('lit', 'rh_revenue_share_app', `${addDays(D, 1)}T00:45:00.000Z`, 0.4);
    const r = (await byId(lit)).get('robinhood_partner_share')!;
    expect(r).toMatchObject({ status: 'breach', lhs: 0.4, rhs: 0.5 });
    expect(r.gapPct).toBeCloseTo(20, 9);
  });

  it('balance: LINK reserve_link delta vs flow_tokens.reserve', async () => {
    const link = asset('link');
    await level('link', 'reserve_link', `${D}T00:45:00.000Z`, 1_000_000);
    await level('link', 'reserve_link', `${addDays(D, 1)}T00:45:00.000Z`, 1_020_000);
    await flow('link', 'flow_tokens.reserve', D, 20_000);
    expect((await byId(link)).get('reserve_balance')).toMatchObject({ type: 'balance', status: 'ok', lhs: 20_000, rhs: 20_000, gapPct: 0 });

    // Dust under tolerance_abs (10 LINK) is ok even though it is far past 1 percent of a quiet day.
    await db.run('TRUNCATE observations RESTART IDENTITY CASCADE');
    await level('link', 'reserve_link', `${D}T00:45:00.000Z`, 1_000_000);
    await level('link', 'reserve_link', `${addDays(D, 1)}T00:45:00.000Z`, 1_000_004);
    await flow('link', 'flow_tokens.reserve', D, 0);
    expect((await byId(link)).get('reserve_balance')).toMatchObject({ status: 'ok', lhs: 4, rhs: 0, gapPct: 100 });

    // A transfer the scan missed: the balance moved by more than the measured buys.
    await db.run('TRUNCATE observations RESTART IDENTITY CASCADE');
    await level('link', 'reserve_link', `${D}T00:45:00.000Z`, 1_000_000);
    await level('link', 'reserve_link', `${addDays(D, 1)}T00:45:00.000Z`, 1_030_000);
    await flow('link', 'flow_tokens.reserve', D, 20_000);
    expect((await byId(link)).get('reserve_balance')).toMatchObject({ status: 'breach', lhs: 30_000, rhs: 20_000 });

    // A reading far from the day boundary (a noon run) cannot be set against a midnight-to-midnight flow: incomplete.
    await db.run('TRUNCATE observations RESTART IDENTITY CASCADE');
    await level('link', 'reserve_link', `${D}T12:05:00.000Z`, 1_000_000);
    await level('link', 'reserve_link', `${addDays(D, 1)}T12:05:00.000Z`, 1_030_000);
    await flow('link', 'flow_tokens.reserve', D, 20_000);
    expect((await byId(link)).get('reserve_balance')).toMatchObject({ status: 'incomplete', lhs: null, rhs: null, gapPct: null });
  });

  it('price: UNI price_usd vs its Chainlink contract_read within tolerance', async () => {
    const uni = asset('uni');
    const run = async (primary: number, check: number) => {
      const s = emptySourceOutcome('chain_levels');
      s.crossChecks.push({ metricKey: 'price_usd', sourceId: 'chain_levels', label: 'level', primary, check, diffPct: 0, tolerancePct: 2, ok: true });
      await insertFetchRun(db, { assetId: 'uni', startedAt: `${addDays(D, 1)}T00:45:00.000Z`, endedAt: `${addDays(D, 1)}T00:46:00.000Z`, outcome: 'ok', detail: { sources: [emptySourceOutcome('coingecko'), s] } });
    };
    await run(6.0, 6.06);
    const ok = (await byId(uni)).get('price_chainlink')!;
    expect(ok).toMatchObject({ type: 'price', status: 'ok', lhs: 6.0, rhs: 6.06 });
    expect(ok.gapPct).toBeCloseTo((0.06 / 6.06) * 100, 9);
    expect(ok.detail).toMatchObject({ against: 'chainlink_uni_usd', source: 'chain_levels', fetch_run_id: 1 });
    await db.run('TRUNCATE fetch_runs RESTART IDENTITY CASCADE');
    await run(6.0, 6.6);
    expect((await byId(uni)).get('price_chainlink')).toMatchObject({ status: 'breach', lhs: 6.0, rhs: 6.6 });
  });

  it('revision: a restated LIT fee day breaches', async () => {
    const lit = asset('lit');
    for (let i = 0; i < 5; i++) await flow('lit', 'flow_usd.fees_core', addDays(D, -i), 100_000 + i, 'api');
    expect((await byId(lit)).get('fees_core_revision')).toMatchObject({ type: 'revision', status: 'ok', lhs: 100_000, rhs: 100_000, gapPct: 0 });
    // The API later restated D-2 (the adapter's re-read wrote a new row, which supersedes the first).
    await flow('lit', 'flow_usd.fees_core', addDays(D, -2), 103_000, 'api');
    const r = (await byId(lit)).get('fees_core_revision')!;
    expect(r).toMatchObject({ status: 'breach', lhs: 100_002, rhs: 103_000 });
    expect(r.detail).toMatchObject({ days: 3, worst_day: addDays(D, -2), restated_count: 1 });
  });

  it('revision: LIT fees_core_revision looks back exactly the Lighter adapter\'s re-read depth (Task 5 I2)', () => {
    // A restatement exists only for a day ingest read again; lit.exchange_fees_daily re-reads REVISION_DAYS days.
    const rev = resolveChecks(asset('lit')).find((c) => c.id === 'fees_core_revision');
    expect(rev).toMatchObject({ type: 'revision', metric: 'flow_usd.fees_core', days: REVISION_DAYS });
    expect(REVISION_DAYS).toBe(3);
  });

  it('refuses a circular check: same metric both sides', () => {
    expect(() => edited('cvxcrv', (raw) => {
      raw.income_statement.checks = [{ id: 'loop', type: 'two_path', a: 'flow_usd.crv', b: 'flow_usd.crv', tolerance_pct: 1 }];
    })).toThrow(/check loop is circular: "flow_usd\.crv" is on both sides/);
    expect(() => edited('crv', (raw) => {
      raw.income_statement.checks[0].total = ['flow_usd.fees']; // the vecrv_fees part's own series
    })).toThrow(/check splitter is circular: "flow_usd\.fees" is on both sides/);
  });

  it('refuses a circular check: PUMP supply total_supply vs flow_tokens.buyback (supply_burn_daily computedFrom token_supply)', () => {
    expect(() => edited('pump', (raw) => {
      raw.income_statement.checks = [{ id: 'supply_burns', type: 'supply', level: 'total_supply', burns: ['flow_tokens.buyback'], tolerance_pct: 1 }];
    })).toThrow(/check supply_burns is circular: "flow_tokens\.buyback" \(adapter solana\.supply_burn_daily\) is computedFrom solana\.token_supply, which reads "total_supply"/);
  });

  it('refuses a circular check: computedFrom followed transitively (Task 5 M1)', () => {
    // An adapter computed from supply_burn_daily, which is computed from token_supply: still the same readings.
    registerAdapter({ name: 'test.relay_of_burn', needsRpc: false, computedFrom: ['solana.supply_burn_daily'], run: () => Promise.reject(new Error('not run')) });
    const withRelay = (raw: Record<string, any>) => {
      raw.metrics['flow_tokens.relay'] = { type: 'flow', unit: 'tokens', cadence: 'daily', staleness_days: 4, monitor_only: true, source: { type: 'adapter', name: 'test.relay_of_burn', params: {} } };
    };
    expect(() => edited('pump', (raw) => {
      withRelay(raw);
      raw.income_statement.checks = [{ id: 'supply_relay', type: 'supply', level: 'total_supply', burns: ['flow_tokens.relay'], tolerance_pct: 1 }];
    })).toThrow(/check supply_relay is circular: "flow_tokens\.relay" \(adapter test\.relay_of_burn\) is computedFrom solana\.token_supply \(via solana\.supply_burn_daily\), which reads "total_supply"/);
    // Without the check the extra metric loads (the refusal is the check's, not the metric's).
    expect(() => edited('pump', withRelay)).not.toThrow();
  });

  it('refuses a circular check: a derived metric whose params list the other side in an array (Task 5 M1)', () => {
    // LINK released_rate = flow_annualized(metrics: [released_hub, released_rewards]).
    expect(() => edited('link', (raw) => {
      raw.income_statement.checks.push({ id: 'released_loop', type: 'balance', level: 'released_rate', inflows: ['flow_tokens.released_hub'], outflows: [], tolerance_pct: 1 });
    })).toThrow(/check released_loop is circular: "released_rate" is derived from "flow_tokens\.released_hub"/);
    // A derived of that derived is still computed from the flow (transitively).
    expect(() => edited('link', (raw) => {
      raw.metrics.released_rate_copy = { type: 'level', unit: 'tokens_per_year', staleness_days: 120, monitor_only: true, source: { type: 'derived', name: 'flow_annualized', params: { metrics: ['released_rate'], days: 365 } } };
      raw.income_statement.checks.push({ id: 'released_loop2', type: 'balance', level: 'released_rate_copy', inflows: ['flow_tokens.released_rewards'], outflows: [], tolerance_pct: 1 });
    })).toThrow(/check released_loop2 is circular: "released_rate_copy" is derived from "flow_tokens\.released_rewards" \(via released_rate\)/);
  });

  it('incomplete when a side has no row for the day (never a breach)', async () => {
    await flow('crv', 'flow_usd.fees', D, 900);
    await flow('crv', 'flow_usd.curve_treasury', D, 100);
    const r = (await byId(asset('crv'))).get('splitter')!;
    expect(r).toMatchObject({ status: 'incomplete', lhs: null, rhs: null, gapPct: null });
    expect(r.detail).toMatchObject({ missing: [`flow_usd.protocol_revenue@${D}`], missing_count: 1 });
    // LIT's parameter with no reading on D+1, UNI's price with no fetch run: incomplete too.
    const lit = await byId(asset('lit'));
    expect(lit.get('robinhood_partner_share')!.status).toBe('incomplete');
    expect(lit.get('fees_core_revision')!.status).toBe('incomplete');
    expect((await byId(asset('uni'))).get('price_chainlink')!.status).toBe('incomplete');
  });

  it('cvxCRV two_path (auto): the CRV lock line vs flow_usd.crv over the statement window', async () => {
    const cvx = asset('cvxcrv');
    expect(resolveChecks(cvx)).toEqual([
      { id: 'crv_paid', tolerancePct: 5, auto: true, type: 'two_path', windowDays: 91, a: [{ metric: 'flow_usd.convex_rev_cvxcrv', factor: 1, line: 'crv' }], b: [{ metric: 'flow_usd.crv', factor: 1, line: 'crv' }] },
    ]);
    for (let i = 0; i < 91; i++) {
      await flow('cvxcrv', 'flow_usd.convex_rev_cvxcrv', addDays(D, -i), 100);
      await flow('cvxcrv', 'flow_usd.crv', addDays(D, -i), 98);
    }
    expect((await byId(cvx)).get('crv_paid')).toMatchObject({ status: 'ok', lhs: 9100, rhs: 98 * 91 });
  });

  it('a breach opens one check_breach anomaly and a second breach bumps occurrences', async () => {
    const lit = asset('lit');
    await level('lit', 'rh_revenue_share_app', `${addDays(D, 1)}T00:45:00.000Z`, 0.4);
    const first = await evaluateChecks(db, lit, D, { now: NOW });
    const raised = await recordChecks(db, 'lit', first, NOW.toISOString());
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'check_breach', metricKey: '', dedupeKey: 'robinhood_partner_share', severity: 'advisory', status: 'open', occurrences: 1 });
    expect(raised[0]!.detail).toMatchObject({ check_id: 'robinhood_partner_share', check_type: 'parameter', day: D, lhs: 0.4, rhs: 0.5, tolerance_pct: 0 });
    expect((await listCheckResults(db, 'lit', D)).map((r) => [r.checkId, r.status])).toEqual([['fees_core_revision', 'incomplete'], ['robinhood_partner_share', 'breach']]);

    // The next day breaches again: the same anomaly, one more occurrence; the stored rows are per day.
    const D2 = addDays(D, 1);
    await level('lit', 'rh_revenue_share_app', `${addDays(D2, 1)}T00:45:00.000Z`, 0.4);
    const later = new Date(NOW.getTime() + 86_400_000);
    await recordChecks(db, 'lit', await evaluateChecks(db, lit, D2, { now: later }), later.toISOString());
    const all = await listAnomalies(db, { assetId: 'lit', includeDecided: true });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'check_breach', occurrences: 2, lastSeenAt: later.toISOString() });
    expect((await listCheckResults(db, 'lit')).filter((r) => r.checkId === 'robinhood_partner_share').map((r) => r.day)).toEqual([D2, D]);

    // Evaluating a day again replaces its row (the latest evaluation wins), never a second row.
    await recordChecks(db, 'lit', await evaluateChecks(db, lit, D2, { now: later }), later.toISOString());
    expect(await listCheckResults(db, 'lit', D2)).toHaveLength(2);
  });

  it('occurrences count breached days: re-evaluating a breached day does not bump (Task 5 M5)', async () => {
    const lit = asset('lit');
    await level('lit', 'rh_revenue_share_app', `${addDays(D, 1)}T00:45:00.000Z`, 0.4);
    const t1 = NOW.toISOString();
    expect(await recordChecks(db, 'lit', await evaluateChecks(db, lit, D, { now: NOW }), t1)).toHaveLength(1);
    // A stale report day (the same holder_yield.day every tick) or a manual re-tick: same day, no new occurrence.
    const t2 = new Date(NOW.getTime() + 3_600_000);
    expect(await recordChecks(db, 'lit', await evaluateChecks(db, lit, D, { now: t2 }), t2.toISOString())).toEqual([]);
    const t3 = new Date(NOW.getTime() + 7_200_000);
    await recordChecks(db, 'lit', await evaluateChecks(db, lit, D, { now: t3 }), t3.toISOString());
    let all = await listAnomalies(db, { assetId: 'lit', includeDecided: true });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ occurrences: 1, lastSeenAt: t1 });
    // The stored row still takes the latest evaluation.
    expect((await listCheckResults(db, 'lit', D)).find((r) => r.checkId === 'robinhood_partner_share')!.evaluatedAt).toBe(t3.toISOString());

    // A day first stored ok (or incomplete) that breaches on re-evaluation is a new breached day: it counts.
    const D2 = addDays(D, 1);
    await level('lit', 'rh_revenue_share_app', `${addDays(D2, 1)}T00:45:00.000Z`, 0.5);
    const t4 = new Date(NOW.getTime() + 86_400_000);
    expect(await recordChecks(db, 'lit', await evaluateChecks(db, lit, D2, { now: t4 }), t4.toISOString())).toEqual([]);
    await db.run("UPDATE observations SET value = 0.4 WHERE metric_key = 'rh_revenue_share_app' AND observed_at = $1", [`${addDays(D2, 1)}T00:45:00.000Z`]);
    const t5 = new Date(t4.getTime() + 3_600_000);
    expect(await recordChecks(db, 'lit', await evaluateChecks(db, lit, D2, { now: t5 }), t5.toISOString())).toHaveLength(1);
    all = await listAnomalies(db, { assetId: 'lit', includeDecided: true });
    expect(all[0]).toMatchObject({ occurrences: 2, lastSeenAt: t5.toISOString() });
  });
});
