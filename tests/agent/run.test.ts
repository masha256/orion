import { beforeEach, describe, expect, it } from 'vitest';
import { runAgent, TOOL_LAYER_VERSION, type RunAgentDeps, type RunAgentOptions } from '../../src/agent/run.js';
import { toolsForRun, type AgentTool } from '../../src/agent/tools/index.js';
import { DEFAULT_BUDGETS } from '../../src/config/agentPolicy.js';
import { getAgentRun, getTranscript, listAgentRuns } from '../../src/db/agentRuns.js';
import { insertDocument } from '../../src/db/documents.js';
import { decideAnomaly, getAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { listJournal } from '../../src/db/journal.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { listProposals } from '../../src/db/proposals.js';
import type { OrionError } from '../../src/types.js';
import { AGENT_ASSET_YAML, agentHome, agentWorld, DOC_TEXT, PAGE_TEXT, PAGE_URL, QUOTE, STAKED_QUOTE, type AgentWorld } from '../helpers/agentWorld.js';
import { calls, journalCall, say, scriptedModel, toolUse, webFetch, type ScriptedModel, type ScriptStep } from '../helpers/fakeModel.js';
import { AS_OF } from '../helpers/obs.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();

let w: AgentWorld;
let home: string;
let model: ScriptedModel;

beforeEach(async () => {
  w = await agentWorld(testDb());
  home = await agentHome(w.db);
});

const NINE = [
  'get_observations', 'get_anomalies', 'get_journal', 'get_flow_total', 'resolve_anomaly', 'record_provisional_observation', 'propose_change',
  'write_journal', 'record_dev_finding',
];
const count = async (table: string): Promise<number> => (await w.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const run = (script: ScriptStep[], opts: Partial<RunAgentOptions> = {}, deps: Partial<RunAgentDeps> = {}) => {
  model = scriptedModel(script);
  return runAgent(
    w.db, w.loaded, { runType: 'disclosure', docId: w.doc.id, assetYaml: AGENT_ASSET_YAML, ...opts },
    { home, now: () => new Date(AS_OF), modelClient: () => model, reload: () => w.loaded, ...deps },
  );
};
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (err: OrionError) => err.code);
const packOf = (i = 0): Record<string, any> => {
  const content = model.requests[i].messages[0].content as string;
  return JSON.parse(content.slice(content.indexOf('{')));
};
/** Staked supply does not allow provisional data, so a figure for it is staged as an inert row. */
const stakedCall = () =>
  toolUse('record_provisional_observation', { metric: 'staked_supply', value: 55, observed_at: '2026-06-28', citation_url: 'doc:1', quoted_text: STAKED_QUOTE });
/** Revenue allows provisional data, so in a disclosure run a figure for it is filed as an observation proposal. */
const revenueCall = (source = 'doc:1') =>
  toolUse('record_provisional_observation', { metric: 'revenue_run_rate_usd', value: 1100, observed_at: '2026-06-28', citation_url: source, quoted_text: QUOTE });
const anomaly = async (dedupeKey = 'x') =>
  await raiseAnomaly(w.db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey, severity: 'degrading', detail: { primary: 10, check: 12 }, seenAt: AS_OF });

