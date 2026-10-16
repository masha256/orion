import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { updateAsset } from '../../src/app/update.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { loadPersona } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys, requiredExtraMetrics } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { addDays } from '../../src/ingest/time.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { loadHolderYieldReport } from '../../src/report/load.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-16T10:30:00.000Z');
const BLOCK_SEC = 12;
const GENESIS_TS = NOW.getTime() / 1000 - 400 * 86_400 + 1;
const E18 = 10n ** 18n;
const PRICE = 0.07;
const SUPPLY = 23_452_431_915;
const STAKED = 17_395_600_000;

const { config } = loadAsset(ROOT, 'sky');
const C = config.contracts;
const lc = (a: string) => a.toLowerCase();
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / BLOCK_SEC));
const STRANGER = '0x7630c870da0f44308a2676898010bed93bd89c19';
const VRD = '0x675671a8756ddb69f7254afb030865388ef699ee'; // VestedRewardsDistribution: funds the SKY farm

function chart(price: number) {
  return (url: string): { prices: [number, number][] } => {
    const days = Number(new URL(url).searchParams.get('days'));
    const end = NOW.getTime();
    const step = days > 90 ? 86_400_000 : 3_600_000;
    const prices: [number, number][] = [];
    for (let t = end - days * 86_400_000; t <= end; t += step) prices.push([t, price]);
    return { prices };
  };
}

type Log = Omit<TransferLog, 'timestamp'>;
const daily = (first: string, n: number, from: string, tokens: bigint, tag: string): Log[] =>
  Array.from({ length: n }, (_, i) => ({ blockNumber: blockAt(`${addDays(first, i)}T12:00:00Z`), logIndex: 0, txHash: `0x${tag}${i}`, from, value: tokens * E18 }));

/**
 * USDS into the USDS farm: 50,000 a day (minted, from zero) for the 91 days to 2026-10-15, plus one 9,000-USDS send from a
 * stranger, which must be flagged, not counted.
 * SKY into the Pause Proxy: 1M SKY a day from the pair over the same days, and the Safe's 500M top-up (ignored).
 * SKY into the reward farms: 1.2M a day to the staker farm for 370 days and a 100M lump to the USDS-depositor farm.
 */
const first91 = addDays('2026-10-15', -90);
const logsTo: Record<string, Log[]> = {
  [`${lc(C.usds)}>${lc(C.usds_farm)}`]: [
    ...daily(first91, 91, lc(C.zero), 50_000n, 'u'),
    { blockNumber: blockAt('2026-09-09T10:00:00Z'), logIndex: 1, txHash: '0xstranger', from: STRANGER, value: 9_000n * E18 },
  ],
  [`${lc(C.token)}>${lc(C.pause_proxy)}`]: [
    ...daily(first91, 91, lc(C.sky_usds_pair), 1_000_000n, 'b'),
    { blockNumber: blockAt('2026-09-01T10:00:00Z'), logIndex: 2, txHash: '0xtopup', from: lc(C.treasury_safe), value: 500_000_000n * E18 },
  ],
  [`${lc(C.token)}>${lc(C.sky_farm)}`]: daily(addDays('2026-10-15', -369), 370, VRD, 1_200_000n, 's'),
  [`${lc(C.token)}>${lc(C.usds_sky_farm)}`]: [{ blockNumber: blockAt('2026-03-02T12:00:00Z'), logIndex: 0, txHash: '0xvrd2', from: VRD, value: 100_000_000n * E18 }],
};

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'sky', symbol: 'sky', current_price: PRICE, market_cap: 1.64e9, circulating_supply: 23_428_082_223, total_supply: SUPPLY }],
    'https://api.coingecko.com/api/v3/coins/sky/market_chart': chart(PRICE),
    'https://api.coingecko.com/api/v3/coins/usds/market_chart': chart(1),
    'https://coins.llama.fi/prices/current/ethereum:0x56072C95FAA701256059aa122697B133aDEd9279': { coins: { 'ethereum:0x56072C95FAA701256059aa122697B133aDEd9279': { price: 0.0704 } } },
  });
  const base = fakeRpc({
    genesisTs: GENESIS_TS,
    blockTimeSec: BLOCK_SEC,
    maxLogRange: 10_000n,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / BLOCK_SEC)),
    calls: {
      [callKey(C.token, 'totalSupply')]: BigInt(SUPPLY) * E18,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.usds, 'decimals')]: 18n,
      [callKey(C.lssky, 'totalSupply')]: BigInt(STAKED) * E18,
      [callKey(C.splitter, 'burn')]: 55n * 10n ** 16n,
    },
  });
  const rpc = {
    ...base,
    async getTransferLogs(q: { token: string; to: string; fromBlock: bigint; toBlock: bigint }) {
      await base.getTransferLogs(q); // keeps the range cap and stats
      return (logsTo[`${lc(q.token)}>${lc(q.to)}`] ?? []).filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock).map((l) => ({ ...l, timestamp: base.timestampOf(l.blockNumber) }));
    },
  };
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: { ORION_ETH_RPC_URL: 'http://eth.test' }, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps };
}

