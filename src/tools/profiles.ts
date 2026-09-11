import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolProfile } from '../config.js';
import {
  a2aCardGetTool,
  a2aCardVerifyTool,
  a2aDiscoverTool,
  a2aPushConfigSetTool,
  a2aServerInfoTool,
  a2aTaskCancelTool,
  a2aTaskGetTool,
  agentPublishTool,
  agentRegisterTool
} from './a2a.js';
import { orchestratorStatusTool, runnerListTool } from './admin.js';
import { agentCreateTool, agentGetTool, agentListTool, agentTemplateListTool } from './agents.js';
import { approvalListTool, approvalResolveTool } from './approvals.js';
import { artifactDeleteTool, artifactGetTool, artifactListTool, artifactPutTool } from './artifacts.js';
import { delegateTool, fanOutTool, planCreateTool } from './delegation.js';
import { jobCancelTool, jobGetTool, jobListTool, jobRetryTool, jobSubmitTool, jobWaitTool } from './jobs.js';
import { memoryDeleteTool, memoryReadTool, memorySearchTool, memoryWriteTool } from './memory.js';
import { channelCreateTool, channelListTool, messageListTool, messageSendTool } from './messaging.js';
import { budgetSetTool, eventsQueryTool } from './observability.js';
import {
  toolserverListTool,
  toolserverRegisterTool,
  toolserverRemoveTool,
  toolserverToolsTool
} from './toolservers.js';
import type { ToolDeps, ToolRegistration } from './types.js';
import {
  workflowDefineTool,
  workflowDeleteTool,
  workflowGetTool,
  workflowListTool,
  workflowRunControlTool,
  workflowRunGetTool,
  workflowRunListTool,
  workflowStartTool
} from './workflows.js';

/**
 * The single ordered source of truth for the tool catalog, following the
 * PLAN.md §5 section order. `tools/list` order follows this array, so additions
 * go in a deliberate position rather than wherever an import happens to land.
 */
export const TOOL_REGISTRY: readonly ToolRegistration[] = [
  // §5.1 Agents
  agentCreateTool,
  agentRegisterTool,
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
  planCreateTool,
  // §5.4 Workflows
  workflowDefineTool,
  workflowListTool,
  workflowGetTool,
  workflowDeleteTool,
  workflowStartTool,
  workflowRunGetTool,
  workflowRunListTool,
  workflowRunControlTool,
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
  // §5.8 Human-in-the-loop
  approvalListTool,
  approvalResolveTool,
  // §5.9 A2A interoperability
  a2aCardGetTool,
  a2aCardVerifyTool,
  a2aDiscoverTool,
  a2aTaskGetTool,
  a2aTaskCancelTool,
  a2aPushConfigSetTool,
  a2aServerInfoTool,
  agentPublishTool,
  // §5.10 Downstream MCP tool servers (local agents only)
  toolserverRegisterTool,
  toolserverListTool,
  toolserverToolsTool,
  toolserverRemoveTool,
  // §5.11 Observability & budgets
  eventsQueryTool,
  budgetSetTool,
  // §5.12 Admin
  orchestratorStatusTool,
  runnerListTool
] as const;

const PROFILE_RANK: Record<ToolProfile, number> = { core: 0, standard: 1, full: 2 };

export interface ProfileOptions {
  /** When false, interop tools are left out of the catalog entirely. */
  a2aEnabled?: boolean;
}

/**
 * Profiles are cumulative: a `core` tool is present in every profile. A purely
 * local deployment never sees the A2A group at all — a smaller tool list is
 * better for model tool selection than one full of tools that cannot be used.
 */
export function toolsForProfile(
  profile: ToolProfile,
  options: ProfileOptions = {}
): readonly ToolRegistration[] {
  const a2aEnabled = options.a2aEnabled ?? false;

  return TOOL_REGISTRY.filter(
    tool => PROFILE_RANK[tool.profile] <= PROFILE_RANK[profile] && (a2aEnabled || tool.requiresA2A !== true)
  );
}

export function registerTools(server: McpServer, deps: ToolDeps): readonly string[] {
  const { config } = deps.services;
  const tools = toolsForProfile(config.toolProfile, { a2aEnabled: config.a2aEnabled });
  for (const tool of tools) tool.register(server, deps);
  return tools.map(tool => tool.name);
}
