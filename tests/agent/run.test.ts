import { beforeEach, describe, expect, it } from 'vitest';
import { runAgent, type RunAgentDeps, type RunAgentOptions } from '../../src/agent/run.js';
import { runValuation } from '../../src/app/valuation.js';
import { getAgentRun, getTranscript, listAgentRuns } from '../../src/db/agentRuns.js';
import { insertFiring } from '../../src/db/triggerFirings.js';
import { getAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { listAssumptionChanges } from '../../src/db/assumptionChanges.js';
import { createAssumptionSet, getLatestAssumptionSet } from '../../src/db/assumptions.js';
import { listJournal } from '../../src/db/journal.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { listProposals } from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { miniAssumptions } from '../helpers/assets.js';
import { agentHome, agentWorld, PAGE_TEXT, PAGE_URL, QUOTE, type AgentWorld } from '../helpers/agentWorld.js';
import { calls, journalCall, say, scriptedModel, toolUse, webFetch, type ScriptedModel, type ScriptStep } from '../helpers/fakeModel.js';
import { AS_OF } from '../helpers/obs.js';

let w: AgentWorld;
let home: string;
let model: ScriptedModel;

beforeEach(() => {
  w = agentWorld();
  home = agentHome(w.db);
});

const count = (table: string): number => (w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const run = (script: ScriptStep[], opts: Partial<RunAgentOptions> = {}, deps: Partial<RunAgentDeps> = {}) => {
  model = scriptedModel(script);
  return runAgent(w.db, w.loaded, { runType: 'weekly', ...opts }, { home, now: () => new Date(AS_OF), modelClient: () => model, reload: () => w.loaded, ...deps });
};
const growthCall = (value: number) =>
  toolUse('apply_assumption_change', { key: 'rev_growth_y1', scenario: 'base', value, evidence: [w.ids.revenue_run_rate_usd], rationale: 'usage is accelerating' });

describe('a weekly run that changes an assumption', () => {
  it('commits one set with its change and evidence, the journal, and a signal that names the agent', async () => {
    runValuation(w.db, w.loaded, new Date(AS_OF)); // a previous signal to compare against
    const result = await run([calls(growthCall(0.2)), calls(journalCall()), say('Done.')]);

    expect(result.run).toMatchObject({ outcome: 'completed', persona: 'analyst', runType: 'weekly', trigger: 'manual', dryRun: false, model: 'claude-opus-5-5', error: null });
    expect(result.run.usage).toMatchObject({ requests: 3, inputTokens: 300, outputTokens: 150 });
    expect(result.committed).toMatchObject({ setVersion: 2, observationIds: [], resolvedAnomalyIds: [], proposalIds: [] });

    const set = getLatestAssumptionSet(w.db, 'mini')!;
    expect(set).toMatchObject({ version: 2, author: 'analyst', rationale: 'rev_growth_y1 base 0 -> 0.2: usage is accelerating' });
    expect(listAssumptionChanges(w.db, set.id)[0]).toMatchObject({ key: 'rev_growth_y1', scenario: 'base', fromValue: 0, toValue: 0.2, evidence: [w.ids.revenue_run_rate_usd] });
    expect(listJournal(w.db, 'mini')[0]).toMatchObject({ agentRunId: result.run.id, persona: 'analyst', thesis: 'steady' });

    expect(result.signal!.change).toMatchObject({ cause: 'assumptions', causes: ['assumptions'], author: 'analyst' });
    expect(result.signal!.provenance).toMatchObject({ agent_run_id: result.run.id, assumption_set_version: 2 });
  });

  it('cites context-pack observations without reading them again, sends the persona, rules, skills, and every tool', async () => {
    await run([calls(growthCall(0.2)), calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: false, result: { applied: true } });
    const first = model.requests[0];
    expect(first.system.indexOf('You are the analyst')).toBe(0);
    expect(first.system).toContain('# How Orion works');
    expect(first.system.indexOf('# Skill: assumption-review')).toBeLessThan(first.system.indexOf('# Skill: disclosure-research'));
    expect(first.system).not.toContain('anomaly-triage');
    expect(first.tools.map((t) => ('name' in t ? t.name : ''))).toEqual(expect.arrayContaining(['apply_assumption_change', 'write_journal', 'web_search', 'web_fetch']));
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].content).toContain('"observations_in_force"');
  });

  it('keeps the transcript apart from the run row', async () => {
    const result = await run([calls(journalCall()), say('Done.')]);
    const transcript = getTranscript(w.db, result.run.id) as { system: string; tools: string[]; messages: unknown[]; responses: unknown[] };
    expect(transcript.messages).toHaveLength(4);
    expect(transcript.responses).toHaveLength(2);
    expect(transcript.tools).toContain('web_fetch');
    expect(JSON.stringify(getAgentRun(w.db, result.run.id))).not.toContain('context pack');
  });
});

