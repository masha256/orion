import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { buildSchedule } from '../../src/drivers/select.js';
import { epochAt, reducedRate } from '../../src/ingest/adapters/crv.js';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, TOKEN } from '../helpers/ingestAsset.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

// CRV on Ethereum, read live at block 26,146,581 (2026-10-08): see the CRV onboarding spec, section 2.2.
const CRV = '0xd533a949740bb3306d119cc777fa900ba034cd52';
const RATE = 3080982847903985532n; // 3.0810 CRV/s
const START = 1786573048n; // 2026-08-12T22:17:28Z, epoch 6
const BLOCK_TS = 1791444000; // 2026-10-08T07:20:00Z
const LIVE = { [callKey(CRV, 'rate')]: RATE, [callKey(CRV, 'start_epoch_time')]: START };
const contract = (name: string) => ({ token: CRV })[name] ?? (() => { throw new Error(`no contract ${name}`); })();

async function chainCtx(calls: Record<string, bigint | Error>, blockTs = BLOCK_TS) {
  const rpc = fakeRpc({ genesisTs: blockTs - 12 * 500, blockTimeSec: 12, latest: 500n, calls });
  return { ctx: sourceCtx({ rpc, block: await rpc.latestBlock(), contract }), rpc };
}

describe('the CRV emission schedule', () => {
  it('is registered and needs the chain', () => {
    expect(adapterNames()).toContain('crv.emission_rate_annual');
    expect(getAdapter('crv.emission_rate_annual').needsRpc).toBe(true);
  });

  it('reduces the rate as the contract does: times 1e18 over 2^(1/4) in 18 decimals, integer division', () => {
    expect(reducedRate(RATE)).toBe((RATE * 10n ** 18n) / 1189207115002721024n);
    expect(Number(reducedRate(RATE)) / Number(RATE)).toBeCloseTo(2 ** -0.25, 12);
  });

  it('gives the step in force and the next coded cut from one multicall: 97.16M then 81.70M CRV a year', async () => {
    const { ctx, rpc } = await chainCtx(LIVE);
    const v = await getAdapter('crv.emission_rate_annual').run(ctx, {});
    expect(v.kind).toBe('schedule_steps');
    if (v.kind !== 'schedule_steps') return;
    expect(v.source).toBe('onchain');
    expect(v.steps).toHaveLength(2);
    expect(v.steps[0].observedAt).toBe(new Date(BLOCK_TS * 1000).toISOString());
    expect(v.steps[0].value).toBeCloseTo(97_161_875.0915, 3);
    expect(v.steps[1].observedAt).toBe('2027-08-12T22:17:28.000Z');
    expect(v.steps[1].value).toBeCloseTo(81_703_072.4637, 3);
    expect(v.detail).toBe('block 500: rate 3.080983 CRV/s from 2026-08-12T22:17:28.000Z; next 2.590787 CRV/s from 2027-08-12T22:17:28.000Z');
    expect(rpc.stats.multicall).toBe(1);
  });

  it('rolls an overdue epoch forward as update_mining_parameters would, and says so', async () => {
    expect(epochAt(RATE, START, START + 365n * 86_400n - 1n)).toEqual({ rate: RATE, start: START, rolled: 0 });
    expect(epochAt(RATE, START, START + 365n * 86_400n)).toEqual({ rate: reducedRate(RATE), start: START + 365n * 86_400n, rolled: 1 });
    const late = Number(START) + 365 * 86_400 + 3600; // an hour into epoch 7, nobody has poked the contract
    const { ctx } = await chainCtx(LIVE, late);
    const v = await getAdapter('crv.emission_rate_annual').run(ctx, {});
    if (v.kind !== 'schedule_steps') throw new Error('expected steps');
    expect(v.steps[0].value).toBeCloseTo(81_703_072.4637, 3);
    expect(v.steps[1].observedAt).toBe('2028-08-11T22:17:28.000Z');
    expect(v.detail).toMatch(/1 epoch\(s\) past the contract's state, rolled forward$/);
  });

  it('refuses a zero rate, an epoch start after the block, a failed read, and no chain', async () => {
    const run = async (calls: Record<string, bigint | Error>) => getAdapter('crv.emission_rate_annual').run((await chainCtx(calls)).ctx, {});
    await expect(run({ ...LIVE, [callKey(CRV, 'rate')]: 0n })).rejects.toThrow(/rate\(\) is zero/);
    await expect(run({ ...LIVE, [callKey(CRV, 'start_epoch_time')]: BigInt(BLOCK_TS + 1) })).rejects.toThrow(/after the block/);
    await expect(run({ ...LIVE, [callKey(CRV, 'rate')]: new Error('boom') })).rejects.toThrow(/rate\(\): boom/);
    await expect(getAdapter('crv.emission_rate_annual').run(sourceCtx({ contract }), {})).rejects.toThrow(/RPC/);
  });
});

describe('a schedule_steps reading in a fetch', () => {
  // The mini asset with its emission schedule read by the CRV adapter from the mini token.
  const yaml = INGEST_ASSET_YAML.replace(
    'source: { type: contract_read, contract: staking, function: emissionRatePerSecond, decimals: 18, scale: 31536000 }',
    'source: { type: adapter, name: crv.emission_rate_annual }',
  );
  const nowSec = BigInt(NOW.getTime() / 1000);
  const calls = { [callKey(TOKEN, 'rate')]: RATE, [callKey(TOKEN, 'start_epoch_time')]: nowSec - 30n * 86_400n };

  it('writes every step as its own observation, so the drivers see the future cut', async () => {
    const h = harness({ loaded: parseAssetYaml(yaml), calls });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['emission_rate_annual'] });
    expect(r.sources).toEqual([expect.objectContaining({ sourceId: 'adapter:crv.emission_rate_annual', status: 'ok', metricsWritten: ['emission_rate_annual'] })]);
    const rows = listActiveObservations(h.db, 'mini', 'emission_rate_annual');
    expect(rows.map((o) => o.value)).toEqual([expect.closeTo(97_161_875.09, 1), expect.closeTo(81_703_072.46, 1)]);
    expect(rows[1].observedAt).toBe(new Date(Number(nowSec + 335n * 86_400n) * 1000).toISOString());
    const asOf = new Date(NOW.getTime() + 60_000).toISOString();
    expect(buildSchedule(rows, asOf).steps.map((s) => s.value)).toEqual([rows[0].value, rows[1].value]);
  });

  it('supersedes the future step on the next run instead of stacking a second one', async () => {
    const h = harness({ loaded: parseAssetYaml(yaml), calls });
    await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['emission_rate_annual'] });
    await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['emission_rate_annual'] });
    const future = listActiveObservations(h.db, 'mini', 'emission_rate_annual').filter((o) => o.observedAt > NOW.toISOString());
    expect(future).toHaveLength(1);
  });

  it('writes nothing on a dry run and reports both steps', async () => {
    const h = harness({ loaded: parseAssetYaml(yaml), calls });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['emission_rate_annual'], dryRun: true });
    expect(r.written.map((w) => [w.metricKey, w.observationId])).toEqual([['emission_rate_annual', null], ['emission_rate_annual', null]]);
    expect(listActiveObservations(h.db, 'mini', 'emission_rate_annual')).toEqual([]);
  });

  it('refuses steps on a metric that is not a schedule', async () => {
    const onLevel = INGEST_ASSET_YAML.replace(
      'source: { type: contract_read, contract: staking, function: totalSupply, decimals: 18 }',
      'source: { type: adapter, name: crv.emission_rate_annual }',
    );
    const h = harness({ loaded: parseAssetYaml(onLevel), calls });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['staked_supply'] });
    expect(r.sources[0]).toMatchObject({ status: 'failed' });
    expect(r.sources[0].error).toMatch(/schedule steps can only be stored on a schedule metric, not a level one/);
    expect(listActiveObservations(h.db, 'mini', 'staked_supply')).toEqual([]);
  });
});