describe('run', () => {
  it('a disclosure run needs no assumption set', async () => {
    expect(await count('assumption_sets')).toBe(0);
    const result = await run([calls(journalCall()), say('Done.')]);
    expect(result.run).toMatchObject({ outcome: 'completed', runType: 'disclosure', error: null });
    expect((await listJournal(w.db, 'mini'))[0]).toMatchObject({ agentRunId: result.run.id });
    expect(await count('assumption_sets')).toBe(0);
  });

  it('commits what it staged in one transaction, and returns run, staged and committed only', async () => {
    const result = await run([calls(stakedCall(), revenueCall()), calls(journalCall()), say('Done.')]);
    expect(Object.keys(result)).toEqual(['run', 'staged', 'committed']);
    expect(result.run).toMatchObject({ outcome: 'completed', persona: 'analyst', runType: 'disclosure', trigger: 'manual', dryRun: false, model: 'claude-opus-5-5', error: null });
    expect(result.run.usage).toMatchObject({ requests: 3, inputTokens: 300, outputTokens: 150 });

    const row = (await listActiveObservations(w.db, 'mini', 'staked_supply')).find((o) => o.status === 'provisional')!;
    expect(row).toMatchObject({ value: 55, source: 'manual', citationUrl: 'doc:1', quotedText: STAKED_QUOTE, sourceDetail: `research:analyst:run ${result.run.id}` });
    const proposal = (await listProposals(w.db))[0];
    expect(proposal).toMatchObject({ agentRunId: result.run.id, status: 'pending', change: { kind: 'observation', value: 1100, citationUrl: 'doc:1' }, effect: null });
    const journalId = (await listJournal(w.db, 'mini'))[0].id;
    expect(result.committed).toEqual({ observationIds: [row.id], resolvedAnomalyIds: [], proposalIds: [proposal.id], journalId, devFindings: [] });
    expect(Object.keys(result.staged)).toEqual(['resolutions', 'observations', 'proposals', 'journal', 'devFindings']);
    expect(Object.keys(result.run.summary!)).toEqual(['committed', 'staged']);
  });

  it('sends the persona, the rules, the run type, both disclosure skills sorted by name, and the nine tools with the web tools', async () => {
    const a = await anomaly();
    // The pack's observations may be cited without reading them again.
    await run([calls(toolUse('resolve_anomaly', { id: a.id, note: 'sources agree again', evidence: [w.ids.price_usd] })), calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: false, result: { staged: true } });
    const first = model.requests[0];
    expect(first.system.indexOf('You are the analyst')).toBe(0);
    expect(first.system).toContain('# How Orion works');
    expect(first.system).toContain('This is a disclosure run.');
    expect(first.system.indexOf('# Skill: disclosure-research')).toBeLessThan(first.system.indexOf('# Skill: disclosure-review'));
    expect(first.tools.map((t) => ('name' in t ? t.name : t.type))).toEqual([...NINE, 'web_search', 'web_fetch']);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].content).toContain('"observations_in_force"');
  });

  it('keeps the transcript apart from the run row', async () => {
    const result = await run([calls(journalCall()), say('Done.')]);
    const transcript = await getTranscript(w.db, result.run.id) as { system: string; tools: string[]; messages: unknown[]; responses: unknown[] };
    expect(transcript.messages).toHaveLength(4);
    expect(transcript.responses).toHaveLength(2);
    expect(transcript.tools).toContain('web_fetch');
    expect(JSON.stringify(await getAgentRun(w.db, result.run.id))).not.toContain('context pack');
  });

  it('a run that changes nothing writes its journal and nothing else', async () => {
    const result = await run([calls(journalCall({ summary: 'nothing needed changing' })), say('Done.')]);
    expect(result.run.outcome).toBe('completed');
    expect(result.committed).toMatchObject({ observationIds: [], resolvedAnomalyIds: [], proposalIds: [], devFindings: [] });
    expect(await count('journal')).toBe(1);
    expect((await count('proposals')) + (await count('valuation_runs')) + (await count('signals'))).toBe(0);
  });

  it('carries --anomaly and --note as pack context, and resolves that anomaly when the evidence supports it', async () => {
    const a = await anomaly();
    const result = await run(
      [calls(toolUse('resolve_anomaly', { id: a.id, note: 'the check source has caught up', evidence: [w.ids.price_usd] })), calls(journalCall()), say('Done.')],
      { anomalyId: a.id, note: 'see https://status.example.com' },
    );
    expect(result.run).toMatchObject({
      outcome: 'completed', triggerDetail: { anomalyId: a.id, note: 'see https://status.example.com', docId: w.doc.id, docSha256: w.doc.sha256 },
    });
    expect(await getAnomaly(w.db, a.id)).toMatchObject({ status: 'resolved', decidedBy: 'analyst' });
    expect(result.committed!.resolvedAnomalyIds).toEqual([a.id]);
    expect(packOf().trigger).toEqual({ anomaly: expect.objectContaining({ id: a.id, detail: { primary: 10, check: 12 } }), unverified_note: 'see https://status.example.com' });
  });
});

