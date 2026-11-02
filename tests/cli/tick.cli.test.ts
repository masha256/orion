import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TickReport } from '../../src/app/tickReport.js';
import { buildProgram } from '../../src/cli/program.js';
import { acquireRunLock } from '../../src/db/runLocks.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { testCliContext, useTestDb } from '../helpers/db.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

const testDb = useTestDb();

let home: string;
let stderr: string[];
let exitCodes: number[];

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const ctx = testCliContext(home, {
    stdout: (l) => lines.push(l), now: () => NOW, ingestDeps: () => h.deps, stderr: (l) => stderr.push(l), setExitCode: (c) => exitCodes.push(c),
    modelClient: () => {
      throw new Error('tick must not ask for a model');
    },
  });
  const h = harness(testDb());
  const program = buildProgram(ctx);
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const REPORTING = 'reporting:\n  window_days: 7\n  haircuts: { fees: 0 }\n';
const lines = (file: string): unknown[] => (existsSync(join(home, file)) ? readFileSync(join(home, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown) : []);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-tick-cli-'));
  stderr = [];
  exitCodes = [];
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), `${INGEST_ASSET_YAML}${REPORTING}`);
});

describe('orion tick', () => {
  it('prints one report line, appends it to ticks.jsonl, writes no signals.jsonl, summarises the fetch on stderr, and exits 0', async () => {
    const text = await orion('tick', 'mini');
    expect(text.split('\n')).toHaveLength(1);
    const report = JSON.parse(text) as TickReport;
    expect(report).toMatchObject({ schema_version: 2, outcome: 'completed', asset: 'mini', report_error: null, holder_yield: { day: '2026-09-18', price: 10 } });
    expect(existsSync(join(home, 'signals.jsonl'))).toBe(false);
    expect(lines('ticks.jsonl')).toEqual([report]);
    expect((lines('ticks.jsonl')[0] as { schema_version: number }).schema_version).toBe(2);
    expect(stderr).toContain('MINI fetch ok');
    expect(exitCodes).toEqual([]);
    expect(await orion('agent', 'runs', 'list')).toBe('no agent runs');
    expect(JSON.parse(await orion('tick', 'mini', '--json')).outcome).toBe('completed');
    expect(existsSync(join(home, 'signals.jsonl'))).toBe(false);
  });

  it('refuses --no-agent, which is gone', async () => {
    await expect(orion('tick', 'mini', '--no-agent')).rejects.toThrow(/unknown option/);
  });

  it('exits 2 when the report cannot be built, still printing it, and 1 with an error report when the ingest cannot run', async () => {
    const volume = '  flow_usd.volume: { type: flow, unit: usd, staleness_days: 45, monitor_only: true }\nholder_flows:';
    writeFileSync(join(home, 'assets', 'mini.yaml'), `${INGEST_ASSET_YAML.replace('holder_flows:', volume)}${REPORTING}  volume: [flow_usd.volume]\n`);
    const unavailable = JSON.parse(await orion('tick', 'mini')) as TickReport;
    expect(unavailable).toMatchObject({ outcome: 'completed', holder_yield: null, report_error: { code: 'report_unavailable' }, ingest: { outcome: 'ok' } });
    expect(exitCodes).toEqual([2]);

    exitCodes = [];
    writeFileSync(join(home, 'assets', 'manual.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: manual'));
    const failed = JSON.parse(await orion('tick', 'manual')) as TickReport;
    expect(failed).toMatchObject({ outcome: 'error', error: { code: 'no_sources' }, ingest: null, holder_yield: null });
    expect(exitCodes).toEqual([1]);
    expect(lines('ticks.jsonl')).toHaveLength(2);
    expect(existsSync(join(home, 'signals.jsonl'))).toBe(false);
  });

  it('exits 0 with run_in_progress when the asset is locked, and writes only the report', async () => {
    await acquireRunLock(testDb(), 'mini', 'agent run pid 7', NOW.toISOString());
    const report = JSON.parse(await orion('tick', 'mini')) as TickReport;
    expect(report).toMatchObject({ outcome: 'run_in_progress', lock: { holder: 'agent run pid 7' }, ingest: null, holder_yield: null });
    expect(exitCodes).toEqual([]);
    expect(existsSync(join(home, 'signals.jsonl'))).toBe(false);
    expect(lines('ticks.jsonl')).toHaveLength(1);
  });
});
