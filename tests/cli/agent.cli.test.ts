import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { finishAgentRun, startAgentRun } from '../../src/db/agentRuns.js';
import { raiseAnomaly } from '../../src/db/anomalies.js';
import type { Db } from '../../src/db/connection.js';
import { insertDocument } from '../../src/db/documents.js';
import { insertProposal, type ProposalChange } from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { AGENT_ASSET_YAML, PERSONA_MD } from '../helpers/agentWorld.js';
import { testCliContext, useTestDb } from '../helpers/db.js';
import { calls, journalCall, say, scriptedModel, toolUse, type ScriptStep } from '../helpers/fakeModel.js';
import { AS_OF } from '../helpers/obs.js';

const testDb = useTestDb();

let home: string;
let exitCode: number | undefined;
let script: ScriptStep[];
let docId: number;

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  exitCode = undefined;
  const program = buildProgram(testCliContext(home, {
    stdout: (l) => lines.push(l), now: () => new Date(AS_OF), setExitCode: (c) => (exitCode = c), modelClient: () => scriptedModel(script),
  }));
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const SKILL = '---\nname: disclosure-review\ndescription: Review a disclosure.\nrun_types: [disclosure]\n---\nReview it.\n';
const POST = 'Mini said its annualized revenue reached $1,100 in September.\n\nStaked supply now stands at 55 tokens across the network.\n';
const STAKED_QUOTE = 'Staked supply now stands at 55 tokens across the network.';

async function seed(skip: string[] = []) {
  const rows: [string, string, string, string[]][] = [
    ['price_usd', '10', '2026-06-29', []], ['revenue_run_rate_usd', '1000', '2026-06-15', []], ['total_supply', '100', '2026-06-29', []],
    ['staked_supply', '50', '2026-06-29', []], ['staker_emission_share', '1', '2026-06-29', []], ['emission_rate_annual', '0', '2026-01-01', []],
    ['flow_usd.fees', String((100 * 90) / 365), AS_OF, ['--period-days', '90']],
  ];
  for (const [metric, value, at, extra] of rows) {
    if (!skip.includes(metric)) await orion('data', 'set', 'mini', metric, value, '--at', at, '--source', 'onchain', ...extra);
  }
}

/** The CLI's database, as the test reads and writes it between commands. */
const withDb = async <T>(fn: (db: Db) => T | Promise<T>): Promise<T> => await fn(testDb());
const revenueId = async () => await withDb(async (db) => (await db.one<{ id: number }>("SELECT id FROM observations WHERE metric_key = 'revenue_run_rate_usd'"))!.id);
const fileProposal = async (change: ProposalChange, filedAgainst: unknown, effect: unknown = null) => {
  const evidence = [await revenueId()];
  return await withDb(async (db) =>
    await insertProposal(db, {
      assetId: 'mini', persona: 'analyst', agentRunId: null, change, filedAgainst, rationale: 'because', evidence, effect: effect as never, createdAt: AS_OF,
    }),
  );
};
/** `agent run mini --type disclosure --doc <the post> ...extra` */
const runArgs = (...extra: string[]) => ['agent', 'run', 'mini', '--type', 'disclosure', '--doc', String(docId), ...extra];
const staked = () => toolUse('record_provisional_observation', { metric: 'staked_supply', value: 55, observed_at: '2026-06-28', citation_url: `doc:${docId}`, quoted_text: STAKED_QUOTE });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-agent-cli-'));
  script = [];
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), AGENT_ASSET_YAML.trimStart());
  writeFileSync(join(home, 'personas', 'analyst.md'), PERSONA_MD);
  writeFileSync(join(home, 'skills', 'disclosure-review.md'), SKILL);
});