describe('guardrails inside a run', () => {
  it('files a figure from a page fetched in the same turn as an observation proposal, and writes no observation', async () => {
    const result = await run([{ content: [...webFetch(PAGE_URL, PAGE_TEXT), revenueCall(PAGE_URL)], stop_reason: 'tool_use' }, calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: false, result: { recorded: false } });
    expect((await listActiveObservations(w.db, 'mini', 'revenue_run_rate_usd')).filter((o) => o.status === 'provisional')).toEqual([]);
    expect((await listProposals(w.db)).map((p) => [p.change, p.effect])).toMatchObject([[{ kind: 'observation', value: 1100, citationUrl: PAGE_URL }, null]]);
    expect(result.committed!.proposalIds).toHaveLength(1);
  });

  it('refuses research whose page was never fetched, and the run goes on', async () => {
    const result = await run([calls(revenueCall(PAGE_URL)), calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: true, result: { refused: 'citation_not_fetched' } });
    expect(result.run.outcome).toBe('completed');
    expect((await count('observations')) + (await count('proposals'))).toBe(7);
  });

  it('refuses a valuation tool call, which no run is offered', async () => {
    const result = await run([calls(toolUse('apply_assumption_change', { key: 'rev_growth_y1', scenario: 'base', value: 0.2, evidence: [w.ids.price_usd], rationale: 'r' })), calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: true, result: { refused: 'unknown_tool' } });
    expect(result.run.outcome).toBe('completed');
  });
});

