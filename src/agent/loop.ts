import type { RunBudgets } from '../config/agentPolicy.js';
import type { Effort } from '../config/personas.js';
import { ZERO_USAGE, type AgentUsage } from '../db/agentRuns.js';
import type { ModelClient, ModelMessage, ModelMessageParam, ModelTool } from './model.js';
import type { ToolOutcome } from './tools/types.js';

/**
 * The tool-use loop. It knows the Messages API's stop reasons and Orion's budgets, and nothing about valuation: the
 * caller supplies how to run a tool and how to tell whether the run may finish.
 */

export const MAX_TOKENS_PER_RESPONSE = 16_000;

export type LoopStop = 'finished' | 'budget_exhausted' | 'refused' | 'no_journal' | 'error';

export interface LoopInput {
  client: ModelClient;
  model: string;
  effort: Effort;
  system: string;
  tools: ModelTool[];
  /** The conversation, owned by the caller so its tools can read it while the loop runs. Append-only. Starts with one user message. */
  messages: ModelMessageParam[];
  budgets: RunBudgets;
  runTool: (name: string, input: unknown) => ToolOutcome;
  /** True when the run may end: the journal entry is staged. */
  isFinished: () => boolean;
  /** Sent once, as a user message, when the model ends its turn before `isFinished`. */
  reminder: string;
}

export interface ResponseMeta {
  model: string;
  stopReason: string | null;
  usage: ModelMessage['usage'];
}

export interface LoopResult {
  stop: LoopStop;
  /** For `budget_exhausted`, which budget; for `error`, the error class and message; for `refused`, the category if given. */
  detail: string | null;
  usage: AgentUsage;
  responses: ResponseMeta[];
}

const inputSpent = (u: AgentUsage): number => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

function exhausted(usage: AgentUsage, budgets: RunBudgets): string | null {
  if (usage.requests >= budgets.requests) return `requests (${budgets.requests})`;
  if (inputSpent(usage) >= budgets.inputTokens) return `input tokens (${budgets.inputTokens})`;
  if (usage.outputTokens >= budgets.outputTokens) return `output tokens (${budgets.outputTokens})`;
  return null;
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const { messages, budgets } = input;
  const usage: AgentUsage = { ...ZERO_USAGE };
  const responses: ResponseMeta[] = [];
  const done = (stop: LoopStop, detail: string | null = null): LoopResult => ({ stop, detail, usage, responses });
  const budgetLeft = () => ({
    requests_left: Math.max(0, budgets.requests - usage.requests),
    input_tokens_left: Math.max(0, budgets.inputTokens - inputSpent(usage)),
    output_tokens_left: Math.max(0, budgets.outputTokens - usage.outputTokens),
  });
  let reminded = false;

  for (;;) {
    const spent = exhausted(usage, budgets);
    if (spent) return done('budget_exhausted', spent);

    let response: ModelMessage;
    try {
      response = await input.client.send({
        model: input.model, effort: input.effort, system: input.system, tools: input.tools, messages, maxTokens: MAX_TOKENS_PER_RESPONSE,
      });
    } catch (err) {
      // The SDK has already retried what is retryable. Keep the class name: it says whether this was auth, rate limit, or a bug.
      return done('error', err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err));
    }

    usage.requests += 1;
    usage.inputTokens += response.usage.input_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
    usage.outputTokens += response.usage.output_tokens;
    usage.webSearches += response.usage.server_tool_use?.web_search_requests ?? 0;
    usage.webFetches += response.usage.server_tool_use?.web_fetch_requests ?? 0;
    responses.push({ model: response.model, stopReason: response.stop_reason, usage: response.usage });

    // The assistant turn goes back unchanged, thinking and server-tool blocks included. An empty turn cannot be sent back.
    if (response.content.length > 0) messages.push({ role: 'assistant', content: response.content as ModelMessageParam['content'] });

    if (response.stop_reason === 'refusal') return done('refused', response.stop_details?.category ?? null);
    // A tool call cut off at the token limit may parse as a valid partial input. Never run tools from such a turn.
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') return done('error', response.stop_reason);
    // A server tool hit its own iteration limit: send the conversation back as it is and the server resumes.
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && calls.length > 0) {
      // Every result goes back in ONE user message: splitting them teaches the model to stop calling tools in parallel.
      const results = calls.map((call) => {
        const outcome = input.runTool(call.name, call.input);
        return {
          type: 'tool_result' as const, tool_use_id: call.id, is_error: outcome.isError,
          content: `${outcome.content}\n\nbudget: ${JSON.stringify(budgetLeft())}`,
        };
      });
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (input.isFinished()) return done('finished');
    if (reminded) return done('no_journal');
    reminded = true;
    messages.push({ role: 'user', content: input.reminder });
  }
}
