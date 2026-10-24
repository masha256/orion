import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runLoop, type LoopInput } from '../../src/agent/loop.js';
import { RESERVE_MESSAGE } from '../../src/agent/prompt.js';
import { webTools, type ModelMessageParam } from '../../src/agent/model.js';
import { fetchedPagesFrom } from '../../src/agent/research.js';
import { DEFAULT_BUDGETS } from '../../src/config/agentPolicy.js';
import type { RunType } from '../../src/types.js';
import { calls, journalCall, say, scriptedModel, text, thinking, toolUse, webFetch, type ScriptStep, type Step } from '../helpers/fakeModel.js';

class RateLimitError extends Error {}

function harness(script: ScriptStep[], over: Partial<LoopInput> = {}) {
  const model = scriptedModel(script);
  const ran: { name: string; input: unknown }[] = [];
  const messages: ModelMessageParam[] = [{ role: 'user', content: 'context pack' }];
  let finished = false;
  const input: LoopInput = {
    client: model, model: 'claude-opus-5', effort: 'high', system: 'system prompt', tools: [], messages, budgets: DEFAULT_BUDGETS.weekly,
    runTool: (name, toolInput) => {
      ran.push({ name, input: toolInput });
      if (name === 'write_journal') finished = true;
      return name === 'bad' ? { content: '{"refused":"nope","message":"no"}', isError: true } : { content: `{"ok":"${name}"}`, isError: false };
    },
    isFinished: () => finished,
    reminder: 'Write your journal entry now.',
    ...over,
  };
  return { model, ran, messages, run: () => runLoop(input) };
}

