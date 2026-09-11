import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolProfile } from '../config.js';
import { orchestratorStatusTool, runnerListTool } from './admin.js';
import { agentCreateTool, agentGetTool, agentListTool, agentTemplateListTool } from './agents.js';
import { artifactDeleteTool, artifactGetTool, artifactListTool, artifactPutTool } from './artifacts.js';
import { delegateTool, fanOutTool } from './delegation.js';
import { jobCancelTool, jobGetTool, jobListTool, jobRetryTool, jobSubmitTool, jobWaitTool } from './jobs.js';
import { memoryDeleteTool, memoryReadTool, memorySearchTool, memoryWriteTool } from './memory.js';
import { channelCreateTool, channelListTool, messageListTool, messageSendTool } from './messaging.js';
import { budgetSetTool, eventsQueryTool } from './observability.js';
import type { ToolDeps, ToolRegistration } from './types.js';

/**
 * The single ordered source of truth for the tool catalog, following the
 * PLAN.md §5 section order. `tools/list` order follows this array, so additions
 * go in a deliberate position rather than wherever an import happens to land.
 */
export const TOOL_REGISTRY: readonly ToolRegistration[] = [
  // §5.1 Agents
  agentCreateTool,
  agentListTool,
  agentGetTool,
  agentTemplateListTool,
  // §5.2 Jobs
  jobSubmitTool,
  jobGetTool,
  jobListTool,
  jobWaitTool,
  jobCancelTool,
  jobRetryTool,
  // §5.3 Delegation shortcuts
  delegateTool,
  fanOutTool,
  // §5.5 Messaging
  messageSendTool,
  messageListTool,
  channelCreateTool,
  channelListTool,
  // §5.6 Shared memory
  memoryWriteTool,
  memoryReadTool,
  memorySearchTool,
  memoryDeleteTool,
  // §5.7 Artifacts
  artifactPutTool,
  artifactGetTool,
  artifactListTool,
  artifactDeleteTool,
  // §5.11 Observability & budgets
  eventsQueryTool,
  budgetSetTool,
  // §5.12 Admin
  orchestratorStatusTool,
  runnerListTool
] as const;

const PROFILE_RANK: Record<ToolProfile, number> = { core: 0, standard: 1, full: 2 };

/** Profiles are cumulative: a `core` tool is present in every profile. */
export function toolsForProfile(profile: ToolProfile): readonly ToolRegistration[] {
  return TOOL_REGISTRY.filter(tool => PROFILE_RANK[tool.profile] <= PROFILE_RANK[profile]);
}

export function registerTools(server: McpServer, deps: ToolDeps): readonly string[] {
  const tools = toolsForProfile(deps.services.config.toolProfile);
  for (const tool of tools) tool.register(server, deps);
  return tools.map(tool => tool.name);
}
