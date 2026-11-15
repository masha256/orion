import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { insertObservation } from '../../src/db/observations.js';
import { upsertPrices, upsertToken } from '../../src/db/prices.js';
import { testCliContext, useTestDb } from '../helpers/db.js';

const db = useTestDb();
const NOW = '2026-11-14T12:00:00.000Z';
const H = 3_600_000;
const REF = 'eip155:8453/0x00000000000000000000000000000000000000a1';

const YAML = `
id: rpx
symbol: RPX
name: Reprice CLI Test
chain: base
contracts:
  token: "0x00000000000000000000000000000000000000a1"
  burn_sink: "0x0000000000000000000000000000000000000000"
  pool: "0x00000000000000000000000000000000000000b2"
ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 100 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true, source: { type: adapter, name: price.token, params: { ref: "${REF}" } } }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.burn: { type: flow, unit: usd, staleness_days: 4, source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [ pool ], unit: usd } }
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'orion-reprice-cli-'));
  dirs.push(h);
  mkdirSync(join(h, 'assets'));
  writeFileSync(join(h, 'assets', 'rpx.yaml'), YAML);
  // The RPX token's prices.yaml entry (Ruling R32(a): its price.token and usd flow need one).
  writeFileSync(join(h, 'prices.yaml'), `"${REF}":\n  symbol: RPX\n  decimals: 18\n  chain: eip155:8453\n  valid_from: "2026-09-01"\n` +
    `  primary: { kind: chainlink, feed: "0x${'a'.repeat(40)}" }\n  check: { kind: chainlink, feed: "0x${'b'.repeat(40)}", tolerance_pct: 2 }\n`);
  return h;
}

async function orion(h: string, ...args: string[]): Promise<{ out: string; exit: number[] }> {
  const lines: string[] = [];
  const exit: number[] = [];
  const program = buildProgram(testCliContext(h, { stdout: (l) => lines.push(l), now: () => new Date(NOW), setExitCode: (c) => exit.push(c) }));
  await program.parseAsync(args, { from: 'user' });
  return { out: lines.join('\n'), exit };
}

/** Prices 2.00 every hour of 10-01..10-02; a burn day of 10 tokens in hour 5 of 10-01 stored at CoinGecko's 21; one gap day. */
async function seed(): Promise<{ ok: number; gap: number }> {
  const d = db();
  await upsertToken(d, { tokenRef: REF, symbol: 'RPX', decimals: 18, coingeckoId: null });
  const from = Date.parse('2026-10-01T00:00:00Z');
  await upsertPrices(d, REF, 'chain:v2_twap', Array.from({ length: 48 }, (_, i) => ({ ts: new Date(from + i * H).toISOString(), priceUsd: 2 })), NOW);
  const scan = async (observedAt: string, hourly: number[], value: number) => (await insertObservation(d, {
    assetId: 'rpx', metricKey: 'flow_usd.burn', observedAt, periodDays: 1, value, fetchedAt: observedAt,
    provenance: { method: 'measured', sourceType: 'log_scan', chain: 'eip155:8453', locator: { event: 'Transfer(address,address,uint256)' }, codeVersion: 'test', configHash: 'h' },
    tokens: { tokenRef: REF, amount: hourly.reduce((s, a) => s + a, 0), hourlyAmounts: hourly },
  })).id;
  const ok = await scan('2026-10-02T00:00:00.000Z', Array.from({ length: 24 }, (_, i) => (i === 5 ? 10 : 0)), 21);
  // 10-04: no price within 6 h of any hour.
  const gap = await scan('2026-10-05T00:00:00.000Z', Array.from({ length: 24 }, (_, i) => (i === 1 ? 1 : 0)), 3);
  return { ok, gap };
}

describe('orion data reprice / rebuild-price-levels / purge-prices', () => {
  it('reprice: dry run lines; --yes exports to $ORION_HOME/repriced and prints the file and its sha256', async () => {
    const h = home();
    const { ok, gap } = await seed();
    const dry = await orion(h, 'data', 'reprice', 'rpx');
    // A refused row exits 3 (dry run and --yes) so a script can't miss it.
    expect(dry.exit).toEqual([3]);
    expect(dry.out.split('\n')).toEqual([
      'RPX reprice (dry run), every day:',
      '  flow_usd.burn: 2 row(s): 1 repriced (value sum 21.00 -> 20.00), 0 unchanged, 1 refused; skipped: none; inactive: 0 superseded/rejected CoinGecko-priced row(s), kept as written',
      `    REFUSED #${gap} 2026-10-04: 0 of 1 hours with an amount priced`,
      `dry run: nothing written; --yes reprices (one transaction per day) after exporting to ${join(h, 'repriced')}`,
    ]);
    expect(() => readdirSync(join(h, 'repriced'))).toThrow();
    const yes = await orion(h, 'data', 'reprice', 'rpx', '--yes');
    const file = join(h, 'repriced', 'rpx-20261114T120000Z.json');
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(yes.out.split('\n').at(-1)).toBe(`repriced 1 day(s); exported to ${file} sha256 ${sha}`);
    expect(yes.exit).toEqual([3]);
    // --json keeps the refused list and exits 3 too.
    const jr = await orion(h, 'data', 'reprice', 'rpx', '--json');
    expect(jr.exit).toEqual([3]);
    expect(JSON.parse(jr.out).perMetric[0].refused).toEqual([{ id: gap, day: '2026-10-04', reason: '0 of 1 hours with an amount priced' }]);
    expect((await db().one<{ value: number }>('SELECT value FROM observations WHERE id = $1', [ok]))!.value).toBe(20);
    const j = JSON.parse((await orion(h, 'data', 'reprice', 'rpx', '--from', '2026-10-01', '--json')).out);
    expect(j).toMatchObject({ asset: 'rpx', from: '2026-10-01', applied: false, perMetric: [{ metric: 'flow_usd.burn', repriced: 0, unchanged: 1 }] });
    // Nothing refused from 10-05 on: exit 0.
    expect((await orion(h, 'data', 'reprice', 'rpx', '--from', '2026-10-05')).exit).toEqual([]);
    const bad = await orion(h, 'data', 'reprice', 'rpx', '--from', '2026-10-32', '--json');
    expect(bad.exit).toEqual([1]);
    expect(JSON.parse(bad.out).error.code).toBe('invalid_day');
  });

  it('rebuild-price-levels: dry run, then --yes', async () => {
    const h = home();
    await seed();
    await insertObservation(db(), {
      assetId: 'rpx', metricKey: 'price_usd', observedAt: '2026-10-02T00:47:00.000Z', value: 2.1, periodDays: null, fetchedAt: NOW,
      provenance: { method: 'measured', sourceType: 'market_data', chain: null, locator: { provider: 'coingecko' }, codeVersion: 'test', configHash: 'h' },
    });
    const dry = await orion(h, 'data', 'rebuild-price-levels', 'rpx');
    expect(dry.out.split('\n')).toEqual([
      'RPX rebuild-price-levels (dry run):',
      `  price_usd (${REF}): 1 CoinGecko row(s), 1 to rebuild, 0 refused`,
      'dry run: nothing written; --yes writes the rebuilt rows',
    ]);
    const yes = await orion(h, 'data', 'rebuild-price-levels', 'rpx', '--yes', '--json');
    expect(JSON.parse(yes.out)).toMatchObject({ asset: 'rpx', applied: true, days: 1, perMetric: [{ metric: 'price_usd', rebuilt: 1 }] });
    expect(await db().all("SELECT value, source_type FROM observations WHERE metric_key = 'price_usd' AND superseded_by IS NULL")).toEqual([{ value: 2, source_type: 'contract_state' }]);
    // Nothing refused: exit 0 on the dry run and --yes.
    expect(dry.exit).toEqual([]);
    expect(yes.exit).toEqual([]);
  });

  it('rebuild-price-levels: a refused row exits 3 (dry run and --yes) and keeps its CoinGecko row', async () => {
    const h = home();
    await seed();
    const cg = async (observedAt: string) => (await insertObservation(db(), {
      assetId: 'rpx', metricKey: 'price_usd', observedAt, value: 2.1, periodDays: null, fetchedAt: NOW,
      provenance: { method: 'measured', sourceType: 'market_data', chain: null, locator: { provider: 'coingecko' }, codeVersion: 'test', configHash: 'h' },
    })).id;
    await cg('2026-10-02T00:47:00.000Z');
    // 10-10: no chain price within 6 h.
    const gap = await cg('2026-10-10T00:47:00.000Z');
    const dry = await orion(h, 'data', 'rebuild-price-levels', 'rpx');
    expect(dry.exit).toEqual([3]);
    expect(dry.out.split('\n')[1]).toBe(`  price_usd (${REF}): 2 CoinGecko row(s), 1 to rebuild, 1 refused`);
    expect(dry.out.split('\n')[2]).toMatch(new RegExp(`^    REFUSED #${gap} 2026-10-10T00:47:00.000Z: no chain/first-party price`));
    const jd = await orion(h, 'data', 'rebuild-price-levels', 'rpx', '--json');
    expect(jd.exit).toEqual([3]);
    expect(JSON.parse(jd.out).perMetric[0].refused.map((x: { id: number }) => x.id)).toEqual([gap]);
    const yes = await orion(h, 'data', 'rebuild-price-levels', 'rpx', '--yes', '--json');
    expect(yes.exit).toEqual([3]);
    expect(JSON.parse(yes.out)).toMatchObject({ applied: true, perMetric: [{ metric: 'price_usd', rebuilt: 1 }] });
    expect((await db().one<{ superseded_by: number | null }>('SELECT superseded_by FROM observations WHERE id = $1', [gap]))!.superseded_by).toBeNull();
  });

  it('R38: rebuild lists rows before valid_from (exit 0); the market_data purge lists them, or refuses (exit 1) an unreplaced later row', async () => {
    const h = home(); // RPX valid_from 2026-09-01
    await seed();
    const cg = async (observedAt: string) => (await insertObservation(db(), {
      assetId: 'rpx', metricKey: 'price_usd', observedAt, value: 2.1, periodDays: null, fetchedAt: NOW,
      provenance: { method: 'measured', sourceType: 'market_data', chain: null, locator: { provider: 'coingecko' }, codeVersion: 'test', configHash: 'h' },
    })).id;
    const old = await cg('2026-08-31T00:47:00.000Z');
    await cg('2026-10-02T00:47:00.000Z');
    const dry = await orion(h, 'data', 'rebuild-price-levels', 'rpx');
    expect(dry.exit).toEqual([]);
    expect(dry.out.split('\n')).toEqual([
      'RPX rebuild-price-levels (dry run):',
      `  price_usd (${REF}): 2 CoinGecko row(s), 1 to rebuild, 0 refused, 1 before valid_from (never rebuilt; data purge deletes them without replacement)`,
      `    BEFORE VALID_FROM #${old} 2026-08-31T00:47:00.000Z`,
      'dry run: nothing written; --yes writes the rebuilt rows',
    ]);
    const yes = await orion(h, 'data', 'rebuild-price-levels', 'rpx', '--yes', '--json');
    expect(yes.exit).toEqual([]);
    expect(JSON.parse(yes.out).perMetric[0]).toMatchObject({ rebuilt: 1, refused: [], beforeValidFrom: [{ id: old, observedAt: '2026-08-31T00:47:00.000Z' }] });
    const pd = await orion(h, 'data', 'purge', 'rpx', '--metric', 'price_usd', '--source-type', 'market_data');
    expect(pd.exit).toEqual([]);
    expect(pd.out.split('\n').slice(1, 3)).toEqual([
      expect.stringMatching(/^  price_usd \(configured\): 2 observation\(s\), 1 superseded, 2026-08-31 to 2026-10-02/),
      `    WITHOUT REPLACEMENT #${old} 2026-08-31 (2026-08-31T00:47:00.000Z): before valid_from, deleted with no rebuilt row`,
    ]);
    // A later CoinGecko row with no rebuilt row: the purge refuses, exit 1, nothing deleted.
    const gap = await cg('2026-10-10T00:47:00.000Z');
    const refused = await orion(h, 'data', 'purge', 'rpx', '--metric', 'price_usd', '--source-type', 'market_data', '--yes', '--json');
    expect(refused.exit).toEqual([1]);
    const e = JSON.parse(refused.out).error;
    expect(e.code).toBe('purge_unreplaced_price_level');
    expect(e.message).toContain(`#${gap}`);
    expect(await db().one('SELECT 1 FROM observations WHERE id = $1', [old])).toBeDefined();
  });

  it('purge-prices: refusals under --json exit 1; the dry run lists rows; --yes deletes', async () => {
    const h = home();
    await seed();
    await upsertToken(db(), { tokenRef: 'coingecko:crvusd', symbol: 'crvusd', decimals: null, coingeckoId: 'crvusd' });
    await upsertPrices(db(), 'coingecko:crvusd', 'coingecko', [{ ts: '2026-10-01T00:00:00.000Z', priceUsd: 1 }], NOW);
    await insertObservation(db(), {
      assetId: 'rpx', metricKey: 'flow_tokens.x', observedAt: '2026-10-02T00:00:00.000Z', value: 1, periodDays: 1, fetchedAt: NOW,
      provenance: { method: 'measured', sourceType: 'log_scan', chain: 'eip155:8453', locator: {}, codeVersion: 'test', configHash: 'h' },
      tokens: { tokenRef: 'coingecko:crvusd', amount: 1, hourlyAmounts: null },
    });
    const refused = await orion(h, 'data', 'purge-prices', '--source', 'coingecko', '--yes', '--json');
    expect(refused.exit).toEqual([1]);
    expect(JSON.parse(refused.out).error.code).toBe('purge_prices_coingecko_refs');
    expect(JSON.parse((await orion(h, 'data', 'purge-prices', '--source', 'defillama', '--json')).out).error.code).toBe('invalid_price_source');
    await db().run("UPDATE observations SET status = 'rejected' WHERE metric_key = 'flow_tokens.x'");
    const dry = await orion(h, 'data', 'purge-prices', '--source', 'coingecko');
    expect(dry.out.split('\n')).toEqual([
      'purge-prices coingecko (dry run):',
      '  coingecko:crvusd: 1 row(s), 2026-10-01T00:00:00.000Z to 2026-10-01T00:00:00.000Z',
      '  tokens rows to delete: none',
      '  kept tokens row coingecko:crvusd: 1 observation(s) still reference it',
      `dry run: nothing deleted; --yes deletes and exports to ${join(h, 'purged')}`,
    ]);
    const yes = await orion(h, 'data', 'purge-prices', '--source', 'coingecko', '--yes');
    expect(yes.out.split('\n').at(-1)).toMatch(new RegExp(`^deleted; exported to ${join(h, 'purged', 'prices-coingecko-20261114T120000Z.json')} sha256 [0-9a-f]{64}$`));
    expect(await db().one("SELECT 1 FROM prices WHERE source = 'coingecko'")).toBeUndefined();
  });
});
