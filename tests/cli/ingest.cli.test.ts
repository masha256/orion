import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { harness, NOW, STATS } from '../helpers/fetchHarness.js';
import type { Route } from '../helpers/fakeHttp.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

let home: string;
let routes: Record<string, Route>;
let stderr: string[];

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const h = harness({ routes });
  const program = buildProgram({ home, stdout: (l) => lines.push(l), now: () => NOW, ingestDeps: () => h.deps, stderr: (l) => stderr.push(l) });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-ingest-cli-'));
  routes = {};
  stderr = [];
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), INGEST_ASSET_YAML);
});

describe('orion data fetch', () => {
  it('fetches one asset, writes observations, and reports each source', async () => {
    const result = JSON.parse(await orion('data', 'fetch', 'mini', '--json'));
    expect(result.outcome).toBe('ok');
    expect(result.sources.map((s: { sourceId: string }) => s.sourceId)).toContain('coingecko');
    const shown = JSON.parse(await orion('data', 'show', 'mini', 'price_usd', '--json'));
    expect(shown[0]).toMatchObject({ value: 10, source: 'api' });
    expect(stderr.some((l) => /transfer_flow.*2026-09-18: 0 transfers/.test(l))).toBe(true);
  });

  it('prints a readable summary', async () => {
    const text = await orion('data', 'fetch', 'mini');
    expect(text).toMatch(/^MINI fetch ok$/m);
    expect(text).toMatch(/ok\s+coingecko\s+wrote price_usd, circulating_supply/);
    expect(text).toMatch(/check price_usd vs http_json:.*10 vs 10\.1 \(1\.00% within 2%\)/);
  });

  it('with no asset, fetches every asset that has a source and returns an array', async () => {
    writeFileSync(join(home, 'assets', 'manual.yaml'), (await import('../helpers/assets.js')).MINI_ASSET_YAML.replace('id: mini', 'id: manual'));
    const results = JSON.parse(await orion('data', 'fetch', '--dry-run', '--json'));
    expect(results.map((r: { assetId: string }) => r.assetId)).toEqual(['mini']);
    expect(results[0].dryRun).toBe(true);
    expect(JSON.parse(await orion('data', 'show', 'mini', '--json'))).toEqual([]);
  });

  it('narrows with repeatable --metric and validates --backfill-days', async () => {
    const result = JSON.parse(await orion('data', 'fetch', 'mini', '--metric', 'price_usd', '--metric', 'circulating_supply', '--json'));
    expect(result.written.map((w: { metricKey: string }) => w.metricKey)).toEqual(['price_usd', 'circulating_supply']);
    await expect(orion('data', 'fetch', 'mini', '--backfill-days', 'abc')).rejects.toThrow(/--backfill-days/);
    await expect(orion('data', 'fetch', 'mini', '--backfill-days', '0')).rejects.toThrow(/positive whole number/);
    await expect(orion('data', 'fetch', 'mini', '--metric', 'nope')).rejects.toThrow(/not defined/);
  });

  it('explains conflicts, and adopts with --adopt', async () => {
    await orion('data', 'set', 'mini', 'flow_usd.fees', '5000', '--at', '2026-09-18', '--period-days', '30');
    const refused = await orion('data', 'fetch', 'mini');
    expect(refused).toMatch(/^MINI fetch partial$/m);
    expect(refused).toMatch(/skipped\s+transfer_flow/);
    expect(refused).toMatch(/conflict #\d+ flow_usd\.fees manual .*adoptable/);
    expect(refused).toMatch(/--adopt/);
    const adopted = JSON.parse(await orion('data', 'fetch', 'mini', '--adopt', '--json'));
    expect(adopted.sources.find((s: { sourceId: string }) => s.sourceId.startsWith('transfer_flow')).retiredObservationIds).toHaveLength(1);
  });
});

describe('orion data sources', () => {
  it('shows each sourced metric, its cross-checks, the last fetch outcome, and the age of the value in force', async () => {
    const before = JSON.parse(await orion('data', 'sources', 'mini', '--json'));
    expect(before.find((r: { metric: string }) => r.metric === 'price_usd')).toEqual({
      metric: 'price_usd', type: 'coingecko', sourceId: 'coingecko', crossChecks: [{ sourceId: `http_json:${STATS}`, tolerancePct: 2 }],
      lastFetch: null, valueInForce: null,
    });
    expect(before.some((r: { metric: string }) => r.metric === 'revenue_run_rate_usd')).toBe(false);

    await orion('data', 'fetch', 'mini');
    const after = JSON.parse(await orion('data', 'sources', 'mini', '--json'));
    const price = after.find((r: { metric: string }) => r.metric === 'price_usd');
    expect(price.lastFetch).toEqual({ at: NOW.toISOString(), status: 'ok', error: null });
    expect(price.valueInForce).toEqual({ value: 10, observedAt: NOW.toISOString(), ageDays: 0 });
    const flow = after.find((r: { metric: string }) => r.metric === 'flow_usd.fees');
    expect(flow.valueInForce.ageDays).toBeCloseTo(0.5, 9); // the last complete day ended at midnight, twelve hours before NOW
    expect(await orion('data', 'sources', 'mini')).toMatch(/price_usd\s+coingecko\s+last fetch ok\s+value 10 \(0\.0 days old\)/);
  });
});

describe('orion data anomalies, resolve, ack', () => {
  it('lists open anomalies, then hides them once they are decided', async () => {
    routes = { [STATS]: { price: 12, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } };
    await orion('data', 'fetch', 'mini');
    const open = JSON.parse(await orion('data', 'anomalies', '--json'));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', severity: 'degrading', status: 'open' });
    expect(await orion('data', 'anomalies', 'mini')).toMatch(/#1\s+open\s+degrading\s+cross_check_mismatch\s+price_usd/);

    const acked = JSON.parse(await orion('data', 'ack', String(open[0].id), '--note', 'venice lags', '--json'));
    expect(acked).toMatchObject({ status: 'acknowledged', note: 'venice lags' });
    expect(await orion('data', 'anomalies', 'mini')).toBe('no open anomalies');
    expect(JSON.parse(await orion('data', 'anomalies', 'mini', '--all', '--json'))).toHaveLength(1);

    await orion('data', 'fetch', 'mini'); // the mismatch recurs: a new anomaly opens
    const again = JSON.parse(await orion('data', 'anomalies', 'mini', '--json'));
    expect(again[0].id).not.toBe(open[0].id);
    expect(JSON.parse(await orion('data', 'resolve', String(again[0].id), '--note', 'fixed', '--json')).status).toBe('resolved');
  });

  it('requires a note and an open anomaly', async () => {
    await expect(orion('data', 'ack', '1')).rejects.toThrow(/note/);
    await expect(orion('data', 'resolve', '99', '--note', 'x')).rejects.toThrow(/no anomaly with id 99/);
  });
});

describe('orion update', () => {
  let exitCodes: number[];

  async function update(...args: string[]): Promise<string> {
    const lines: string[] = [];
    const h = harness({ routes });
    const program = buildProgram({
      home, stdout: (l) => lines.push(l), now: () => NOW, ingestDeps: () => h.deps, stderr: (l) => stderr.push(l), setExitCode: (c) => exitCodes.push(c),
    });
    await program.parseAsync(['update', ...args], { from: 'user' });
    return lines.join('\n');
  }

  beforeEach(() => {
    exitCodes = [];
  });

  const ASSUMPTIONS = 'all:\n  rev_growth_y1: 0\n  growth_fade_years: 1\n  terminal_growth: 0\n  capture_rate_terminal.fees: 0.1\n  capture_ramp_years.fees: 0\n  discount_rate_base: 0.1\n  staked_ratio_horizon: 0.5\n';

  it('emits one JSON signal line on stdout, the fetch summary on stderr, and exits 0 when ok', async () => {
    await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1000', '--at', '2026-09-18');
    await orion('data', 'set', 'mini', 'staker_emission_share', '1', '--at', '2026-09-18');
    writeFileSync(join(home, 'a.yaml'), ASSUMPTIONS);
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'a.yaml'), '--rationale', 'initial');

    const out = join(home, 'signals.jsonl');
    const text = await update('mini', '--out', out);
    expect(text.split('\n')).toHaveLength(1);
    const signal = JSON.parse(text);
    expect(signal.status).toBe('ok');
    expect(JSON.parse((await import('node:fs')).readFileSync(out, 'utf8').trim()).signal_id).toBe(signal.signal_id);
    expect(stderr.some((l) => l === 'MINI fetch ok')).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(JSON.parse(await orion('signal', 'latest', 'mini', '--json')).signal_id).toBe(signal.signal_id);
    expect(JSON.parse(await update('mini', '--json')).status).toBe('ok'); // --json is accepted; the output is JSON either way
  });

  it('exits 2 for a blocked signal, and still emits it', async () => {
    const signal = JSON.parse(await update('mini'));
    expect(signal.status).toBe('blocked');
    expect(exitCodes).toEqual([2]);
  });

  it('throws for a configuration error, which the entry point turns into exit 1', async () => {
    writeFileSync(join(home, 'assets', 'manual.yaml'), (await import('../helpers/assets.js')).MINI_ASSET_YAML.replace('id: mini', 'id: manual'));
    await expect(update('manual')).rejects.toThrow(/nothing to fetch/);
  });
});
