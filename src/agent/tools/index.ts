import { READ_TOOLS } from './read.js';
import { THINK_TOOLS } from './think.js';
import type { AgentTool } from './types.js';
import { WRITE_TOOLS } from './write.js';

/** Every run type gets the same tools, in this fixed order (the tool list is part of the cached prompt prefix). */
export const AGENT_TOOLS: AgentTool[] = [...READ_TOOLS, ...THINK_TOOLS, ...WRITE_TOOLS];

export { runTool, toApiTools, ToolRefusal, type AgentTool, type ToolContext, type ToolOutcome } from './types.js';