describe('runs that do not finish cleanly', () => {
  it('writes nothing when a budget runs out, but keeps the run row, the transcript, and what was staged', async () => {
    w.loaded = { ...w.loaded, config: { ...w.loaded.config, agent: { budgets: { disclosure: { requests: 1 } } } } };
    const result = await run([calls(stakedCall()), say('ok')]); // the reserve request writes no journal
    expect(result.run).toMatchObject({ outcome: 'budget_exhausted', error: 'requests (1)' });
    expect(result.committed).toBeNull();
    expect(result.staged.observations).toHaveLength(1);
    expect((await count('journal')) + (await count('proposals'))).toBe(0);
    expect(await count('observations')).toBe(7);
    expect(await getTranscript(w.db, result.run.id)).not.toBeNull();
    expect((result.run.summary as { staged: { observations: unknown[] } }).staged.observations).toHaveLength(1);
  });

  it('commits what was staged when it finishes on the reserve request, and records why', async () => {
    const result = await run([{ ...calls(stakedCall()), usage: { input_tokens: 10_000_000 } }, calls(journalCall())]);
    expect(result.run).toMatchObject({ outcome: 'completed', error: null });
    expect(result.committed!.observationIds).toHaveLength(1);
    expect((await listJournal(w.db, 'mini'))[0]).toMatchObject({ agentRunId: result.run.id, thesis: 'steady' });
    expect((result.run.summary as { reserve?: unknown }).reserve).toEqual({ reason: 'input units (1200000)' });
  });

  it('still refuses to commit on reserve when the config changed during the run', async () => {
    const moved = { ...w.loaded, hash: 'c'.repeat(64) };
    const result = await run([{ ...calls(stakedCall()), usage: { input_tokens: 10_000_000 } }, calls(journalCall())], {}, { reload: () => moved });
    expect(result.run.outcome).toBe('conflict');
    expect(result.committed).toBeNull();
    expect(await count('journal')).toBe(0);
    expect(await count('observations')).toBe(7);
  });

  it('puts no reserve key in the summary when the reserve did not run', async () => {
    const result = await run([calls(journalCall()), say('Done.')]);
    expect(result.run.outcome).toBe('completed');
    expect('reserve' in (result.run.summary as object)).toBe(false);
  });

  it('records the reserve on a run that still ran out', async () => {
    const result = await run([{ ...calls(stakedCall()), usage: { input_tokens: 10_000_000 } }, calls(toolUse('get_observations', { metric: 'price_usd' }))]);
    expect(result.run).toMatchObject({ outcome: 'budget_exhausted', error: 'input units (1200000)' });
    expect((result.run.summary as { reserve?: unknown }).reserve).toEqual({ reason: 'input units (1200000)' });
    expect(result.committed).toBeNull();
    expect(await count('journal')).toBe(0);
  });

  it('ends as no_journal, refused, or error, each without writing', async () => {
    expect((await run([calls(stakedCall()), say('Done.'), say('Still done.')])).run.outcome).toBe('no_journal');
    expect((await run([{ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }])).run.outcome).toBe('refused');
    expect((await run([new Error('socket hang up')])).run).toMatchObject({ outcome: 'error', error: 'Error: socket hang up' });
    expect(await count('observations')).toBe(7);
    expect(await listAgentRuns(w.db)).toHaveLength(3);
  });

  it('ends as conflict when the user decides the anomaly it resolved mid-run, and leaves the user\'s decision alone', async () => {
    const a = await anomaly();
    const userAcknowledges = async () => {
      await decideAnomaly(w.db, a.id, 'acknowledged', 'known lag', AS_OF);
      return calls(journalCall());
    };
    const result = await run([calls(toolUse('resolve_anomaly', { id: a.id, note: 'cleared', evidence: [w.ids.price_usd] })), userAcknowledges, say('Done.')]);
    expect(result.run.outcome).toBe('conflict');
    expect(result.run.error).toMatch(/anomaly \d+ is no longer open \(acknowledged\)/);
    expect(await getAnomaly(w.db, a.id)).toMatchObject({ status: 'acknowledged', note: 'known lag' });
    expect(await count('journal')).toBe(0);
  });

  it('ends as conflict when the asset config changed under the run, and writes nothing', async () => {
    // The run began on w.loaded; halfway through, the file on disk becomes a different config with a different hash.
    const edited = { ...w.loaded, hash: `${'b'.repeat(64)}`, config: { ...w.loaded.config, name: 'Mini Renamed' } };
    let current = w.loaded;
    const userEditsTheConfig = () => {
      current = edited;
      return calls(journalCall());
    };
    const result = await run([calls(stakedCall()), userEditsTheConfig, say('Done.')], {}, { reload: () => current });
    expect(result.run.outcome).toBe('conflict');
    expect(result.run.error).toBe(`the asset config changed during the run (${w.loaded.hash.slice(0, 12)} -> ${'b'.repeat(12)}); nothing was committed`);
    expect(result.committed).toBeNull();
    expect(await count('journal')).toBe(0);
    expect(await count('observations')).toBe(7);
  });

  it('ends as conflict, not error, when the config on disk cannot be reloaded: the file moved under the run, half-edited', async () => {
    const halfEdited = () => {
      throw new Error('metrics: \"price_usd\" has no type');
    };
    const result = await run([calls(stakedCall()), calls(journalCall()), say('Done.')], {}, { reload: halfEdited });
    expect(result.run.outcome).toBe('conflict');
    expect(result.run.error).toBe('the asset config could not be reloaded at the end of the run (Error: metrics: "price_usd" has no type); nothing was committed');
    expect(result.committed).toBeNull();
    expect(await count('journal')).toBe(0);
  });

  it('still finishes the run row when the transcript cannot be stored, keeping a minimal one instead', async () => {
    // A run left `running` while its writes are live is the worst outcome: the next lock takeover would call it
    // `error/abandoned`. Stand in for whatever makes the transcript unstorable with a size limit.
    await w.db.run(
      "CREATE TRIGGER no_large_transcripts BEFORE INSERT ON agent_transcripts WHEN length(NEW.messages_json) > 400 " +
        "BEGIN SELECT RAISE(ABORT, 'transcript too large'); END",
    );
    const result = await run([calls(stakedCall()), calls(journalCall()), say('Done.')]);
    expect(result.run).toMatchObject({ outcome: 'completed', error: null });
    expect(result.committed!.observationIds).toHaveLength(1);
    expect(await getTranscript(w.db, result.run.id)).toEqual({
      error: expect.stringContaining('transcript too large'),
      note: 'the full transcript could not be stored',
    });
  });

  it('does everything but commit on a dry run', async () => {
    const result = await run([calls(stakedCall()), calls(journalCall()), say('Done.')], { dryRun: true });
    expect(result.run).toMatchObject({ outcome: 'completed', dryRun: true });
    expect(result.committed).toBeNull();
    expect(result.staged.observations).toHaveLength(1);
    expect(result.staged.journal).not.toBeNull();
    expect(await count('journal')).toBe(0);
    expect(await count('observations')).toBe(7);
  });

  it('catalysts on a dry run appear in staged.journal and nothing is written', async () => {
    const catalysts = [{ event: 'revenue milestone', kind: 'product', by: '2026-09-30', citations: [{ source: 'doc:1', quoted_text: QUOTE }] }];
    const result = await run([calls(journalCall({ catalysts })), say('Done.')], { dryRun: true });
    expect(result.run).toMatchObject({ outcome: 'completed', dryRun: true });
    expect(result.committed).toBeNull();
    expect(result.staged.journal!.catalysts).toEqual([
      { event: 'revenue milestone', kind: 'product', by: '2026-09-30', citations: [{ source: 'doc:1', quotedText: QUOTE, locator: null, docSha256: w.doc.sha256, docKind: 'post' }] },
    ]);
    expect(await count('journal')).toBe(0);
  });
});