describe('a run that changes nothing', () => {
  it('writes its journal and emits no signal', async () => {
    const result = await run([calls(journalCall({ summary: 'nothing needed changing' })), say('Done.')]);
    expect(result.run.outcome).toBe('completed');
    expect(result.signal).toBeNull();
    expect(count('valuation_runs')).toBe(0);
    expect(count('journal')).toBe(1);
    expect(result.run.summary).toMatchObject({ signal_id: null, valuation_error: null });
  });
});

describe('a triage run', () => {
  it('resolves a degrading anomaly on a critical metric and the grade recovers', async () => {
    const a = raiseAnomaly(w.db, {
      assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'x', severity: 'degrading', detail: { primary: 10, check: 12 }, seenAt: AS_OF,
    });
    expect(runValuation(w.db, w.loaded, new Date(AS_OF)).signal).toMatchObject({ status: 'degraded', data_quality: { grade: 'D' } });

    const result = await run(
      [calls(toolUse('resolve_anomaly', { id: a.id, note: 'the check source has caught up', evidence: [w.ids.price_usd] })), calls(journalCall()), say('Done.')],
      { runType: 'triage', anomalyId: a.id, note: 'see https://status.example.com' },
    );
    expect(result.run).toMatchObject({ outcome: 'completed', runType: 'triage', triggerDetail: { anomalyId: a.id, note: 'see https://status.example.com' } });
    expect(getAnomaly(w.db, a.id)).toMatchObject({ status: 'resolved', decidedBy: 'analyst' });
    expect(result.signal).toMatchObject({ status: 'ok', data_quality: { grade: 'A', open_anomalies: 0 } });
    expect(model.requests[0].system).toContain('# Skill: anomaly-triage');
    const pack = model.requests[0].messages[0].content as string;
    expect(pack).toContain('"unverified_note": "see https://status.example.com"');
  });
});

describe('guardrails inside a run', () => {
  it('files an out-of-band value as a proposal tied to the run, and moves no signal', async () => {
    const result = await run([calls(growthCall(1.2)), calls(journalCall()), say('Done.')]);
    expect(result.signal).toBeNull();
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(1);
    const p = listProposals(w.db)[0];
    expect(p).toMatchObject({ persona: 'analyst', agentRunId: result.run.id, status: 'pending', change: { kind: 'assumption_value', value: 1.2 } });
    expect(result.committed!.proposalIds).toEqual([p.id]);
  });

  it('records research from a page fetched in the same turn, and the signal drops to grade C', async () => {
    const record = toolUse('record_provisional_observation', { metric: 'revenue_run_rate_usd', value: 1100, observed_at: '2026-06-28', citation_url: PAGE_URL, quoted_text: QUOTE });
    const result = await run([{ content: [...webFetch(PAGE_URL, PAGE_TEXT), record], stop_reason: 'tool_use' }, calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: false, result: { recorded: true, in_signal: true } });
    const row = listActiveObservations(w.db, 'mini', 'revenue_run_rate_usd').find((o) => o.status === 'provisional')!;
    expect(row).toMatchObject({ value: 1100, source: 'manual', citationUrl: PAGE_URL, quotedText: QUOTE, sourceDetail: `research:analyst:run ${result.run.id}` });
    expect(result.signal).toMatchObject({ data_quality: { grade: 'C', provisional_metrics: ['revenue_run_rate_usd'] } });
    expect(result.signal!.horizons!['12m'].expected_target).toBeCloseTo(11, 6);
  });

  it('refuses research whose page was never fetched, and the run goes on', async () => {
    const record = toolUse('record_provisional_observation', { metric: 'revenue_run_rate_usd', value: 1100, observed_at: '2026-06-28', citation_url: PAGE_URL, quoted_text: QUOTE });
    const result = await run([calls(record), calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: true, result: { refused: 'citation_not_fetched' } });
    expect(result.run.outcome).toBe('completed');
    expect(count('observations')).toBe(7);
  });

  it('turns a large researched move into a proposal and writes no observation', async () => {
    const big = 'The company reports annualized revenue of $2,000 this quarter.';
    const record = toolUse('record_provisional_observation', {
      metric: 'revenue_run_rate_usd', value: 2000, observed_at: '2026-06-28', citation_url: PAGE_URL, quoted_text: 'reports annualized revenue of $2,000',
    });
    const result = await run([{ content: [...webFetch(PAGE_URL, big), record], stop_reason: 'tool_use' }, calls(journalCall()), say('Done.')]);
    expect(count('observations')).toBe(7);
    expect(listProposals(w.db)[0].change).toMatchObject({ kind: 'observation', value: 2000 });
    expect(result.signal).toBeNull();
  });
});

