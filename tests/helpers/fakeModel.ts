import type { ModelClient, ModelMessage, ModelRequest } from '../../src/agent/model.js';

/**
 * A scripted model: each call to `send` returns the next step. A step may be a function of the request, so a script can
 * react to what the loop sent back (a refused tool call, say). Every request is recorded, with the messages copied at
 * the time of the call, because the loop keeps appending to the same array.
 */

export type Block = Record<string, unknown>;
export interface Step {
  content: Block[];
  stop_reason?: string;
  model?: string;
  usage?: Partial<{
    input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number;
    server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  }>;
  stop_details?: { type: 'refusal'; category: string | null; explanation: string | null };
}
export type ScriptStep = Step | Error | ((request: ModelRequest) => Step | Error);

let nextToolUseId = 1;

export const text = (t: string): Block => ({ type: 'text', text: t });
export const thinking = (): Block => ({ type: 'thinking', thinking: '', signature: 'sig' });
export const toolUse = (name: string, input: unknown, id = `toolu_${nextToolUseId++}`): Block => ({ type: 'tool_use', id, name, input });

/** One or more client tool calls in a single assistant turn. */
export const calls = (...blocks: Block[]): Step => ({ content: blocks, stop_reason: 'tool_use' });
export const say = (t: string): Step => ({ content: [text(t)], stop_reason: 'end_turn' });

/** A server-side web_fetch inside the assistant turn: the call and its result, as the API returns them. */
export const webFetch = (url: string, pageText: string, id = `srvtoolu_${nextToolUseId++}`): Block[] => [
  { type: 'server_tool_use', id, name: 'web_fetch', input: { url } },
  {
    type: 'web_fetch_tool_result', tool_use_id: id,
    content: {
      type: 'web_fetch_result', url, retrieved_at: '2026-06-30T00:00:00Z',
      content: { type: 'document', title: null, citations: null, source: { type: 'text', media_type: 'text/plain', data: pageText } },
    },
  },
];

export const journalCall = (over: Record<string, unknown> = {}): Block =>
  toolUse('write_journal', { thesis: 'steady', open_questions: ['next disclosure?'], summary: 'reviewed', ...over });

export interface ScriptedModel extends ModelClient {
  requests: ModelRequest[];
  /** The tool results the loop sent back in request `i` (0-based), parsed: [{ tool_use_id, is_error, result, budget }]. */
  toolResults: (i: number) => { tool_use_id: string; is_error: boolean; result: Record<string, unknown>; budget: Record<string, number> }[];
}

export function scriptedModel(script: ScriptStep[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    requests,
    async send(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const next = script[i++];
      if (next === undefined) throw new Error(`the script has ${script.length} steps but the loop asked for step ${i}`);
      const step = typeof next === 'function' ? next(request) : next;
      if (step instanceof Error) throw step;
      return {
        id: `msg_${i}`, type: 'message', role: 'assistant', model: step.model ?? request.model, content: step.content,
        stop_reason: step.stop_reason ?? 'end_turn', stop_sequence: null, stop_details: step.stop_details ?? null,
        usage: {
          input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null,
          ...step.usage,
        },
      } as unknown as ModelMessage;
    },
    toolResults(index) {
      const last = requests[index].messages.at(-1)!;
      if (last.role !== 'user' || typeof last.content === 'string') return [];
      return last.content.flatMap((b) => {
        if (b.type !== 'tool_result' || typeof b.content !== 'string') return [];
        const [result, budget] = b.content.split('\n\nbudget: ');
        return [{ tool_use_id: b.tool_use_id, is_error: b.is_error === true, result: JSON.parse(result) as Record<string, unknown>, budget: JSON.parse(budget) as Record<string, number> }];
      });
    },
  };
}