describe('the tool-use loop', () => {
  it('runs tool calls, sends the results back with the budget left, and finishes once the journal is staged', async () => {
    const h = harness([calls(toolUse('get_drivers', {}, 'a')), calls(toolUse('write_journal', { thesis: 't' }, 'b')), say('Done.')]);
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'finished', detail: null });
    expect(h.ran).toEqual([{ name: 'get_drivers', input: {} }, { name: 'write_journal', input: { thesis: 't' } }]);
    expect(h.model.requests).toHaveLength(3);
    expect(h.model.requests[0]).toMatchObject({ model: 'claude-opus-5', effort: 'high', system: 'system prompt', maxTokens: 32000 });
    expect(h.model.toolResults(1)).toEqual([
      {
        tool_use_id: 'a', is_error: false, result: { ok: 'get_drivers' },
        budget: { requests_left: 24, input_units_left: 599_900, output_tokens_left: 39_950, web_searches_left: 5, web_fetches_left: 5 },
      },
    ]);
    expect(result.usage).toMatchObject({ requests: 3, inputTokens: 300, outputTokens: 150 });
    expect(h.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  it('answers parallel tool calls in one user message, in order, errors included', async () => {
    const h = harness([calls(toolUse('get_drivers', {}, 'a'), toolUse('bad', {}, 'b'), toolUse('write_journal', {}, 'c')), say('Done.')]);
    await h.run();
    const results = h.model.toolResults(1);
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([['a', false], ['b', true], ['c', false]]);
    expect(results[1].result).toEqual({ refused: 'nope', message: 'no' });
    expect(h.messages).toHaveLength(4); // context, assistant, ONE user message of results, assistant
  });

  it('passes the assistant turn back unchanged, thinking blocks included', async () => {
    const turn = [thinking(), text('Checking.'), toolUse('write_journal', {}, 'a')];
    const h = harness([{ content: turn, stop_reason: 'tool_use' }, say('Done.')]);
    await h.run();
    expect(h.model.requests[1].messages[1]).toEqual({ role: 'assistant', content: turn });
  });

  it('resumes a paused server-tool turn by sending the conversation back as it is', async () => {
    const paused = { content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'venice revenue' } }], stop_reason: 'pause_turn' };
    const h = harness([paused, calls(toolUse('write_journal', {}, 'a')), say('Done.')]);
    const result = await h.run();
    expect(result.stop).toBe('finished');
    expect(h.model.requests[1].messages.map((m) => m.role)).toEqual(['user', 'assistant']); // no "continue" message added
    expect(result.usage.requests).toBe(3); // a resume is a request
  });

  it('stops on a refusal without running that turn\'s tools', async () => {
    const h = harness([
      { content: [toolUse('write_journal', {}, 'a')], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } },
    ]);
    expect(await h.run()).toMatchObject({ stop: 'refused', detail: 'cyber', reserve: null });
    expect(h.ran).toEqual([]);
  });

  it('treats a turn cut off at the token limit as an error and never runs its tools', async () => {
    const h = harness([{ content: [toolUse('apply_assumption_change', { key: 'rev' }, 'a')], stop_reason: 'max_tokens' }]);
    expect(await h.run()).toMatchObject({ stop: 'error', detail: 'max_tokens', reserve: null });
    expect(h.ran).toEqual([]);
  });

  it('stops when the request budget is spent, checked before each request', async () => {
    const step = () => calls(toolUse('get_drivers', {}));
    const h = harness([step(), step(), step()], { budgets: { ...DEFAULT_BUDGETS.weekly, requests: 2 } });
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'budget_exhausted', detail: 'requests (2)', reserve: 'requests (2)' });
    expect(h.model.requests).toHaveLength(3); // two, then the reserve request, whose get_drivers does not run
    expect(h.ran).toHaveLength(2);
  });

  it('counts input in weighted units: uncached x1, cache writes x1.25, cache reads x0.1', async () => {
    // 10 + 400 x 1.25 + 600 x 0.1 = 570 units. 600 x 0.1 is 60.00000000000001 in a double, hence the count in tenths.
    const cached = { ...calls(toolUse('get_drivers', {})), usage: { input_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 400, output_tokens: 5 } };
    const atCap = harness([cached, cached], { budgets: { ...DEFAULT_BUDGETS.weekly, inputUnits: 570 } });
    const input = await atCap.run();
    expect(input).toMatchObject({ stop: 'budget_exhausted', detail: 'input units (570)', reserve: 'input units (570)' });
    expect(input.usage).toMatchObject({ requests: 2, inputTokens: 20, cacheReadTokens: 1200, cacheWriteTokens: 800 }); // the reserve request counts
    expect(atCap.ran).toHaveLength(1); // the first request's tool only: the reserve turn's get_drivers does not run
    const underCap = harness([cached, calls(journalCall()), say('Done.')], { budgets: { ...DEFAULT_BUDGETS.weekly, inputUnits: 571 } });
    expect(await underCap.run()).toMatchObject({ stop: 'finished', reserve: 'input units (571)' });
    // One unit under the cap: the second request goes out (its own 100 then spend the rest), then the reserve request.
    expect(underCap.model.requests).toHaveLength(3);
    expect(underCap.model.toolResults(1)[0].budget.input_units_left).toBe(1);
    const output = await harness([{ ...cached, usage: { output_tokens: 70 } }, cached], { budgets: { ...DEFAULT_BUDGETS.weekly, outputTokens: 60 } }).run();
    expect(output).toMatchObject({ stop: 'budget_exhausted', detail: 'output tokens (60)', reserve: 'output tokens (60)' });
  });

  it('never reports negative input units left', async () => {
    const huge = { ...calls(toolUse('get_drivers', {}, 'a')), usage: { input_tokens: 10_000_000 } };
    const h = harness([huge, say('ok')], { budgets: { ...DEFAULT_BUDGETS.weekly, inputUnits: 600_000 } });
    expect(await h.run()).toMatchObject({ stop: 'budget_exhausted', detail: 'input units (600000)' });
    const results = (h.messages[2] as { content: { content: string }[] }).content; // the first request's tool results
    expect((JSON.parse(results[0].content.split('\n\nbudget: ')[1]) as Record<string, number>).input_units_left).toBe(0);
  });

  it('lets the three live budget stops run on under units (AERO #44, VVV #17, #31)', async () => {
    type Row = [number, number, number, number, number, number];
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/agent/budget-incidents.json', import.meta.url), 'utf8')) as {
      incidents: { run: number; runType: RunType; rows: Row[] }[];
    };
    expect(fixture.incidents.map((i) => i.run)).toEqual([17, 31, 44]);
    for (const incident of fixture.incidents) {
      const budgets = DEFAULT_BUDGETS[incident.runType];
      // (a) The fixture reproduces the incident: raw input crossed the cap on the last request, not before.
      const raw = incident.rows.map(([input, read, write]) => input + read + write);
      const before = raw.slice(0, -1).reduce((a, b) => a + b, 0);
      expect(before, `run ${incident.run}`).toBeLessThan(budgets.inputUnits);
      expect(before + raw.at(-1)!, `run ${incident.run}`).toBeGreaterThanOrEqual(budgets.inputUnits);
      // (b) Under units the same requests leave room to write the journal.
      const steps: ScriptStep[] = incident.rows.map(([input, read, write, output, searches, fetches]) => ({
        ...calls(toolUse('get_drivers', {})),
        usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output, server_tool_use: { web_search_requests: searches, web_fetch_requests: fetches } },
      }));
      const h = harness([...steps, calls(journalCall()), say('Done.')], { budgets });
      expect(await h.run(), `run ${incident.run}`).toMatchObject({ stop: 'finished' });
      expect(h.model.requests, `run ${incident.run}`).toHaveLength(incident.rows.length + 2);
    }
  });

  it('reminds once when the model stops without a journal entry, then gives up', async () => {
    const reminded = harness([say('All done.'), calls(toolUse('write_journal', {}, 'a')), say('Done.')]);
    expect((await reminded.run()).stop).toBe('finished');
    expect(reminded.model.requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'Write your journal entry now.' });

    const stubborn = harness([say('All done.'), say('Really done.')]);
    expect(await stubborn.run()).toMatchObject({ stop: 'no_journal', reserve: null });
    expect(stubborn.model.requests).toHaveLength(2);
  });

  it('reports an API error with its class, and keeps the usage so far', async () => {
    const h = harness([calls(toolUse('get_drivers', {})), new RateLimitError('429 slow down')]);
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'error', detail: 'RateLimitError: 429 slow down', usage: { requests: 1 }, reserve: null });
  });

  it('ends as an error when a tool throws unexpectedly, keeping the usage and the turn that asked for it', async () => {
    class ToolBug extends Error {}
    const h = harness([calls(toolUse('get_drivers', {}, 'a')), calls(toolUse('explode', {}, 'b')), say('never reached')], {
      runTool: (name) => {
        if (name === 'explode') throw new ToolBug('undefined is not a function');
        return { content: '{"ok":true}', isError: false };
      },
    });
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'error', detail: 'ToolBug: undefined is not a function', usage: { requests: 2, inputTokens: 200 }, reserve: null });
    expect(result.responses).toHaveLength(2);
    expect(h.model.requests).toHaveLength(2);
    expect(h.messages.at(-1)).toMatchObject({ role: 'assistant' }); // the turn is kept; no half-built results message follows it
  });

  it('runs only the client tool calls in a turn that also used a server tool, and answers only those', async () => {
    const mixed = {
      content: [
        { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'venice revenue' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
        toolUse('write_journal', {}, 'c1'),
      ],
      stop_reason: 'tool_use',
    };
    const h = harness([mixed, say('Done.')]);
    expect((await h.run()).stop).toBe('finished');
    expect(h.ran.map((r) => r.name)).toEqual(['write_journal']);
    expect(h.model.toolResults(1).map((r) => r.tool_use_id)).toEqual(['c1']);
  });

  it('ends the run once web use has gone PAST the run budget, and counts what is left in every tool result', async () => {
    const searched = (n: number) => ({ ...calls(toolUse('get_drivers', {}, 'a')), usage: { server_tool_use: { web_search_requests: n, web_fetch_requests: 0 } } });
    const budgets = { ...DEFAULT_BUDGETS.weekly, webSearches: 2 };

    // Spending exactly the budget is the run doing what it was allowed: it goes on, and the model sees nothing left.
    const atLimit = harness([searched(2), calls(toolUse('write_journal', {}, 'j')), say('Done.')], { budgets });
    expect((await atLimit.run()).stop).toBe('finished');
    expect(atLimit.model.toolResults(1)[0].budget).toMatchObject({ web_searches_left: 0, web_fetches_left: 5 });

    // A later request that spends beyond the run's total ends it.
    const over = harness([searched(3), calls(toolUse('get_drivers', {}, 'b'))], { budgets });
    const result = await over.run();
    expect(result).toMatchObject({ stop: 'budget_exhausted', detail: 'web searches (2)', usage: { webSearches: 3 }, reserve: 'web searches (2)' });
    expect(over.model.requests).toHaveLength(2); // the second is the reserve request; its get_drivers does not run
    expect(over.ran.map((r) => r.name)).toEqual(['get_drivers']);
  });

  it('ends the run on a web fetch budget the same way', async () => {
    const fetched = { ...calls(toolUse('get_drivers', {}, 'a')), usage: { server_tool_use: { web_search_requests: 0, web_fetch_requests: 4 } } };
    const h = harness([fetched, say('ok')], { budgets: { ...DEFAULT_BUDGETS.weekly, webFetches: 3 } });
    expect(await h.run()).toMatchObject({ stop: 'budget_exhausted', detail: 'web fetches (3)', reserve: 'web fetches (3)' });
  });

  it('never reports a negative amount of web budget left', async () => {
    // The overspending request's own tool results are built before the loop notices, so this is the one place the
    // figure could go negative. The run ends right after, so the results are read from the conversation itself.
    const searched = { ...calls(toolUse('get_drivers', {}, 'a')), usage: { server_tool_use: { web_search_requests: 9, web_fetch_requests: 9 } } };
    const h = harness([searched, say('ok')], { budgets: { ...DEFAULT_BUDGETS.weekly, webSearches: 5, webFetches: 5 } });
    expect((await h.run()).stop).toBe('budget_exhausted');
    const results = (h.messages[2] as { content: { content: string }[] }).content; // the first request's tool results
    expect(JSON.parse(results[0].content.split('\n\nbudget: ')[1]) as Record<string, number>).toMatchObject({ web_searches_left: 0, web_fetches_left: 0 });
  });

  it('runs no tool call that precedes a model fallback, and ends the run', async () => {
    // The model that declined may have been cut off mid-tool-call; its partial input can still parse.
    const fallback = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-sonnet-5' }, trigger: { type: 'refusal' } };
    const h = harness([{ content: [toolUse('apply_assumption_change', { key: 'rev' }, 'a'), fallback, text('Carrying on.')], stop_reason: 'tool_use' }]);
    expect(await h.run()).toMatchObject({ stop: 'error', detail: 'tool call precedes a model fallback; not run', reserve: null });
    expect(h.ran).toEqual([]);
  });

  it('runs a tool call the fallback model itself made', async () => {
    const fallback = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-sonnet-5' }, trigger: { type: 'refusal' } };
    const h = harness([{ content: [fallback, toolUse('write_journal', {}, 'a')], stop_reason: 'tool_use' }, say('Done.')]);
    expect((await h.run()).stop).toBe('finished');
    expect(h.ran.map((r) => r.name)).toEqual(['write_journal']);
  });

  it('adds up server tool usage and records each response', async () => {
    const searched = { ...calls(toolUse('write_journal', {})), model: 'claude-opus-4-8', usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } } };
    const result = await harness([searched, say('Done.')]).run();
    expect(result.usage).toMatchObject({ webSearches: 2, webFetches: 1 });
    expect(result.responses.map((r) => [r.model, r.stopReason])).toEqual([['claude-opus-4-8', 'tool_use'], ['claude-opus-5', 'end_turn']]);
  });
});

