import { z } from 'zod';
import { whatIf, type WhatIfOptions } from '../../app/valuation.js';
import type { ProposalEffect } from '../../db/proposals.js';
import { HORIZONS, SCENARIOS, type Scenario } from '../../types.js';
import { describeEngine } from '../describe.js';
import { defineTool, type AgentTool, type ToolContext } from './types.js';

export interface Override {
  key: string;
  value: number;
  scenario?: Scenario;
}

/** `whatIf` on top of everything this run has staged: its assumption changes, and the research that will go live. */
export function stagedWhatIf(ctx: ToolContext, overrides: Override[] = [], opts: WhatIfOptions = {}): ReturnType<typeof whatIf> {
  const now = ctx.now();
  const staged = ctx.ledger.observationRows(now.toISOString(), { liveOnly: true });
  return whatIf(ctx.db, ctx.loaded, now, [...ctx.ledger.overrides(), ...overrides], {
    ...opts,
    addObservations: [...staged, ...(opts.addObservations ?? [])],
  });
}

/** Expected targets before and after a change, both on top of the staged state. Nothing is persisted. */
export function computeEffect(ctx: ToolContext, overrides: Override[], opts: WhatIfOptions = {}): ProposalEffect {
  const before = stagedWhatIf(ctx);
  const after = stagedWhatIf(ctx, overrides, opts);
  if ('blocked' in after) return { blocked: after.blocked };
  const from = (h: (typeof HORIZONS)[number]): number | null => ('output' in before ? before.output.horizons[h].expectedTarget : null);
  return {
    '6m': { from: from('6m'), to: after.output.horizons['6m'].expectedTarget },
    '12m': { from: from('12m'), to: after.output.horizons['12m'].expectedTarget },
  };
}

const runWhatIf = defineTool({
  name: 'run_whatif',
  description:
    'Runs the valuation engine with assumption overrides on top of whatever you have staged in this run, and returns targets per horizon ' +
    'and scenario and each module\'s value. Nothing is saved or staged, and bounds are not enforced, so use it to size a change or a ' +
    'proposal before you make it. Omit scenario to override all three.',
  input: z.strictObject({
    overrides: z.array(z.strictObject({ key: z.string(), value: z.number(), scenario: z.enum(SCENARIOS).optional() })),
  }),
  run(ctx, input) {
    const result = stagedWhatIf(ctx, input.overrides);
    return 'blocked' in result ? { blocked: result.blocked } : describeEngine(result.output);
  },
});

export const THINK_TOOLS: AgentTool[] = [runWhatIf];
