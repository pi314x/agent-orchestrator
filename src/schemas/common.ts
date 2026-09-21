import { z } from 'zod';
import { JOB_STATES, type JobRecord } from '../core/jobs.js';
import { MAX_TIMEOUT_SEC } from '../core/policy.js';
import { SINGLE_OWNER } from '../core/principal.js';
import type { AgentRecord } from '../core/registry.js';
import { RUNNER_NAMES } from '../core/templates.js';
import { ERROR_CODES } from '../errors.js';

export const CursorSchema = z.string().optional().describe('Opaque cursor from a previous response.');
export const LimitSchema = z.number().int().min(1).max(100).default(20);

export const ErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  hint: z.string().optional()
});

export const UsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional()
});

/**
 * One shape, two backends (AGENTS.md interop rule 1). Backend-specific detail
 * never leaks into these common fields.
 */
export const JobViewSchema = z.object({
  jobId: z.string(),
  state: z.enum(JOB_STATES),
  backend: z.enum(['local', 'a2a_remote']),
  agentId: z.string(),
  agentName: z.string(),
  instruction: z.string(),
  attempt: z.number(),
  depth: z.number(),
  priority: z.number(),
  dependsOn: z.array(z.string()),
  resultText: z.string().optional(),
  resultStructured: z.unknown().optional(),
  error: ErrorSchema.optional(),
  usage: UsageSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional()
});

export type JobView = z.infer<typeof JobViewSchema>;

export function toJobView(job: JobRecord): JobView {
  return {
    jobId: job.id,
    state: job.state,
    backend: job.backend,
    agentId: job.agentId,
    agentName: job.agentSnapshot.name,
    instruction: job.instruction,
    attempt: job.attempt,
    depth: job.depth,
    priority: job.priority,
    dependsOn: job.dependsOn,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.resultText !== undefined && { resultText: job.resultText }),
    ...(job.resultStructured !== undefined && { resultStructured: job.resultStructured }),
    ...(job.error !== undefined && { error: job.error }),
    ...(job.usage !== undefined && { usage: job.usage }),
    ...(job.startedAt !== undefined && { startedAt: job.startedAt }),
    ...(job.finishedAt !== undefined && { finishedAt: job.finishedAt })
  };
}

export const AgentLimitsSchema = z.object({
  maxSteps: z.number().optional(),
  timeoutSec: z.number().optional(),
  maxCostUsd: z.number().optional()
});

/**
 * What agent_create/agent_update accept. Stricter than the view schema above
 * on purpose: a stored legacy row may carry anything once accepted, but new
 * writes are bounded — in particular timeoutSec, which past the setTimeout
 * range would fire after 1ms (see MAX_TIMEOUT_SEC). Never use this for
 * reading rows back, or a once-legal legacy value fails the read.
 */
export const AgentLimitsInputSchema = z.object({
  maxSteps: z.number().int().min(1).optional(),
  timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional(),
  maxCostUsd: z.number().min(0).optional()
});

export const AgentViewSchema = z.object({
  agentId: z.string(),
  kind: z.enum(['local', 'remote']),
  name: z.string(),
  role: z.string().optional(),
  instructions: z.string(),
  runner: z.enum(RUNNER_NAMES).optional(),
  model: z.string().optional(),
  toolGrants: z.array(z.string()),
  // Round-trips what agent_create/agent_update accept, so a caller can read
  // back exactly what they set — a agent's own limits were previously
  // write-only, invisible to its owner through any tool.
  limits: AgentLimitsSchema,
  // True for an admin-created central agent, visible to and usable by every
  // caller. In a single-owner (no OAuth) deployment this is true for
  // everything, which is accurate: nothing is private there either.
  shared: z.boolean(),
  // True when the viewer sees this agent only through someone else's peer
  // share: usable via delegate, but not modifiable, deletable or re-shareable.
  sharedWithYou: z.boolean(),
  ephemeral: z.boolean(),
  // Kill switch: visible and readable either way, but only an enabled agent
  // runs new jobs — toggled with agent_update.
  enabled: z.boolean(),
  createdAt: z.string()
});

export type AgentView = z.infer<typeof AgentViewSchema>;

/**
 * Whether a rendered view reaches its viewer only through a peer grant.
 * getVisible/getManaged already guarantee the viewer may see the agent, so a
 * row that is neither theirs, nor an admin's, nor the admin-wide sentinel
 * can only be visible through exactly such a grant — no extra query needed.
 */
export function isSharedWithViewer(
  agent: AgentRecord,
  viewer: { ownerId: string; isAdmin: boolean }
): boolean {
  return !viewer.isAdmin && agent.ownerId !== viewer.ownerId && agent.ownerId !== SINGLE_OWNER;
}

export function toAgentView(agent: AgentRecord, opts: { sharedWithYou?: boolean } = {}): AgentView {
  return {
    agentId: agent.id,
    kind: agent.kind,
    name: agent.name,
    instructions: agent.instructions,
    toolGrants: agent.toolGrants,
    limits: agent.limits,
    shared: agent.ownerId === SINGLE_OWNER,
    sharedWithYou: opts.sharedWithYou ?? false,
    ephemeral: agent.ephemeral,
    enabled: agent.enabled,
    createdAt: agent.createdAt,
    ...(agent.role !== undefined && { role: agent.role }),
    ...(agent.runner !== undefined && { runner: agent.runner }),
    ...(agent.model !== undefined && { model: agent.model })
  };
}

/** A JSON Schema supplied by the caller to constrain an agent's output. */
export const OutputSchemaSchema = z.record(z.string(), z.unknown()).optional();
