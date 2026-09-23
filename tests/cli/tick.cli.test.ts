import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TickReport } from '../../src/app/tickReport.js';
import { buildProgram } from '../../src/cli/program.js';
import { openDb } from '../../src/db/connection.js';
import { acquireRunLock } from '../../src/db/runLocks.js';
import { PERSONA_MD } from '../helpers/agentWorld.js';
import { calls, journalCall, say, scriptedModel, toolUse, type ScriptStep } from '../helpers/fakeModel.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

let home: string;
let stderr: string[];
let exitCodes: number[];
let script: ScriptStep[];

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const h = harness();
  const program = buildProgram({
    home, stdout: (l) => lines.push(l), now: () => NOW, ingestDeps: () => h.deps, stderr: (l) => stderr.push(l), setExitCode: (c) => exitCodes.push(c),
    modelClient: () => scriptedModel(script),
  });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const SKILL = (name: string, runTypes: string) => `---\nname: ${name}\ndescription: ${name}.\nrun_types: [${runTypes}]\n---\nDo ${name}.\n`;
const ASSUMPTIONS = 'all:\n  rev_growth_y1: 0\n  growth_fade_years: 1\n  terminal_growth: 0\n  capture_rate_terminal.fees: 0.1\n  capture_ramp_years.fees: 0\n  discount_rate_base: 0.1\n  staked_ratio_horizon: 0.5\n';
const lines = (file: string): unknown[] => (existsSync(join(home, file)) ? readFileSync(join(home, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown) : []);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-tick-cli-'));
  stderr = [];
  exitCodes = [];
  script = [calls(journalCall()), say('Done.')];
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), INGEST_ASSET_YAML);
  writeFileSync(join(home, 'personas', 'analyst.md'), PERSONA_MD);
  writeFileSync(join(home, 'skills', 'assumption-review.md'), SKILL('assumption-review', 'weekly, deep'));
  writeFileSync(join(home, 'skills', 'anomaly-triage.md'), SKILL('anomaly-triage', 'triage'));
  writeFileSync(join(home, 'a.yaml'), ASSUMPTIONS);
  await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1000', '--at', '2026-09-18');
  await orion('data', 'set', 'mini', 'staker_emission_share', '1', '--at', '2026-09-18');
  await orion('model', 'assumptions', 'import', 'mini', join(home, 'a.yaml'), '--rationale', 'initial');
  await orion('persona', 'assign', 'mini', 'analyst');
});

describe('orion tick', () => {
  it('prints one report line, appends it to ticks.jsonl and the signal to signals.jsonl, summarises on stderr, and exits 0', async () => {
    const text = await orion('tick', 'mini');
    expect(text.split('\n')).toHaveLength(1);
    const report = JSON.parse(text) as TickReport;
    expect(report).toMatchObject({ outcome: 'completed', asset: 'mini', signal: { status: 'ok' }, agent: { run_type: 'bootstrap', trigger_kind: 'schedule', outcome: 'completed' } });
    expect(lines('ticks.jsonl')).toEqual([report]);
    expect((lines('signals.jsonl') as { signal_id: string }[]).map((s) => s.signal_id)).toEqual([report.signal!.signal_id]); // a journal-only run moves no signal
    expect(stderr).toContain('MINI fetch ok');
    expect(stderr.some((l) => l.startsWith('agent bootstrap run (schedule)'))).toBe(true);
    expect(stderr.some((l) => l.includes('12m'))).toBe(true); // the signal summary
    expect(exitCodes).toEqual([]);
    expect(await orion('agent', 'runs', 'list')).toContain('mini  bootstrap  analyst  completed');
    expect(JSON.parse(await orion('tick', 'mini', '--json')).outcome).toBe('completed');
  });

  it('appends the agent\'s signal too when the run moved one, and the next tick runs nothing', async () => {
    const revenueId = JSON.parse(await orion('data', 'show', 'mini', 'revenue_run_rate_usd', '--json'))[0].id as number;
    script = [calls(toolUse('apply_assumption_change', { key: 'rev_growth_y1', scenario: 'base', value: 0.2, evidence: [revenueId], rationale: 'usage is accelerating markedly' })), calls(journalCall()), say('Done.')];
    const first = JSON.parse(await orion('tick', 'mini')) as TickReport;
    expect(first.agent).toMatchObject({ committed: { assumption_set_version: 2 } });
    const signals = lines('signals.jsonl') as { signal_id: string; provenance: { assumption_set_version: number; agent_run_id: number | null } }[];
    expect(signals.map((s) => s.provenance.assumption_set_version)).toEqual([1, 2]);
    expect(signals[1]).toMatchObject({ signal_id: first.agent!.signal_id, provenance: { agent_run_id: first.agent!.run_id } });
    expect(stderr.some((l) => l.includes('usage is accelerating markedly'))).toBe(false);
    expect(stderr.some((l) => l.startsWith('change: assumptions by analyst'))).toBe(true);
    const second = JSON.parse(await orion('tick', 'mini')) as TickReport;
    expect(second.agent).toBeNull(); // the bootstrap today satisfies the schedule
    expect(lines('ticks.jsonl')).toHaveLength(2);
    expect((lines('signals.jsonl') as typeof signals).map((s) => s.provenance.assumption_set_version)).toEqual([1, 2, 2]);
  });

  it('--no-agent reports what would have run, starts nothing, and records no firing', async () => {
    const report = JSON.parse(await orion('tick', 'mini', '--no-agent')) as TickReport;
    expect(report).toMatchObject({ agent: null, agent_would_run: { run_type: 'bootstrap', trigger_kind: 'schedule' }, triggers_recorded: false });
    expect(await orion('agent', 'runs', 'list')).toBe('no agent runs');
    expect(exitCodes).toEqual([]);
  });

  it('exits 2 when the signal is blocked, and 1 with an error report when the ingest cannot run', async () => {
    const db = openDb(join(home, 'orion.db'));
    db.prepare("DELETE FROM observations WHERE metric_key = 'revenue_run_rate_usd'").run();
    db.close();
    const blocked = JSON.parse(await orion('tick', 'mini')) as TickReport;
    expect(blocked.signal!.status).toBe('blocked');
    expect(exitCodes).toEqual([2]);

    exitCodes = [];
    writeFileSync(join(home, 'assets', 'manual.yaml'), (await import('../helpers/assets.js')).MINI_ASSET_YAML.replace('id: mini', 'id: manual'));
    const failed = JSON.parse(await orion('tick', 'manual')) as TickReport;
    expect(failed).toMatchObject({ outcome: 'error', error: { code: 'no_sources' }, signal: null, agent: null });
    expect(exitCodes).toEqual([1]);
    expect(lines('ticks.jsonl')).toHaveLength(2);
  });

  it('exits 0 with run_in_progress when the asset is locked, and writes only the report', async () => {
    const db = openDb(join(home, 'orion.db'));
    acquireRunLock(db, 'mini', 'agent run pid 7', NOW.toISOString());
    db.close();
    const report = JSON.parse(await orion('tick', 'mini')) as TickReport;
    expect(report).toMatchObject({ outcome: 'run_in_progress', lock: { holder: 'agent run pid 7' }, signal: null });
    expect(exitCodes).toEqual([]);
    expect(lines('signals.jsonl')).toEqual([]);
    expect(lines('ticks.jsonl')).toHaveLength(1);
  });
});