describe('preflight', () => {
  it('fails before any model call and before a run row exists', async () => {
    const foreign = (await insertDocument(w.db, {
      assetId: 'hype', kind: 'post', sourceUrl: 'https://x.com/hype/status/1', sourceId: null, title: null, publishedAt: AS_OF, addedAt: AS_OF, meta: {},
      text: 'Hype said something else entirely about its revenue.\n',
    })).doc;
    const decided = await anomaly('decided');
    await decideAnomaly(w.db, decided.id, 'resolved', 'fixed', AS_OF);
    expect(await codeOf(run([], { runType: 'weekly' as never }))).toBe('invalid_run_type');
    expect(await codeOf(run([], { docId: undefined }))).toBe('disclosure_needs_doc');
    expect(await codeOf(run([], { docId: 999 }))).toBe('doc_not_found');
    expect(await codeOf(run([], { docId: foreign.id }))).toBe('doc_not_found');
    expect(await codeOf(run([], { assetYaml: undefined }))).toBe('disclosure_needs_asset_yaml');
    expect(await codeOf(run([], { anomalyId: 999 }))).toBe('anomaly_not_found');
    expect(await codeOf(run([], { anomalyId: decided.id }))).toBe('anomaly_not_open');
    await w.db.run('UPDATE coverage SET persona = $1', ['ghost']);
    expect(await codeOf(run([]))).toBe('persona_not_found');
    await w.db.run('DELETE FROM coverage');
    expect(await codeOf(run([]))).toBe('no_persona_assigned');
    expect(model.requests).toHaveLength(0);
    expect(await count('agent_runs')).toBe(0);
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

  it('runs under tool layer 2.0.0', () => {
    expect(TOOL_LAYER_VERSION).toBe('2.0.0');
  });
});

describe('a disclosure run', () => {
  it('can cite doc:<id> of its target doc and nothing else', async () => {
    const other = (await insertDocument(w.db, {
      assetId: 'mini', kind: 'post', sourceUrl: 'https://x.com/mini/status/2', sourceId: null, title: null, publishedAt: AS_OF, addedAt: AS_OF, meta: {},
      text: 'Mini also said its annualized revenue reached $1,100 in September, per a second post.\n',
    })).doc;
    const result = await run([calls(revenueCall(`doc:${other.id}`)), calls(revenueCall(`doc:${w.doc.id}`)), calls(journalCall()), say('Done.')]);
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: true, result: { refused: 'doc_not_in_run', citable_docs: [`doc:${w.doc.id}`] } });
    // A figure from a disclosure run waits for the user (spec section 15, Ruling 18): on an allow_provisional metric it is a proposal.
    expect(model.toolResults(2)[0]).toMatchObject({ is_error: false, result: { recorded: false } });
    expect(result.run.outcome).toBe('completed');
    expect((await listActiveObservations(w.db, 'mini', 'revenue_run_rate_usd')).filter((o) => o.citationUrl === `doc:${w.doc.id}`)).toEqual([]);
    expect((await listProposals(w.db)).map((p) => p.change)).toMatchObject([{ kind: 'observation', value: 1100, citationUrl: `doc:${w.doc.id}`, quotedText: QUOTE }]);
  });

  it('keeps dev findings in the run summary: staged on a dry run, committed too after a commit, and in no table', async () => {
    const devFinding = toolUse('record_dev_finding', {
      category: 'revenue', title: 'Revenue claim', metric_keys: ['revenue_run_rate_usd'], claim: 'The post says $1,100.', orion_reading: 'Orion has 1000.',
      value_direction: 'up', proposed_fix: 'Read the revenue page.', evidence: [w.ids.revenue_run_rate_usd],
      citations: [{ source: `doc:${w.doc.id}`, quoted_text: QUOTE }],
    });
    const dry = await run([calls(devFinding), calls(journalCall()), say('Done.')], { dryRun: true });
    expect(model.toolResults(1)[0]).toMatchObject({ is_error: false, result: { staged: true } });
    const drySummary = (await getAgentRun(w.db, dry.run.id))!.summary as { committed: unknown; staged: { devFindings: { category: string; fingerprint: string }[] } };
    expect(drySummary.committed).toBeNull();
    expect(drySummary.staged.devFindings).toMatchObject([{ category: 'revenue', metricKeys: ['revenue_run_rate_usd'], fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }]);

    const done = await run([calls(devFinding), calls(journalCall()), say('Done.')]);
    const summary = (await getAgentRun(w.db, done.run.id))!.summary as { committed: { devFindings: unknown[] }; staged: { devFindings: unknown[] } };
    expect(summary.committed.devFindings).toEqual(drySummary.staged.devFindings);
    expect(summary.staged.devFindings).toEqual(drySummary.staged.devFindings);
  });

  it('records docId and docSha256 in trigger_detail and runs under budget disclosure', async () => {
    const result = await run([calls(journalCall()), say('Done.')], { note: 'see the post' });
    expect(result.run).toMatchObject({ outcome: 'completed', runType: 'disclosure', trigger: 'manual', triggerDetail: { note: 'see the post', docId: w.doc.id, docSha256: w.doc.sha256 } });
    expect((await getAgentRun(w.db, result.run.id))!.triggerDetail).toEqual({ note: 'see the post', docId: w.doc.id, docSha256: w.doc.sha256 });
    const pack = packOf();
    expect(pack.run).toEqual({ type: 'disclosure', now: AS_OF, budgets: DEFAULT_BUDGETS.disclosure });
    expect(pack.document).toMatchObject({ id: w.doc.id, kind: 'post', sha256: w.doc.sha256, text: DOC_TEXT });
    // 25 requests, 3 searches, 5 fetches: the web tools carry the disclosure budget's limits.
    expect(DEFAULT_BUDGETS.disclosure).toEqual({ requests: 25, inputUnits: 1_200_000, outputTokens: 40_000, webSearches: 3, webFetches: 5, proposals: 5 });
    expect(model.requests[0].tools.find((t) => 'name' in t && t.name === 'web_search')).toMatchObject({ max_uses: 3 });
    expect(model.requests[0].tools.find((t) => 'name' in t && t.name === 'web_fetch')).toMatchObject({ max_uses: 5 });
  });
});

describe('which tools a run is offered', () => {
  // The filter goes by name, so stand-ins with those names test it apart from what the real tools do.
  const stand = (name: string): AgentTool => ({ name, description: name, input: {} as AgentTool['input'], run: () => null });

  it('offers a disclosure run the nine tools, in the order it is given them, and nothing else', () => {
    const given = ['write_journal', 'get_drivers', ...NINE.filter((n) => n !== 'write_journal'), 'apply_assumption_change', 'run_whatif'].map(stand);
    expect(toolsForRun(given, 'disclosure').map((t) => t.name)).toEqual(['write_journal', ...NINE.filter((n) => n !== 'write_journal')]);
  });
});