describe('the reserve request', () => {
  const huge = (step: Step = calls(toolUse('get_drivers', {}))): Step => ({ ...step, usage: { input_tokens: 10_000_000 } });
  const spentInput = 'input units (600000)';

  it('sends one reserve request on exhaustion, with the reserve message and 16k max tokens, and finishes on a journal', async () => {
    const h = harness([huge(), calls(journalCall())]);
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'finished', detail: null, reserve: spentInput });
    expect(h.model.requests).toHaveLength(2);
    expect(h.model.requests[1].maxTokens).toBe(16000);
    expect(h.model.requests[1].messages.at(-1)).toEqual({ role: 'user', content: RESERVE_MESSAGE(spentInput) });
    expect(h.model.requests[1].tools).toEqual(h.model.requests[0].tools);
    expect(h.model.requests[1].system).toBe(h.model.requests[0].system);
    expect(h.model.requests[1]).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
    expect(h.model.requests[1]).not.toHaveProperty('toolChoice');
    expect(result.usage.requests).toBe(2);
    expect(result.responses).toHaveLength(2);
    expect(h.ran.map((r) => r.name)).toEqual(['get_drivers', 'write_journal']);
    expect(h.messages.at(-1)).toMatchObject({ role: 'assistant' }); // the journal's result is not sent back
  });

  it('runs no tool and ends budget_exhausted when the reserve turn calls anything but write_journal', async () => {
    const h = harness([huge(), calls(toolUse('get_drivers', {}), journalCall())]);
    expect(await h.run()).toMatchObject({ stop: 'budget_exhausted', detail: spentInput, reserve: spentInput, usage: { requests: 2 } });
    expect(h.ran.map((r) => r.name)).toEqual(['get_drivers']);
    expect(h.model.requests).toHaveLength(2);
  });

  it('ends budget_exhausted when the reserve turn uses a server tool', async () => {
    const h = harness([huge(), { ...calls(journalCall()), usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } }]);
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'budget_exhausted', detail: spentInput, reserve: spentInput, usage: { webSearches: 1 } });
    expect(h.ran.map((r) => r.name)).toEqual(['get_drivers']);
  });

  it('ends budget_exhausted when write_journal is refused in the reserve turn', async () => {
    const ran: string[] = [];
    const h = harness([huge(), calls(journalCall())], {
      runTool: (name) => {
        ran.push(name);
        return name === 'write_journal' ? { content: '{"refused":"no thesis","message":"no"}', isError: true } : { content: '{"ok":true}', isError: false };
      },
      isFinished: () => false,
    });
    expect(await h.run()).toMatchObject({ stop: 'budget_exhausted', detail: spentInput, reserve: spentInput });
    expect(ran).toEqual(['get_drivers', 'write_journal']);
  });

  it('finishes when the journal was already staged and the reserve turn calls nothing', async () => {
    const h = harness([huge(calls(journalCall())), say('Done.')]);
    expect(await h.run()).toMatchObject({ stop: 'finished', detail: null, reserve: spentInput });
    expect(h.model.requests).toHaveLength(2);
  });

  it('reports a failed reserve request as budget_exhausted, not error', async () => {
    const h = harness([huge(), new RateLimitError('429')]);
    const result = await h.run();
    expect(result).toMatchObject({
      stop: 'budget_exhausted', detail: 'input units (600000); reserve request failed: RateLimitError: 429', reserve: spentInput, usage: { requests: 1 },
    });
    expect(result.responses).toHaveLength(1);
  });

  it('uses the reserve once: a reserve turn ending without a journal does not get a reminder or a second reserve', async () => {
    const h = harness([huge(), say('ok')]);
    expect(await h.run()).toMatchObject({ stop: 'budget_exhausted', detail: spentInput, reserve: spentInput });
    expect(h.model.requests).toHaveLength(2);
  });

  it('ends budget_exhausted, running nothing, when the reserve turn stops on refusal, the token limit, the context window or a pause', async () => {
    for (const stop_reason of ['refusal', 'max_tokens', 'model_context_window_exceeded', 'pause_turn']) {
      const h = harness([huge(), { content: [journalCall()], stop_reason }]);
      expect(await h.run(), stop_reason).toMatchObject({ stop: 'budget_exhausted', detail: spentInput, reserve: spentInput });
      expect(h.ran.map((r) => r.name), stop_reason).toEqual(['get_drivers']);
      expect(h.model.requests, stop_reason).toHaveLength(2);
    }
  });

  it('ends budget_exhausted, running nothing, when a reserve-turn journal call precedes a model fallback', async () => {
    const fallback = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-sonnet-5' }, trigger: { type: 'refusal' } };
    const h = harness([huge(), { content: [journalCall(), fallback, text('Carrying on.')], stop_reason: 'tool_use' }]);
    expect(await h.run()).toMatchObject({ stop: 'budget_exhausted', detail: spentInput, reserve: spentInput });
    expect(h.ran.map((r) => r.name)).toEqual(['get_drivers']);
  });

  it('ends as an error when write_journal throws in the reserve turn, as on the main path', async () => {
    class ToolBug extends Error {}
    const h = harness([huge(), calls(journalCall())], {
      runTool: (name) => {
        if (name === 'write_journal') throw new ToolBug('boom');
        return { content: '{"ok":true}', isError: false };
      },
    });
    expect(await h.run()).toMatchObject({ stop: 'error', detail: 'ToolBug: boom', reserve: spentInput, usage: { requests: 2 } });
  });

  it('covers the request, output and web budgets too', async () => {
    const drivers = () => calls(toolUse('get_drivers', {}));
    const cases: [Partial<typeof DEFAULT_BUDGETS.weekly>, ScriptStep[], string][] = [
      [{ requests: 2 }, [drivers(), drivers(), calls(journalCall())], 'requests (2)'],
      [{ outputTokens: 60 }, [{ ...drivers(), usage: { output_tokens: 70 } }, calls(journalCall())], 'output tokens (60)'],
      [{ webSearches: 2 }, [{ ...drivers(), usage: { server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } } }, calls(journalCall())], 'web searches (2)'],
    ];
    for (const [over, script, reason] of cases) {
      const h = harness(script, { budgets: { ...DEFAULT_BUDGETS.weekly, ...over } });
      expect(await h.run(), reason).toMatchObject({ stop: 'finished', detail: null, reserve: reason });
      expect(h.model.requests.at(-1)!.messages.at(-1), reason).toEqual({ role: 'user', content: RESERVE_MESSAGE(reason) });
      expect(h.model.requests.at(-1)!.maxTokens, reason).toBe(16000);
    }
  });

  it('runs no reserve after a pause_turn, refusal, error, max_tokens or no_journal', async () => {
    const paused = { content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'venice revenue' } }], stop_reason: 'pause_turn', usage: { input_tokens: 10_000_000 } };
    const h = harness([paused, calls(journalCall())]);
    expect(await h.run()).toMatchObject({ stop: 'budget_exhausted', detail: spentInput, reserve: null });
    expect(h.model.requests).toHaveLength(1);
  });
});

