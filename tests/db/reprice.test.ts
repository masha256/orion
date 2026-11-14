import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { upsertPrices, upsertToken } from '../../src/db/prices.js';
import { COINGECKO_REF_REMAP, repriceAsset, type RepriceResult } from '../../src/db/reprice.js';
import { burnMomentum, flowAnnualized } from '../../src/ingest/derived.js';
import type { Provenance } from '../../src/provenance/types.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const NOW = new Date('2026-11-14T12:00:00.000Z');
const H = 3_600_000;
const D = 86_400_000;

/** An EVM asset: a transfer-scan burn (CoinGecko-priced at write), its two derived rates, and a hand-entered USD flow. */
const EVM_YAML = `
id: rpx
symbol: RPX
name: Reprice Test
chain: base
contracts:
  token: "0x00000000000000000000000000000000000000a1"
  burn_sink: "0x0000000000000000000000000000000000000000"
  pool: "0x00000000000000000000000000000000000000b2"
ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 100 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.burn: { type: flow, unit: usd, staleness_days: 4, source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [ pool ], unit: usd } }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45 }
  usage_index: { type: level, unit: usd_per_day, staleness_days: 7, source: { type: derived, name: burn_momentum, params: { metric: flow_usd.burn, days: 3 } } }
  burn_rate: { type: level, unit: usd_per_year, staleness_days: 7, source: { type: derived, name: flow_annualized, params: { metric: flow_usd.burn, days: 2 } } }
`;

/** A Solana asset: the supply-drop buyback (CoinGecko daily mean at write) and its token twin. */
const PUMP_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
const PUMP_REF = `solana:mainnet/${PUMP_MINT}`;
const PUMP_YAML = `
id: pmp
symbol: PMP
name: Pump Test
chain: solana
contracts:
  token: "${PUMP_MINT}"
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true, source: { type: adapter, name: solana.token_supply, params: { mint: token } } }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.buyback: { type: flow, unit: usd, staleness_days: 4, source: { type: adapter, name: solana.supply_burn_daily, params: { mint: token, unit: usd, supply_metric: total_supply, days: 7, history: { slug: pump, data_type: dailyHoldersRevenue } } } }
  flow_tokens.buyback: { type: flow, unit: tokens, staleness_days: 4, monitor_only: true, source: { type: adapter, name: solana.supply_burn_daily, params: { mint: token, unit: tokens, supply_metric: total_supply, days: 7, history: { slug: pump, data_type: dailyHoldersRevenue } } } }
`;

const load = (yaml: string): LoadedAsset => {
  const { config, hash } = parseAssetYaml(yaml);
  return { config, hash };
};
const evm = (): LoadedAsset => load(EVM_YAML);
const pump = (): LoadedAsset => load(PUMP_YAML);

const REF = 'eip155:8453/0x00000000000000000000000000000000000000a1';
const CRVUSD = COINGECKO_REF_REMAP['coingecko:crvusd']!.ref;
const YCRV = COINGECKO_REF_REMAP['coingecko:yearn-crv']!.ref;
const SRC = 'chain:v2_twap';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'orion-reprice-'));
  dirs.push(d);
  return d;
}

const dayEnd = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + D).toISOString();
const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
/** The chain price of hour `ms` in the fixtures: moves every hour, so a wrong bucket shows. */
const px = (ms: number): number => 2 + ((ms / H) % 97) * 0.01;

async function seedPrices(d: Db, ref: string, fromMs: number, hours: number, skip: number[] = [], source = SRC, price = px): Promise<void> {
  await upsertToken(d, { tokenRef: ref, symbol: 'T', decimals: 18, coingeckoId: null });
  const rows = [];
  for (let i = 0; i < hours; i++) {
    const ms = fromMs + i * H;
    if (!skip.includes(ms)) rows.push({ ts: new Date(ms).toISOString(), priceUsd: price(ms) });
  }
  await upsertPrices(d, ref, source, rows, '2026-11-14T00:00:00.000Z');
}

const logScan = (hash: string): Provenance => ({
  method: 'measured', sourceType: 'log_scan', chain: 'eip155:8453',
  locator: { contracts: ['0x00000000000000000000000000000000000000a1'], event: 'Transfer(address,address,uint256)' }, codeVersion: 'test', configHash: hash,
});

/** A transfer-scan day: 24 hourly amounts (hour i of the day), its CoinGecko-era `value`. */
async function seedScan(d: Db, assetId: string, metricKey: string, day: string, hourly: number[], value: number, tokenRef = REF): Promise<number> {
  if (!(await d.one('SELECT 1 FROM tokens WHERE token_ref = $1', [tokenRef]))) await upsertToken(d, { tokenRef, symbol: 'T', decimals: 18, coingeckoId: null });
  const o = await insertObservation(d, {
    assetId, metricKey, observedAt: dayEnd(day), periodDays: 1, value, fetchedAt: dayEnd(day),
    provenance: logScan('h'), tokens: { tokenRef, amount: hourly.reduce((s, a) => s + a, 0), hourlyAmounts: hourly },
  });
  return o.id;
}

