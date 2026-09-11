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