describe('web tools', () => {
  it('declares the server tools with the run\'s limits, and leaves one out when its limit is zero', () => {
    expect(webTools({ webSearches: 5, webFetches: 3 })).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      // allowed_callers keeps the fetch out of server-side code execution, where the page text would never reach the
      // transcript and so every citation of it would be refused.
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, max_content_tokens: 25000, allowed_callers: ['direct'] },
    ]);
    expect(webTools({ webSearches: 0, webFetches: 0 })).toEqual([]);
  });

  it('reads fetched pages out of the transcript, and only text that actually came back', () => {
    const messages = [
      { role: 'user', content: 'context pack' },
      {
        role: 'assistant',
        content: [
          text('Looking.'),
          ...webFetch('https://news.example.com/a', '<p>Revenue reached $100 million.</p>'),
          { type: 'server_tool_use', id: 's2', name: 'web_fetch', input: { url: 'https://gone.example.com' } },
          { type: 'web_fetch_tool_result', tool_use_id: 's2', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
          { type: 'server_tool_use', id: 's3', name: 'web_fetch', input: { url: 'https://example.com/report.pdf' } },
          {
            type: 'web_fetch_tool_result', tool_use_id: 's3',
            content: { type: 'web_fetch_result', url: 'https://example.com/report.pdf', content: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } } },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'a user turn that merely mentions web_fetch_tool_result' }] },
    ] as unknown as ModelMessageParam[];
    expect(fetchedPagesFrom(messages)).toEqual([{ url: 'https://news.example.com/a', text: '<p>Revenue reached $100 million.</p>' }]);
  });
});
