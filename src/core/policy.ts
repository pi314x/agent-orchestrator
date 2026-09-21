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

/**
 * Ceiling on any job timeout, in seconds (7 days). Past Node's setTimeout
 * range (~24.8 days) the timer overflows and fires after 1ms — a job asking
 * for a month would time out instantly, the exact opposite of what was
 * asked. Seven days is far below that cliff and far above any sane
 * orchestrated run; anything larger is a misconfiguration, rejected here so
 * every creator of job rows (tools, schedules, workflows, declarative
 * config) is covered by the same check.
 */
export const MAX_TIMEOUT_SEC = 604_800;

export function assertTimeoutWithinLimit(timeoutSec: number): void {
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `timeoutSec must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SEC} (7 days); got ${timeoutSec}.`,
      'Split longer work into chained jobs instead of one unbounded run.'
    );
  }
}