describe('runs that do not finish cleanly', () => {
  it('writes nothing when a budget runs out, but keeps the run row, the transcript, and what was staged', async () => {
    w.loaded = { ...w.loaded, config: { ...w.loaded.config, agent: { budgets: { weekly: { requests: 1 } } } } };
    const result = await run([calls(growthCall(0.2))]);
    expect(result.run).toMatchObject({ outcome: 'budget_exhausted', error: 'requests (1)' });
    expect(result.committed).toBeNull();
    expect(result.staged.assumptionChanges).toHaveLength(1);
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(1);
    expect(count('journal') + count('proposals') + count('assumption_changes') + count('valuation_runs')).toBe(0);
    expect(getTranscript(w.db, result.run.id)).not.toBeNull();
    expect((result.run.summary as { staged: { assumptionChanges: unknown[] } }).staged.assumptionChanges).toHaveLength(1);
  });

  it('ends as no_journal, refused, or error, each without writing', async () => {
    expect((await run([calls(growthCall(0.2)), say('Done.'), say('Still done.')])).run.outcome).toBe('no_journal');
    expect((await run([{ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }])).run.outcome).toBe('refused');
    expect((await run([new Error('socket hang up')])).run).toMatchObject({ outcome: 'error', error: 'Error: socket hang up' });
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(1);
    expect(listAgentRuns(w.db)).toHaveLength(3);
  });

  it('ends as conflict when the user saves a set mid-run, and leaves the user\'s set alone', async () => {
    const userSavesASet = () => {
      createAssumptionSet(w.db, { assetId: 'mini', author: 'user', rationale: 'mine', values: miniAssumptions({ rev_growth_y1: 0.3 }), createdAt: AS_OF });
      return calls(journalCall());
    };
    const result = await run([calls(growthCall(0.2)), userSavesASet, say('Done.')]);
    expect(result.run.outcome).toBe('conflict');
    expect(result.run.error).toMatch(/assumption set v2 was saved during the run/);
    expect(getLatestAssumptionSet(w.db, 'mini')).toMatchObject({ version: 2, author: 'user' });
    expect(count('journal')).toBe(0);
  });

  it('ends as conflict when the asset config changed under the run, and writes nothing', async () => {
    // The run began on w.loaded; halfway through, the file on disk becomes a tightened config with a different hash.
    const tightened = {
      ...w.loaded,
      hash: `${'b'.repeat(64)}`,
      config: { ...w.loaded.config, assumptions: { ...w.loaded.config.assumptions, rev_growth_y1: { min: -0.5, max: 0.05 } } },
    };
    let current = w.loaded;
    const userEditsTheConfig = () => {
      current = tightened;
      return calls(journalCall());
    };
    const result = await run([calls(growthCall(0.2)), userEditsTheConfig, say('Done.')], {}, { reload: () => current });
    expect(result.run.outcome).toBe('conflict');
    expect(result.run.error).toBe(`the asset config changed during the run (${w.loaded.hash.slice(0, 12)} -> ${'b'.repeat(12)}); nothing was committed`);
    expect(result.committed).toBeNull();
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(1);
    expect(count('journal')).toBe(0);
  });

  it('ends as conflict, not error, when the config on disk cannot be reloaded: the file moved under the run, half-edited', async () => {
    const halfEdited = () => {
      throw new Error('assumptions: "rev_growth_y1" has min greater than max');
    };
    const result = await run([calls(growthCall(0.2)), calls(journalCall()), say('Done.')], {}, { reload: halfEdited });
    expect(result.run.outcome).toBe('conflict');
    expect(result.run.error).toBe('the asset config could not be reloaded at the end of the run (Error: assumptions: "rev_growth_y1" has min greater than max); nothing was committed');
    expect(result.committed).toBeNull();
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(1);
    expect(count('journal')).toBe(0);
  });

  it('keeps a commit that stood when something after it throws, and records the message as a valuation error', async () => {
    // deps.now is called for the run start, the commit, the valuation, and the finish. Blow up on the valuation's call.
    let calledNow = 0;
    const now = () => {
      calledNow += 1;
      if (calledNow === 3) throw new Error('the clock stopped');
      return new Date(AS_OF);
    };
    const result = await run([calls(growthCall(0.2)), calls(journalCall()), say('Done.')], {}, { now });
    expect(result.run.outcome).toBe('completed');
    expect(result.run.error).toBeNull();
    expect(result.committed).toMatchObject({ setVersion: 2 });
    expect(result.signal).toBeNull();
    expect(result.run.summary!.valuation_error).toContain('the clock stopped');
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(2);
  });

  it('still finishes the run row when the transcript cannot be stored, keeping a minimal one instead', async () => {
    // A run left `running` while its writes are live is the worst outcome: the next lock takeover would call it
    // `error/abandoned`. Stand in for whatever makes the transcript unstorable with a size limit.
    w.db.exec(
      "CREATE TRIGGER no_large_transcripts BEFORE INSERT ON agent_transcripts WHEN length(NEW.messages_json) > 400 " +
        "BEGIN SELECT RAISE(ABORT, 'transcript too large'); END",
    );
    const result = await run([calls(growthCall(0.2)), calls(journalCall()), say('Done.')]);
    expect(result.run).toMatchObject({ outcome: 'completed', error: null });
    expect(result.committed).toMatchObject({ setVersion: 2 });
    expect(getTranscript(w.db, result.run.id)).toEqual({
      error: expect.stringContaining('transcript too large'),
      note: 'the full transcript could not be stored',
    });
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(2);
  });

  it('does everything but commit on a dry run', async () => {
    const result = await run([calls(growthCall(0.2)), calls(journalCall()), say('Done.')], { dryRun: true });
    expect(result.run).toMatchObject({ outcome: 'completed', dryRun: true });
    expect(result.committed).toBeNull();
    expect(result.staged.assumptionChanges).toHaveLength(1);
    expect(result.staged.journal).not.toBeNull();
    expect(getLatestAssumptionSet(w.db, 'mini')!.version).toBe(1);
    expect(count('journal')).toBe(0);
  });
});

