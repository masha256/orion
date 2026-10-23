import type { RunType } from '../../types.js';
import { READ_TOOLS } from './read.js';
import { THINK_TOOLS } from './think.js';
import type { AgentTool } from './types.js';
import { WRITE_TOOLS } from './write.js';

/** Every tool, in this fixed order (the tool list is part of the cached prompt prefix). `toolsForRun` picks a run's. */
export const AGENT_TOOLS: AgentTool[] = [...READ_TOOLS, ...THINK_TOOLS, ...WRITE_TOOLS];

/** Tools offered to a disclosure run only, so no other run's tool list changes. */
export const DISCLOSURE_ONLY_TOOLS: readonly string[] = ['get_flow_total', 'record_dev_finding'];

/**
 * The tools a run is offered, in `tools`' order. With no assumption set there is nothing to read or change. A bootstrap
 * never changes an assumption (spec invariant 5), and a disclosure run never writes one directly: what it finds goes to
 * the user as a proposal. So apply_assumption_change is offered to neither, set or no set.
 */
export function toolsForRun(tools: AgentTool[], runType: RunType, hasAssumptionSet: boolean): AgentTool[] {
  return tools.filter((t) => {
    if (t.name === 'apply_assumption_change') return hasAssumptionSet && runType !== 'bootstrap' && runType !== 'disclosure';
    if (t.name === 'get_assumptions') return hasAssumptionSet;
    if (DISCLOSURE_ONLY_TOOLS.includes(t.name)) return runType === 'disclosure';
    return true;
  });
}

export { runTool, toApiTools, ToolRefusal, type AgentTool, type ToolContext, type ToolOutcome } from './types.js';
