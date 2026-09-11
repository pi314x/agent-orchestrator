import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolProfile } from '../config.js';
import { orchestratorStatusTool } from './admin.js';
import type { ToolDeps, ToolRegistration } from './types.js';

/**
 * The single ordered source of truth for the tool catalog. `tools/list` order
 * follows this array, so additions go in a deliberate position rather than
 * wherever a module import happens to land.
 */
export const TOOL_REGISTRY: readonly ToolRegistration[] = [orchestratorStatusTool] as const;

const PROFILE_RANK: Record<ToolProfile, number> = { core: 0, standard: 1, full: 2 };

/** Profiles are cumulative: a `core` tool is present in every profile. */
export function toolsForProfile(profile: ToolProfile): readonly ToolRegistration[] {
  return TOOL_REGISTRY.filter(tool => PROFILE_RANK[tool.profile] <= PROFILE_RANK[profile]);
}

export function registerTools(server: McpServer, deps: ToolDeps): readonly string[] {
  const tools = toolsForProfile(deps.config.toolProfile);
  for (const tool of tools) tool.register(server, deps);
  return tools.map(tool => tool.name);
}
