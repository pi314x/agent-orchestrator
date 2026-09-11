import { OrchestratorError } from '../errors.js';

/**
 * Enforced here rather than in the tool adapters so every submit path — tools,
 * shortcuts, and the agent-side `spawn_job` in M2 — is covered by one check.
 */
export function assertDepthWithinLimit(depth: number, maxDepth: number): void {
  if (depth > maxDepth) {
    throw new OrchestratorError(
      'DEPTH_EXCEEDED',
      `Job depth ${depth} exceeds the limit of ${maxDepth}.`,
      'Raise ORCH_MAX_DEPTH, or flatten the delegation chain.'
    );
  }
}
