import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { ADMIN_SCOPE, hasScope } from '../auth.js';
import { OrchestratorError } from '../errors.js';
import { toolError } from './result.js';

/**
 * Guards the tools that change what the orchestrator may do — budgets, tool
 * grants, and what we publish. Returns a refusal result when the caller lacks
 * the scope, and `undefined` when the call may proceed. With OAuth unconfigured
 * there is no authInfo and every call proceeds, which matches a local server.
 */
export function denyWithoutAdminScope(ctx: ServerContext, toolName: string): CallToolResult | undefined {
  if (hasScope(ctx.http?.authInfo, ADMIN_SCOPE)) return undefined;

  return toolError(
    new OrchestratorError(
      'POLICY_DENIED',
      `${toolName} requires the ${ADMIN_SCOPE} scope.`,
      'Present a token carrying that scope.'
    )
  );
}

/**
 * Guards the grant itself rather than the whole tool: anyone may create or
 * update an agent, but attaching downstream MCP tools to one is an admin act.
 * Gating `toolserver_register` alone is half a boundary — the servers it
 * protects are reachable by granting an agent access to them.
 */
export function denyUngrantedToolGrants(
  ctx: ServerContext,
  toolName: string,
  toolGrants: readonly string[] | undefined
): CallToolResult | undefined {
  if (toolGrants === undefined || toolGrants.length === 0) return undefined;
  return denyWithoutAdminScope(ctx, `${toolName} with toolGrants`);
}

/**
 * Guards making an agent shared (owner '', visible to every caller). Same
 * shape as `denyUngrantedToolGrants`: the everyday act of creating an agent
 * stays unprivileged, only opting it into "everyone can see and use this"
 * requires admin.
 */
export function denySharedWithoutAdmin(
  ctx: ServerContext,
  toolName: string,
  shared: boolean | undefined
): CallToolResult | undefined {
  if (shared !== true) return undefined;
  return denyWithoutAdminScope(ctx, `${toolName} with shared:true`);
}
