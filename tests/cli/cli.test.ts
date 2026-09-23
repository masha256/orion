import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { AS_OF } from '../helpers/obs.js';

let home: string;

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const program = buildProgram({ home, stdout: (l) => lines.push(l), now: () => new Date(AS_OF) });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const ASSUMPTIONS_YAML = `
all:
  rev_growth_y1: 0
  growth_fade_years: 1
  terminal_growth: 0
  capture_rate_terminal.fees: 0.1
  capture_ramp_years.fees: 0
  discount_rate_base: 0.1
  staked_ratio_horizon: 0.5
bull:
  discount_rate_base: 0.05
`;

async function seedData() {
  await orion('data', 'set', 'mini', 'price_usd', '10', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1000', '--at', '2026-06-15', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'effective_supply', '100', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'staked_supply', '50', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'staker_emission_share', '1', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'emission_rate_annual', '0', '--at', '2026-01-01', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'flow_usd.fees', String((100 * 90) / 365), '--at', AS_OF, '--period-days', '90', '--source', 'onchain');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-cli-'));
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  writeFileSync(join(home, 'assumptions.yaml'), ASSUMPTIONS_YAML);
});

describe('orion cli', () => {
  it('init creates the home layout and database', () => {
    for (const d of ['assets', 'personas', 'skills', 'calibration']) expect(existsSync(join(home, d))).toBe(true);
    expect(existsSync(join(home, 'orion.db'))).toBe(true);
  });

  it('lists, shows, and validates assets', async () => {
    expect(JSON.parse(await orion('asset', 'list', '--json'))).toEqual(['mini']);
    expect(JSON.parse(await orion('asset', 'show', 'mini', '--json')).hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(await orion('asset', 'validate', '--json'))).toEqual([{ id: 'mini', errors: [] }]);
    mkdirSync(join(home, 'assets'), { recursive: true });
    writeFileSync(join(home, 'assets', 'bad.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: bad').replace('type: holder_cashflow', 'type: nope'));
    await expect(orion('asset', 'validate', 'bad')).rejects.toThrow(/validation failed/);
  });

  it('rejects data for a metric the asset does not define', async () => {
    await expect(orion('data', 'set', 'mini', 'nonsense', '1')).rejects.toThrow(/not defined/);
  });

  it('requires --period-days for a flow metric and refuses it for any other type', async () => {
    await expect(orion('data', 'set', 'mini', 'flow_usd.fees', '100', '--at', AS_OF)).rejects.toThrow(/--period-days/);
    await expect(
      orion('data', 'set', 'mini', 'price_usd', '10', '--at', AS_OF, '--period-days', '30'),
    ).rejects.toThrow(/--period-days/);
  });

  it('refuses an invalid --as-of on whatif, the same as on run', async () => {
    await expect(orion('model', 'whatif', 'mini', '--as-of', 'not-a-date')).rejects.toThrow(/invalid --as-of/);
  });

  it('runs the full flow: data, assumptions, run, replay, what-if, emit', async () => {
    await seedData();
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');

    const signal = JSON.parse(await orion('model', 'run', 'mini', '--json'));
    expect(signal.status).toBe('ok');
    expect(signal.horizons['12m'].scenarios.bull.target).toBeCloseTo(20, 6);
    expect(signal.horizons['12m'].expected_target).toBeCloseTo(12.5, 6);

    expect(JSON.parse(await orion('signal', 'latest', 'mini', '--json')).signal_id).toBe(signal.signal_id);
    expect(JSON.parse(await orion('model', 'replay', String(signal.provenance.run_id), '--json')).identical).toBe(true);

    await orion('model', 'assumptions', 'set', 'mini', 'discount_rate_base', '0.2', '--scenario', 'bear', '--rationale', 'more cautious bear');
    const history = JSON.parse(await orion('model', 'assumptions', 'history', 'mini', '--json'));
    expect(history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    const shown = JSON.parse(await orion('model', 'assumptions', 'show', 'mini', '--json'));
    expect(shown.values.bear.discount_rate_base).toBe(0.2);
    expect(shown.values.base.discount_rate_base).toBe(0.1);

    const wi = JSON.parse(await orion('model', 'whatif', 'mini', '--set', 'discount_rate_base=0.05', '--scenario', 'base', '--json'));
    expect(wi.output.horizons['12m'].scenarios.base.target).toBeCloseTo(20, 6);

    const out = join(home, 'signals.jsonl');
    await orion('signal', 'emit', 'mini', '--out', out);
    expect(JSON.parse(readFileSync(out, 'utf8').trim()).signal_id).toBe(signal.signal_id);
    expect(JSON.parse(await orion('signal', 'history', 'mini', '--json'))).toHaveLength(1);
    // SQLite reads a negative LIMIT as "no limit": the guard refuses it rather than return every row.
    for (const bad of ['-5', '0', '2.5']) {
      await expect(orion('signal', 'history', 'mini', '--limit', bad)).rejects.toMatchObject({ code: 'invalid_limit' });
    }
    await expect(orion('signal', 'history', 'mini', '--limit', 'many')).rejects.toMatchObject({ code: 'invalid_number' });
    expect(JSON.parse(await orion('signal', 'history', 'mini', '--limit', '1', '--json'))).toHaveLength(1);
  });

  it('refuses out-of-bounds assumptions', async () => {
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');
    await expect(
      orion('model', 'assumptions', 'set', 'mini', 'discount_rate_base', '0.9', '--rationale', 'too high'),
    ).rejects.toThrow(/outside/);
  });

  it('handles provisional observations through confirm', async () => {
    await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1200', '--at', '2026-06-20', '--provisional', '--citation', 'https://example.com/post', '--quote', 'crossed 1200');
    const shown = JSON.parse(await orion('data', 'show', 'mini', 'revenue_run_rate_usd', '--json'));
    expect(shown[0].status).toBe('provisional');
    // The inbox is where the row waits, with its id, and without the quote.
    const inbox = JSON.parse(await orion('inbox', 'mini', '--json'));
    expect(inbox).toMatchObject({ asset: 'mini', observations: [{ id: shown[0].id, metric: 'revenue_run_rate_usd', value: 1200, citation_url: 'https://example.com/post', recorded_by: null }], proposals: [], anomalies: [] });
    expect(JSON.stringify(inbox)).not.toContain('crossed 1200');
    expect(await orion('inbox', 'mini')).toMatch(/^obs #\d+  revenue_run_rate_usd  1200 at 2026-06-20  no confirmed value  entered by hand  https:\/\/example.com\/post$/);
    const confirmed = JSON.parse(await orion('data', 'confirm', String(shown[0].id), '--json'));
    expect(confirmed.status).toBe('confirmed');
    expect(await orion('inbox', 'mini')).toBe('nothing to decide');
    await expect(orion('data', 'set', 'mini', 'price_usd', '1', '--provisional')).rejects.toThrow(/citation/);
  });

  it('accepts --json on signal emit, same as every other command', async () => {
    await seedData();
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');
    const signal = JSON.parse(await orion('model', 'run', 'mini', '--json'));

    const emitted = JSON.parse(await orion('signal', 'emit', 'mini', '--json'));
    expect(emitted.signal_id).toBe(signal.signal_id);
  });

  it('prints a readable summary without --json', async () => {
    await seedData();
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');
    const text = await orion('model', 'run', 'mini');
    expect(text).toMatch(/MINI\s+ok\s+grade A/);
    expect(text).toMatch(/12m\s+expected 12\.5000/);
  });
});