const STAKERS_USD = 91 * 50_000;
const BUYBACK_USD = 91 * 1_000_000 * PRICE;
const RUN_RATE = ((STAKERS_USD + BUYBACK_USD) * 365) / 91;

/** The calibrated package (UNI's central, Mike 2026-10-16); the flat placeholder no longer fits the agent bands. */
const calibrated = parseYaml(readFileSync(`${ROOT}/calibration/sky-assumptions.yaml`, 'utf8')) as Record<'bear' | 'base' | 'bull', Record<string, number>>;

describe('assets/sky.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'sky', symbol: 'SKY', chain: 'ethereum', supply_basis: 'effective_total', ingest: { chain_id: 1, rpc_url_env: 'ORION_ETH_RPC_URL', backfill_days: 100 } });
    // Both halves of the surplus reach staked SKY, as cash (Mike, 2026-10-16).
    expect(config.holder_flows).toEqual([
      { id: 'stakers', kind: 'fee_share', capture_rule: 'programmatic', recipient_base: 'staked', metric: 'flow_usd.stakers', window_days: 91 },
      { id: 'buyback', kind: 'fee_share', capture_rule: 'programmatic', recipient_base: 'staked', metric: 'flow_usd.buyback', window_days: 91 },
    ]);
    expect(config.modules.map((m) => [m.id, m.kind, m.weight ?? null])).toEqual([['hc', 'estimate', 0.6], ['fm_holder_flow', 'estimate', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.buyback', 'capture_ramp_years.stakers', 'capture_rate_terminal.buyback', 'capture_rate_terminal.stakers',
      'discount_premium_programmatic', 'discount_rate_base', 'growth_fade_years', 'multiple.fm_holder_flow', 'regime_multiplier',
      'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(config)).toEqual([]);
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // No DefiLlama (Mike, 2026-10-11): every flow is read on chain.
    expect(Object.entries(config.metrics).filter(([, d]) => d.source?.type === 'defillama' || d.cross_checks?.some((c) => c.source.type === 'defillama')).map(([k]) => k)).toEqual([]);
    expect(config.reporting!.dilution).toEqual([expect.objectContaining({ id: 'treasury_net', metric: 'treasury_net_payout' })]);
    // A deliberate edit of assets/sky.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/sky.yaml`, 'utf8')).hash).toBe('533eedb07b160556ccb7b38a894d45e60b228bdbd0816512d90a1597afe6053e');
  });

  it('plans the two holder-flow scans, the treasury scans, the chain levels and the DefiLlama price cross-check', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'cross_check:total_supply', 'primary:circulating_supply']],
      ['http_json:https://coins.llama.fi/prices/current/ethereum:0x56072C95FAA701256059aa122697B133aDEd9279', ['cross_check:price_usd']],
      ['chain_levels', ['primary:total_supply', 'primary:staked_supply', 'primary:splitter_burn_share']],
      ['constant', ['primary:staker_emission_share', 'primary:emission_rate_annual']],
    ]);
    expect(plan.flowGroups.map((g) => [g.sourceId, g.members.map((m) => m.metricKey)])).toEqual([
      [expect.stringMatching(/^transfer_flow:usds>usds_farm/), ['flow_usd.stakers']],
      [expect.stringMatching(/^transfer_flow:token>pause_proxy/), ['flow_usd.buyback', 'flow_tokens.buyback']],
      [expect.stringMatching(/^transfer_flow:token>sky_farm/), ['flow_tokens.rewards_staker']],
      [expect.stringMatching(/^transfer_flow:token>usds_sky_farm/), ['flow_tokens.rewards_usds']],
    ]);
    expect(plan.derived.map((r) => r.metricKey).sort()).toEqual(['revenue_run_rate_usd', 'treasury_net_payout']);
  });

  it('fetches every metric, counts the mints and the pair, ignores the top-up, flags the stranger, and values through the tick path', async () => {
    const w = world();
    createAssumptionSet(w.db, { assetId: 'sky', author: 'user', rationale: 'calibrated', values: calibrated as unknown as AssumptionValues, createdAt: NOW.toISOString() });
    // The year of treasury flows first (live does this as the onboarding backfill); then the routine tick reads 100 days.
    await fetchAsset(w.db, { config, hash: 'backfill' }, NOW, w.deps, { backfillDays: 362, metrics: ['flow_tokens.rewards_staker', 'flow_tokens.rewards_usds', 'flow_tokens.buyback', 'treasury_net_payout'] });
    const { fetch: r, signal } = await updateAsset(w.db, loadAsset(ROOT, 'sky'), NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error])).toEqual([]);
    expect(r.sources.flatMap((s) => s.crossChecks).map((c) => [c.metricKey, c.ok])).toEqual([['total_supply', true], ['price_usd', true]]);

    const rows = (metric: string) => listActiveObservations(w.db, 'sky', metric);
    const value = (metric: string) => rows(metric).at(-1)!.value;
    expect(value('price_usd')).toBe(PRICE);
    expect(value('staked_supply')).toBe(STAKED);
    expect(value('splitter_burn_share')).toBe(0.55);

    const usdsScan = r.sources.find((s) => s.sourceId.startsWith('transfer_flow:usds>usds_farm'))!;
    expect(usdsScan.unlistedTransfers.map((t) => [t.from, t.tokens])).toEqual([[STRANGER, 9_000]]);
    expect(r.anomalies.map((a) => [a.kind, a.metricKey])).toEqual([['unlisted_sender', 'flow_usd.stakers']]);
    expect(rows('flow_usd.stakers').filter((o) => o.value > 0).every((o) => o.value === 50_000)).toBe(true);
    // The Safe's 500M top-up is a treasury transfer, never a buy.
    expect(Math.max(...rows('flow_tokens.buyback').map((o) => o.value))).toBe(1_000_000);
    expect(value('revenue_run_rate_usd')).toBeCloseTo(RUN_RATE, 0);

    // Treasury net payout over 357 days, scaled to a year: 357 x 1.2M + 100M paid, less 91 x 1M bought.
    expect(value('treasury_net_payout')).toBeCloseTo(((357 * 1_200_000 + 100_000_000 - 91_000_000) * 365) / 357, 0);

    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
    expect(signal.spot!.price).toBe(PRICE);
  });

  it('reports both halves as cash to stakers, and the treasury net payout as dilution', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { backfillDays: 362 });
    const rep = loadHolderYieldReport(w.db, config);
    expect(rep.day).toBe('2026-10-15');
    const ann = (x: number) => (x * 365) / 91;
    expect(rep.flows).toEqual([
      expect.objectContaining({ id: 'stakers', bucket: 'cash', haircut: 0, gross: expect.closeTo(ann(STAKERS_USD), 0) }),
      expect.objectContaining({ id: 'buyback', bucket: 'cash', haircut: 0, gross: expect.closeTo(ann(BUYBACK_USD), 0) }),
    ]);
    expect(rep.buckets.cash!.net).toBeCloseTo(RUN_RATE, 0);
    expect(rep.buckets.burn).toBeNull();
    expect(rep.buckets.hold).toBeNull();
    expect(rep.fdv).toBeCloseTo(SUPPLY * PRICE, 0);
    const net = ((357 * 1_200_000 + 100_000_000 - 91_000_000) * 365) / 357;
    expect(rep.yields.dilutionLines).toEqual([{ id: 'treasury_net', tokensPerYear: expect.closeTo(net, 0), yield: expect.closeTo(net / SUPPLY, 9) }]);
  });

  it('refuses to run without the Ethereum RPC URL', async () => {
    const w = world();
    await expect(fetchAsset(w.db, { config, hash: 'test' }, NOW, { ...w.deps, env: {} })).rejects.toMatchObject({ code: 'missing_rpc_url' });
  });
});

