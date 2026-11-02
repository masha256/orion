import type { RunnableRunType } from '../../types.js';
import { READ_TOOLS } from './read.js';
import type { AgentTool } from './types.js';
import { WRITE_TOOLS } from './write.js';

/** Every tool, in this fixed order (the tool list is part of the cached prompt prefix). `toolsForRun` picks a run's. */
export const AGENT_TOOLS: AgentTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** The tools each runnable run type is offered, by name. A disclosure run, the only one, is offered all of them. */
const RUN_TOOLS: Record<RunnableRunType, readonly string[]> = {
  disclosure: [
    'get_observations', 'get_anomalies', 'get_journal', 'get_flow_total', 'resolve_anomaly', 'record_provisional_observation', 'propose_change',
    'write_journal', 'record_dev_finding',
  ],
};

/** The tools a run is offered, in `tools`' order. */
export function toolsForRun(tools: AgentTool[], runType: RunnableRunType): AgentTool[] {
  const offered = new Set(RUN_TOOLS[runType]);
  return tools.filter((t) => offered.has(t.name));
}

export { runTool, toApiTools, ToolRefusal, type AgentTool, type ToolContext, type ToolOutcome } from './types.js';
