import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { insertObservation } from '../../src/db/observations.js';
import { testCliContext, useTestDb } from '../helpers/db.js';

const db = useTestDb();
const NOW = '2026-11-12T12:00:00.000Z';

/** Ruling R2: a synthetic asset whose configured metric sits on a non-third-party source (a constant). */
const PURGE_ASSET_YAML = `
id: purg
symbol: PURG
name: Purge Test Asset
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  unlocks_next_year:
    type: level
    unit: tokens
    staleness_days: 30
    source: { type: constant, value: 1000, note: "test fixture: a non-third-party current source" }
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'orion-purge-cli-'));
  dirs.push(h);
  mkdirSync(join(h, 'assets'));
  writeFileSync(join(h, 'assets', 'purg.yaml'), PURGE_ASSET_YAML);
  return h;
}

async function orion(h: string, ...args: string[]): Promise<{ out: string; exit: number[] }> {
  const lines: string[] = [];
  const exit: number[] = [];
  const program = buildProgram(testCliContext(h, { stdout: (l) => lines.push(l), now: () => new Date(NOW), setExitCode: (c) => exit.push(c) }));
  await program.parseAsync(args, { from: 'user' });
  return { out: lines.join('\n'), exit };
}

async function seed(metricKey: string, sourceType: 'third_party' | 'constant', observedAt: string, value: number): Promise<void> {
  await insertObservation(db(), {
    assetId: 'purg', metricKey, observedAt, value, periodDays: metricKey.startsWith('flow_') ? 1 : null, fetchedAt: observedAt,
    provenance: { method: sourceType === 'constant' ? 'disclosed' : 'measured', sourceType, chain: null, locator: { test: true }, codeVersion: 'test', configHash: 'test' },
  });
}

const obsCount = async (): Promise<number> => Number((await db().one<{ n: number }>('SELECT count(*)::bigint AS n FROM observations'))!.n);

describe('orion data purge', () => {
  it('cli: without --yes prints the dry run and the dry-run line, deleting nothing', async () => {
    const h = home();
    await seed('flow_usd.llama_fees', 'third_party', '2026-10-01T00:00:00Z', 10);
    await seed('flow_usd.llama_fees', 'third_party', '2026-10-02T00:00:00Z', 20);
    const r = await orion(h, 'data', 'purge', 'purg', '--metric', 'flow_usd.llama_fees');
    expect(r.exit).toEqual([]);
    expect(r.out.split('\n')).toEqual([
      'PURG purge (dry run), all source types:',
      '  flow_usd.llama_fees (not configured): 2 observation(s), 0 superseded, 2026-10-01 to 2026-10-02, value sum 30; latest_levels 0, watch_state 0, fetch_cursors 0',
      `dry run: nothing deleted; --yes deletes and exports to ${join(h, 'purged')}`,
    ]);
    expect(await obsCount()).toBe(2);
    expect(() => readdirSync(join(h, 'purged'))).toThrow();
    const j = await orion(h, 'data', 'purge', 'purg', '--metric', 'flow_usd.llama_fees', '--json');
    expect(JSON.parse(j.out)).toMatchObject({ asset: 'purg', applied: false, exportFile: null, perMetric: [{ metric: 'flow_usd.llama_fees', observations: 2 }] });
  });

  it('cli: --yes exports to $ORION_HOME/purged, prints the file and its sha256, then deletes', async () => {
    const h = home();
    await seed('flow_usd.llama_fees', 'third_party', '2026-10-01T00:00:00Z', 10);
    await seed('unlocks_next_year', 'third_party', '2026-10-01T00:00:00Z', 5);
    await seed('unlocks_next_year', 'constant', '2026-10-02T00:00:00Z', 1000);
    const r = await orion(h, 'data', 'purge', 'purg', '--metric', 'flow_usd.llama_fees', '--metric', 'unlocks_next_year', '--source-type', 'third_party', '--yes');
    expect(r.exit).toEqual([]);
    const file = join(h, 'purged', 'purg-flow_usd.llama_fees+1-20261112T120000Z.json');
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(r.out.split('\n')).toEqual([
      'PURG purge, source type third_party:',
      '  flow_usd.llama_fees (not configured): 1 observation(s), 0 superseded, 2026-10-01 to 2026-10-01, value sum 10; latest_levels 0, watch_state 0, fetch_cursors 0',
      '  unlocks_next_year (configured): 1 observation(s), 0 superseded, 2026-10-01 to 2026-10-01, value sum 5; latest_levels 0, watch_state 0, fetch_cursors 0',
      `deleted; exported to ${file} sha256 ${sha}`,
    ]);
    expect(await db().all('SELECT metric_key, source_type FROM observations')).toEqual([{ metric_key: 'unlocks_next_year', source_type: 'constant' }]);
  });

  it('cli: refusals print the code under --json, exit 1, and write nothing', async () => {
    const h = home();
    await seed('unlocks_next_year', 'constant', '2026-10-02T00:00:00Z', 1000);
    const code = async (...a: string[]) => {
      const r = await orion(h, 'data', 'purge', ...a, '--json');
      expect(r.exit, a.join(' ')).toEqual([1]);
      return JSON.parse(r.out).error.code as string;
    };
    // Each refusal is the same code with and without --yes (the dry run shows what --yes would hit).
    for (const yes of [['--yes'], []]) {
      expect(await code('purg', '--metric', 'unlocks_next_year', ...yes)).toBe('purge_configured_metric');
      expect(await code('purg', '--metric', 'unlocks_next_year', '--source-type', 'constant', ...yes)).toBe('purge_live_source');
      expect(await code('purg', '--metric', 'unlocks_next_year', '--source-type', 'defillama', ...yes)).toBe('invalid_source_type');
      expect(await code('purg', ...yes)).toBe('purge_no_metric');
      expect(await code('ghost', '--metric', 'x', ...yes)).toBe('asset_not_found');
    }
    expect(await obsCount()).toBe(1);
    expect(() => readdirSync(join(h, 'purged'))).toThrow();
  });
});