async function seedPlain(d: Db, assetId: string, metricKey: string, observedAt: string, value: number, p: Provenance, opts: { periodDays?: number | null; tokens?: { tokenRef: string; amount: number }; citationUrl?: string } = {}): Promise<number> {
  const o = await insertObservation(d, {
    assetId, metricKey, observedAt, value, periodDays: opts.periodDays === undefined ? 1 : opts.periodDays, fetchedAt: observedAt, provenance: p,
    citationUrl: opts.citationUrl ?? null,
    ...(opts.tokens ? { tokens: { tokenRef: opts.tokens.tokenRef, amount: opts.tokens.amount, hourlyAmounts: null } } : {}),
  });
  return o.id;
}

const hourlyOf = (amounts: Record<number, number>): number[] => Array.from({ length: 24 }, (_, i) => amounts[i] ?? 0);
/** The fixture's expected new value: sum of amount x price of the hour bucket. */
const hourlyUsd = (day: string, hourly: number[]): number => hourly.reduce((s, a, i) => (a === 0 ? s : s + a * px(dayStartMs(day) + i * H)), 0);

/** Every row of the tables reprice touches, rendered whole: "nothing written" is equality of this. */
async function snapshot(d: Db): Promise<unknown> {
  return {
    observations: await d.all('SELECT to_jsonb(o) AS r FROM observations o ORDER BY id'),
    tokens: await d.all('SELECT to_jsonb(t) AS r FROM tokens t ORDER BY token_ref'),
  };
}

const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return 'no error';
};

const metric = (r: RepriceResult, m: string) => r.perMetric.find((x) => x.metric === m)!;

const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const AMOUNTS: number[][] = [hourlyOf({ 0: 10, 5: 3, 23: 1 }), hourlyOf({ 1: 4, 12: 8 }), hourlyOf({ 2: 6, 20: 2.5 }), hourlyOf({ 7: 1.25 })];

/** Four burn days with every hour priced; the derived rates stored on CoinGecko-era values; three non-repriceable fees rows. */
async function seedEvm(d: Db): Promise<{ burn: number[]; usage: number[]; rate: number[] }> {
  await seedPrices(d, REF, dayStartMs('2026-09-30'), 24 * 6);
  const burn: number[] = [];
  for (let i = 0; i < DAYS.length; i++) burn.push(await seedScan(d, 'rpx', 'flow_usd.burn', DAYS[i]!, AMOUNTS[i]!, 100 + i));
  // Derived rows as the fetch stored them over the CoinGecko-era values 100..103 (burn_momentum 3 d, flow_annualized 2 d).
  const old = new Map(DAYS.map((day, i) => [day, 100 + i]));
  const deriv = (m: string, name: 'burn_momentum' | 'flow_annualized', days: number) =>
    (name === 'burn_momentum' ? burnMomentum(old, days) : flowAnnualized(old, days)).map((p) =>
      seedPlain(d, 'rpx', m, dayEnd(p.day), p.value, { method: 'derived', sourceType: 'derived', chain: null, locator: { metrics: ['flow_usd.burn'] }, formula: `${name}@1`, codeVersion: 'test', configHash: 'h' }, { periodDays: null }));
  const usage = await Promise.all(deriv('usage_index', 'burn_momentum', 3));
  const rate = await Promise.all(deriv('burn_rate', 'flow_annualized', 2));
  // Not repriceable by design: first-party dollars, a DefiLlama day, a hand-entered day.
  await upsertToken(d, { tokenRef: 'usd', symbol: 'USD', decimals: null, peg: 'usd', coingeckoId: null });
  await seedPlain(d, 'rpx', 'flow_usd.fees', dayEnd('2026-10-01'), 5, { method: 'measured', sourceType: 'first_party_api', chain: null, locator: { adapter: 'lit.exchange_fees_daily' }, codeVersion: 'test', configHash: 'h' }, { tokens: { tokenRef: 'usd', amount: 5 } });
  await seedPlain(d, 'rpx', 'flow_usd.fees', dayEnd('2026-10-02'), 6, { method: 'measured', sourceType: 'third_party', chain: null, locator: { endpoint: 'https://api.llama.fi/summary/fees/x' }, codeVersion: 'test', configHash: 'h' });
  await seedPlain(d, 'rpx', 'flow_usd.fees', dayEnd('2026-10-03'), 7, { method: 'disclosed', sourceType: 'disclosure', chain: null, locator: { citation_url: 'https://example.test' }, codeVersion: 'test', configHash: 'h' }, { citationUrl: 'https://example.test' });
  return { burn, usage, rate };
}

