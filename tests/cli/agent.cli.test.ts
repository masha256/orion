import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { raiseAnomaly } from '../../src/db/anomalies.js';
import { openDb } from '../../src/db/connection.js';
import { insertProposal, type ProposalChange } from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { AGENT_ASSET_YAML, PERSONA_MD } from '../helpers/agentWorld.js';
import { calls, journalCall, say, scriptedModel, toolUse, type ScriptStep } from '../helpers/fakeModel.js';
import { AS_OF } from '../helpers/obs.js';

let home: string;
let exitCode: number | undefined;
let script: ScriptStep[];

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  exitCode = undefined;
  const program = buildProgram({
    home, stdout: (l) => lines.push(l), now: () => new Date(AS_OF), setExitCode: (c) => (exitCode = c), modelClient: () => scriptedModel(script),
  });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const SKILL = '---\nname: assumption-review\ndescription: Review assumptions.\nrun_types: [weekly, triage, deep]\n---\nReview them.\n';
const ASSUMPTIONS =
  'all:\n  rev_growth_y1: 0\n  growth_fade_years: 1\n  terminal_growth: 0\n  capture_rate_terminal.fees: 0.1\n  capture_ramp_years.fees: 0\n  discount_rate_base: 0.1\n  staked_ratio_horizon: 0.5\n';

async function seed(skip: string[] = []) {
  const rows: [string, string, string, string[]][] = [
    ['price_usd', '10', '2026-06-29', []], ['revenue_run_rate_usd', '1000', '2026-06-15', []], ['effective_supply', '100', '2026-06-29', []],
    ['staked_supply', '50', '2026-06-29', []], ['staker_emission_share', '1', '2026-06-29', []], ['emission_rate_annual', '0', '2026-01-01', []],
    ['flow_usd.fees', String((100 * 90) / 365), AS_OF, ['--period-days', '90']],
  ];
  for (const [metric, value, at, extra] of rows) {
    if (!skip.includes(metric)) await orion('data', 'set', 'mini', metric, value, '--at', at, '--source', 'onchain', ...extra);
  }
}

const withDb = <T>(fn: (db: ReturnType<typeof openDb>) => T): T => {
  const db = openDb(join(home, 'orion.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const revenueId = () => withDb((db) => (db.prepare("SELECT id FROM observations WHERE metric_key = 'revenue_run_rate_usd'").get() as { id: number }).id);
const fileProposal = (change: ProposalChange, filedAgainst: unknown) =>
  withDb((db) =>
    insertProposal(db, { assetId: 'mini', persona: 'analyst', agentRunId: null, change, filedAgainst, rationale: 'because', evidence: [revenueId()], effect: null, createdAt: AS_OF }),
  );

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-agent-cli-'));
  script = [];
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), AGENT_ASSET_YAML.trimStart());
  writeFileSync(join(home, 'personas', 'analyst.md'), PERSONA_MD);
  writeFileSync(join(home, 'skills', 'assumption-review.md'), SKILL);
  writeFileSync(join(home, 'assumptions.yaml'), ASSUMPTIONS);
});

describe('orion persona', () => {
  it('lists personas with what they cover and the skills, shows one, and assigns one', async () => {
    expect(await orion('persona', 'list')).toContain('analyst  claude-opus-5  effort high  covers: nothing');
    expect(await orion('persona', 'assign', 'mini', 'analyst')).toBe('analyst now covers mini');
    const listed = await orion('persona', 'list');
    expect(listed).toContain('covers: mini');
    expect(listed).toContain('skill assumption-review  [weekly, triage, deep]');
    expect(await orion('persona', 'show', 'analyst')).toContain('You are the analyst covering the mini test asset.');
  });

  it('refuses to assign a persona or an asset that does not exist; under --json the error is JSON and the exit code is 1', async () => {
    await expect(orion('persona', 'assign', 'mini', 'ghost')).rejects.toMatchObject({ code: 'persona_not_found' });
    await expect(orion('persona', 'assign', 'nope', 'analyst')).rejects.toMatchObject({ code: 'asset_not_found' });
    const out = JSON.parse(await orion('persona', 'assign', 'mini', 'ghost', '--json')) as { error: { code: string } };
    expect(out.error.code).toBe('persona_not_found');
    expect(exitCode).toBe(1);
  });
});

