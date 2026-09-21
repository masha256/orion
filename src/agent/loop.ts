import type { RunBudgets } from '../config/agentPolicy.js';
import type { Effort } from '../config/personas.js';
import { ZERO_USAGE, type AgentUsage } from '../db/agentRuns.js';
import type { ModelClient, ModelMessage, ModelMessageParam, ModelTool } from './model.js';
import type { ToolOutcome } from './tools/types.js';

/**
 * The tool-use loop. It knows the Messages API's stop reasons and Orion's budgets, and nothing about valuation: the
 * caller supplies how to run a tool and how to tell whether the run may finish.
 */

/** Requests are streamed, and the run's output budget is what bounds the cost; a long adaptive-thinking turn that hits
 * this cap would throw the whole run away. */
export const MAX_TOKENS_PER_RESPONSE = 32_000;

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
  // STRICTLY greater, unlike the budgets above. `max_uses` bounds one request's server-side loop, not the run's total,
  // so without this a 25-request run could search 125 times. Reaching the limit exactly is a run doing precisely what
  // it was allowed, and ending there would throw that run away; only a LATER request spending past the total ends it.
  if (usage.webSearches > budgets.webSearches) return `web searches (${budgets.webSearches})`;
  if (usage.webFetches > budgets.webFetches) return `web fetches (${budgets.webFetches})`;
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
    web_searches_left: Math.max(0, budgets.webSearches - usage.webSearches),
    web_fetches_left: Math.max(0, budgets.webFetches - usage.webFetches),
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

    // A `fallback` block means the server switched models mid-turn, after the model before it declined. Anything that
    // model had already emitted may be a tool call it never finished, and a truncated input can still parse. Nothing
    // before the last handover is run.
    const lastFallback = response.content.map((b) => b.type).lastIndexOf('fallback');
    if (lastFallback >= 0 && response.content.some((b, i) => b.type === 'tool_use' && i < lastFallback)) {
      return done('error', 'tool call precedes a model fallback; not run');
    }

    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && calls.length > 0) {
      // Every result goes back in ONE user message: splitting them teaches the model to stop calling tools in parallel.
      // runTool answers every EXPECTED failure as an is_error result. A throw here is a bug in a tool: end the loop as an
      // error rather than reject, so the usage and the transcript so far still reach the run record.
      let results: { type: 'tool_result'; tool_use_id: string; is_error: boolean; content: string }[];
      try {
        results = calls.map((call) => {
          const outcome = input.runTool(call.name, call.input);
          return {
            type: 'tool_result' as const, tool_use_id: call.id, is_error: outcome.isError,
            content: `${outcome.content}\n\nbudget: ${JSON.stringify(budgetLeft())}`,
          };
        });
      } catch (err) {
        return done('error', err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err));
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (input.isFinished()) return done('finished');
    if (reminded) return done('no_journal');
    reminded = true;
    messages.push({ role: 'user', content: input.reminder });
  }
}
