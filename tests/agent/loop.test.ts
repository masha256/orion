import { describe, expect, it } from 'vitest';
import { runLoop, type LoopInput } from '../../src/agent/loop.js';
import { webTools, type ModelMessageParam } from '../../src/agent/model.js';
import { fetchedPagesFrom } from '../../src/agent/research.js';
import { DEFAULT_BUDGETS } from '../../src/config/agentPolicy.js';
import { calls, say, scriptedModel, text, thinking, toolUse, webFetch, type ScriptStep } from '../helpers/fakeModel.js';

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
    expect(h.model.requests[0]).toMatchObject({ model: 'claude-opus-5', effort: 'high', system: 'system prompt', maxTokens: 16000 });
    expect(h.model.toolResults(1)).toEqual([
      { tool_use_id: 'a', is_error: false, result: { ok: 'get_drivers' }, budget: { requests_left: 24, input_tokens_left: 599_900, output_tokens_left: 39_950 } },
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
    expect(await h.run()).toMatchObject({ stop: 'refused', detail: 'cyber' });
    expect(h.ran).toEqual([]);
  });

  it('treats a turn cut off at the token limit as an error and never runs its tools', async () => {
    const h = harness([{ content: [toolUse('apply_assumption_change', { key: 'rev' }, 'a')], stop_reason: 'max_tokens' }]);
    expect(await h.run()).toMatchObject({ stop: 'error', detail: 'max_tokens' });
    expect(h.ran).toEqual([]);
  });

  it('stops when the request budget is spent, checked before each request', async () => {
    const step = () => calls(toolUse('get_drivers', {}));
    const h = harness([step(), step(), step()], { budgets: { ...DEFAULT_BUDGETS.weekly, requests: 2 } });
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'budget_exhausted', detail: 'requests (2)' });
    expect(h.model.requests).toHaveLength(2);
  });

  it('counts cache reads and writes toward the input budget, and output toward its own', async () => {
    const cached = { ...calls(toolUse('get_drivers', {})), usage: { input_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 400, output_tokens: 5 } };
    const input = await harness([cached, cached], { budgets: { ...DEFAULT_BUDGETS.weekly, inputTokens: 1000 } }).run();
    expect(input).toMatchObject({ stop: 'budget_exhausted', detail: 'input tokens (1000)', usage: { inputTokens: 10, cacheReadTokens: 600, cacheWriteTokens: 400 } });
    const output = await harness([{ ...cached, usage: { output_tokens: 70 } }, cached], { budgets: { ...DEFAULT_BUDGETS.weekly, outputTokens: 60 } }).run();
    expect(output).toMatchObject({ stop: 'budget_exhausted', detail: 'output tokens (60)' });
  });

  it('reminds once when the model stops without a journal entry, then gives up', async () => {
    const reminded = harness([say('All done.'), calls(toolUse('write_journal', {}, 'a')), say('Done.')]);
    expect((await reminded.run()).stop).toBe('finished');
    expect(reminded.model.requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'Write your journal entry now.' });

    const stubborn = harness([say('All done.'), say('Really done.')]);
    expect((await stubborn.run()).stop).toBe('no_journal');
    expect(stubborn.model.requests).toHaveLength(2);
  });

  it('reports an API error with its class, and keeps the usage so far', async () => {
    const h = harness([calls(toolUse('get_drivers', {})), new RateLimitError('429 slow down')]);
    const result = await h.run();
    expect(result).toMatchObject({ stop: 'error', detail: 'RateLimitError: 429 slow down', usage: { requests: 1 } });
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
    expect(result).toMatchObject({ stop: 'error', detail: 'ToolBug: undefined is not a function', usage: { requests: 2, inputTokens: 200 } });
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

  it('adds up server tool usage and records each response', async () => {
    const searched = { ...calls(toolUse('write_journal', {})), model: 'claude-opus-4-8', usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } } };
    const result = await harness([searched, say('Done.')]).run();
    expect(result.usage).toMatchObject({ webSearches: 2, webFetches: 1 });
    expect(result.responses.map((r) => [r.model, r.stopReason])).toEqual([['claude-opus-4-8', 'tool_use'], ['claude-opus-5', 'end_turn']]);
  });
});

describe('web tools', () => {
  it('declares the server tools with the run\'s limits, and leaves one out when its limit is zero', () => {
    expect(webTools({ webSearches: 5, webFetches: 3 })).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, max_content_tokens: 25000 },
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
