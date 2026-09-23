import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { RunBudgets } from '../../config/agentPolicy.js';
import type { LoadedAsset } from '../../config/load.js';
import type { Db } from '../../db/connection.js';
import { OrionError, type RunType } from '../../types.js';
import type { FetchedPage, Refusal } from '../guardrails.js';
import type { Ledger } from '../ledger.js';

/** What every tool gets. Tools read the database, and write only to the ledger. */
export interface ToolContext {
  db: Db;
  loaded: LoadedAsset;
  ledger: Ledger;
  now: () => Date;
  budgets: RunBudgets;
  /** Pages fetched by web_fetch so far in this run, read from the transcript by the runner. */
  fetchedPages: () => FetchedPage[];
  /** Which run this is: some writes are closed to a bootstrap. */
  runType: RunType;
}

export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** Returns a JSON-serializable result, or throws ToolRefusal. */
  run(ctx: ToolContext, input: I): unknown;
}

/** Erases the input type so tools of different shapes fit in one list. `runTool` validates before calling `run`. */
export function defineTool<I>(tool: AgentTool<I>): AgentTool {
  return tool as unknown as AgentTool;
}

/** A guardrail said no. The model sees why, with the numbers it needs, and the run goes on. */
export class ToolRefusal extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = 'ToolRefusal';
  }
}

export const refuse = (refused: string, message: string, detail: Record<string, unknown> = {}): never => {
  throw new ToolRefusal({ refused, message, ...detail });
};

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/**
 * Validates the input, runs the tool, and turns every expected failure into an `is_error` result: an unknown tool, input
 * that fails the schema, a guardrail refusal, an OrionError from the code the tool calls through. Anything else is a bug
 * and propagates, which ends the run as `error`.
 */
export function runTool(tools: AgentTool[], ctx: ToolContext, name: string, rawInput: unknown): ToolOutcome {
  const fail = (refusal: Refusal): ToolOutcome => ({ content: JSON.stringify(refusal), isError: true });
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail({ refused: 'unknown_tool', message: `there is no tool named ${name}` });
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`);
    return fail({ refused: 'invalid_input', message: issues.join('; '), issues });
  }
  try {
    return { content: JSON.stringify(tool.run(ctx, parsed.data)), isError: false };
  } catch (err) {
    if (err instanceof ToolRefusal) return fail(err.refusal);
    if (err instanceof OrionError) return fail({ refused: err.code, message: err.message });
    throw err;
  }
}

/** The tool definitions the API takes. The JSON Schema comes from the same zod object that validates the input. */
export function toApiTools(tools: AgentTool[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => {
    const { $schema: _dropped, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, input_schema: schema as Anthropic.Beta.BetaTool['input_schema'] };
  });
}
