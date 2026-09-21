import Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Effort } from '../config/personas.js';
import { OrionError } from '../types.js';

export type ModelMessage = Anthropic.Beta.BetaMessage;
export type ModelMessageParam = Anthropic.Beta.BetaMessageParam;
export type ModelTool = Anthropic.Beta.BetaToolUnion;

export interface ModelRequest {
  model: string;
  effort: Effort;
  system: string;
  tools: ModelTool[];
  messages: ModelMessageParam[];
  maxTokens: number;
}

/** The one seam between Orion and the Claude API. The real client and the scripted test model both implement it. */
export interface ModelClient {
  send(request: ModelRequest): Promise<ModelMessage>;
}

/** Which web_fetch variant the runner declares. One constant, because the live probe in the plan's checkpoint may change it. */
export const WEB_FETCH_TOOL_TYPE = 'web_fetch_20260209' as const;
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209' as const;
export const MAX_FETCH_CONTENT_TOKENS = 25_000;

/** Server-side tools: Anthropic runs them; their results come back inside the assistant turn. */
export function webTools(limits: { webSearches: number; webFetches: number }): ModelTool[] {
  const tools: ModelTool[] = [];
  if (limits.webSearches > 0) tools.push({ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: limits.webSearches });
  if (limits.webFetches > 0) {
    tools.push({
      type: WEB_FETCH_TOOL_TYPE, name: 'web_fetch', max_uses: limits.webFetches, max_content_tokens: MAX_FETCH_CONTENT_TOKENS,
      // Direct calls only. A fetch from inside server-side code execution would keep the page text out of the
      // transcript, so `fetchedPages` would never see it and every citation of that page would be refused.
      allowed_callers: ['direct'],
    });
  }
  return tools;
}

/**
 * Where credentials will come from, or null when nothing suggests there are any. The SDK only finds out at the first
 * request, by which time a run row exists; this lets preflight fail first, for free. It is a hint, not proof: a key can
 * still be wrong, and then the run ends as `error` with the SDK's AuthenticationError.
 */
export function credentialSource(env: Record<string, string | undefined>, profileDirExists: boolean): string | null {
  if (env.ANTHROPIC_API_KEY?.trim()) return 'ANTHROPIC_API_KEY';
  if (env.ANTHROPIC_AUTH_TOKEN?.trim()) return 'ANTHROPIC_AUTH_TOKEN';
  if (env.ANTHROPIC_PROFILE?.trim()) return 'ANTHROPIC_PROFILE';
  if (env.ANTHROPIC_FEDERATION_RULE_ID?.trim()) return 'workload identity federation';
  return profileDirExists ? 'an SDK profile on disk' : null;
}

/**
 * The real client. This is the only place in Orion that constructs the SDK client, so no test can reach the network by
 * accident. `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) from <ORION_HOME>/.env or the environment is passed
 * explicitly when set, because the SDK reads only the process environment; otherwise the SDK resolves credentials
 * itself (an `ant auth login` profile, or workload identity federation).
 */
export function anthropicModelClient(env: Record<string, string | undefined>): ModelClient {
  if (credentialSource(env, existsSync(join(homedir(), '.config', 'anthropic'))) === null) {
    throw new OrionError('no_credentials', 'no Anthropic credentials: set ANTHROPIC_API_KEY in <ORION_HOME>/.env or the environment, or run "ant auth login"');
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined;
  const client = apiKey || authToken ? new Anthropic({ apiKey, authToken }) : new Anthropic();
  return {
    async send(request) {
      // Streamed, because a research turn can outlast an HTTP timeout; finalMessage() assembles the whole response.
      const stream = client.beta.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: request.effort },
        // Caches the growing prefix: tools, system, and the conversation so far.
        cache_control: { type: 'ephemeral' },
        // If the model's safety classifier declines a turn, the API reruns it on a fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      return stream.finalMessage();
    },
  };
}