describe('preflight', () => {
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (err: OrionError) => err.code);

  it('records why tick launched it: the trigger kind on the row, the firings in the detail and the pack; a tick triage needs no anomaly or note', async () => {
    const firing = insertFiring(w.db, { assetId: 'mini', kind: 'calendar', key: '2026-07-01', firedAt: AS_OF, detail: { note: 'Emission cut' } });
    const triage = await run([calls(journalCall()), say('Done.')], { runType: 'triage', trigger: { kind: 'trigger', firings: [firing] } });
    expect(triage.run).toMatchObject({ outcome: 'completed', runType: 'triage', trigger: 'trigger', triggerDetail: { firings: [{ kind: 'calendar', key: '2026-07-01', detail: { note: 'Emission cut' } }] } });
    const pack = JSON.parse((model.requests[0].messages[0].content as string).slice((model.requests[0].messages[0].content as string).indexOf('{'))) as { trigger: { triggers_this_tick: unknown[] } };
    expect(pack.trigger.triggers_this_tick).toEqual([{ kind: 'calendar', key: '2026-07-01', fired_at: AS_OF, detail: { note: 'Emission cut' } }]);

    const scheduled = await run([calls(journalCall()), say('Done.')], { runType: 'deep', trigger: { kind: 'schedule', firings: [] } });
    expect(scheduled.run).toMatchObject({ trigger: 'schedule', triggerDetail: { firings: [] } });
    expect(triage.run.trigger).not.toBe(scheduled.run.trigger);
  });

  it('fails before any model call and before a run row exists', async () => {
    expect(await codeOf(run([], { runType: 'triage' }))).toBe('triage_needs_target');
    expect(await codeOf(run([], { runType: 'triage', trigger: { kind: 'trigger', firings: [] } }))).toBe('triage_needs_target');
    expect(await codeOf(run([], { runType: 'triage', anomalyId: 999 }))).toBe('anomaly_not_found');
    w.db.prepare('DELETE FROM coverage').run();
    expect(await codeOf(run([]))).toBe('no_persona_assigned');
    expect(model.requests).toHaveLength(0);
    expect(count('agent_runs')).toBe(0);
  });

  it('needs an assumption set, and a persona file that exists', async () => {
    w.db.prepare('UPDATE coverage SET persona = ?').run('ghost');
    expect(await codeOf(run([]))).toBe('persona_not_found');
    w.db.prepare('UPDATE coverage SET persona = ?').run('analyst');
    w.db.prepare('DELETE FROM assumptions').run();
    w.db.prepare('DELETE FROM assumption_sets').run();
    expect(await codeOf(run([]))).toBe('no_assumption_set');
  });

  it('records a config hash that moves with the persona file', async () => {
    const first = (await run([calls(journalCall()), say('Done.')])).run.configHash;
    const same = (await run([calls(journalCall()), say('Done.')])).run.configHash;
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(home, 'personas', 'analyst.md'), '---\nname: analyst\n---\nA different analyst.\n');
    const changed = (await run([calls(journalCall()), say('Done.')])).run.configHash;
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });
});