describe('repriceAsset', () => {
  it('dry run: counts repriced, skipped by reason and refused; writes nothing, takes no lock, creates no export', async () => {
    await seedEvm(db());
    const before = await snapshot(db());
    const exportDir = join(scratch(), 'repriced');
    const held = await db().tryAssetRunLock('rpx', 'tick pid 1');
    try {
      const r = await repriceAsset(db(), evm(), { yes: false, now: NOW, exportDir });
      expect(r.applied).toBe(false);
      expect(r.exportFile).toBeNull();
      const burn = metric(r, 'flow_usd.burn');
      expect(burn).toMatchObject({ rows: 4, repriced: 4, unchanged: 0, refused: [], skipped: {} });
      expect(burn.oldSum).toBe(100 + 101 + 102 + 103);
      expect(burn.newSum).toBeCloseTo(DAYS.reduce((s, day, i) => s + hourlyUsd(day, AMOUNTS[i]!), 0), 9);
      expect(metric(r, 'flow_usd.fees')).toMatchObject({ rows: 3, repriced: 0, refused: [], skipped: { usd_native: 1, third_party: 1, disclosed: 1 } });
      expect(r.derived.map((x) => [x.metric, x.recomputed])).toEqual([['burn_rate', 3], ['usage_index', 2]]);
    } finally {
      await held!.release();
    }
    expect(await snapshot(db())).toEqual(before);
    expect(() => readdirSync(exportDir)).toThrow();
  });

  it('R33: superseded/rejected rows of the CoinGecko-priced classes are counted per metric (inactiveCoingeckoRows), never rewritten', async () => {
    const { burn } = await seedEvm(db());
    // A burn day re-scanned (its first row superseded), a rejected burn day, and a rejected DefiLlama fees day (not counted).
    const superseded = await seedScan(db(), 'rpx', 'flow_usd.burn', '2026-10-05', hourlyOf({ 3: 1 }), 50);
    const rejected = await seedScan(db(), 'rpx', 'flow_usd.burn', '2026-10-06', hourlyOf({ 4: 1 }), 60);
    const llama = await seedPlain(db(), 'rpx', 'flow_usd.fees', dayEnd('2026-10-04'), 8, { method: 'measured', sourceType: 'third_party', chain: null, locator: { endpoint: 'https://api.llama.fi/summary/fees/x' }, codeVersion: 'test', configHash: 'h' });
    await db().run('UPDATE observations SET superseded_by = $2 WHERE id = $1', [superseded, burn[3]]);
    await db().run("UPDATE observations SET status = 'rejected' WHERE id = ANY($1::bigint[])", [[rejected, llama]]);
    const dry = await repriceAsset(db(), evm(), { yes: false, now: NOW, exportDir: join(scratch(), 'repriced') });
    expect(metric(dry, 'flow_usd.burn')).toMatchObject({ rows: 4, repriced: 4, inactiveCoingeckoRows: 2 });
    expect(metric(dry, 'flow_usd.fees')).toMatchObject({ rows: 3, inactiveCoingeckoRows: 0 });
    const yes = await repriceAsset(db(), evm(), { yes: true, now: NOW, exportDir: join(scratch(), 'repriced'), syncDir: () => undefined });
    expect(metric(yes, 'flow_usd.burn').inactiveCoingeckoRows).toBe(2);
    const kept = await db().all<{ id: number; value: number; locator: Record<string, unknown> }>('SELECT id, value, locator FROM observations WHERE id = ANY($1::bigint[]) ORDER BY id', [[superseded, rejected]]);
    expect(kept.map((r) => [Number(r.id), r.value, 'repriced' in (r.locator ?? {})])).toEqual([[superseded, 50, false], [rejected, 60, false]]);
  });

  it('Review Focus 5: a row with 23 of 24 hours priced is refused, counted, and keeps its value (dry run and --yes)', async () => {
    // Prices from 2026-10-01 01:00: hour 0 of 10-01 has an amount and no price at or within 6 h before it.
    await seedPrices(db(), REF, dayStartMs('2026-10-01') + H, 24 * 3);
    const gap = await seedScan(db(), 'rpx', 'flow_usd.burn', '2026-10-01', hourlyOf({ 0: 10, 5: 3 }), 100);
    const ok = await seedScan(db(), 'rpx', 'flow_usd.burn', '2026-10-02', hourlyOf({ 3: 2 }), 50);
    const exportDir = join(scratch(), 'repriced');
    for (const yes of [false, true]) {
      const r = await repriceAsset(db(), evm(), { yes, now: NOW, exportDir });
      const burn = metric(r, 'flow_usd.burn');
      expect(burn.refused).toEqual([{ id: gap, day: '2026-10-01', reason: '1 of 2 hours with an amount priced' }]);
      expect(burn.rows).toBe(2);
      expect(burn.repriced).toBe(1);
    }
    // After --yes: a third call finds the repriced row at its new value (unchanged) and the gap row still refused.
    const third = metric(await repriceAsset(db(), evm(), { yes: false, now: NOW, exportDir }), 'flow_usd.burn');
    expect(third).toMatchObject({ rows: 2, repriced: 0, unchanged: 1, refused: [{ id: gap, day: '2026-10-01', reason: '1 of 2 hours with an amount priced' }] });
    const row = await db().one<{ value: number; locator: Record<string, unknown> }>('SELECT value, locator FROM observations WHERE id = $1', [gap]);
    expect(row!.value).toBe(100);
    expect(row!.locator.repriced).toBeUndefined();
    expect((await db().one<{ value: number }>('SELECT value FROM observations WHERE id = $1', [ok]))!.value).toBeCloseTo(2 * px(dayStartMs('2026-10-02') + 3 * H), 12);

    // Every one of 24 hours carries an amount, one of them unpriced: "23 of 24".
    await db().run("DELETE FROM prices WHERE ts = '2026-10-03T07:00:00Z'");
    await db().run("DELETE FROM prices WHERE ts >= '2026-10-03T01:00:00Z' AND ts < '2026-10-03T07:00:00Z'");
    const all = await seedScan(db(), 'rpx', 'flow_usd.burn', '2026-10-03', Array.from({ length: 24 }, () => 1), 77);
    const r = await repriceAsset(db(), evm(), { yes: false, now: NOW, exportDir });
    expect(metric(r, 'flow_usd.burn').refused).toContainEqual({ id: all, day: '2026-10-03', reason: '23 of 24 hours with an amount priced' });
  });

  it('--yes: exports every touched row whole before writing, reprices from the hours, marks provenance, recomputes the derived rows', async () => {
    const ids = await seedEvm(db());
    const touched = [...ids.burn, ...ids.usage, ...ids.rate];
    const oldRows = (await db().all<{ r: unknown }>('SELECT to_jsonb(o) AS r FROM observations o WHERE id = ANY($1::bigint[]) ORDER BY id', [touched])).map((x) => x.r);
    const home = scratch();
    const exportDir = join(home, 'repriced');
    const synced: string[] = [];
    const r = await repriceAsset(db(), evm(), { yes: true, now: NOW, exportDir, release: 'orion-2026.11.14.1', syncDir: (dd) => synced.push(dd) });
    expect(r.applied).toBe(true);
    expect(r.exportFile).toBe(join(exportDir, 'rpx-20261114T120000Z.json'));
    expect(readdirSync(exportDir)).toEqual(['rpx-20261114T120000Z.json']);
    expect(synced).toEqual([exportDir, home]);
    expect(statSync(exportDir).mode & 0o777).toBe(0o700);
    expect(statSync(r.exportFile!).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(r.exportFile!);
    expect(r.exportSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const doc = JSON.parse(bytes.toString('utf8'));
    // The export holds every old row exactly as Postgres rendered it before the write, and the derived rows' old values.
    expect(doc.observations).toEqual(oldRows);
    expect(doc).toMatchObject({ asset: 'rpx', from: null, createdAt: NOW.toISOString(), release: 'orion-2026.11.14.1' });
    expect(doc.derived.map((x: { id: number }) => x.id).sort((a: number, b: number) => a - b)).toEqual([...ids.usage, ...ids.rate].sort((a, b) => a - b));

    // Flows: value = sum of amount x the hour's chain price; marker on each.
    const rows = await db().all<{ id: number; value: number; locator: { repriced?: Record<string, unknown> }; amount: number; hourly_amounts: number[] }>(
      "SELECT id, value, locator, amount, hourly_amounts FROM observations WHERE metric_key = 'flow_usd.burn' ORDER BY observed_at",
    );
    rows.forEach((row, i) => {
      expect(row.value).toBeCloseTo(hourlyUsd(DAYS[i]!, AMOUNTS[i]!), 12);
      expect(row.locator.repriced).toEqual({ at: NOW.toISOString(), release: 'orion-2026.11.14.1', basis: 'hourly' });
      expect(row.hourly_amounts).toEqual(AMOUNTS[i]);
    });
    // The view now agrees with value on every repriced row.
    const view = await db().all<{ usd: number; legacy_usd: number; usd_basis: string }>("SELECT usd, legacy_usd, usd_basis FROM flow_usd_chain_v WHERE metric_key = 'flow_usd.burn'");
    for (const v of view) {
      expect(v.usd_basis).toBe('hourly');
      expect(v.legacy_usd).toBeCloseTo(v.usd, 9);
    }
    // Derived rows: equal derived.ts over the new values, at each stored row's observed_at.
    const newDays = new Map(rows.map((row, i) => [DAYS[i]!, row.value]));
    const expectAt = async (m: string, pts: { day: string; value: number }[]) => {
      const stored = await db().all<{ observed_at: string; value: number; locator: { repriced?: { basis: string } } }>(
        'SELECT observed_at, value, locator FROM observations WHERE metric_key = $1 AND superseded_by IS NULL ORDER BY observed_at', [m],
      );
      expect(stored.map((s) => new Date(s.observed_at).toISOString())).toEqual(pts.map((p) => dayEnd(p.day)));
      stored.forEach((s, i) => {
        expect(s.value).toBe(pts[i]!.value);
        expect(s.locator.repriced?.basis).toBe('derived');
      });
    };
    await expectAt('usage_index', burnMomentum(newDays, 3));
    await expectAt('burn_rate', flowAnnualized(newDays, 2));
    // The non-repriceable rows are untouched.
    expect((await db().all<{ value: number }>("SELECT value FROM observations WHERE metric_key = 'flow_usd.fees' ORDER BY id")).map((x) => x.value)).toEqual([5, 6, 7]);
    // In place: no row added, ids stable.
    expect(Number((await db().one<{ n: number }>('SELECT count(*)::bigint AS n FROM observations'))!.n)).toBe(4 + 2 + 3 + 3);
  });

  it('--yes twice: the second run is a no-op (no write, no export)', async () => {
    await seedEvm(db());
    const exportDir = join(scratch(), 'repriced');
    await repriceAsset(db(), evm(), { yes: true, now: NOW, exportDir });
    const after = await snapshot(db());
    const r2 = await repriceAsset(db(), evm(), { yes: true, now: new Date('2026-11-14T13:00:00.000Z'), exportDir });
    expect(metric(r2, 'flow_usd.burn')).toMatchObject({ rows: 4, repriced: 0, unchanged: 4, refused: [] });
    expect(r2.derived.every((x) => x.recomputed === 0)).toBe(true);
    expect(r2.exportFile).toBeNull();
    expect(r2.days).toBe(0);
    expect(await snapshot(db())).toEqual(after);
    expect(readdirSync(exportDir)).toHaveLength(1);
  });

  it('--from: only rows of that day on are repriced; derived rows before it stay', async () => {
    const ids = await seedEvm(db());
    const r = await repriceAsset(db(), evm(), { yes: true, now: NOW, exportDir: join(scratch(), 'repriced'), from: '2026-10-03' });
    expect(metric(r, 'flow_usd.burn')).toMatchObject({ rows: 2, repriced: 2 });
    const values = (await db().all<{ value: number }>('SELECT value FROM observations WHERE id = ANY($1::bigint[]) ORDER BY id', [ids.burn])).map((x) => x.value);
    expect(values.slice(0, 2)).toEqual([100, 101]);
    expect(values[2]).toBeCloseTo(hourlyUsd(DAYS[2]!, AMOUNTS[2]!), 12);
    expect(await errCode(repriceAsset(db(), evm(), { yes: false, now: NOW, exportDir: scratch(), from: '2026-13-01' }))).toBe('invalid_day');
  });

  it('PUMP: a chain day with amount, one without (amount from the flow_tokens twin), the DefiLlama history skipped, no twin refused', async () => {
    const d = db();
    await upsertToken(d, { tokenRef: PUMP_REF, symbol: 'PUMP', decimals: null, coingeckoId: null });
    // The first stored supply reading: 2026-10-24 00:00, so 10-23 is DefiLlama history and 10-24 on is the chain.
    await seedPlain(d, 'pmp', 'total_supply', '2026-10-24T00:00:00.000Z', 1e12, { method: 'measured', sourceType: 'contract_state', chain: 'solana:mainnet', locator: { adapter: 'solana.token_supply' }, codeVersion: 'test', configHash: 'h' }, { periodDays: null });
    const burnProv: Provenance = { method: 'measured', sourceType: 'contract_state', chain: 'solana:mainnet', locator: { adapter: 'solana.supply_burn_daily', params: { unit: 'usd' } }, codeVersion: 'test', configHash: 'h' };
    const history = await seedPlain(d, 'pmp', 'flow_usd.buyback', dayEnd('2026-10-23'), 900, burnProv);
    await seedPlain(d, 'pmp', 'flow_tokens.buyback', dayEnd('2026-10-23'), 450, burnProv);
    const noAmount = await seedPlain(d, 'pmp', 'flow_usd.buyback', dayEnd('2026-10-24'), 1000, burnProv);
    await seedPlain(d, 'pmp', 'flow_tokens.buyback', dayEnd('2026-10-24'), 400, burnProv);
    const noTwin = await seedPlain(d, 'pmp', 'flow_usd.buyback', dayEnd('2026-10-25'), 1100, burnProv);
    const withAmount = await seedPlain(d, 'pmp', 'flow_usd.buyback', dayEnd('2026-10-26'), 1200, burnProv, { tokens: { tokenRef: PUMP_REF, amount: 300 } });
    const gap = await seedPlain(d, 'pmp', 'flow_usd.buyback', dayEnd('2026-10-27'), 1300, burnProv, { tokens: { tokenRef: PUMP_REF, amount: 310 } });
    // Chain prices 10-24 .. 10-27, one hour of 10-27 missing (23 of 24).
    await seedPrices(d, PUMP_REF, dayStartMs('2026-10-24'), 24 * 4, [dayStartMs('2026-10-27') + 9 * H], 'chain:solana_vaults');
    const mean = (day: string) => Array.from({ length: 24 }, (_, i) => px(dayStartMs(day) + i * H)).reduce((s, p) => s + p, 0) / 24;

    const dry = await repriceAsset(d, pump(), { yes: false, now: NOW, exportDir: scratch() });
    const m = metric(dry, 'flow_usd.buyback');
    expect(m).toMatchObject({ rows: 5, repriced: 2, skipped: { defillama_history: 1 } });
    expect(m.refused).toEqual([
      { id: noTwin, day: '2026-10-25', reason: 'no amount and no flow_tokens.buyback twin row' },
      { id: gap, day: '2026-10-27', reason: '23 of 24 hours priced (daily mean)' },
    ]);
    // flow_tokens are never repriced (not a USD row).
    expect(dry.perMetric.map((x) => x.metric)).toEqual(['flow_usd.buyback']);

    await repriceAsset(d, pump(), { yes: true, now: NOW, exportDir: join(scratch(), 'repriced'), release: 'rel' });
    const get = async (id: number) => (await d.one<{ value: number; amount: number | null; token_ref: string | null; locator: { repriced?: unknown } }>(
      'SELECT value, amount, token_ref, locator FROM observations WHERE id = $1', [id]))!;
    const a = await get(noAmount);
    expect(a.amount).toBe(400);
    expect(a.token_ref).toBe(PUMP_REF);
    expect(a.value).toBeCloseTo(400 * mean('2026-10-24'), 12);
    expect(a.locator.repriced).toEqual({ at: NOW.toISOString(), release: 'rel', basis: 'daily_mean' });
    expect((await get(withAmount)).value).toBeCloseTo(300 * mean('2026-10-26'), 12);
    for (const [id, v] of [[history, 900], [noTwin, 1100], [gap, 1300]] as const) {
      const row = await get(id);
      expect(row.value).toBe(v);
      expect(row.locator.repriced).toBeUndefined();
    }
    // The view prices the twin-filled row on the daily mean now.
    const v = await d.one<{ usd_basis: string; usd: number }>('SELECT usd_basis, usd FROM flow_usd_chain_v WHERE id = $1', [noAmount]);
    expect(v!.usd_basis).toBe('daily_mean');
    expect(v!.usd).toBeCloseTo(a.value, 9);
  });

  it('P4: coingecko:crvusd and coingecko:yearn-crv refs are remapped (yCRV token row added) before the rows are priced', async () => {
    const d = db();
    await upsertToken(d, { tokenRef: 'coingecko:crvusd', symbol: 'crvusd', decimals: null, coingeckoId: 'crvusd' });
    await upsertToken(d, { tokenRef: 'coingecko:yearn-crv', symbol: 'yearn-crv', decimals: null, coingeckoId: 'yearn-crv' });
    await upsertPrices(d, 'coingecko:crvusd', 'coingecko', [{ ts: '2026-10-01T00:00:00.000Z', priceUsd: 1 }], NOW.toISOString());
    await seedPrices(d, CRVUSD, dayStartMs('2026-10-01'), 24, [], 'chain:chainlink_feed', () => 0.999);
    // yCRV's address ref has neither a tokens row nor a price here.
    const a = await seedScan(d, 'rpx', 'flow_usd.burn', '2026-10-01', hourlyOf({ 4: 100 }), 100, 'coingecko:crvusd');
    const b = await seedScan(d, 'rpx', 'flow_usd.burn', '2026-10-02', hourlyOf({ 4: 10 }), 7, 'coingecko:yearn-crv');
    const tokensTwin = await seedPlain(d, 'rpx', 'flow_tokens.burn', dayEnd('2026-10-02'), 10, logScan('h'), { tokens: { tokenRef: 'coingecko:yearn-crv', amount: 10 } });

    const dry = await repriceAsset(d, evm(), { yes: false, now: NOW, exportDir: scratch() });
    expect(dry.remapped).toEqual([{ from: 'coingecko:crvusd', to: CRVUSD, rows: 1 }, { from: 'coingecko:yearn-crv', to: YCRV, rows: 2 }]);
    // Dry run: priced from the address ref already (crvUSD), refused where the address ref has no price (yCRV).
    expect(metric(dry, 'flow_usd.burn')).toMatchObject({ repriced: 1, refused: [{ id: b, day: '2026-10-02', reason: '0 of 1 hours with an amount priced' }] });
    expect((await d.one<{ token_ref: string }>('SELECT token_ref FROM observations WHERE id = $1', [a]))!.token_ref).toBe('coingecko:crvusd');

    // --yes remaps first (adding yCRV's tokens row), then prices from the address refs.
    expect(await d.one('SELECT 1 FROM tokens WHERE token_ref = $1', [YCRV])).toBeUndefined();
    const r = await repriceAsset(d, evm(), { yes: true, now: NOW, exportDir: join(scratch(), 'repriced') });
    expect(r.remapped).toEqual([{ from: 'coingecko:crvusd', to: CRVUSD, rows: 1 }, { from: 'coingecko:yearn-crv', to: YCRV, rows: 2 }]);
    expect(await d.one('SELECT symbol, decimals FROM tokens WHERE token_ref = $1', [YCRV])).toEqual({ symbol: 'yCRV', decimals: 18 });
    const refs = await d.all<{ id: number; token_ref: string; value: number }>('SELECT id, token_ref, value FROM observations WHERE id = ANY($1::bigint[]) ORDER BY id', [[a, b, tokensTwin]]);
    expect(refs.map((x) => x.token_ref)).toEqual([CRVUSD, YCRV, YCRV]);
    expect(refs[0]!.value).toBeCloseTo(99.9, 12);
    expect(refs[1]!.value).toBe(7); // yCRV has no chain price here: refused, but remapped
    expect(refs[2]!.value).toBe(10); // a token row: remapped only
    expect(await d.one("SELECT 1 FROM observations WHERE token_ref LIKE 'coingecko:%'")).toBeUndefined();
  });

  it('R30: a day that failed mid-apply, then a rerun: every derived row equals derived.ts on the final flows; a third run is a no-op', async () => {
    // Five burn days; 10-04 burns nothing (value 0 stays 0, so its flow only gets the marker). usage_index = burn_momentum 3 d.
    const days5 = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
    const d = db();
    await seedPrices(d, REF, dayStartMs('2026-09-30'), 24 * 7);
    const amounts = days5.map((_, k) => (k === 3 ? hourlyOf({}) : hourlyOf({ [k]: 3 + k, [10 + k]: 1.5, 22: 0.25 * (k + 1) })));
    const values = [10, 11, 12, 0, 14];
    const burn: number[] = [];
    for (let i = 0; i < days5.length; i++) burn.push(await seedScan(d, 'rpx', 'flow_usd.burn', days5[i]!, amounts[i]!, values[i]!));
    const old = new Map(days5.map((day, i) => [day, values[i]!]));
    const derivedProv = (name: string): Provenance => ({ method: 'derived', sourceType: 'derived', chain: null, locator: { metrics: ['flow_usd.burn'] }, formula: `${name}@1`, codeVersion: 'test', configHash: 'h' });
    for (const p of burnMomentum(old, 3)) await seedPlain(d, 'rpx', 'usage_index', dayEnd(p.day), p.value, derivedProv('burn_momentum'), { periodDays: null });
    for (const p of flowAnnualized(old, 2)) await seedPlain(d, 'rpx', 'burn_rate', dayEnd(p.day), p.value, derivedProv('flow_annualized'), { periodDays: null });

    // The 10-04 day transaction fails once (a crash or reprice_conflict mid-apply): 10-01..10-03 stay committed.
    await d.run("CREATE OR REPLACE FUNCTION t8_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 't8 boom'; END $$ LANGUAGE plpgsql");
    await d.run(`CREATE TRIGGER t8_fail BEFORE UPDATE ON observations FOR EACH ROW WHEN (OLD.id = ${Number(burn[3])}) EXECUTE FUNCTION t8_fail()`);
    const exportDir = join(scratch(), 'repriced');
    await expect(repriceAsset(d, evm(), { yes: true, now: NOW, exportDir })).rejects.toThrow(/t8 boom/);
    await d.run('DROP TRIGGER t8_fail ON observations');
    await d.run('DROP FUNCTION t8_fail()');
    expect((await d.one<{ value: number }>('SELECT value FROM observations WHERE id = $1', [burn[0]]))!.value).toBeCloseTo(hourlyUsd(days5[0]!, amounts[0]!), 12);

    await repriceAsset(d, evm(), { yes: true, now: new Date(NOW.getTime() + 1000), exportDir });
    const flows = await d.all<{ observed_at: string; value: number }>("SELECT observed_at, value FROM observations WHERE metric_key = 'flow_usd.burn' AND superseded_by IS NULL ORDER BY observed_at");
    const finalDays = new Map(flows.map((f) => [new Date(Date.parse(new Date(f.observed_at).toISOString()) - D).toISOString().slice(0, 10), f.value]));
    const storedOf = async (m: string) => (await d.all<{ observed_at: string; value: number }>(
      'SELECT observed_at, value FROM observations WHERE metric_key = $1 AND superseded_by IS NULL ORDER BY observed_at', [m],
    )).map((g) => [new Date(g.observed_at).toISOString(), g.value]);
    const want = burnMomentum(finalDays, 3);
    expect(await storedOf('usage_index')).toEqual(want.map((p) => [dayEnd(p.day), p.value]));
    expect(await storedOf('burn_rate')).toEqual(flowAnnualized(finalDays, 2).map((p) => [dayEnd(p.day), p.value]));
    // The usage_index of 10-04 moved off its CoinGecko-era value (the stale case the review reproduced).
    expect(want.find((p) => p.day === '2026-10-04')!.value).not.toBe(burnMomentum(old, 3).find((p) => p.day === '2026-10-04')!.value);

    // A third --yes writes nothing and exports nothing.
    const after = await snapshot(d);
    const r3 = await repriceAsset(d, evm(), { yes: true, now: new Date(NOW.getTime() + 2000), exportDir });
    expect(r3.exportFile).toBeNull();
    expect(r3.days).toBe(0);
    expect(r3.derived.every((x) => x.recomputed === 0)).toBe(true);
    expect(await snapshot(d)).toEqual(after);
  });

  it('PUMP: a rejected supply reading does not move the history/chain split (the adapter reads active rows only)', async () => {
    const d = db();
    await upsertToken(d, { tokenRef: PUMP_REF, symbol: 'PUMP', decimals: null, coingeckoId: null });
    const supplyProv: Provenance = { method: 'measured', sourceType: 'contract_state', chain: 'solana:mainnet', locator: { adapter: 'solana.token_supply' }, codeVersion: 'test', configHash: 'h' };
    // A rejected reading on 10-20 before the first active one on 10-24: 10-23 is still DefiLlama history.
    const rejected = await seedPlain(d, 'pmp', 'total_supply', '2026-10-20T00:00:00.000Z', 1e12, supplyProv, { periodDays: null });
    await d.run("UPDATE observations SET status = 'rejected' WHERE id = $1", [rejected]);
    await seedPlain(d, 'pmp', 'total_supply', '2026-10-24T00:00:00.000Z', 1e12, supplyProv, { periodDays: null });
    const burnProv: Provenance = { method: 'measured', sourceType: 'contract_state', chain: 'solana:mainnet', locator: { adapter: 'solana.supply_burn_daily', params: { unit: 'usd' } }, codeVersion: 'test', configHash: 'h' };
    await seedPlain(d, 'pmp', 'flow_usd.buyback', dayEnd('2026-10-23'), 900, burnProv);
    await seedPlain(d, 'pmp', 'flow_tokens.buyback', dayEnd('2026-10-23'), 450, burnProv);
    await seedPrices(d, PUMP_REF, dayStartMs('2026-10-23'), 24, [], 'chain:solana_vaults');
    const m = metric(await repriceAsset(d, pump(), { yes: false, now: NOW, exportDir: scratch() }), 'flow_usd.buyback');
    expect(m).toMatchObject({ rows: 1, repriced: 0, refused: [], skipped: { defillama_history: 1 } });
  });

  it('run_in_progress while another holder has the asset lock: --yes writes nothing and no export', async () => {
    await seedEvm(db());
    const before = await snapshot(db());
    const exportDir = join(scratch(), 'repriced');
    const held = await db().tryAssetRunLock('rpx', 'tick pid 999');
    try {
      expect(await errCode(repriceAsset(db(), evm(), { yes: true, now: NOW, exportDir }))).toBe('run_in_progress');
    } finally {
      await held!.release();
    }
    expect(await snapshot(db())).toEqual(before);
    expect(() => readdirSync(exportDir)).toThrow();
  });

  it("an export that can't be written refuses before any write", async () => {
    await seedEvm(db());
    const before = await snapshot(db());
    const blocker = join(scratch(), 'not-a-dir');
    writeFileSync(blocker, 'x');
    expect(await errCode(repriceAsset(db(), evm(), { yes: true, now: NOW, exportDir: join(blocker, 'repriced') }))).toBe('reprice_export_failed');
    expect(await snapshot(db())).toEqual(before);
  });
});