describe('orion persona', () => {
  it('lists personas with what they cover and the skills, shows one, and assigns one', async () => {
    expect(await orion('persona', 'list')).toContain('analyst  claude-opus-5-5  effort high  covers: nothing');
    expect(await orion('persona', 'assign', 'mini', 'analyst')).toBe('analyst now covers mini');
    const listed = await orion('persona', 'list');
    expect(listed).toContain('covers: mini');
    expect(listed).toContain('skill disclosure-review  [disclosure]');
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
    await orion('persona', 'assign', 'mini', 'analyst');
    const docPath = join(home, 'post.txt');
    writeFileSync(docPath, POST);
    docId = (JSON.parse(await orion('doc', 'add', 'mini', '--file', docPath, '--kind', 'post', '--url', 'https://x.com/mini/status/1', '--json')) as { id: number }).id;
  });

  it('runs, prints what was committed, and exits 0', async () => {
    script = [calls(staked()), calls(journalCall()), say('Done.')];
    const out = await orion(...runArgs());
    expect(out).toContain('#1  2026-06-30T00:00:00.000Z  mini  disclosure  analyst  completed');
    expect(out).toContain('3 requests');
    expect(out).toContain('about $0.00 at list price'); // 300 input and 150 output tokens at Opus 5.5 prices is 0.42 cents
    expect(out).toContain(`committed provisional staked_supply = 55 at 2026-06-28T00:00:00.000Z (inert until confirmed) doc:${docId}`);
    expect(out).toContain('committed journal: reviewed');
    expect(out).not.toContain('signal');
    expect(exitCode).toBeUndefined();
  });

  it('cli: agent run is refused on stage before any request, even with a key in the env file (I-4)', async () => {
    // The stage watcher's CLI child re-reads ~/shared/.env through ORION_ENV_FILE: a key there must still not spend.
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-ant-stage-test\n');
    const model = scriptedModel([calls(staked()), calls(journalCall()), say('Done.')]);
    const lines: string[] = [];
    exitCode = undefined;
    const program = buildProgram(testCliContext(home, {
      stdout: (l) => lines.push(l), now: () => new Date(AS_OF), setExitCode: (c) => (exitCode = c), modelClient: () => model,
    }));
    const saved = process.env.ORION_ENV;
    process.env.ORION_ENV = 'stage';
    try {
      await program.parseAsync(runArgs('--dry-run', '--json'), { from: 'user' });
    } finally {
      if (saved === undefined) delete process.env.ORION_ENV;
      else process.env.ORION_ENV = saved;
    }
    const json = JSON.parse(lines.join('\n')) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('agent_refused_stage');
    expect(exitCode).toBe(1);
    expect(model.requests).toEqual([]);
    expect(await withDb(async (db) => (await db.one<{ n: number }>('SELECT count(*)::int AS n FROM agent_runs'))!.n)).toBe(0);
    // ORION_ENV named in the env file itself is refused the same way.
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-ant-stage-test\nORION_ENV=stage\n');
    const again = JSON.parse(await orion(...runArgs('--dry-run', '--json'))) as { error: { code: string } };
    expect(again.error.code).toBe('agent_refused_stage');
  });

  it('cli: agent run --out <file> is accepted, writes no file, JSON keys are run, staged, committed', async () => {
    // The disclosure watcher's own command line: agent run <a> --type disclosure --doc <id> --out <home>/signals.jsonl --json.
    script = [calls(staked()), calls(journalCall()), say('Done.')];
    const out = join(home, 'signals.jsonl');
    const json = JSON.parse(await orion(...runArgs('--out', out, '--json'))) as Record<string, unknown> & { run: { outcome: string }; committed: { observationIds: number[] } };
    expect(Object.keys(json)).toEqual(['run', 'staged', 'committed']);
    expect(json.run.outcome).toBe('completed');
    expect(json.committed.observationIds).toHaveLength(1);
    expect(exitCode).toBeUndefined();
    expect(existsSync(out)).toBe(false);
  });

  it('prints one JSON object under --json, and on a dry run says what it would commit', async () => {
    script = [calls(staked()), calls(journalCall()), say('Done.')];
    const json = JSON.parse(await orion(...runArgs('--dry-run', '--json'))) as { run: { outcome: string; dryRun: boolean }; committed: unknown; staged: { observations: unknown[] } };
    expect(json.run).toMatchObject({ outcome: 'completed', dryRun: true });
    expect(json.committed).toBeNull();
    expect(json.staged.observations).toHaveLength(1);
    script = [calls(staked()), calls(journalCall()), say('Done.')];
    const text = await orion(...runArgs('--dry-run'));
    expect(text).toContain('would commit provisional staked_supply = 55');
    expect(text).not.toContain('signal');
  });

  it('prints one line per staged catalyst: the date or range, kind, event, and where each citation points', async () => {
    const quote = 'annualized revenue reached $1,100 in September';
    const catalysts = [
      { event: 'mainnet launch', kind: 'product', from: '2026-07-01', to: '2026-09-30', citations: [{ source: `doc:${docId}`, quoted_text: quote }] },
      { event: 'token unlock', kind: 'token', by: '2026-08-01', citations: [{ source: `doc:${docId}`, quoted_text: quote }] },
    ];
    script = [calls(journalCall({ catalysts })), say('Done.')];
    const text = await orion(...runArgs('--dry-run'));
    expect(text).toContain(`would commit catalyst 2026-07-01..2026-09-30 product: mainnet launch [doc:${docId}]`);
    expect(text).toContain(`would commit catalyst by 2026-08-01 token: token unlock [doc:${docId}]`);
  });

  it('says when a run finished on the reserve request', async () => {
    script = [{ ...calls(staked()), usage: { input_tokens: 10_000_000 } }, calls(journalCall())];
    const out = await orion(...runArgs('--dry-run'));
    expect(out).toContain('finished on reserve after input units (1200000)');
    expect(exitCode).toBeUndefined();
    expect(await orion('agent', 'runs', 'show', '1')).toContain('finished on reserve after input units (1200000)');
  });

  it('says when the reserve request was used and the run still ran out, and says nothing of it otherwise', async () => {
    script = [{ ...calls(staked()), usage: { input_tokens: 10_000_000 } }, calls(toolUse('get_observations', { metric: 'price_usd' }))];
    const out = await orion(...runArgs('--dry-run'));
    expect(out).toContain('reserve request used after input units (1200000); nothing committed');
    expect(out).not.toContain('finished on reserve');
    expect(await orion('agent', 'runs', 'show', '1')).toContain('reserve request used after input units (1200000); nothing committed');
    script = [calls(journalCall()), say('Done.')];
    const plain = await orion(...runArgs('--dry-run'));
    expect(plain).not.toContain('reserve');
    expect(await orion('agent', 'runs', 'show', '2')).not.toContain('reserve');
  });

  it('exits 1 when the run does not complete, and says what was discarded', async () => {
    script = [calls(staked()), say('Done.'), say('Still done.')];
    const out = await orion(...runArgs());
    expect(out).toContain('no_journal');
    expect(out).toContain('discarded provisional staked_supply = 55');
    expect(exitCode).toBe(1);
  });

  it('exits 1 and commits nothing when the asset config is edited while the run is in flight', async () => {
    const file = join(home, 'assets', 'mini.yaml');
    const editTheConfigMidRun = () => {
      writeFileSync(file, readFileSync(file, 'utf8').replace('name: Mini Test Asset', 'name: Mini Test Asset Renamed'));
      return calls(journalCall());
    };
    script = [calls(staked()), editTheConfigMidRun, say('Done.')];
    const out = await orion(...runArgs());
    expect(out).toContain('conflict');
    expect(out).toContain('the asset config changed during the run');
    expect(out).toContain('discarded provisional staked_supply = 55');
    expect(exitCode).toBe(1);
    expect((await withDb(async (db) => (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM journal'))!)).n).toBe(0);
  });

  it('passes --anomaly and --note to the run as pack context, and the run can resolve that anomaly', async () => {
    const a = await withDb(async (db) =>
      await raiseAnomaly(db, { assetId: 'mini', kind: 'source_failure_streak', metricKey: '', dedupeKey: 'coingecko', severity: 'advisory', detail: {}, seenAt: AS_OF }),
    );
    script = [calls(toolUse('resolve_anomaly', { id: a.id, note: 'the source is back', evidence: [await revenueId()] })), calls(journalCall()), say('Done.')];
    const out = await orion(...runArgs('--anomaly', String(a.id), '--note', 'see the status page'));
    expect(out).toContain(`committed anomaly #${a.id} resolved: the source is back`);
    expect(exitCode).toBeUndefined();
    const shown = JSON.parse(await orion('agent', 'runs', 'show', '1', '--transcript', '--json')) as { triggerDetail: unknown; transcript: { messages: { content: unknown }[] } };
    expect(shown.triggerDetail).toMatchObject({ anomalyId: a.id, note: 'see the status page', docId });
    const first = shown.transcript.messages[0].content as string;
    const pack = JSON.parse(first.slice(first.indexOf('{'))) as { trigger: Record<string, any> };
    expect(pack.trigger).toEqual({ anomaly: expect.objectContaining({ id: a.id }), unverified_note: 'see the status page' });
  });

  it('cli: --type weekly is refused with invalid_run_type, and the message lists only disclosure', async () => {
    for (const type of ['weekly', 'triage', 'deep', 'bootstrap', 'hourly']) {
      await expect(orion('agent', 'run', 'mini', '--type', type, '--doc', String(docId))).rejects.toMatchObject({
        code: 'invalid_run_type', message: '--type must be one of disclosure',
      } satisfies Partial<OrionError>);
    }
    const out = JSON.parse(await orion('agent', 'run', 'mini', '--type', 'weekly', '--json')) as { error: { code: string; message: string } };
    expect(out.error).toEqual({ code: 'invalid_run_type', message: '--type must be one of disclosure' });
    expect(exitCode).toBe(1);
    expect(await orion('agent', 'runs', 'list')).toBe('no agent runs');
  });

  it('fails preflight without calling the model', async () => {
    await expect(orion(...runArgs('--anomaly', '999'))).rejects.toMatchObject({ code: 'anomaly_not_found' });
    await expect(orion('agent', 'run', 'mini', '--type', 'disclosure')).rejects.toMatchObject({ code: 'disclosure_needs_doc' });
    const out = JSON.parse(await orion('agent', 'run', 'mini', '--type', 'disclosure', '--json')) as { error: { code: string } };
    expect(out.error.code).toBe('disclosure_needs_doc');
    expect(exitCode).toBe(1);
    await expect(orion('agent', 'run', 'mini', '--type', 'disclosure', '--doc', '7')).rejects.toMatchObject({ code: 'doc_not_found' });
    expect(await orion('agent', 'runs', 'list')).toBe('no agent runs');
  });

  it('runs a disclosure run on --doc with the document and the asset YAML text in its pack', async () => {
    const sha = await withDb(async (db) => (await db.one<{ sha256: string }>('SELECT sha256 FROM documents WHERE id = $1', [docId]))!.sha256);
    script = [calls(journalCall()), say('Done.')];
    const run = JSON.parse(await orion(...runArgs('--json'))) as { run: { id: number; runType: string; outcome: string; triggerDetail: unknown } };
    expect(run.run).toMatchObject({ runType: 'disclosure', outcome: 'completed', triggerDetail: { docId, docSha256: sha } });
    const shown = JSON.parse(await orion('agent', 'runs', 'show', String(run.run.id), '--transcript', '--json')) as { transcript: { messages: { content: unknown }[] } };
    const first = shown.transcript.messages[0].content as string;
    const pack = JSON.parse(first.slice(first.indexOf('{'))) as Record<string, any>;
    expect(pack.document).toMatchObject({ id: docId, kind: 'post', label: "the issuer's own post: a dated claim" });
    expect(pack.asset_config_yaml).toBe(readFileSync(join(home, 'assets', 'mini.yaml'), 'utf8'));
    expect(pack.adapter_params).toEqual([]);
  });

  it('prints each dev finding with its category, metric keys, title, and where each citation points', async () => {
    const devFinding = toolUse('record_dev_finding', {
      category: 'revenue', title: 'Revenue claim not measured', metric_keys: ['revenue_run_rate_usd', 'flow_usd.fees'], claim: 'The post says $1,100.',
      orion_reading: 'Orion has 1000.', value_direction: 'up', proposed_fix: 'Read the revenue page.', evidence: [await revenueId()],
      citations: [{ source: `doc:${docId}`, quoted_text: 'annualized revenue reached $1,100 in September' }],
    });
    script = [calls(devFinding), calls(journalCall()), say('Done.')];
    const text = await orion(...runArgs('--dry-run'));
    const line = `would commit dev finding revenue [flow_usd.fees, revenue_run_rate_usd]: Revenue claim not measured [doc:${docId} (post)]`;
    expect(text).toContain(line);
    expect(await orion('agent', 'runs', 'show', '1')).toContain(line);
  });

  it('labels a machine-transcript citation in the dev finding line after its locator', async () => {
    const docPath = join(home, 'call.txt');
    writeFileSync(docPath, '[12:33] Our annualized revenue reached $1,100 in September.\n');
    const added = JSON.parse(await orion('doc', 'add', 'mini', '--file', docPath, '--kind', 'machine_transcript', '--url', 'https://x.com/mini/status/2', '--json')) as { id: number };
    const devFinding = toolUse('record_dev_finding', {
      category: 'revenue', title: 'Revenue claim not measured', metric_keys: ['revenue_run_rate_usd'], claim: 'The call says $1,100.',
      orion_reading: 'Orion has 1000.', value_direction: 'up', proposed_fix: 'Read the revenue page.', evidence: [await revenueId()],
      citations: [{ source: `doc:${added.id}`, quoted_text: 'annualized revenue reached $1,100 in September' }],
    });
    script = [calls(devFinding), calls(journalCall()), say('Done.')];
    const text = await orion('agent', 'run', 'mini', '--type', 'disclosure', '--doc', String(added.id), '--dry-run');
    expect(text).toContain(`would commit dev finding revenue [revenue_run_rate_usd]: Revenue claim not measured [doc:${added.id}@12:33 (machine transcript)]`);
  });

  it('exits 1 with run_in_progress while another holder has the asset\'s lock, and releases its own lock afterwards', async () => {
    const held = await testDb().tryAssetRunLock('mini', 'tick pid 999');
    const since = (await testDb().assetRunLockHolder('mini'))!.since;
    script = [calls(journalCall()), say('Done.')];
    await expect(orion(...runArgs())).rejects.toMatchObject({ code: 'run_in_progress' });
    const out = JSON.parse(await orion(...runArgs('--json'))) as { error: { code: string; message: string } };
    expect(out.error).toEqual({ code: 'run_in_progress', message: `asset mini is locked by tick pid 999 since ${since}` });
    expect(exitCode).toBe(1);
    expect(await orion('agent', 'runs', 'list')).toBe('no agent runs');
    await held!.release();
    await orion(...runArgs());
    expect(exitCode).toBeUndefined();
    expect(await testDb().assetRunLockHolder('mini')).toBeNull();
  });

  it('lists past runs and shows one with its cost estimate and, on request, its transcript', async () => {
    script = [calls(staked()), calls(journalCall()), say('Done.')];
    await orion(...runArgs());
    expect(await orion('agent', 'runs', 'list', 'mini')).toContain('#1  2026-06-30T00:00:00.000Z  mini  disclosure  analyst  completed');
    const shown = await orion('agent', 'runs', 'show', '1');
    expect(shown).toContain('model claude-opus-5-5');
    expect(shown).toContain('committed provisional staked_supply = 55');
    expect(shown).not.toContain('signal');
    expect(shown).not.toContain('context pack');
    expect(await orion('agent', 'runs', 'show', '1', '--transcript')).toContain('This is your context pack');
    const json = JSON.parse(await orion('agent', 'runs', 'show', '1', '--json')) as { estimated_cost_usd: number };
    expect(json.estimated_cost_usd).toBeCloseTo((300 * 4 + 150 * 20) / 1_000_000, 9);
    await expect(orion('agent', 'runs', 'show', '9')).rejects.toMatchObject({ code: 'agent_run_not_found' });
  });

  it('agent runs: list and show read a stored weekly run', async () => {
    // A row the valuation era wrote: a weekly run that changed an assumption and moved the signal.
    await withDb(async (db) => {
      const id = await startAgentRun(db, {
        assetId: 'mini', persona: 'analyst', runType: 'weekly', trigger: 'schedule', triggerDetail: { firings: [] }, dryRun: false, configHash: 'a'.repeat(64),
        model: 'claude-opus-5-5', startedAt: '2026-06-01T00:00:00.000Z',
      });
      const change = { key: 'rev_growth_y1', scenario: 'base', start: 0, value: 0.2, rationale: 'usage is accelerating', evidence: [1] };
      await finishAgentRun(db, id, {
        outcome: 'completed', endedAt: '2026-06-01T00:05:00.000Z', usage: { requests: 3, inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 150, webSearches: 0, webFetches: 0 },
        error: null,
        summary: {
          committed: { setVersion: 2, observationIds: [], resolvedAnomalyIds: [], proposalIds: [], journalId: 1 },
          staged: { assumptionChanges: [change], resolutions: [], observations: [], proposals: [], journal: { thesis: 't', openQuestions: [], summary: 'raised growth' } },
          signal_id: 'mini-2026-06-01T00:05:00.000Z', valuation_error: null,
        },
        transcript: { system: 's', tools: ['apply_assumption_change'], messages: [], responses: [] },
      });
    });
    expect(await orion('agent', 'runs', 'list')).toContain('#1  2026-06-01T00:00:00.000Z  mini  weekly  analyst  completed');
    const shown = await orion('agent', 'runs', 'show', '1');
    expect(shown).toContain('#1  2026-06-01T00:00:00.000Z  mini  weekly  analyst  completed');
    expect(shown).toContain('trigger schedule {"firings":[]}');
    expect(shown).toContain('committed rev_growth_y1 (base) 0 -> 0.2: usage is accelerating');
    expect(shown).toContain('committed journal: raised growth');
    expect(shown).toContain('signal mini-2026-06-01T00:05:00.000Z');
    const json = JSON.parse(await orion('agent', 'runs', 'show', '1', '--json')) as { runType: string; summary: { signal_id: string } };
    expect(json).toMatchObject({ runType: 'weekly', summary: { signal_id: 'mini-2026-06-01T00:05:00.000Z' } });
    expect(JSON.parse(await orion('agent', 'runs', 'list', '--json'))).toMatchObject([{ id: 1, runType: 'weekly' }]);
  });

  it('refuses a --limit that is not a positive whole number, rather than pass it to the database', async () => {
    for (const bad of ['-5', '0', '2.5', 'many']) {
      await expect(orion('agent', 'runs', 'list', '--limit', bad)).rejects.toMatchObject({ code: bad === 'many' ? 'invalid_number' : 'invalid_limit' });
    }
    const out = JSON.parse(await orion('agent', 'runs', 'list', '--limit', '-5', '--json')) as { error: { code: string } };
    expect(out.error.code).toBe('invalid_limit');
    expect(exitCode).toBe(1);
    expect(await orion('agent', 'runs', 'list', '--limit', '3')).toBe('no agent runs');
  });
});

const STALENESS_EDIT: ProposalChange = { kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'staleness_days'], value: 14 }] };

describe('orion proposals', () => {
  beforeEach(async () => {
    await seed();
  });

  it('lists and shows a stored config proposal with a valuation-era effect as retired, and rejects it', async () => {
    // A carried config proposal may hold a 6m/12m effect from the valuation era (the assumption_value kind itself is not
    // carried: the database refuses it). Its numbers are never printed as a live target.
    expect(await orion('proposals', 'list')).toBe('no proposals');
    const p = await fileProposal(STALENESS_EDIT, [7], { '6m': { from: 10, to: 11 }, '12m': { from: 10, to: 12.5 } });
    const listed = await orion('proposals', 'list', 'mini');
    expect(listed).toContain(`#${p.id}  mini  analyst  config  pending`);
    expect(listed).toContain('[effect: valuation-era (retired), not computed]  0d old');
    const shown = await orion('proposals', 'show', String(p.id));
    expect(shown).toContain('[effect: valuation-era (retired), not computed]');
    expect(shown).not.toContain('12.50');
    expect(shown).toContain('rationale: because');
    expect(shown).toContain('revenue_run_rate_usd = 1000');
    expect(await orion('proposals', 'reject', String(p.id), '--note', 'not now')).toBe(`proposal #${p.id} rejected: not now`);
    expect(await orion('proposals', 'list')).toBe('no proposals');
    expect(await orion('proposals', 'list', '--all')).toContain('rejected');
  });

  it('a stored valuation-era effect: human lines say retired, the JSON of inbox and proposals list/show still carries the stored effect object', async () => {
    const effect = { '6m': { from: 10, to: 11 }, '12m': { from: 10, to: 12.5 } };
    const blocked = { blocked: ['missing_metric:revenue_run_rate_usd'] };
    const p = await fileProposal(STALENESS_EDIT, [7], effect);
    const b = await fileProposal({ kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'staleness_days'], value: 30 }] }, [7], blocked);
    const inboxText = (await orion('inbox', 'mini')).split('\n');
    expect(inboxText).toContain(`prop #${p.id}  config  filed ${AS_OF.slice(0, 10)} by analyst  effect: valuation-era (retired), not computed`);
    expect(inboxText).toContain(`prop #${b.id}  config  filed ${AS_OF.slice(0, 10)} by analyst  effect: valuation-era (retired), not computed`);
    const inbox = JSON.parse(await orion('inbox', 'mini', '--json')) as { proposals: { id: number; effect: unknown }[] };
    expect(inbox.proposals.find((x) => x.id === p.id)!.effect).toEqual(effect);
    expect(inbox.proposals.find((x) => x.id === b.id)!.effect).toEqual(blocked);
    const list = JSON.parse(await orion('proposals', 'list', 'mini', '--json')) as { id: number; effect: unknown }[];
    expect(list.find((x) => x.id === p.id)!.effect).toEqual(effect);
    expect(list.find((x) => x.id === b.id)!.effect).toEqual(blocked);
    expect((JSON.parse(await orion('proposals', 'show', String(p.id), '--json')) as { effect: unknown }).effect).toEqual(effect);
    expect(await orion('proposals', 'list', 'mini')).not.toMatch(/blocks the engine|12m /);
  });

  it('shows each citation with its locator and the label of its document', async () => {
    const doc = await withDb(async (db) =>
      (await insertDocument(db, {
        assetId: 'mini', kind: 'machine_transcript', sourceUrl: 'https://x.com/mini/status/1', sourceId: null, title: null, publishedAt: AS_OF,
        addedAt: AS_OF, meta: { asr_model: 'whisper-large-v3' }, text: '[12:33] revenue reached $1,100 in September\n',
      })).doc,
    );
    const p = await withDb(async (db) =>
      await insertProposal(db, {
        assetId: 'mini', persona: 'analyst', agentRunId: null, change: { kind: 'acknowledge_anomaly', anomalyId: 1, note: 'lags' },
        filedAgainst: { status: 'open' }, rationale: 'because', evidence: [], effect: null, createdAt: AS_OF,
        citations: [
          { source: `doc:${doc.id}`, quotedText: 'revenue reached $1,100 in September', locator: '12:33', docSha256: doc.sha256, docKind: 'machine_transcript' },
          { source: 'https://news.example.com/a', quotedText: 'annualized revenue of $1,100', locator: null, docSha256: null, docKind: null },
        ],
      }),
    );
    const shown = (await orion('proposals', 'show', String(p.id))).split('\n');
    expect(shown).toContain(
      `  citation doc:${doc.id} at 12:33 [machine transcript (whisper-large-v3): names and numbers may be misheard; every figure in it is the speaker's dated claim, not a fact]: "revenue reached $1,100 in September"`,
    );
    expect(shown).toContain('  citation https://news.example.com/a: "annualized revenue of $1,100"');
    const json = JSON.parse(await orion('proposals', 'show', String(p.id), '--json')) as { citations: unknown[] };
    expect(json.citations).toHaveLength(2);
  });

  it('approving a config proposal edits the YAML and says to review and commit it', async () => {
    const p = await fileProposal({ kind: 'config', edits: [{ path: ['metrics', 'flow_usd.fees', 'staleness_days'], value: 60 }] }, [45]);
    const out = await orion('proposals', 'approve', String(p.id));
    // " > ", not ".": metric keys contain dots, so a dotted path is ambiguous.
    expect(out).toContain('metrics > flow_usd.fees > staleness_days: 45 -> 60');
    expect(out).toContain('review it with "git diff", then commit it');
    expect(readFileSync(join(home, 'assets', 'mini.yaml'), 'utf8')).toContain('flow_usd.fees: { type: flow, unit: usd, staleness_days: 60, critical: true }');
  });

  it('marks a config proposal that would change what the agent may do by itself, in the list and in show', async () => {
    const band = await fileProposal({ kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'critical'], value: true }] }, [null]);
    const weight = await fileProposal({ kind: 'config', edits: [{ path: ['metrics', 'staked_supply', 'staleness_days'], value: 14 }] }, [7]);
    const listed = await orion('proposals', 'list', 'mini');
    expect(listed).toContain(`#${band.id}`);
    expect(listed.split('\n').find((l) => l.includes(`#${band.id}`))).toContain("[changes the agent's limits]");
    expect(listed.split('\n').find((l) => l.includes(`#${weight.id}`))).not.toContain("[changes the agent's limits]");
    expect(await orion('proposals', 'show', String(band.id))).toContain("[changes the agent's limits]");
    expect(await orion('proposals', 'show', String(weight.id))).not.toContain("[changes the agent's limits]");
  });

  it('rejects with a required note, and reports a stale or missing proposal as JSON under --json', async () => {
    const p = await fileProposal({ kind: 'config', edits: [{ path: ['symbol'], value: 'MIN2' }] }, ['OLD']);
    const stale = JSON.parse(await orion('proposals', 'approve', String(p.id), '--json')) as { error: { code: string } };
    expect(stale.error.code).toBe('stale_proposal');
    expect(exitCode).toBe(1);
    expect(await orion('proposals', 'reject', String(p.id), '--note', 'filed against an old value')).toBe(`proposal #${p.id} rejected: filed against an old value`);
    await expect(orion('proposals', 'show', '99')).rejects.toMatchObject({ code: 'proposal_not_found' } satisfies Partial<OrionError>);
  });
});