describe('orion agent run', () => {
  beforeEach(async () => {
    await seed();
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');
    await orion('persona', 'assign', 'mini', 'analyst');
  });

  const growth = () =>
    toolUse('apply_assumption_change', { key: 'rev_growth_y1', scenario: 'base', value: 0.2, evidence: [revenueId()], rationale: 'usage is accelerating' });

  it('runs, prints what was committed and the signal, appends the signal to --out, and exits 0', async () => {
    script = [calls(growth()), calls(journalCall()), say('Done.')];
    const out = await orion('agent', 'run', 'mini', '--type', 'weekly', '--out', join(home, 'signals.jsonl'));
    expect(out).toContain('#1  2026-06-30T00:00:00.000Z  mini  weekly  analyst  completed');
    expect(out).toContain('3 requests');
    expect(out).toContain('about $0.01 at list price'); // 300 input and 150 output tokens at Opus 5 prices is half a cent
    expect(out).toContain('committed rev_growth_y1 (base) 0 -> 0.2: usage is accelerating');
    expect(out).toContain('committed journal: reviewed');
    expect(out).toContain('MINI  ok  grade');
    expect(exitCode).toBeUndefined();
    const appended = JSON.parse(readFileSync(join(home, 'signals.jsonl'), 'utf8').trim()) as { provenance: { agent_run_id: number } };
    expect(appended.provenance.agent_run_id).toBe(1);
  });

  it('prints one JSON object under --json, and on a dry run says what it would commit and writes no signal file', async () => {
    script = [calls(growth()), calls(journalCall()), say('Done.')];
    const json = JSON.parse(await orion('agent', 'run', 'mini', '--type', 'weekly', '--dry-run', '--json', '--out', join(home, 's.jsonl'))) as {
      run: { outcome: string; dryRun: boolean }; committed: unknown; signal: unknown; staged: { assumptionChanges: unknown[] };
    };
    expect(json.run).toMatchObject({ outcome: 'completed', dryRun: true });
    expect(json.committed).toBeNull();
    expect(json.signal).toBeNull();
    expect(json.staged.assumptionChanges).toHaveLength(1);
    expect(existsSync(join(home, 's.jsonl'))).toBe(false);
    script = [calls(growth()), calls(journalCall()), say('Done.')];
    expect(await orion('agent', 'run', 'mini', '--type', 'weekly', '--dry-run')).toContain('would commit rev_growth_y1 (base) 0 -> 0.2');
  });

  it('exits 1 when the run does not complete, and says what was discarded', async () => {
    script = [calls(growth()), say('Done.'), say('Still done.')];
    const out = await orion('agent', 'run', 'mini', '--type', 'weekly');
    expect(out).toContain('no_journal');
    expect(out).toContain('discarded rev_growth_y1 (base) 0 -> 0.2');
    expect(exitCode).toBe(1);
  });

  it('exits 1 and commits nothing when the asset config is edited while the run is in flight', async () => {
    const file = join(home, 'assets', 'mini.yaml');
    const editTheConfigMidRun = () => {
      writeFileSync(file, readFileSync(file, 'utf8').replace('name: Mini Test Asset', 'name: Mini Test Asset Renamed'));
      return calls(journalCall());
    };
    script = [calls(growth()), editTheConfigMidRun, say('Done.')];
    const out = await orion('agent', 'run', 'mini', '--type', 'weekly');
    expect(out).toContain('conflict');
    expect(out).toContain('the asset config changed during the run');
    expect(out).toContain('discarded rev_growth_y1 (base) 0 -> 0.2');
    expect(exitCode).toBe(1);
    expect(withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM journal').get() as { n: number }).n).toBe(0);
  });

  it('exits 2 when the run completes but its signal is blocked', async () => {
    withDb((db) => db.prepare("UPDATE observations SET status = 'rejected' WHERE metric_key = 'price_usd'").run());
    const a = withDb((db) =>
      raiseAnomaly(db, { assetId: 'mini', kind: 'source_failure_streak', metricKey: '', dedupeKey: 'coingecko', severity: 'advisory', detail: {}, seenAt: AS_OF }),
    );
    script = [calls(toolUse('resolve_anomaly', { id: a.id, note: 'the source is back', evidence: [revenueId()] })), calls(journalCall()), say('Done.')];
    const out = await orion('agent', 'run', 'mini', '--type', 'triage', '--anomaly', String(a.id));
    expect(out).toContain('committed anomaly #1 resolved: the source is back');
    expect(out).toContain('MINI  blocked');
    expect(exitCode).toBe(2);
  });

  it('fails preflight without calling the model', async () => {
    await expect(orion('agent', 'run', 'mini', '--type', 'hourly')).rejects.toMatchObject({ code: 'invalid_run_type' });
    await expect(orion('agent', 'run', 'mini', '--type', 'triage')).rejects.toMatchObject({ code: 'triage_needs_target' });
    const out = JSON.parse(await orion('agent', 'run', 'mini', '--type', 'triage', '--json')) as { error: { code: string } };
    expect(out.error.code).toBe('triage_needs_target');
    expect(exitCode).toBe(1);
    expect(await orion('agent', 'runs', 'list')).toBe('no agent runs');
  });

  it('lists past runs and shows one with its cost estimate and, on request, its transcript', async () => {
    script = [calls(growth()), calls(journalCall()), say('Done.')];
    await orion('agent', 'run', 'mini', '--type', 'weekly');
    expect(await orion('agent', 'runs', 'list', 'mini')).toContain('#1  2026-06-30T00:00:00.000Z  mini  weekly  analyst  completed');
    const shown = await orion('agent', 'runs', 'show', '1');
    expect(shown).toContain('model claude-opus-5');
    expect(shown).toContain('committed rev_growth_y1 (base) 0 -> 0.2');
    expect(shown).toContain('signal mini-');
    expect(shown).not.toContain('context pack');
    expect(await orion('agent', 'runs', 'show', '1', '--transcript')).toContain('This is your context pack');
    const json = JSON.parse(await orion('agent', 'runs', 'show', '1', '--json')) as { estimated_cost_usd: number };
    expect(json.estimated_cost_usd).toBeCloseTo((300 * 5 + 150 * 25) / 1_000_000, 9);
    await expect(orion('agent', 'runs', 'show', '9')).rejects.toMatchObject({ code: 'agent_run_not_found' });
  });

  it('refuses a --limit that is not a positive whole number, rather than let SQLite read it as no limit', async () => {
    for (const bad of ['-5', '0', '2.5', 'many']) {
      await expect(orion('agent', 'runs', 'list', '--limit', bad)).rejects.toMatchObject({ code: bad === 'many' ? 'invalid_number' : 'invalid_limit' });
    }
    const out = JSON.parse(await orion('agent', 'runs', 'list', '--limit', '-5', '--json')) as { error: { code: string } };
    expect(out.error.code).toBe('invalid_limit');
    expect(exitCode).toBe(1);
    expect(await orion('agent', 'runs', 'list', '--limit', '3')).toBe('no agent runs');
  });
});

describe('orion model proposals', () => {
  beforeEach(async () => {
    await seed();
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');
  });

  it('lists pending proposals, shows one with its evidence, and approves a value as a new set', async () => {
    expect(await orion('model', 'proposals', 'list')).toBe('no proposals');
    const p = fileProposal({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 1.8 }, { value: 0 });
    expect(await orion('model', 'proposals', 'list', 'mini')).toContain(`#${p.id}  mini  analyst  assumption_value  pending  rev_growth_y1 (base) -> 1.8  0d old`);
    const shown = await orion('model', 'proposals', 'show', String(p.id));
    expect(shown).toContain('rationale: because');
    expect(shown).toContain('revenue_run_rate_usd = 1000');
    expect(await orion('model', 'proposals', 'approve', String(p.id), '--note', 'agreed')).toBe(`proposal #${p.id} approved\nsaved as assumption set v2`);
    expect(await orion('model', 'proposals', 'list')).toBe('no proposals');
    expect(await orion('model', 'proposals', 'list', '--all')).toContain('approved');
    expect(await orion('model', 'assumptions', 'history', 'mini')).toContain(`Approved proposal #${p.id} from analyst: because`);
  });

  it('approving a config proposal edits the YAML and says to review and commit it', async () => {
    const p = fileProposal({ kind: 'config', edits: [{ path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 2 } }] }, [{ min: 0, max: 1 }]);
    const out = await orion('model', 'proposals', 'approve', String(p.id));
    // " > ", not ".": assumption keys contain dots, so a dotted path is ambiguous.
    expect(out).toContain('assumptions > rev_growth_y1 > base: {"max":1,"min":0} -> {"max":2,"min":0}');
    expect(out).toContain('review it with "git diff", then commit it');
    expect(readFileSync(join(home, 'assets', 'mini.yaml'), 'utf8')).toContain('rev_growth_y1: { min: -0.5, max: 5, base: { min: 0, max: 2 } }');
  });

  it('marks a config proposal that would change what the agent may do by itself, in the list and in show', async () => {
    const band = fileProposal({ kind: 'config', edits: [{ path: ['assumptions', 'rev_growth_y1', 'base'], value: { min: 0, max: 2 } }] }, [{ min: 0, max: 1 }]);
    const weight = fileProposal({ kind: 'config', edits: [{ path: ['modules', 'hc', 'weight'], value: 1 }] }, [1]);
    const listed = await orion('model', 'proposals', 'list', 'mini');
    expect(listed).toContain(`#${band.id}`);
    expect(listed.split('\n').find((l) => l.includes(`#${band.id}`))).toContain("[changes the agent's limits]");
    expect(listed.split('\n').find((l) => l.includes(`#${weight.id}`))).not.toContain("[changes the agent's limits]");
    expect(await orion('model', 'proposals', 'show', String(band.id))).toContain("[changes the agent's limits]");
    expect(await orion('model', 'proposals', 'show', String(weight.id))).not.toContain("[changes the agent's limits]");
  });

  it('rejects with a required note, and reports a stale or missing proposal as JSON under --json', async () => {
    const p = fileProposal({ kind: 'assumption_value', key: 'rev_growth_y1', scenario: 'base', value: 1.8 }, { value: 0.5 });
    const stale = JSON.parse(await orion('model', 'proposals', 'approve', String(p.id), '--json')) as { error: { code: string } };
    expect(stale.error.code).toBe('stale_proposal');
    expect(exitCode).toBe(1);
    expect(await orion('model', 'proposals', 'reject', String(p.id), '--note', 'filed against an old value')).toBe(`proposal #${p.id} rejected: filed against an old value`);
    await expect(orion('model', 'proposals', 'show', '99')).rejects.toMatchObject({ code: 'proposal_not_found' } satisfies Partial<OrionError>);
  });
});