describe('the SKY persona', () => {
  it('is the stablecoin-protocol analyst, which knows the Splitter and the treasury payout', () => {
    const persona = loadPersona(ROOT, 'stablecoin-protocol-analyst');
    expect(persona.body).toContain('Surplus splits by governance vote (SKY)');
    expect(persona.body).toContain('"Smart Burn" burns nothing');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
  });
});

describe('calibration/sky-assumptions.yaml', () => {
  it('is complete, sits inside the agent bands of assets/sky.yaml, and its capture shares sum to at most 1', () => {
    for (const s of ['bear', 'base', 'bull'] as const) {
      expect(Object.keys(calibrated[s]).sort()).toEqual(requiredAssumptionKeys(config));
      for (const [key, value] of Object.entries(calibrated[s])) {
        const b = config.assumptions[key];
        const band = b[s] ?? b;
        expect(value, `${s} ${key}`).toBeGreaterThanOrEqual(band.min);
        expect(value, `${s} ${key}`).toBeLessThanOrEqual(band.max);
      }
      expect(calibrated[s]['capture_rate_terminal.stakers'] + calibrated[s]['capture_rate_terminal.buyback'], s).toBeLessThanOrEqual(1);
      // The agent can move the split, but the two flows' band maxima cannot count much more than the whole run rate.
      expect(config.assumptions['capture_rate_terminal.stakers'][s]!.max + config.assumptions['capture_rate_terminal.buyback'][s]!.max, s).toBeLessThanOrEqual(1.1);
    }
    for (const key of ['rev_growth_y1', 'multiple.fm_holder_flow', 'discount_rate_base', 'capture_rate_terminal.stakers', 'capture_rate_terminal.buyback', 'discount_premium_programmatic']) {
      for (const s of ['bear', 'base', 'bull'] as const) expect(config.assumptions[key][s], `${s} ${key}`).toBeDefined();
    }
  });
});
